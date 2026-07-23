import { Redis } from "@upstash/redis";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  CapabilityMatch,
  DeduplicationMetadata,
  ProviderAttemptMetric,
  ProviderCandidateEvaluation,
  ProviderCapabilityName,
  RoutingStrategy,
  TokenUsage,
  RequestTimelineEvent,
  RequestIdSource,
  RoutingHeaders,
  RequestPerformanceTiming,
  ApiClientApplicationInfo,
  RequestToolAnalytics,
} from "./types.js";
import { buildRequestTimeline } from "./request-timeline.js";
import { generateRequestId } from "./request-ids.js";
import {
  analyzeToolActivity,
  detectClientApplication,
  fallbackMetadata,
  summarizeRequestAnalytics,
} from "./request-analytics.js";
import {
  normalizeProviderId,
  normalizeProviderText,
} from "./provider-identities.js";

const ANALYTICS_KEY_PREFIX = "freellm:analytics:";
const DEFAULT_ANALYTICS_LIMIT = 250;
const MAX_ANALYTICS_LIMIT = 500;
const MAX_STRING_LENGTH = 8_000;
const MAX_ARRAY_LENGTH = 50;
const MAX_OBJECT_KEYS = 80;
let localWriteQueue: Promise<void> = Promise.resolve();

async function enqueueLocalWrite(operation: () => Promise<void>): Promise<void> {
  const next = localWriteQueue.then(operation, operation);
  localWriteQueue = next.catch(() => undefined);
  await next;
}

export type ApiFormat =
  | "openai-compatible"
  | "openai-responses-compatible"
  | "claude-code-compatible";

export interface RequestLogEntry {
  id: string;
  requestId?: string;
  clientRequestId?: string;
  requestIdSource?: RequestIdSource;
  routingHeaders?: RoutingHeaders;
  routerKeyHash: string;
  createdAt: string;
  providerId: string;
  providerModel?: string | undefined;
  requestedModel?: string | undefined;
  resolvedAlias?: string | undefined;
  apiFormat?: ApiFormat | undefined;
  endpoint?: string | undefined;
  routingStrategy?: RoutingStrategy | undefined;
  requiredCapabilities?: ProviderCapabilityName[] | undefined;
  capabilityMatch?: CapabilityMatch["level"] | undefined;
  providerEvaluations?: ProviderCandidateEvaluation[] | undefined;
  providerAttempts?: ProviderAttemptMetric[] | undefined;
  status: number;
  latencyMs: number;
  usage?: TokenUsage | undefined;
  deduplication?: DeduplicationMetadata | undefined;
  timeline?: RequestTimelineEvent[] | undefined;
  performance?: RequestPerformanceTiming | undefined;
  clientApplication?: ApiClientApplicationInfo | undefined;
  toolAnalytics?: RequestToolAnalytics | undefined;
  streaming?: boolean | undefined;
  fallbackUsed?: boolean | undefined;
  providerAttemptCount?: number | undefined;
  fallbackPath?: string[] | undefined;
  request: unknown;
  response: unknown;
}

interface AnalyticsStore {
  requests: RequestLogEntry[];
}

function normalizeTimelineDetails(value: unknown): unknown {
  if (typeof value === "string") return normalizeProviderText(value);
  if (Array.isArray(value)) return value.map(normalizeTimelineDetails);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizeTimelineDetails(item)]),
  );
}

function normalizeRequestLogProviderIds(entry: RequestLogEntry): RequestLogEntry {
  const providerId = normalizeProviderId(entry.providerId);
  const providerAttempts = entry.providerAttempts?.map((attempt) => ({
    ...attempt,
    providerId: normalizeProviderId(attempt.providerId),
  }));
  const providerEvaluations = entry.providerEvaluations?.map((evaluation) => ({
    ...evaluation,
    providerId: normalizeProviderId(evaluation.providerId),
  }));
  const timeline = entry.timeline?.map((event) => ({
    ...event,
    title: normalizeProviderText(event.title),
    ...(event.detail ? { detail: normalizeProviderText(event.detail) } : {}),
    ...(event.providerId ? { providerId: normalizeProviderId(event.providerId) } : {}),
    ...(event.details
      ? { details: normalizeTimelineDetails(event.details) as Record<string, unknown> }
      : {}),
  }));
  const performance = entry.performance
    ? {
        ...entry.performance,
        attempts: entry.performance.attempts.map((attempt) => ({
          ...attempt,
          providerId: normalizeProviderId(attempt.providerId),
        })),
      }
    : undefined;
  const fallbackPath = entry.fallbackPath?.map(normalizeProviderId);
  const routingHeaders = entry.routingHeaders
    ? {
        ...entry.routingHeaders,
        ...(entry.routingHeaders["x-free-llm-provider"]
          ? {
              "x-free-llm-provider": normalizeProviderId(
                entry.routingHeaders["x-free-llm-provider"],
              ),
            }
          : {}),
      }
    : undefined;

  return {
    ...entry,
    providerId,
    ...(providerAttempts ? { providerAttempts } : {}),
    ...(providerEvaluations ? { providerEvaluations } : {}),
    ...(timeline ? { timeline } : {}),
    ...(performance ? { performance } : {}),
    ...(fallbackPath ? { fallbackPath } : {}),
    ...(routingHeaders ? { routingHeaders } : {}),
  };
}

