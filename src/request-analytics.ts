import type { IncomingHttpHeaders } from "node:http";
import type {
  ApiClientApplication,
  ApiClientApplicationInfo,
  RequestToolAnalytics,
  StructuredOutputValidation,
  ToolCallOutcome,
  ProviderAttemptMetric,
  TokenUsage,
} from "./types.js";

const MAX_TOOL_NAMES = 20;
const MAX_TOOL_NAME_LENGTH = 80;

function headerValue(headers: IncomingHttpHeaders | Record<string, unknown> | undefined, name: string): string {
  if (!headers) return "";
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return String(raw[0] ?? "").trim();
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

function cleanVersion(value: string): string | undefined {
  const normalized = value.trim().slice(0, 40);
  return /^[A-Za-z0-9._+-]+$/.test(normalized) ? normalized : undefined;
}

function client(
  id: ApiClientApplication,
  name: string,
  detectedBy: ApiClientApplicationInfo["detectedBy"],
  extra: Partial<Pick<ApiClientApplicationInfo, "language" | "sdkVersion">> = {},
): ApiClientApplicationInfo {
  return { id, name, detectedBy, ...extra };
}

export function detectClientApplication(
  headers: IncomingHttpHeaders | Record<string, unknown> | undefined,
): ApiClientApplicationInfo {
  const userAgent = headerValue(headers, "user-agent").toLowerCase();
  const stainlessLang = headerValue(headers, "x-stainless-lang").toLowerCase();
  const stainlessVersion = cleanVersion(
    headerValue(headers, "x-stainless-package-version") ||
      headerValue(headers, "x-stainless-runtime-version"),
  );
  const anthropicVersion = headerValue(headers, "anthropic-version");

  if (/\b(codex[-_/ ]?cli|openai[-_/ ]?codex|codex\/)/i.test(userAgent)) {
    return client("codex-cli", "Codex CLI", "user-agent");
  }
  if (/\b(claude[-_/ ]?code|claude[-_/ ]?cli)\b/i.test(userAgent)) {
    return client("claude-code", "Claude Code", "user-agent");
  }
  if (/\bcurl\//i.test(userAgent)) {
    return client("curl", "cURL", "user-agent");
  }
  if (/openai[-_/ ]?python/i.test(userAgent) || stainlessLang === "python") {
    return client("openai-python", "OpenAI Python SDK", stainlessLang ? "stainless" : "user-agent", {
      language: "python",
      ...(stainlessVersion ? { sdkVersion: stainlessVersion } : {}),
    });
  }
  if (
    /openai[-_/ ]?(node|javascript|typescript|js)/i.test(userAgent) ||
    ["javascript", "typescript", "js", "node"].includes(stainlessLang)
  ) {
    return client("openai-javascript", "OpenAI JavaScript SDK", stainlessLang ? "stainless" : "user-agent", {
      language: stainlessLang || "javascript",
      ...(stainlessVersion ? { sdkVersion: stainlessVersion } : {}),
    });
  }
  if (/anthropic[-_/ ]?python/i.test(userAgent)) {
    return client("anthropic-python", "Anthropic Python SDK", "user-agent", {
      language: "python",
      ...(stainlessVersion ? { sdkVersion: stainlessVersion } : {}),
    });
  }
  if (/anthropic[-_/ ]?(node|javascript|typescript|js)/i.test(userAgent)) {
    return client("anthropic-javascript", "Anthropic JavaScript SDK", "user-agent", {
      language: "javascript",
      ...(stainlessVersion ? { sdkVersion: stainlessVersion } : {}),
    });
  }
  if (anthropicVersion) {
    return client("anthropic-compatible", "Anthropic-compatible client", "anthropic-version");
  }
  return client("unknown", "Unknown client", "unknown");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanToolName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, MAX_TOOL_NAME_LENGTH);
  return normalized || undefined;
}

function uniqueToolNames(names: Array<string | undefined>): string[] {
  return [...new Set(names.filter((name): name is string => Boolean(name)))].slice(0, MAX_TOOL_NAMES);
}

function requestToolNames(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.tools)) return [];
  return uniqueToolNames(body.tools.map((tool) => {
    if (!isObject(tool)) return undefined;
    const fn = isObject(tool.function) ? tool.function : undefined;
    return cleanToolName(tool.name) ?? cleanToolName(fn?.name);
  }));
}

function responseToolNames(payload: unknown): string[] {
  if (!isObject(payload)) return [];
  const names: Array<string | undefined> = [];

  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices) {
      if (!isObject(choice) || !isObject(choice.message) || !Array.isArray(choice.message.tool_calls)) continue;
      for (const call of choice.message.tool_calls) {
        if (!isObject(call)) continue;
        const fn = isObject(call.function) ? call.function : undefined;
        names.push(cleanToolName(call.name) ?? cleanToolName(fn?.name));
      }
    }
  }

  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (!isObject(item)) continue;
      if (["function_call", "custom_tool_call", "computer_call"].includes(String(item.type))) {
        names.push(cleanToolName(item.name));
      }
    }
  }

  if (Array.isArray(payload.content)) {
    for (const item of payload.content) {
      if (!isObject(item) || item.type !== "tool_use") continue;
      names.push(cleanToolName(item.name));
    }
  }

  return names.filter((name): name is string => Boolean(name)).slice(0, 100);
}

