import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Redis } from "@upstash/redis";
import type {
  ProviderAttemptMetric,
  ProviderRoutingStats,
  TokenUsage,
} from "./types.js";
import {
  addProviderAttemptUsage,
  addProviderTokenUsage,
  normalizeProviderQuotaUsage,
} from "./provider-quotas.js";
import { normalizeProviderId, normalizeProviderRecord } from "./provider-identities.js";

interface RouterRoutingState {
  cursor: number;
  providers: Record<string, ProviderRoutingStats>;
}

interface RoutingStateStore {
  routers: Record<string, RouterRoutingState>;
}

const ROUTING_STATE_KEY_PREFIX = "freellm:routing-state:";
const ROUTING_CURSOR_KEY_PREFIX = "freellm:routing-cursor:";
const HALF_OPEN_PROBE_STALE_MS = 2 * 60_000;

function routingStatePath(): string {
  return path.resolve(
    process.env.ROUTING_STATE_PATH ?? ".freellm/routing-state.json",
  );
}

function redisClient(): Redis | undefined {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : undefined;
}

function routingStateKey(routerKeyHash: string): string {
  return `${ROUTING_STATE_KEY_PREFIX}${routerKeyHash}`;
}

function routingCursorKey(routerKeyHash: string): string {
  return `${ROUTING_CURSOR_KEY_PREFIX}${routerKeyHash}`;
}

async function loadLocalStore(): Promise<RoutingStateStore> {
  try {
    const parsed = JSON.parse(
      await readFile(routingStatePath(), "utf8"),
    ) as RoutingStateStore;
    if (!parsed.routers || typeof parsed.routers !== "object") {
      throw new Error("Invalid routing state store");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { routers: {} };
    }
    throw error;
  }
}