export interface RequestFrequencyBucket {
  label: string;
  count: number;
}

function analyticsPath(): string {
  return path.resolve(process.env.ANALYTICS_PATH ?? ".freellm/analytics.json");
}

function redisClient(): Redis | undefined {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : undefined;
}

function analyticsKey(routerKeyHash: string): string {
  return `${ANALYTICS_KEY_PREFIX}${routerKeyHash}`;
}

async function loadLocalStore(): Promise<AnalyticsStore> {
  try {
    const parsed = JSON.parse(await readFile(analyticsPath(), "utf8")) as AnalyticsStore;
    if (!Array.isArray(parsed.requests)) throw new Error("Invalid analytics store");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { requests: [] };
    }
    throw error;
  }
}

async function saveLocalStore(store: AnalyticsStore): Promise<void> {
  const target = analyticsPath();
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

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  if (["number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`
      : value;
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (depth >= 6) return "[max depth reached]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitize(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      if (["authorization", "apiKey", "api_key", "key", "token", "password"].includes(key.toLowerCase())) {
        output[key] = "[redacted]";
      } else {
        output[key] = sanitize(item, depth + 1);
      }
    }
    return output;
  }
  return String(value);
}

function requestSnapshot(body: Record<string, unknown>): unknown {
  return sanitize({
    model: body.model,
    stream: body.stream === true,
    instructions: body.instructions,
    input: body.input,
    messages: body.messages,
    tools: body.tools,
    tool_choice: body.tool_choice,
    max_output_tokens: body.max_output_tokens,
    max_tokens: body.max_tokens,
  });
}

function responseSnapshot(text: string, contentType: string | null): unknown {
  const clipped = text.length > MAX_STRING_LENGTH
    ? `${text.slice(0, MAX_STRING_LENGTH)}…[truncated]`
    : text;

  if (contentType?.includes("application/json")) {
    try {
      return sanitize(JSON.parse(clipped) as unknown);
    } catch {
      return clipped;
    }
  }

  return clipped;
}