function structuredOutputRequested(body: Record<string, unknown>): boolean {
  if (isObject(body.response_format)) {
    const type = String(body.response_format.type ?? "");
    if (["json_schema", "json_object"].includes(type)) return true;
  }
  if (isObject(body.text) && isObject(body.text.format)) {
    const type = String(body.text.format.type ?? "");
    if (["json_schema", "json_object"].includes(type)) return true;
  }
  return false;
}

function responseText(payload: unknown): string | undefined {
  if (!isObject(payload)) return undefined;
  if (typeof payload.output_text === "string") return payload.output_text;
  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices) {
      if (!isObject(choice) || !isObject(choice.message)) continue;
      const content = choice.message.content;
      if (typeof content === "string") return content;
    }
  }
  if (Array.isArray(payload.output)) {
    const parts: string[] = [];
    for (const item of payload.output) {
      if (!isObject(item) || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (isObject(content) && typeof content.text === "string") parts.push(content.text);
      }
    }
    if (parts.length) return parts.join("\n");
  }
  if (Array.isArray(payload.content)) {
    const parts = payload.content
      .filter((item): item is Record<string, unknown> => isObject(item) && item.type === "text")
      .map((item) => typeof item.text === "string" ? item.text : "")
      .filter(Boolean);
    if (parts.length) return parts.join("\n");
  }
  return undefined;
}

function validateStructuredOutput(
  requested: boolean,
  payload: unknown,
  status: number,
  streaming: boolean,
): StructuredOutputValidation {
  if (!requested) return "not-requested";
  if (status < 200 || status >= 300) return "request-failed";
  if (streaming) return "not-observed-streaming";
  const text = responseText(payload);
  if (!text) return "not-observed";
  try {
    JSON.parse(text);
    return "valid";
  } catch {
    return "invalid";
  }
}

function toolOutcome(
  requested: boolean,
  generatedCount: number,
  status: number,
  streaming: boolean,
): ToolCallOutcome {
  if (!requested) return "not-requested";
  if (status < 200 || status >= 300) return "request-failed";
  if (streaming) return "not-observed-streaming";
  return generatedCount > 0 ? "generated" : "none-generated";
}

export function analyzeToolActivity(params: {
  body: Record<string, unknown>;
  responsePayload?: unknown;
  status: number;
  streaming: boolean;
}): RequestToolAnalytics {
  const requestedToolNames = requestToolNames(params.body);
  const requestedToolCount = Array.isArray(params.body.tools)
    ? params.body.tools.length
    : 0;
  const generatedToolCalls = params.streaming
    ? []
    : responseToolNames(params.responsePayload);
  const generatedToolCallCount = generatedToolCalls.length;
  const generatedToolNames = uniqueToolNames(generatedToolCalls);
  const structuredRequested = structuredOutputRequested(params.body);

  return {
    toolRequest: requestedToolCount > 0,
    requestedToolCount,
    requestedToolNames,
    generatedToolCallCount,
    generatedToolNames,
    outcome: toolOutcome(requestedToolCount > 0, generatedToolCallCount, params.status, params.streaming),
    structuredOutputRequested: structuredRequested,
    structuredOutputValidation: validateStructuredOutput(
      structuredRequested,
      params.responsePayload,
      params.status,
      params.streaming,
    ),
  };
}

export function fallbackMetadata(
  attempts: ProviderAttemptMetric[] | undefined,
): { fallbackUsed: boolean; providerAttemptCount: number; fallbackPath: string[] } {
  const ordered = (attempts ?? []).map((attempt) => attempt.providerId).filter(Boolean);
  return {
    fallbackUsed: ordered.length > 1,
    providerAttemptCount: ordered.length,
    fallbackPath: ordered,
  };
}

export interface RequestAnalyticsSummary {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalTokens: number;
  reportedTokens: number;
  estimatedTokens: number;
  fallbackRequests: number;
  fallbackRate: number;
  averageProviderAttempts: number;
  toolEnabledRequests: number;
  generatedToolCalls: number;
  topClient?: ApiClientApplicationInfo;
  mostReliableProvider?: { providerId: string; attempts: number; successes: number; successRate: number };
  fallbackPaths: Array<{ path: string[]; count: number }>;
  clients: Array<{ client: ApiClientApplicationInfo; count: number }>;
  providers: Array<{ providerId: string; attempts: number; successes: number; failures: number; successRate: number }>;
  apiFormats: Array<{ apiFormat: string; count: number }>;
}

