import type {
  ProviderQuotaConfig,
  ProviderQuotaStatus,
  ProviderQuotaUsage,
  ProviderUsageWindow,
  TokenUsage,
} from "./types.js";
import { normalizeProviderId } from "./provider-identities.js";

export const DEFAULT_QUOTA_WARNING_THRESHOLD_PERCENT = 80;
const MAX_QUOTA_LIMIT = 1_000_000_000_000;

function positiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.min(MAX_QUOTA_LIMIT, Math.max(1, Math.round(number)));
}

export function normalizeProviderQuotaConfig(
  value: unknown,
): ProviderQuotaConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const dailyRequestLimit = positiveInteger(candidate.dailyRequestLimit);
  const monthlyRequestLimit = positiveInteger(candidate.monthlyRequestLimit);
  const dailyTokenLimit = positiveInteger(candidate.dailyTokenLimit);
  const monthlyTokenLimit = positiveInteger(candidate.monthlyTokenLimit);
  const rawThreshold = Number(candidate.warningThresholdPercent);
  const warningThresholdPercent = Number.isFinite(rawThreshold)
    ? Math.min(99, Math.max(1, Math.round(rawThreshold)))
    : DEFAULT_QUOTA_WARNING_THRESHOLD_PERCENT;

  if (
    dailyRequestLimit === undefined &&
    monthlyRequestLimit === undefined &&
    dailyTokenLimit === undefined &&
    monthlyTokenLimit === undefined
  ) {
    return undefined;
  }

  return {
    ...(dailyRequestLimit !== undefined ? { dailyRequestLimit } : {}),
    ...(monthlyRequestLimit !== undefined ? { monthlyRequestLimit } : {}),
    ...(dailyTokenLimit !== undefined ? { dailyTokenLimit } : {}),
    ...(monthlyTokenLimit !== undefined ? { monthlyTokenLimit } : {}),
    warningThresholdPercent,
  };
}

export function normalizeProviderQuotaMap(
  value: unknown,
): Record<string, ProviderQuotaConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: Record<string, ProviderQuotaConfig> = {};
  for (const [providerId, quota] of Object.entries(value)) {
    const id = normalizeProviderId(providerId);
    if (!id) continue;
    const config = normalizeProviderQuotaConfig(quota);
    if (config && (!normalized[id] || id === providerId)) normalized[id] = config;
  }
  return normalized;
}

function dayBounds(now: number): { startedAt: string; resetAt: string } {
  const date = new Date(now);
  const start = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
  return {
    startedAt: new Date(start).toISOString(),
    resetAt: new Date(start + 24 * 60 * 60_000).toISOString(),
  };
}

function monthBounds(now: number): { startedAt: string; resetAt: string } {
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const reset = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return {
    startedAt: new Date(start).toISOString(),
    resetAt: new Date(reset).toISOString(),
  };
}