function parseResponsePayload(text: string, contentType: string | null): unknown {
  if (!text || !contentType?.includes("application/json")) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function createRequestLog(params: {
  routerKeyHash: string;
  requestId?: string;
  clientRequestId?: string;
  requestIdSource?: RequestIdSource;
  routingHeaders?: RoutingHeaders;
  providerId: string;
  providerModel?: string | undefined;
  requestedModel?: string | undefined;
  resolvedAlias?: string | undefined;
  apiFormat: ApiFormat;
  endpoint: string;
  routingStrategy?: RoutingStrategy;
  requiredCapabilities?: ProviderCapabilityName[];
  capabilityMatch?: CapabilityMatch["level"];
  providerEvaluations?: ProviderCandidateEvaluation[];
  providerAttempts?: ProviderAttemptMetric[];
  status: number;
  latencyMs: number;
  usage?: TokenUsage;
  deduplication?: DeduplicationMetadata;
  performance?: RequestPerformanceTiming;
  requestBody: Record<string, unknown>;
  responseText: string;
  responseContentType: string | null;
  requestHeaders?: IncomingHttpHeaders;
  startedAt?: number;
  completedAt?: number;
}): RequestLogEntry {
  const completedAt = params.completedAt ?? Date.now();
  const startedAt = params.startedAt ?? completedAt - Math.max(0, params.latencyMs);
  const requestId = params.requestId ?? generateRequestId();
  const responsePayload = parseResponsePayload(params.responseText, params.responseContentType);
  const clientApplication = detectClientApplication(params.requestHeaders);
  const toolAnalytics = analyzeToolActivity({
    body: params.requestBody,
    ...(responsePayload !== undefined ? { responsePayload } : {}),
    status: params.status,
    streaming: false,
  });
  const fallback = fallbackMetadata(params.providerAttempts);
  const timeline = buildRequestTimeline({
    requestId,
    ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
    ...(params.requestIdSource ? { requestIdSource: params.requestIdSource } : {}),
    startedAt,
    completedAt,
    latencyMs: params.latencyMs,
    status: params.status,
    providerId: params.providerId,
    ...(params.requestedModel ? { requestedModel: params.requestedModel } : {}),
    ...(params.resolvedAlias ? { resolvedAlias: params.resolvedAlias } : {}),
    ...(params.routingStrategy ? { routingStrategy: params.routingStrategy } : {}),
    ...(params.requiredCapabilities ? { requiredCapabilities: params.requiredCapabilities } : {}),
    ...(params.providerEvaluations ? { providerEvaluations: params.providerEvaluations } : {}),
    ...(params.providerAttempts ? { providerAttempts: params.providerAttempts } : {}),
    ...(params.deduplication ? { deduplication: params.deduplication } : {}),
  });
  return {
    id: randomUUID(),
    requestId,
    ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
    ...(params.requestIdSource ? { requestIdSource: params.requestIdSource } : {}),
    ...(params.routingHeaders ? { routingHeaders: params.routingHeaders } : {}),
    routerKeyHash: params.routerKeyHash,
    createdAt: new Date().toISOString(),
    providerId: params.providerId,
    providerModel: params.providerModel,
    requestedModel: params.requestedModel,
    resolvedAlias: params.resolvedAlias,
    apiFormat: params.apiFormat,
    endpoint: params.endpoint,
    routingStrategy: params.routingStrategy,
    requiredCapabilities: params.requiredCapabilities,
    capabilityMatch: params.capabilityMatch,
    providerEvaluations: params.providerEvaluations,
    providerAttempts: params.providerAttempts,
    status: params.status,
    latencyMs: params.latencyMs,
    ...(params.usage ? { usage: params.usage } : {}),
    ...(params.deduplication ? { deduplication: params.deduplication } : {}),
    ...(params.performance ? { performance: params.performance } : {}),
    clientApplication,
    toolAnalytics,
    streaming: false,
    fallbackUsed: fallback.fallbackUsed,
    providerAttemptCount: fallback.providerAttemptCount,
    fallbackPath: fallback.fallbackPath,
    timeline,
    request: requestSnapshot(params.requestBody),
    response: responseSnapshot(params.responseText, params.responseContentType),
  };
}

export function createStreamingRequestLog(params: {
  routerKeyHash: string;
  requestId?: string;
  clientRequestId?: string;
  requestIdSource?: RequestIdSource;
  routingHeaders?: RoutingHeaders;
  providerId: string;
  providerModel?: string | undefined;
  requestedModel?: string | undefined;
  resolvedAlias?: string | undefined;
  apiFormat: ApiFormat;
  endpoint: string;
  routingStrategy?: RoutingStrategy;
  requiredCapabilities?: ProviderCapabilityName[];
  capabilityMatch?: CapabilityMatch["level"];
  providerEvaluations?: ProviderCandidateEvaluation[];
  providerAttempts?: ProviderAttemptMetric[];
  status: number;
  latencyMs: number;
  usage?: TokenUsage;
  deduplication?: DeduplicationMetadata;
  performance?: RequestPerformanceTiming;
  requestBody: Record<string, unknown>;
  requestHeaders?: IncomingHttpHeaders;
  startedAt?: number;
  completedAt?: number;
}): RequestLogEntry {
  const completedAt = params.completedAt ?? Date.now();
  const startedAt = params.startedAt ?? completedAt - Math.max(0, params.latencyMs);
  const requestId = params.requestId ?? generateRequestId();
  const clientApplication = detectClientApplication(params.requestHeaders);
  const toolAnalytics = analyzeToolActivity({
    body: params.requestBody,
    status: params.status,
    streaming: true,
  });
  const fallback = fallbackMetadata(params.providerAttempts);
  const timeline = buildRequestTimeline({
    requestId,
    ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
    ...(params.requestIdSource ? { requestIdSource: params.requestIdSource } : {}),
    startedAt,
    completedAt,
    latencyMs: params.latencyMs,
    status: params.status,
    providerId: params.providerId,
    ...(params.requestedModel ? { requestedModel: params.requestedModel } : {}),
    ...(params.resolvedAlias ? { resolvedAlias: params.resolvedAlias } : {}),
    ...(params.routingStrategy ? { routingStrategy: params.routingStrategy } : {}),
    ...(params.requiredCapabilities ? { requiredCapabilities: params.requiredCapabilities } : {}),
    ...(params.providerEvaluations ? { providerEvaluations: params.providerEvaluations } : {}),
    ...(params.providerAttempts ? { providerAttempts: params.providerAttempts } : {}),
    ...(params.deduplication ? { deduplication: params.deduplication } : {}),
    streaming: true,
  });
  return {
    id: randomUUID(),
    requestId,
    ...(params.clientRequestId ? { clientRequestId: params.clientRequestId } : {}),
    ...(params.requestIdSource ? { requestIdSource: params.requestIdSource } : {}),
    ...(params.routingHeaders ? { routingHeaders: params.routingHeaders } : {}),
    routerKeyHash: params.routerKeyHash,
    createdAt: new Date().toISOString(),
    providerId: params.providerId,
    providerModel: params.providerModel,
    requestedModel: params.requestedModel,
    resolvedAlias: params.resolvedAlias,
    apiFormat: params.apiFormat,
    endpoint: params.endpoint,
    routingStrategy: params.routingStrategy,
    requiredCapabilities: params.requiredCapabilities,
    capabilityMatch: params.capabilityMatch,
    providerEvaluations: params.providerEvaluations,
    providerAttempts: params.providerAttempts,
    status: params.status,
    latencyMs: params.latencyMs,
    ...(params.usage ? { usage: params.usage } : {}),
    ...(params.deduplication ? { deduplication: params.deduplication } : {}),
    ...(params.performance ? { performance: params.performance } : {}),
    clientApplication,
    toolAnalytics,
    streaming: true,
    fallbackUsed: fallback.fallbackUsed,
    providerAttemptCount: fallback.providerAttemptCount,
    fallbackPath: fallback.fallbackPath,
    timeline,
    request: requestSnapshot(params.requestBody),
    response: "Streaming response was forwarded to the client and was not captured.",
  };
}

export async function recordRequestLog(entry: RequestLogEntry): Promise<void> {
  entry = normalizeRequestLogProviderIds(entry);
  const redis = redisClient();
  if (redis) {
    const key = analyticsKey(entry.routerKeyHash);
    await redis.lpush(key, entry);
    await redis.ltrim(key, 0, DEFAULT_ANALYTICS_LIMIT - 1);
    return;
  }

  await enqueueLocalWrite(async () => {
    const store = await loadLocalStore();
    const kept = store.requests
      .filter((request) => request.routerKeyHash === entry.routerKeyHash)
      .slice(0, DEFAULT_ANALYTICS_LIMIT - 1);
    const other = store.requests.filter(
      (request) => request.routerKeyHash !== entry.routerKeyHash,
    );
    await saveLocalStore({ requests: [entry, ...kept, ...other] });
  });
}

export async function listRequestLogs(
  routerKeyHash: string,
  limit = 100,
): Promise<RequestLogEntry[]> {
  const safeLimit = Math.min(Math.max(1, limit), MAX_ANALYTICS_LIMIT);
  const redis = redisClient();
  if (redis) {
    const entries = await redis.lrange(analyticsKey(routerKeyHash), 0, safeLimit - 1);
    return (entries as unknown as RequestLogEntry[]).map(normalizeRequestLogProviderIds);
  }

  return (await loadLocalStore()).requests
    .filter((request) => request.routerKeyHash === routerKeyHash)
    .slice(0, safeLimit)
    .map(normalizeRequestLogProviderIds);
}

export async function clearRequestLogs(routerKeyHash: string): Promise<void> {
  const redis = redisClient();
  if (redis) {
    await redis.del(analyticsKey(routerKeyHash));
    return;
  }

  await enqueueLocalWrite(async () => {
    const store = await loadLocalStore();
    await saveLocalStore({
      requests: store.requests.filter((request) => request.routerKeyHash !== routerKeyHash),
    });
  });
}

export function requestFrequency(
  requests: RequestLogEntry[],
  bucketCount = 12,
): RequestFrequencyBucket[] {
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;

  return Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = now - (bucketCount - index - 1) * hourMs;
    const bucketEnd = bucketStart + hourMs;
    const label = new Date(bucketStart).toLocaleTimeString("en-US", {
      hour: "numeric",
    });
    const count = requests.filter((request) => {
      const createdAt = Date.parse(request.createdAt);
      return createdAt >= bucketStart && createdAt < bucketEnd;
    }).length;
    return { label, count };
  });
}

export function analyticsSummary(requests: RequestLogEntry[]) {
  return summarizeRequestAnalytics(requests);
}