interface AnalyticsLikeRequest {
  status: number;
  providerId: string;
  apiFormat?: string | undefined;
  usage?: TokenUsage | undefined;
  deduplication?: { deduplicated?: boolean | undefined } | undefined;
  fallbackUsed?: boolean | undefined;
  providerAttemptCount?: number | undefined;
  fallbackPath?: string[] | undefined;
  providerAttempts?: ProviderAttemptMetric[] | undefined;
  toolAnalytics?: RequestToolAnalytics | undefined;
  clientApplication?: ApiClientApplicationInfo | undefined;
}

export function summarizeRequestAnalytics(
  requests: AnalyticsLikeRequest[],
): RequestAnalyticsSummary {
  const successfulRequests = requests.filter((request) => request.status >= 200 && request.status < 300).length;
  const upstreamRequests = requests.filter((request) => request.deduplication?.deduplicated !== true);
  const totalTokens = upstreamRequests.reduce((sum, request) => sum + (request.usage?.totalTokens ?? 0), 0);
  const reportedTokens = upstreamRequests.reduce(
    (sum, request) => sum + (request.usage?.source === "reported" ? request.usage.totalTokens : 0),
    0,
  );
  const estimatedTokens = upstreamRequests.reduce(
    (sum, request) => sum + (request.usage?.source === "estimated" ? request.usage.totalTokens : 0),
    0,
  );

  const fallbackRequests = upstreamRequests.filter((request) => {
    if (typeof request.fallbackUsed === "boolean") return request.fallbackUsed;
    return (request.providerAttempts?.length ?? 0) > 1;
  }).length;
  const totalAttempts = upstreamRequests.reduce((sum, request) => {
    if (typeof request.providerAttemptCount === "number") return sum + request.providerAttemptCount;
    return sum + (request.providerAttempts?.length ?? (request.providerId ? 1 : 0));
  }, 0);

  const clients = new Map<string, { client: ApiClientApplicationInfo; count: number }>();
  for (const request of requests) {
    const app = request.clientApplication ?? client("unknown", "Unknown client", "unknown");
    const current = clients.get(app.id) ?? { client: app, count: 0 };
    current.count += 1;
    clients.set(app.id, current);
  }

  const paths = new Map<string, { path: string[]; count: number }>();
  for (const request of upstreamRequests) {
    const path = request.fallbackPath?.length
      ? request.fallbackPath
      : request.providerAttempts?.map((attempt) => attempt.providerId) ?? [];
    if (path.length <= 1) continue;
    const key = path.join("\u0000");
    const current = paths.get(key) ?? { path, count: 0 };
    current.count += 1;
    paths.set(key, current);
  }

  const providerStats = new Map<string, { providerId: string; attempts: number; successes: number; failures: number }>();
  for (const request of upstreamRequests) {
    const attempts = request.providerAttempts?.length
      ? request.providerAttempts
      : [{ providerId: request.providerId, success: request.status >= 200 && request.status < 300, latencyMs: 0 }];
    for (const attempt of attempts) {
      const current = providerStats.get(attempt.providerId) ?? {
        providerId: attempt.providerId,
        attempts: 0,
        successes: 0,
        failures: 0,
      };
      current.attempts += 1;
      if (attempt.success) current.successes += 1;
      else current.failures += 1;
      providerStats.set(attempt.providerId, current);
    }
  }

  const providers = [...providerStats.values()]
    .map((provider) => ({
      ...provider,
      successRate: provider.attempts ? provider.successes / provider.attempts : 0,
    }))
    .sort((left, right) => right.successRate - left.successRate || right.attempts - left.attempts);

  const apiCounts = new Map<string, number>();
  for (const request of requests) {
    const key = request.apiFormat ?? "unknown";
    apiCounts.set(key, (apiCounts.get(key) ?? 0) + 1);
  }

  const clientList = [...clients.values()].sort((left, right) => right.count - left.count);
  return {
    totalRequests: requests.length,
    successfulRequests,
    failedRequests: requests.length - successfulRequests,
    totalTokens,
    reportedTokens,
    estimatedTokens,
    fallbackRequests,
    fallbackRate: upstreamRequests.length ? fallbackRequests / upstreamRequests.length : 0,
    averageProviderAttempts: upstreamRequests.length ? totalAttempts / upstreamRequests.length : 0,
    toolEnabledRequests: requests.filter((request) => request.toolAnalytics?.toolRequest === true).length,
    generatedToolCalls: requests.reduce((sum, request) => sum + (request.toolAnalytics?.generatedToolCallCount ?? 0), 0),
    ...(clientList[0] ? { topClient: clientList[0].client } : {}),
    ...(providers[0] ? {
      mostReliableProvider: {
        providerId: providers[0].providerId,
        attempts: providers[0].attempts,
        successes: providers[0].successes,
        successRate: providers[0].successRate,
      },
    } : {}),
    fallbackPaths: [...paths.values()].sort((left, right) => right.count - left.count),
    clients: clientList,
    providers,
    apiFormats: [...apiCounts.entries()]
      .map(([apiFormat, count]) => ({ apiFormat, count }))
      .sort((left, right) => right.count - left.count),
  };
}