function emptyWindow(
  period: ProviderUsageWindow["period"],
  now: number,
): ProviderUsageWindow {
  const bounds = period === "daily" ? dayBounds(now) : monthBounds(now);
  return {
    period,
    ...bounds,
    requests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function normalizeWindow(
  value: ProviderUsageWindow | undefined,
  period: ProviderUsageWindow["period"],
  now: number,
): ProviderUsageWindow {
  const resetAt = Date.parse(value?.resetAt ?? "");
  if (!value || !Number.isFinite(resetAt) || resetAt <= now) {
    return emptyWindow(period, now);
  }

  return {
    period,
    startedAt: value.startedAt,
    resetAt: value.resetAt,
    requests: Math.max(0, Math.round(Number(value.requests) || 0)),
    successfulRequests: Math.max(
      0,
      Math.round(Number(value.successfulRequests) || 0),
    ),
    failedRequests: Math.max(0, Math.round(Number(value.failedRequests) || 0)),
    inputTokens: Math.max(0, Math.round(Number(value.inputTokens) || 0)),
    outputTokens: Math.max(0, Math.round(Number(value.outputTokens) || 0)),
    totalTokens: Math.max(0, Math.round(Number(value.totalTokens) || 0)),
  };
}

export function normalizeProviderQuotaUsage(
  usage: ProviderQuotaUsage | undefined,
  now = Date.now(),
): ProviderQuotaUsage {
  return {
    daily: normalizeWindow(usage?.daily, "daily", now),
    monthly: normalizeWindow(usage?.monthly, "monthly", now),
    ...(usage?.lastUpdatedAt ? { lastUpdatedAt: usage.lastUpdatedAt } : {}),
    ...(usage?.lastTokenUsageSource
      ? { lastTokenUsageSource: usage.lastTokenUsageSource }
      : {}),
  };
}

export function addProviderAttemptUsage(
  usage: ProviderQuotaUsage | undefined,
  success: boolean,
  now = Date.now(),
): ProviderQuotaUsage {
  const normalized = normalizeProviderQuotaUsage(usage, now);
  const increment = (window: ProviderUsageWindow): ProviderUsageWindow => ({
    ...window,
    requests: window.requests + 1,
    successfulRequests: window.successfulRequests + (success ? 1 : 0),
    failedRequests: window.failedRequests + (success ? 0 : 1),
  });
  return {
    daily: increment(normalized.daily),
    monthly: increment(normalized.monthly),
    lastUpdatedAt: new Date(now).toISOString(),
    ...(normalized.lastTokenUsageSource
      ? { lastTokenUsageSource: normalized.lastTokenUsageSource }
      : {}),
  };
}

export function addProviderTokenUsage(
  usage: ProviderQuotaUsage | undefined,
  tokens: TokenUsage,
  now = Date.now(),
): ProviderQuotaUsage {
  const normalized = normalizeProviderQuotaUsage(usage, now);
  const inputTokens = Math.max(0, Math.round(tokens.inputTokens));
  const outputTokens = Math.max(0, Math.round(tokens.outputTokens));
  const totalTokens = Math.max(
    inputTokens + outputTokens,
    Math.max(0, Math.round(tokens.totalTokens)),
  );
  const increment = (window: ProviderUsageWindow): ProviderUsageWindow => ({
    ...window,
    inputTokens: window.inputTokens + inputTokens,
    outputTokens: window.outputTokens + outputTokens,
    totalTokens: window.totalTokens + totalTokens,
  });
  return {
    daily: increment(normalized.daily),
    monthly: increment(normalized.monthly),
    lastUpdatedAt: new Date(now).toISOString(),
    lastTokenUsageSource: tokens.source,
  };
}

interface LimitEvaluation {
  name: ProviderQuotaStatus["exhaustedLimits"][number];
  used: number;
  limit: number;
  resetAt: number;
}

export function providerQuotaStatus(
  config: ProviderQuotaConfig | undefined,
  usage: ProviderQuotaUsage | undefined,
  now = Date.now(),
): ProviderQuotaStatus | undefined {
  if (!config) return undefined;
  const normalizedUsage = normalizeProviderQuotaUsage(usage, now);
  const limits: LimitEvaluation[] = [];

  if (config.dailyRequestLimit !== undefined) {
    limits.push({
      name: "daily_requests",
      used: normalizedUsage.daily.requests,
      limit: config.dailyRequestLimit,
      resetAt: Date.parse(normalizedUsage.daily.resetAt),
    });
  }
  if (config.monthlyRequestLimit !== undefined) {
    limits.push({
      name: "monthly_requests",
      used: normalizedUsage.monthly.requests,
      limit: config.monthlyRequestLimit,
      resetAt: Date.parse(normalizedUsage.monthly.resetAt),
    });
  }
  if (config.dailyTokenLimit !== undefined) {
    limits.push({
      name: "daily_tokens",
      used: normalizedUsage.daily.totalTokens,
      limit: config.dailyTokenLimit,
      resetAt: Date.parse(normalizedUsage.daily.resetAt),
    });
  }
  if (config.monthlyTokenLimit !== undefined) {
    limits.push({
      name: "monthly_tokens",
      used: normalizedUsage.monthly.totalTokens,
      limit: config.monthlyTokenLimit,
      resetAt: Date.parse(normalizedUsage.monthly.resetAt),
    });
  }

  const exhausted = limits.filter((limit) => limit.used >= limit.limit);
  const consumedRatio = limits.length
    ? Math.max(...limits.map((limit) => limit.used / limit.limit))
    : 0;
  const remainingRatio = Math.max(0, Math.min(1, 1 - consumedRatio));
  const warningThreshold = config.warningThresholdPercent / 100;
  const warning = exhausted.length === 0 && consumedRatio >= warningThreshold;
  const maxConsumedRatio = limits.length
    ? Math.max(...limits.map((limit) => limit.used / limit.limit))
    : 0;
  const warningLimits = limits.filter(
    (limit) => Math.abs(limit.used / limit.limit - maxConsumedRatio) < 0.000001,
  );
  const relevantResets = exhausted.length ? exhausted : warningLimits;
  const nextResetAt = relevantResets.length
    ? Math.min(...relevantResets.map((limit) => limit.resetAt))
    : undefined;

  return {
    config,
    usage: normalizedUsage,
    exhausted: exhausted.length > 0,
    warning,
    remainingRatio,
    consumedPercent: Math.min(100, Math.max(0, Math.round(consumedRatio * 100))),
    exhaustedLimits: exhausted.map((limit) => limit.name),
    ...(nextResetAt !== undefined ? { nextResetAt } : {}),
  };
}

export function extractTokenUsage(
  payload: unknown,
  fallbackInputTokens?: number,
): TokenUsage | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    if (fallbackInputTokens === undefined) return undefined;
    return {
      inputTokens: Math.max(0, Math.round(fallbackInputTokens)),
      outputTokens: 0,
      totalTokens: Math.max(0, Math.round(fallbackInputTokens)),
      source: "estimated",
    };
  }

  const body = payload as Record<string, unknown>;
  const rawUsage = body.usage;
  const usage = rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage)
    ? rawUsage as Record<string, unknown>
    : undefined;

  const numeric = (...values: unknown[]): number | undefined => {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) return Math.round(number);
    }
    return undefined;
  };

  const reportedInputTokens = numeric(
    usage?.prompt_tokens,
    usage?.input_tokens,
  );
  const reportedOutputTokens = numeric(
    usage?.completion_tokens,
    usage?.output_tokens,
  );
  const reportedTotalTokens = numeric(usage?.total_tokens);
  const inputTokens = reportedInputTokens ?? numeric(fallbackInputTokens);

  if (
    inputTokens === undefined &&
    reportedOutputTokens === undefined &&
    reportedTotalTokens === undefined
  ) {
    return undefined;
  }

  const normalizedInput = inputTokens ?? 0;
  const normalizedOutput = reportedOutputTokens ?? 0;
  const hasReportedUsage =
    reportedInputTokens !== undefined ||
    reportedOutputTokens !== undefined ||
    reportedTotalTokens !== undefined;
  return {
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    totalTokens: reportedTotalTokens ?? normalizedInput + normalizedOutput,
    source: hasReportedUsage ? "reported" : "estimated",
  };
}

export function approximateInputTokens(body: Record<string, unknown>): number {
  return Math.max(1, Math.ceil(JSON.stringify(body).length / 4));
}