async function saveLocalStore(store: RoutingStateStore): Promise<void> {
  const target = routingStatePath();
  const directory = path.dirname(target);
  const temporary = `${target}.${process.pid}.tmp`;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

function emptyRouterState(): RouterRoutingState {
  return { cursor: 0, providers: {} };
}

function normalizeProviderStatsRecord(
  providers: Record<string, ProviderRoutingStats> | undefined,
): Record<string, ProviderRoutingStats> {
  const canonical = normalizeProviderRecord(providers);
  return Object.fromEntries(
    Object.entries(canonical).map(([providerId, stats]) => [
      providerId,
      {
        ...stats,
        providerId,
        quotaUsage: normalizeProviderQuotaUsage(stats.quotaUsage),
      },
    ]),
  );
}

function initialStats(providerId: string): ProviderRoutingStats {
  return {
    providerId,
    attempts: 0,
    successes: 0,
    failures: 0,
    successScore: 0.75,
    consecutiveFailures: 0,
    rateLimitCount: 0,
    circuitState: "closed",
    circuitFailureCount: 0,
    circuitOpenCount: 0,
    halfOpenProbeActive: false,
  };
}

function withoutCooldown(current: ProviderRoutingStats): ProviderRoutingStats {
  const {
    cooldownUntil: _cooldownUntil,
    cooldownStartedAt: _cooldownStartedAt,
    cooldownReason: _cooldownReason,
    lastRetryAfterSeconds: _lastRetryAfterSeconds,
    ...rest
  } = current;
  return rest;
}

function withoutOpenCircuit(current: ProviderRoutingStats): ProviderRoutingStats {
  const {
    circuitOpenedAt: _circuitOpenedAt,
    circuitOpenUntil: _circuitOpenUntil,
    halfOpenStartedAt: _halfOpenStartedAt,
    ...rest
  } = current;
  return rest;
}

function updateStats(
  previous: ProviderRoutingStats | undefined,
  attempt: ProviderAttemptMetric,
): ProviderRoutingStats {
  const current = previous ?? initialStats(attempt.providerId);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const averageLatencyMs = current.averageLatencyMs === undefined
    ? Math.max(0, Math.round(attempt.latencyMs))
    : Math.max(
        0,
        Math.round(current.averageLatencyMs * 0.75 + attempt.latencyMs * 0.25),
      );
  const successScore = attempt.success
    ? current.successScore * 0.8 + 0.2
    : current.successScore * 0.8;
  const isRateLimit = !attempt.success && attempt.status === 429;
  const wasCircuitRestricted =
    current.circuitState === "open" || current.circuitState === "half-open";

  let base: ProviderRoutingStats = {
    ...current,
    attempts: current.attempts + 1,
    successes: current.successes + (attempt.success ? 1 : 0),
    failures: current.failures + (attempt.success ? 0 : 1),
    averageLatencyMs,
    successScore: Math.max(0, Math.min(1, successScore)),
    consecutiveFailures: attempt.success
      ? 0
      : current.consecutiveFailures + 1,
    rateLimitCount: attempt.success
      ? 0
      : isRateLimit
        ? (current.rateLimitCount ?? 0) + 1
        : current.rateLimitCount ?? 0,
    lastUsedAt: now,
    ...(attempt.success
      ? { lastSuccessAt: now }
      : {
          lastFailureAt: now,
          ...(attempt.message ? { lastError: attempt.message.slice(0, 500) } : {}),
          ...(isRateLimit ? { lastRateLimitAt: now } : {}),
          ...(attempt.failureType ? { lastFailureType: attempt.failureType } : {}),
        }),
    ...(attempt.status !== undefined ? { lastStatus: attempt.status } : {}),
    quotaUsage: addProviderAttemptUsage(current.quotaUsage, attempt.success, nowMs),
  };

  if (attempt.success) {
    base = withoutCooldown(base);
    base = withoutOpenCircuit(base);
    return {
      ...base,
      rateLimitCount: 0,
      circuitState: "closed",
      circuitFailureCount: 0,
      circuitOpenCount: 0,
      halfOpenProbeActive: false,
      ...(wasCircuitRestricted ? { lastRecoveredAt: now } : {}),
    };
  }

  if (attempt.cooldownUntil !== undefined) {
    base.cooldownUntil = attempt.cooldownUntil;
    base.cooldownStartedAt = now;
    base.cooldownReason = attempt.cooldownReason ?? "rate_limit";
  }
  if (attempt.retryAfterSeconds !== undefined) {
    base.lastRetryAfterSeconds = attempt.retryAfterSeconds;
  }

  if (attempt.circuitState !== undefined) {
    base.circuitState = attempt.circuitState;
  }
  if (attempt.circuitFailureCount !== undefined) {
    base.circuitFailureCount = attempt.circuitFailureCount;
  }
  if (attempt.circuitOpenCount !== undefined) {
    base.circuitOpenCount = attempt.circuitOpenCount;
  }
  if (attempt.halfOpenProbeActive !== undefined) {
    base.halfOpenProbeActive = attempt.halfOpenProbeActive;
  }
  if (attempt.circuitOpenUntil !== undefined) {
    base.circuitOpenUntil = attempt.circuitOpenUntil;
    base.circuitOpenedAt = now;
  }
  if (attempt.circuitAction === "closed") {
    base = withoutOpenCircuit(base);
    base.circuitState = "closed";
    base.circuitFailureCount = 0;
    base.circuitOpenCount = 0;
    base.halfOpenProbeActive = false;
  }
  if (attempt.circuitAction === "half_open") {
    base.circuitState = "half-open";
    base.halfOpenProbeActive = true;
    base.halfOpenStartedAt = now;
  }
  if (attempt.circuitAction === "opened" || attempt.circuitAction === "reopened") {
    base.circuitState = "open";
    base.halfOpenProbeActive = false;
    delete base.halfOpenStartedAt;
  }

  return base;
}

async function mutateRouterState<T>(
  routerKeyHash: string,
  mutate: (state: RouterRoutingState) => T,
): Promise<T> {
  const redis = redisClient();
  if (redis) {
    const key = routingStateKey(routerKeyHash);
    const state =
      (await redis.get<RouterRoutingState>(key)) ?? emptyRouterState();
    state.providers = normalizeProviderStatsRecord(state.providers);
    const result = mutate(state);
    await redis.set(key, state);
    return result;
  }

  const store = await loadLocalStore();
  const state = store.routers[routerKeyHash] ?? emptyRouterState();
  state.providers = normalizeProviderStatsRecord(state.providers);
  const result = mutate(state);
  store.routers[routerKeyHash] = state;
  await saveLocalStore(store);
  return result;
}

export async function getRoutingStats(
  routerKeyHash: string,
): Promise<Record<string, ProviderRoutingStats>> {
  const redis = redisClient();
  if (redis) {
    const key = routingStateKey(routerKeyHash);
    const state = await redis.get<RouterRoutingState>(key);
    if (!state) return {};
    state.providers = normalizeProviderStatsRecord(state.providers);
    await redis.set(key, state);
    return state.providers;
  }

  const store = await loadLocalStore();
  const state = store.routers[routerKeyHash];
  if (!state) return {};
  state.providers = normalizeProviderStatsRecord(state.providers);
  await saveLocalStore(store);
  return state.providers;
}

export async function recordRoutingAttempt(
  routerKeyHash: string,
  attempt: ProviderAttemptMetric,
): Promise<void> {
  attempt = { ...attempt, providerId: normalizeProviderId(attempt.providerId) };
  await mutateRouterState(routerKeyHash, (state) => {
    state.providers[attempt.providerId] = updateStats(
      state.providers[attempt.providerId],
      attempt,
    );
  });
}

export async function recordProviderTokenUsage(
  routerKeyHash: string,
  providerId: string,
  usage: TokenUsage,
): Promise<ProviderRoutingStats> {
  providerId = normalizeProviderId(providerId);
  return mutateRouterState(routerKeyHash, (state) => {
    const current = state.providers[providerId] ?? initialStats(providerId);
    const updated: ProviderRoutingStats = {
      ...current,
      quotaUsage: addProviderTokenUsage(current.quotaUsage, usage),
    };
    state.providers[providerId] = updated;
    return updated;
  });
}

export async function clearProviderUsage(
  routerKeyHash: string,
  providerId: string,
): Promise<ProviderRoutingStats> {
  providerId = normalizeProviderId(providerId);
  return mutateRouterState(routerKeyHash, (state) => {
    const current = state.providers[providerId] ?? initialStats(providerId);
    const updated: ProviderRoutingStats = {
      ...current,
      quotaUsage: normalizeProviderQuotaUsage(undefined),
    };
    state.providers[providerId] = updated;
    return updated;
  });
}

export async function nextRoundRobinCursor(
  routerKeyHash: string,
  providerCount: number,
): Promise<number> {
  if (providerCount <= 0) return 0;

  const redis = redisClient();
  if (redis) {
    const next = await redis.incr(routingCursorKey(routerKeyHash));
    return Math.max(0, (next - 1) % providerCount);
  }

  return mutateRouterState(routerKeyHash, (state) => {
    const cursor = Math.max(0, state.cursor % providerCount);
    state.cursor = (cursor + 1) % providerCount;
    return cursor;
  });
}

export async function clearProviderCooldown(
  routerKeyHash: string,
  providerId: string,
): Promise<ProviderRoutingStats> {
  providerId = normalizeProviderId(providerId);
  return mutateRouterState(routerKeyHash, (state) => {
    const current = state.providers[providerId] ?? initialStats(providerId);
    const updated: ProviderRoutingStats = {
      ...withoutCooldown(current),
      rateLimitCount: 0,
    };
    state.providers[providerId] = updated;
    return updated;
  });
}

export async function resetProviderCircuit(
  routerKeyHash: string,
  providerId: string,
): Promise<ProviderRoutingStats> {
  providerId = normalizeProviderId(providerId);
  return mutateRouterState(routerKeyHash, (state) => {
    const current = state.providers[providerId] ?? initialStats(providerId);
    const updated: ProviderRoutingStats = {
      ...withoutOpenCircuit(current),
      circuitState: "closed",
      circuitFailureCount: 0,
      circuitOpenCount: 0,
      halfOpenProbeActive: false,
      consecutiveFailures: 0,
    };
    state.providers[providerId] = updated;
    return updated;
  });
}

export async function prepareProviderCircuitRetry(
  routerKeyHash: string,
  providerId: string,
): Promise<ProviderRoutingStats> {
  providerId = normalizeProviderId(providerId);
  return mutateRouterState(routerKeyHash, (state) => {
    const current = state.providers[providerId] ?? initialStats(providerId);
    const updated: ProviderRoutingStats = {
      ...current,
      circuitState: "open",
      circuitOpenUntil: Date.now() - 1,
      halfOpenProbeActive: false,
    };
    delete updated.halfOpenStartedAt;
    state.providers[providerId] = updated;
    return updated;
  });
}

export async function claimProviderHalfOpenProbe(
  routerKeyHash: string,
  providerId: string,
): Promise<boolean> {
  providerId = normalizeProviderId(providerId);
  return mutateRouterState(routerKeyHash, (state) => {
    const current = state.providers[providerId] ?? initialStats(providerId);
    const now = Date.now();
    const halfOpenStartedAt = Date.parse(current.halfOpenStartedAt ?? "");
    const probeIsStale =
      !Number.isFinite(halfOpenStartedAt) ||
      now - halfOpenStartedAt >= HALF_OPEN_PROBE_STALE_MS;

    if (current.circuitState !== "open" && current.circuitState !== "half-open") {
      return false;
    }
    if (current.circuitState === "open" && (current.circuitOpenUntil ?? 0) > now) {
      return false;
    }
    if (current.halfOpenProbeActive && !probeIsStale) return false;

    state.providers[providerId] = {
      ...current,
      circuitState: "half-open",
      halfOpenProbeActive: true,
      halfOpenStartedAt: new Date(now).toISOString(),
    };
    return true;
  });
}
