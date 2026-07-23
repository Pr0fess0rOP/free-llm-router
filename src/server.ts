import "dotenv/config";
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import {
  createAccount,
  deleteProviderKey,
  deleteProviderQuota,
  findAccount,
  findAccountForUser,
  getAccountForUser,
  getProviderKeys,
  hashRouterKey,
  setProviderKey,
  setProviderQuota,
  setProviderModelCatalog,
  updateProviderModelCapabilitiesByHash,
  updateProviderModelHealthByHash,
  updateAccountSettings,
} from "./accounts.js";
import { clerkPublishableKey, sessionUserId } from "./auth.js";
import { loadProviderConfigs, loadProviders } from "./config.js";
import { readPublicFile } from "./dashboard.js";
import { PROVIDER_CATALOG } from "./provider-catalog.js";
import {
  clearRequestLogs,
  createRequestLog,
  createStreamingRequestLog,
  listRequestLogs,
  recordRequestLog,
  requestFrequency,
  analyticsSummary,
  type ApiFormat,
} from "./analytics.js";
import {
  AllProvidersCoolingDownError,
  AllProvidersFailedError,
  AllProvidersQuotaExhaustedError,
  AllProvidersUnavailableError,
  NoCompatibleProvidersError,
  ProviderRouter,
} from "./router.js";
import {
  claimProviderHalfOpenProbe,
  clearProviderCooldown,
  clearProviderUsage,
  getRoutingStats,
  nextRoundRobinCursor,
  prepareProviderCircuitRetry,
  recordProviderTokenUsage,
  recordRoutingAttempt,
  resetProviderCircuit,
} from "./routing-state.js";
import type {
  CapabilityMatch,
  CapabilityRequirements,
  CapabilityRoutingSettings,
  ModelCapabilityState,
  ProviderCapabilityName,
  ModelAlias,
  ProviderCandidateEvaluation,
  ProviderAttemptMetric,
  ProviderRuntime,
  ReliabilitySettings,
  RoutingPolicy,
  TokenUsage,
  RoutingStrategy,
  DeduplicationMetadata,
  DeduplicationSettings,
  RoutingHeaders,
  RequestPerformanceTiming,
  ProviderModelCatalog,
} from "./types.js";
import {
  detectCapabilityRequirements,
  matchProviderCapabilities,
  normalizeCapabilityRoutingSettings,
  resolveEffectiveModelCapabilities,
  resolveProviderCapabilities,
} from "./provider-capabilities.js";
import {
  effectiveAliasPolicy,
  mergeAliasRequirements,
  normalizeModelAliases,
  parseModelAliases,
  resolveModelAlias,
} from "./model-aliases.js";
import {
  approximateInputTokens,
  extractTokenUsage,
  normalizeProviderQuotaConfig,
  providerQuotaStatus,
} from "./provider-quotas.js";
import {
  normalizeProviderModelCatalogMap,
  parseProviderModelCatalog,
  statusFromAttempt,
  statusFromHttpStatus,
} from "./provider-models.js";
import {
  effectiveReliabilitySettings,
  parseReliabilitySettings,
} from "./reliability-settings.js";
import {
  createRequestFingerprint,
  deduplicationBypassReason,
  executeDeduplicated,
  parseDeduplicationSettings,
  type CapturedHttpResponse,
} from "./deduplication.js";
import {
  anthropicError,
  anthropicToOpenAI,
  approximateAnthropicInputTokens,
  openAIToAnthropic,
  streamOpenAIAsAnthropic,
} from "./anthropic.js";
import {
  addRequestIdToErrorPayload,
  requestCorrelation,
  setRequestCorrelationHeaders,
  type RequestCorrelation,
} from "./request-ids.js";
import {
  buildRequestPerformanceTiming,
  finalizeSuccessfulAttempt,
} from "./performance-timing.js";
import {
  approximateResponsesInputTokens,
  openAIToResponses,
  responsesError,
  responsesToOpenAI,
  streamOpenAIAsResponses,
} from "./responses.js";
import { normalizeProviderId } from "./provider-identities.js";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const requestIdHeader = response.getHeader("x-free-llm-request-id");
  const requestId = Array.isArray(requestIdHeader)
    ? String(requestIdHeader[0] ?? "")
    : requestIdHeader !== undefined
      ? String(requestIdHeader)
      : undefined;
  const payload = status >= 400
    ? addRequestIdToErrorPayload(body, requestId)
    : body;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function clientId(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return firstForwarded?.split(",")[0]?.trim() || request.socket.remoteAddress || "unknown";
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const providedBody = (request as IncomingMessage & { body?: unknown }).body;
  if (providedBody !== undefined && providedBody !== null) {
    const parsed =
      typeof providedBody === "string" || Buffer.isBuffer(providedBody)
        ? (JSON.parse(String(providedBody)) as unknown)
        : providedBody;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON body must be an object");
    }
    return parsed as Record<string, unknown>;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }

  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("JSON body must be an object");
  }
  return body as Record<string, unknown>;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
}

function routerToken(request: IncomingMessage): string | undefined {
  const apiKey = request.headers["x-api-key"];
  const firstApiKey = Array.isArray(apiKey) ? apiKey[0] : apiKey;
  return bearerToken(request) ?? firstApiKey;
}


type RoutedCompletionResult = Awaited<ReturnType<ProviderRouter["chatCompletion"]>>;

interface RoutedFailureAnalyticsContext {
  routerKeyHash: string;
  correlation: RequestCorrelation;
  providers: ProviderRuntime[];
  requestedModel: string;
  alias: ModelAlias | undefined;
  policy: RoutingPolicy;
  apiFormat: ApiFormat;
  endpoint: string;
  capabilityRequirements: CapabilityRequirements;
  requestBody: Record<string, unknown>;
  requestHeaders: IncomingMessage["headers"];
  startedAt: number;
}

function routedFailureStatus(error: unknown): number {
  if (error instanceof AllProvidersCoolingDownError) return 429;
  if (error instanceof AllProvidersQuotaExhaustedError) return 429;
  if (error instanceof AllProvidersUnavailableError) return 503;
  if (error instanceof AllProvidersFailedError) return 503;
  if (error instanceof NoCompatibleProvidersError) return 400;
  return 500;
}

function routedFailureProviderId(
  error: unknown,
  providers: ProviderRuntime[],
): string {
  if (error instanceof AllProvidersFailedError) {
    return error.attempts.at(-1)?.provider ?? providers[0]?.id ?? "router";
  }
  if (error instanceof AllProvidersCoolingDownError) {
    return error.providers[0]?.providerId ?? providers[0]?.id ?? "router";
  }
  if (error instanceof AllProvidersQuotaExhaustedError) {
    return error.providers[0]?.providerId ?? providers[0]?.id ?? "router";
  }
  if (error instanceof AllProvidersUnavailableError) {
    return error.providers[0]?.providerId ?? providers[0]?.id ?? "router";
  }
  if (error instanceof NoCompatibleProvidersError) {
    return error.providers[0]?.providerId ?? providers[0]?.id ?? "router";
  }
  return providers[0]?.id ?? "router";
}

function routedFailureResponse(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AllProvidersFailedError) {
    return {
      error: {
        message,
        type: "providers_exhausted",
        attempts: error.attempts,
        providerAttempts: error.providerAttempts,
        retryStopReason: error.retryStopReason,
      },
    };
  }
  if (error instanceof AllProvidersCoolingDownError) {
    return {
      error: {
        message,
        type: "providers_cooling_down",
        providers: error.providers,
        retryAt: new Date(error.retryAt).toISOString(),
      },
    };
  }
  if (error instanceof AllProvidersQuotaExhaustedError) {
    return {
      error: {
        message,
        type: "providers_quota_exhausted",
        providers: error.providers,
        retryAt: new Date(error.retryAt).toISOString(),
      },
    };
  }
  if (error instanceof AllProvidersUnavailableError) {
    return {
      error: {
        message,
        type: "providers_unavailable",
        providers: error.providers,
        retryAt: new Date(error.retryAt).toISOString(),
      },
    };
  }
  if (error instanceof NoCompatibleProvidersError) {
    return {
      error: {
        message,
        type: "no_compatible_provider",
        requiredCapabilities: error.requirements.required,
        providers: error.providers,
      },
    };
  }
  return { error: { message, type: "routing_error" } };
}

function routedFailureEvaluations(
  error: unknown,
  providers: ProviderRuntime[],
  requirements: CapabilityRequirements,
): ProviderCandidateEvaluation[] | undefined {
  if (error instanceof AllProvidersFailedError) {
    return error.providerEvaluations;
  }
  if (error instanceof NoCompatibleProvidersError) {
    return error.providers.map((provider) => ({
      providerId: provider.providerId,
      match: provider.match,
      state: "incompatible",
    }));
  }
  if (error instanceof AllProvidersCoolingDownError) {
    const unavailable = new Map(
      error.providers.map((provider) => [provider.providerId, provider]),
    );
    return providers.map((provider) => {
      const state = unavailable.get(provider.id);
      return {
        providerId: provider.id,
        match: matchProviderCapabilities(provider.capabilities, requirements),
        state: "cooldown",
        cooldownUntil: state?.cooldownUntil ?? provider.cooldownUntil,
        cooldownReason: "rate_limit",
      };
    });
  }
  if (error instanceof AllProvidersQuotaExhaustedError) {
    const exhausted = new Map(
      error.providers.map((provider) => [provider.providerId, provider]),
    );
    return providers.map((provider) => {
      const quota = exhausted.get(provider.id);
      return {
        providerId: provider.id,
        match: matchProviderCapabilities(provider.capabilities, requirements),
        state: "quota-exhausted",
        quotaExhausted: true,
        quotaConsumedPercent: quota?.consumedPercent ?? 100,
        quotaRemainingRatio: 0,
        quotaResetAt: quota?.resetAt ?? error.retryAt,
        quotaExhaustedLimits: quota?.exhaustedLimits ?? [],
      };
    });
  }
  if (error instanceof AllProvidersUnavailableError) {
    const unavailable = new Map(
      error.providers.map((provider) => [provider.providerId, provider]),
    );
    return providers.map((provider) => {
      const state = unavailable.get(provider.id);
      const evaluationState = state?.state === "cooldown"
        ? "cooldown"
        : state?.state === "half-open"
          ? "half-open"
          : "circuit-open";
      return {
        providerId: provider.id,
        match: matchProviderCapabilities(provider.capabilities, requirements),
        state: evaluationState,
        ...(state?.state === "cooldown"
          ? {
              cooldownUntil: state.retryAt,
              cooldownReason: "rate_limit" as const,
            }
          : {
              circuitState: state?.state === "half-open" ? "half-open" as const : "open" as const,
              circuitOpenUntil: state?.retryAt ?? provider.circuitOpenUntil,
              ...(state?.failureType ? { lastFailureType: state.failureType } : {}),
            }),
      };
    });
  }
  return undefined;
}

function routedFailureAttempts(error: unknown) {
  if (error instanceof AllProvidersFailedError) return error.providerAttempts;
  if (error instanceof AllProvidersCoolingDownError) return error.providerAttempts;
  if (error instanceof AllProvidersUnavailableError) return error.providerAttempts;
  return undefined;
}

async function recordRoutedFailure(
  context: RoutedFailureAnalyticsContext,
  error: unknown,
): Promise<void> {
  const providerId = routedFailureProviderId(error, context.providers);
  const provider = context.providers.find((candidate) => candidate.id === providerId);
  const evaluations = routedFailureEvaluations(
    error,
    context.providers,
    context.capabilityRequirements,
  );
  const selectedEvaluation = evaluations?.find(
    (evaluation) => evaluation.providerId === providerId,
  );
  const providerAttempts = routedFailureAttempts(error);
  const completedAt = Date.now();
  const performance = buildRequestPerformanceTiming({
    startedAt: context.startedAt,
    completedAt,
    attempts: providerAttempts ?? [],
    providerId,
  });
  const headerCapture = new CapturingServerResponse();
  setFailureRoutingHeaders(
    headerCapture as unknown as ServerResponse,
    error,
    context.correlation,
  );
  headerCapture.setHeader("x-free-llm-requested-model", context.requestedModel);
  headerCapture.setHeader("x-free-llm-model-alias", context.alias?.id ?? "none");
  headerCapture.setHeader("x-free-llm-routing-policy", context.policy.strategy);
  headerCapture.setHeader("x-free-llm-routing-strategy", context.policy.strategy);
  headerCapture.setHeader("x-free-llm-api-format", context.apiFormat);
  const responsePayload = addRequestIdToErrorPayload(
    routedFailureResponse(error),
    context.correlation.requestId,
  );

  await recordRequestLog(
    createRequestLog({
      routerKeyHash: context.routerKeyHash,
      requestId: context.correlation.requestId,
      ...(context.correlation.clientRequestId
        ? { clientRequestId: context.correlation.clientRequestId }
        : {}),
      requestIdSource: context.correlation.source,
      routingHeaders: routingHeadersFromResponse(
        headerCapture as unknown as ServerResponse,
      ),
      providerId,
      providerModel: provider?.model,
      requestedModel: context.requestedModel,
      resolvedAlias: context.alias?.id,
      apiFormat: context.apiFormat,
      endpoint: context.endpoint,
      routingStrategy: context.policy.strategy,
      requiredCapabilities: context.capabilityRequirements.required,
      ...(selectedEvaluation ? { capabilityMatch: selectedEvaluation.match.level } : {}),
      ...(evaluations ? { providerEvaluations: evaluations } : {}),
      ...(providerAttempts?.length ? { providerAttempts } : {}),
      status: routedFailureStatus(error),
      latencyMs: completedAt - context.startedAt,
      startedAt: context.startedAt,
      completedAt,
      performance,
      requestHeaders: context.requestHeaders,
      requestBody: context.requestBody,
      responseText: JSON.stringify(responsePayload),
      responseContentType: "application/json",
    }),
  );
}

async function routedChatCompletion(params: {
  router: ProviderRouter;
  upstreamBody: Record<string, unknown>;
  requestSignal: AbortSignal;
  context: RoutedFailureAnalyticsContext;
}): Promise<RoutedCompletionResult> {
  try {
    return await params.router.chatCompletion(
      params.upstreamBody,
      params.requestSignal,
      params.context.capabilityRequirements,
    );
  } catch (error) {
    try {
      await recordRoutedFailure(params.context, error);
    } catch (analyticsError) {
      console.warn("Failed to record routed request failure:", analyticsError);
    }
    throw error;
  }
}

async function captureProviderUsage(params: {
  routerKeyHash: string;
  providerId: string;
  payload: unknown;
  fallbackInputTokens?: number;
}): Promise<TokenUsage | undefined> {
  const usage = extractTokenUsage(params.payload, params.fallbackInputTokens);
  if (usage) {
    await recordProviderTokenUsage(
      params.routerKeyHash,
      params.providerId,
      usage,
    );
  }
  return usage;
}

async function providerResponse(routerKey: string): Promise<{
  account: Awaited<ReturnType<typeof findAccount>>;
  providers: Array<Record<string, unknown>>;
} | undefined> {
  const account = await findAccount(routerKey);
  if (!account) return undefined;
  const configs = await loadProviderConfigs();
  const providerModels = normalizeProviderModelCatalogMap(account.providerModels, configs);
  const routingStats = await getRoutingStats(hashRouterKey(routerKey));
  return {
    account: { ...account, providerModels },
    providers: configs.map((provider) => {
      const modelCatalog = providerModels[provider.id]!;
      const decoratedModels = modelCatalog.models.map((model) => {
        const effective = resolveEffectiveModelCapabilities(provider, model);
        return {
          ...model,
          effectiveCapabilities: effective.capabilities,
          capabilitySources: effective.sources,
        };
      });
      const activeModel = decoratedModels.find((model) => model.id === modelCatalog.activeModelId)!;
      return ({
      id: provider.id,
      model: modelCatalog.activeModelId,
      modelCatalog: { ...modelCatalog, models: decoratedModels },
      baseUrl: provider.baseUrl,
      configured: account.configuredProviderIds.includes(provider.id),
      routingStats: routingStats[provider.id] ?? null,
      quota: providerQuotaStatus(
        account.providerQuotas[provider.id],
        routingStats[provider.id]?.quotaUsage,
      ) ?? null,
      capabilities: activeModel.effectiveCapabilities,
      capabilitySources: activeModel.capabilitySources,
      providerCapabilities: resolveProviderCapabilities(provider),
      ...(PROVIDER_CATALOG[provider.id] ?? {
        name: provider.id,
        website: provider.baseUrl,
        description: "OpenAI-compatible provider.",
        freeTier: "See provider website",
        category: "Inference platform",
      }),
    });
    }),
  };
}

async function providerModelTestMessage(response: Response): Promise<string> {
  const fallback = `${response.status} ${response.statusText}`.trim();
  try {
    const payload = await response.clone().json() as {
      error?: string | { message?: string };
      message?: string;
    };
    if (typeof payload.error === "string") return payload.error;
    return payload.error?.message ?? payload.message ?? fallback;
  } catch {
    return fallback;
  }
}

async function testProviderModel(params: {
  routerKey: string;
  providerId: string;
  modelId: string;
}): Promise<{
  ok: boolean;
  status: number;
  message: string;
  catalog: ProviderModelCatalog;
}> {
  params.providerId = normalizeProviderId(params.providerId);
  const configs = await loadProviderConfigs();
  const provider = configs.find((candidate) => candidate.id === params.providerId);
  if (!provider) throw new Error("Unknown provider");
  const providerKeys = await getProviderKeys(params.routerKey);
  const apiKey = providerKeys?.[params.providerId];
  if (!apiKey) throw new Error("Provider key is not configured");
  const account = await findAccount(params.routerKey);
  if (!account) throw new Error("Invalid router key");
  const catalogs = normalizeProviderModelCatalogMap(account.providerModels, configs);
  const catalog = catalogs[params.providerId];
  if (!catalog?.models.some((model) => model.id === params.modelId)) {
    throw new Error("Save the model before testing it");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Model test timed out")), 15_000);
  let status = 502;
  let message = "Model test failed";
  try {
    const upstream = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        ...provider.headers,
      },
      body: JSON.stringify({
        model: params.modelId,
        stream: false,
        max_tokens: 2,
        messages: [{ role: "user", content: "Reply with OK" }],
      }),
      signal: controller.signal,
    });
    status = upstream.status;
    message = upstream.ok ? "Model responded successfully" : await providerModelTestMessage(upstream);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
  }
  await updateProviderModelHealthByHash(hashRouterKey(params.routerKey), params.providerId, params.modelId, {
    status: statusFromHttpStatus(status),
    lastStatus: status,
    ...(status >= 200 && status < 300 ? {} : { lastError: message }),
  });
  const refreshed = await findAccount(params.routerKey);
  const refreshedCatalog = normalizeProviderModelCatalogMap(refreshed?.providerModels, configs)[params.providerId]!;
  return { ok: status >= 200 && status < 300, status, message, catalog: refreshedCatalog };
}

const CAPABILITY_PROBE_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

function capabilityProbeRequest(
  capability: ProviderCapabilityName,
  modelId: string,
): { path: string; body: Record<string, unknown> } {
  const base = {
    model: modelId,
    stream: false,
    max_tokens: 12,
    messages: [{ role: "user", content: "Reply with OK." }],
  };
  switch (capability) {
    case "streaming":
      return { path: "/chat/completions", body: { ...base, stream: true } };
    case "tools":
      return {
        path: "/chat/completions",
        body: {
          ...base,
          messages: [{ role: "user", content: "Call the capability_probe function now." }],
          tools: [{
            type: "function",
            function: {
              name: "capability_probe",
              description: "A harmless capability test.",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
          }],
          tool_choice: "required",
        },
      };
    case "jsonMode":
      return {
        path: "/chat/completions",
        body: {
          ...base,
          messages: [{ role: "user", content: "Return JSON with ok=true." }],
          response_format: { type: "json_object" },
        },
      };
    case "structuredOutputs":
      return {
        path: "/chat/completions",
        body: {
          ...base,
          messages: [{ role: "user", content: "Return the requested object." }],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "capability_probe",
              strict: true,
              schema: {
                type: "object",
                properties: { ok: { type: "boolean" } },
                required: ["ok"],
                additionalProperties: false,
              },
            },
          },
        },
      };
    case "vision":
      return {
        path: "/chat/completions",
        body: {
          ...base,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "Reply with OK." },
              { type: "image_url", image_url: { url: CAPABILITY_PROBE_IMAGE } },
            ],
          }],
        },
      };
    case "reasoning":
      return {
        path: "/chat/completions",
        body: { ...base, reasoning_effort: "low" },
      };
    case "embeddings":
      return {
        path: "/embeddings",
        body: { model: modelId, input: "capability probe" },
      };
  }
}


async function inspectSuccessfulCapabilityProbe(
  capability: ProviderCapabilityName,
  response: Response,
): Promise<{ value: "supported" | "unknown"; message: string }> {
  if (capability === "streaming") {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      return {
        value: "unknown",
        message: "Streaming request was accepted, but the response was not an event stream",
      };
    }
    const reader = response.body.getReader();
    try {
      const chunk = await reader.read();
      const text = chunk.value ? new TextDecoder().decode(chunk.value) : "";
      return !chunk.done && text.trim()
        ? { value: "supported", message: "Streaming probe returned an event-stream chunk" }
        : { value: "unknown", message: "Streaming request was accepted, but no stream chunk was observed" };
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  if (["tools", "jsonMode", "structuredOutputs", "embeddings"].includes(capability)) {
    let payload: any;
    try {
      payload = await response.clone().json();
    } catch {
      return {
        value: "unknown",
        message: `${capability} request was accepted, but the response was not valid JSON`,
      };
    }

    if (capability === "embeddings") {
      return Array.isArray(payload?.data) && payload.data.length > 0
        ? { value: "supported", message: "Embeddings probe returned embedding data" }
        : { value: "unknown", message: "Embeddings request was accepted, but no embedding data was returned" };
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (capability === "tools") {
      const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
      return Array.isArray(toolCalls) && toolCalls.length > 0
        ? { value: "supported", message: "Tool probe returned a valid tool call" }
        : { value: "unknown", message: "Tool request was accepted, but the model did not return a tool call" };
    }

    let parsed: unknown;
    try {
      parsed = typeof content === "string" ? JSON.parse(content) : content;
    } catch {
      return {
        value: "unknown",
        message: `${capability} request was accepted, but the model did not return valid JSON`,
      };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        value: "unknown",
        message: `${capability} request was accepted, but the model did not return a JSON object`,
      };
    }
    if (capability === "structuredOutputs" && typeof (parsed as { ok?: unknown }).ok !== "boolean") {
      return {
        value: "unknown",
        message: "Structured-output request was accepted, but the response did not match the probe schema",
      };
    }
    return {
      value: "supported",
      message: capability === "structuredOutputs"
        ? "Structured-output probe returned a schema-valid object"
        : "JSON-mode probe returned valid JSON",
    };
  }

  if (response.body) await response.body.cancel().catch(() => undefined);
  return { value: "supported", message: `${capability} probe succeeded` };
}

export async function detectProviderModelCapabilities(params: {
  routerKey: string;
  providerId: string;
  modelId: string;
}): Promise<{
  catalog: ProviderModelCatalog;
  results: Partial<Record<ProviderCapabilityName, ModelCapabilityState>>;
}> {
  params.providerId = normalizeProviderId(params.providerId);
  const configs = await loadProviderConfigs();
  const provider = configs.find((candidate) => candidate.id === params.providerId);
  if (!provider) throw new Error("Unknown provider");
  const providerKeys = await getProviderKeys(params.routerKey);
  const apiKey = providerKeys?.[params.providerId];
  if (!apiKey) throw new Error("Provider key is not configured");
  const account = await findAccount(params.routerKey);
  if (!account) throw new Error("Invalid router key");
  const catalogs = normalizeProviderModelCatalogMap(account.providerModels, configs);
  const catalog = catalogs[params.providerId];
  if (!catalog?.models.some((model) => model.id === params.modelId)) {
    throw new Error("Save the model before detecting capabilities");
  }

  const results: Partial<Record<ProviderCapabilityName, ModelCapabilityState>> = {};
  for (const capability of [
    "streaming",
    "tools",
    "jsonMode",
    "structuredOutputs",
    "vision",
    "reasoning",
    "embeddings",
  ] as ProviderCapabilityName[]) {
    const request = capabilityProbeRequest(capability, params.modelId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Capability probe timed out")), 12_000);
    let status: number | undefined;
    let message = "Capability probe did not complete";
    try {
      const upstream = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}${request.path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: capability === "streaming"
            ? "application/json, text/event-stream"
            : "application/json",
          authorization: `Bearer ${apiKey}`,
          ...provider.headers,
        },
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
      status = upstream.status;
      if (upstream.ok) {
        const inspected = await inspectSuccessfulCapabilityProbe(capability, upstream);
        message = inspected.message;
        results[capability] = {
          value: inspected.value,
          source: "probe",
          lastVerifiedAt: new Date().toISOString(),
          evidence: {
            status,
            message,
            observedAt: new Date().toISOString(),
          },
        };
      } else {
        message = await providerModelTestMessage(upstream);
        if (upstream.body) await upstream.body.cancel().catch(() => undefined);
      }
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timeout);
    }

    if (!results[capability]) {
      const value = status !== undefined && [400, 404, 405, 415, 422].includes(status)
        ? "unsupported"
        : "unknown";
      const observedAt = new Date().toISOString();
      results[capability] = {
        value,
        source: "probe",
        lastVerifiedAt: observedAt,
        evidence: {
          ...(status !== undefined ? { status } : {}),
          message,
          observedAt,
        },
      };
    }
  }

  await updateProviderModelCapabilitiesByHash(
    hashRouterKey(params.routerKey),
    params.providerId,
    params.modelId,
    results,
  );
  const refreshed = await findAccount(params.routerKey);
  const refreshedCatalog = normalizeProviderModelCatalogMap(
    refreshed?.providerModels,
    configs,
  )[params.providerId]!;
  return { catalog: refreshedCatalog, results };
}

async function createRoutedProviderRouter(params: {
  routerKey: string;
  routerKeyHash: string;
  providerKeys: Record<string, string>;
  requestedModel: string;
  requestId: string;
  requestStartedAt: number;
}): Promise<{
  providers: Awaited<ReturnType<typeof loadProviders>>;
  router: ProviderRouter;
  policy: RoutingPolicy;
  reliability: ReliabilitySettings;
  alias?: ModelAlias;
}> {
  const account = await findAccount(params.routerKey);
  const accountPolicy = account?.routingPolicy ?? {
    strategy: "priority",
    providerOrder: [],
  };
  const aliases = normalizeModelAliases(account?.modelAliases);
  const alias = resolveModelAlias(aliases, params.requestedModel);
  const policy = effectiveAliasPolicy(accountPolicy, alias);
  const reliability = effectiveReliabilitySettings(
    account?.reliabilitySettings,
    alias,
  );
  const providerModels = normalizeProviderModelCatalogMap(account?.providerModels, await loadProviderConfigs());
  const activeModels = Object.fromEntries(
    Object.entries(providerModels).map(([providerId, catalog]) => [providerId, catalog.activeModelId]),
  );
  const activeModelOptions = Object.fromEntries(
    Object.entries(providerModels).map(([providerId, catalog]) => [
      providerId,
      catalog.models.find((model) => model.id === catalog.activeModelId)!,
    ]),
  );
  let providers = await loadProviders(
    undefined,
    params.providerKeys,
    activeModels,
    activeModelOptions,
  );

  if (alias?.eligibleProviderIds.length) {
    const eligible = new Set(alias.eligibleProviderIds);
    providers = providers.filter((provider) => eligible.has(provider.id));
  }

  const stats = await getRoutingStats(params.routerKeyHash);
  providers = providers.map((provider) => ({
    ...provider,
    cooldownUntil: Math.max(
      provider.cooldownUntil ?? 0,
      stats[provider.id]?.cooldownUntil ?? 0,
    ),
    failures: stats[provider.id]?.rateLimitCount ?? provider.failures ?? 0,
    circuitState: stats[provider.id]?.circuitState ?? provider.circuitState ?? "closed",
    circuitOpenUntil: Math.max(
      provider.circuitOpenUntil ?? 0,
      stats[provider.id]?.circuitOpenUntil ?? 0,
    ),
    circuitFailureCount:
      stats[provider.id]?.circuitFailureCount ?? provider.circuitFailureCount ?? 0,
    circuitOpenCount:
      stats[provider.id]?.circuitOpenCount ?? provider.circuitOpenCount ?? 0,
    halfOpenProbeActive:
      stats[provider.id]?.halfOpenProbeActive ?? provider.halfOpenProbeActive ?? false,
    ...(account?.providerQuotas[provider.id]
      ? { quotaConfig: account.providerQuotas[provider.id] }
      : {}),
    ...(stats[provider.id]?.quotaUsage
      ? { quotaUsage: stats[provider.id]!.quotaUsage }
      : {}),
  }));

  const roundRobinScope = alias?.id
    ? `${params.routerKeyHash}:${alias.id}`
    : params.routerKeyHash;
  const roundRobinCursor = policy.strategy === "round-robin"
    ? await nextRoundRobinCursor(roundRobinScope, providers.length)
    : 0;

  return {
    providers,
    policy,
    reliability,
    ...(alias ? { alias } : {}),
    router: new ProviderRouter(providers, fetch, {
      policy,
      stats,
      roundRobinCursor,
      reliability,
      requestId: params.requestId,
      requestStartedAt: params.requestStartedAt,
      capabilityUnknownMode: account?.capabilityRoutingSettings?.unknownMode ?? "flexible",
      onAttempt: async (attempt) => {
        const capabilityUpdates: Partial<Record<ProviderCapabilityName, ModelCapabilityState>> = {};
        const observedAt = new Date().toISOString();
        for (const capability of attempt.observedSupportedCapabilities ?? []) {
          capabilityUpdates[capability] = {
            value: "supported",
            source: "runtime",
            lastVerifiedAt: observedAt,
            evidence: {
              ...(attempt.status !== undefined ? { status: attempt.status } : {}),
              requestId: params.requestId,
              observedAt,
            },
          };
        }
        for (const capability of attempt.observedUnsupportedCapabilities ?? []) {
          capabilityUpdates[capability] = {
            value: "unsupported",
            source: "runtime",
            lastVerifiedAt: observedAt,
            evidence: {
              ...(attempt.status !== undefined ? { status: attempt.status } : {}),
              ...(attempt.message ? { message: attempt.message } : {}),
              requestId: params.requestId,
              observedAt,
            },
          };
        }
        await recordRoutingAttempt(params.routerKeyHash, attempt);
        if (attempt.providerModel) {
          await updateProviderModelHealthByHash(
            params.routerKeyHash,
            attempt.providerId,
            attempt.providerModel,
            {
              status: statusFromAttempt(attempt),
              ...(attempt.status !== undefined ? { lastStatus: attempt.status } : {}),
              ...(!attempt.success && attempt.message ? { lastError: attempt.message } : {}),
            },
          );
          if (Object.keys(capabilityUpdates).length) {
            await updateProviderModelCapabilitiesByHash(
              params.routerKeyHash,
              attempt.providerId,
              attempt.providerModel,
              capabilityUpdates,
            );
          }
        }
      },
      claimHalfOpenProbe: (providerId) =>
        claimProviderHalfOpenProbe(params.routerKeyHash, providerId),
    }),
  };
}

function setAliasHeaders(
  response: ServerResponse,
  requestedModel: string,
  alias: ModelAlias | undefined,
  providerModel?: string,
): void {
  response.setHeader("x-free-llm-requested-model", requestedModel);
  response.setHeader("x-free-llm-model-alias", alias?.id ?? "none");
  if (providerModel) response.setHeader("x-free-llm-provider-model", providerModel);
}



function setCapabilityHeaders(
  response: ServerResponse,
  requirements: CapabilityRequirements,
  match: CapabilityMatch,
): void {
  response.setHeader(
    "x-free-llm-required-capabilities",
    requirements.required.length > 0 ? requirements.required.join(",") : "none",
  );
  response.setHeader("x-free-llm-capability-match", match.level);
}

function headerString(value: number | string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.map(String).join(",") : String(value);
}

function routingHeadersFromResponse(response: ServerResponse): RoutingHeaders {
  return Object.fromEntries(
    Object.entries(response.getHeaders())
      .filter(([name, value]) =>
        value !== undefined &&
        (name.startsWith("x-free-llm-") || name === "retry-after")
      )
      .map(([name, value]) => [name, headerString(value as number | string | string[]) ?? ""]),
  );
}


interface StreamObservation {
  firstChunkAt?: number;
  completedAt?: number;
  bytes: number;
}

async function primeStreamingResponse(upstream: Response): Promise<{
  response: Response;
  observation: StreamObservation;
}> {
  const observation: StreamObservation = { bytes: 0 };
  if (!upstream.body) return { response: upstream, observation };

  const reader = upstream.body.getReader();
  const first = await reader.read();
  if (first.done) {
    observation.completedAt = Date.now();
    return {
      response: new Response(null, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      }),
      observation,
    };
  }

  observation.firstChunkAt = Date.now();
  observation.bytes += first.value.byteLength;
  let firstPending = true;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (firstPending) {
        firstPending = false;
        controller.enqueue(first.value);
        return;
      }
      const next = await reader.read();
      if (next.done) {
        observation.completedAt = Date.now();
        controller.close();
        return;
      }
      observation.bytes += next.value.byteLength;
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      observation.completedAt = Date.now();
      await reader.cancel(reason);
    },
  });

  return {
    response: new Response(stream, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    }),
    observation,
  };
}

async function pipeStreamingBody(
  body: ReadableStream<Uint8Array> | null,
  response: ServerResponse,
): Promise<void> {
  if (!body) return;
  const readable = Readable.fromWeb(
    body as import("node:stream/web").ReadableStream,
  );
  for await (const chunk of readable) {
    if (!response.write(chunk)) {
      await new Promise<void>((resolve) => response.once("drain", resolve));
    }
  }
}

function performanceHeaderRecord(
  performance: RequestPerformanceTiming,
): RoutingHeaders {
  const headers: RoutingHeaders = {
    "x-free-llm-router-latency-ms": String(
      performance.routerPreparationMs + performance.routerOverheadMs,
    ),
    "x-free-llm-provider-latency-ms": String(performance.providerLatencyMs),
    "x-free-llm-retry-delay-ms": String(performance.retryDelayMs),
    "x-free-llm-response-processing-ms": String(performance.responseProcessingMs),
    "x-free-llm-total-latency-ms": String(performance.totalLatencyMs),
  };
  if (performance.firstTokenMs !== undefined) {
    headers["x-free-llm-first-token-ms"] = String(performance.firstTokenMs);
  }
  if (performance.streamDurationMs !== undefined) {
    headers["x-free-llm-stream-duration-ms"] = String(performance.streamDurationMs);
  }
  if (performance.tokensPerSecond !== undefined) {
    headers["x-free-llm-stream-tokens-per-second"] = String(performance.tokensPerSecond);
  }
  return headers;
}

function setPerformanceHeaders(
  response: ServerResponse,
  performance: RequestPerformanceTiming,
): void {
  for (const [name, value] of Object.entries(performanceHeaderRecord(performance))) {
    response.setHeader(name, value);
  }
}

function routingHeadersWithPerformance(
  response: ServerResponse,
  performance: RequestPerformanceTiming,
): RoutingHeaders {
  return {
    ...routingHeadersFromResponse(response),
    ...performanceHeaderRecord(performance),
  };
}

function announcePerformanceTrailers(response: ServerResponse): void {
  const existing = headerString(
    response.getHeader("trailer") as string | string[] | number | undefined,
  );
  const names = [
    "x-free-llm-stream-duration-ms",
    "x-free-llm-stream-tokens-per-second",
    "x-free-llm-total-latency-ms",
  ];
  response.setHeader(
    "trailer",
    [...new Set([...(existing ? existing.split(",").map((item) => item.trim()) : []), ...names])]
      .filter(Boolean)
      .join(", "),
  );
}

function addPerformanceTrailers(
  response: ServerResponse,
  performance: RequestPerformanceTiming,
): void {
  const headers = performanceHeaderRecord(performance);
  const trailers: Record<string, string> = {};
  for (const name of [
    "x-free-llm-stream-duration-ms",
    "x-free-llm-stream-tokens-per-second",
    "x-free-llm-total-latency-ms",
  ]) {
    const value = headers[name];
    if (value !== undefined) trailers[name] = value;
  }
  if (Object.keys(trailers).length > 0 && !response.writableEnded) {
    response.addTrailers(trailers);
  }
}

function selectedAttemptHeaderAt(
  attempts: ProviderAttemptMetric[],
  providerId: string,
  startedAt: number,
): number | undefined {
  const attempt = [...attempts]
    .reverse()
    .find((candidate) => candidate.success && candidate.providerId === providerId);
  if (!attempt) return undefined;
  if (attempt.startedElapsedMs !== undefined && attempt.headersLatencyMs !== undefined) {
    return startedAt + attempt.startedElapsedMs + attempt.headersLatencyMs;
  }
  return undefined;
}

function setSuccessfulRoutingHeaders(params: {
  response: ServerResponse;
  result: RoutedCompletionResult;
  requestedModel: string;
  alias: ModelAlias | undefined;
  policy: RoutingPolicy;
  providerModel: string | undefined;
  apiFormat: ApiFormat;
  startedAt: number;
}): void {
  const { response, result } = params;
  response.setHeader("x-free-llm-provider", result.providerId);
  response.setHeader("x-free-llm-routing-policy", params.policy.strategy);
  response.setHeader("x-free-llm-routing-strategy", params.policy.strategy);
  response.setHeader("x-free-llm-api-format", params.apiFormat);
  response.setHeader("x-free-llm-provider-attempts", String(result.attempts.length));
  response.setHeader("x-free-llm-fallback-used", String(result.attempts.length > 1));
  response.setHeader("x-free-llm-total-latency-ms", String(Date.now() - params.startedAt));
  if (!response.hasHeader("x-free-llm-deduplicated")) {
    response.setHeader("x-free-llm-deduplicated", "false");
  }
  const requestId = headerString(response.getHeader("x-free-llm-request-id") as string | string[] | number | undefined);
  if (requestId) response.setHeader("x-free-llm-original-request-id", requestId);
  response.setHeader("x-free-llm-deduplication-source", "original");
  response.setHeader("x-free-llm-duplicate-count", "0");
  setAliasHeaders(response, params.requestedModel, params.alias, params.providerModel);
  setCapabilityHeaders(response, result.requirements, result.capabilityMatch);

  const cooldownProviders = [...new Set(
    result.attempts.filter((attempt) => attempt.cooldownUntil).map((attempt) => attempt.providerId),
  )];
  if (cooldownProviders.length) {
    response.setHeader("x-free-llm-cooldown-applied", cooldownProviders.join(","));
  }
  const selectedAttempt = [...result.attempts]
    .reverse()
    .find((attempt) => attempt.providerId === result.providerId);
  if (selectedAttempt?.circuitState) {
    response.setHeader("x-free-llm-circuit-state", selectedAttempt.circuitState);
  }
  const selectedEvaluation = result.providerEvaluations.find(
    (evaluation) => evaluation.providerId === result.providerId,
  );
  if (selectedEvaluation?.quotaWarning) {
    response.setHeader("x-free-llm-quota-warning", "true");
  }
  const retryStopReason = result.attempts.at(-1)?.retryStopReason;
  if (retryStopReason) {
    response.setHeader("x-free-llm-retry-stop-reason", retryStopReason);
  }
}

function failureProviderAttempts(error: unknown): ProviderAttemptMetric[] {
  if (error instanceof AllProvidersFailedError) return error.providerAttempts;
  if (error instanceof AllProvidersCoolingDownError) return error.providerAttempts;
  if (error instanceof AllProvidersUnavailableError) return error.providerAttempts;
  return [];
}

function setFailureRoutingHeaders(
  response: ServerResponse,
  error: unknown,
  correlation: RequestCorrelation,
): void {
  setRequestCorrelationHeaders(response, correlation);
  const attempts = failureProviderAttempts(error);
  response.setHeader("x-free-llm-provider-attempts", String(attempts.length));
  response.setHeader("x-free-llm-fallback-used", String(attempts.length > 1));
  const performance = buildRequestPerformanceTiming({
    startedAt: correlation.startedAt,
    completedAt: Date.now(),
    attempts,
    ...(attempts.at(-1)?.providerId ? { providerId: attempts.at(-1)!.providerId } : {}),
  });
  setPerformanceHeaders(response, performance);
  response.setHeader("x-free-llm-deduplicated", "false");
  response.setHeader("x-free-llm-original-request-id", correlation.requestId);
  response.setHeader("x-free-llm-deduplication-source", "original");
  response.setHeader("x-free-llm-duplicate-count", "0");
  const lastAttempt = attempts.at(-1);
  if (lastAttempt?.providerId) response.setHeader("x-free-llm-provider", lastAttempt.providerId);
  if (lastAttempt?.retryStopReason) {
    response.setHeader("x-free-llm-retry-stop-reason", lastAttempt.retryStopReason);
  }
  const cooldownProviders = [...new Set(
    attempts.filter((attempt) => attempt.cooldownUntil).map((attempt) => attempt.providerId),
  )];
  if (cooldownProviders.length) {
    response.setHeader("x-free-llm-cooldown-applied", cooldownProviders.join(","));
  }
  if (lastAttempt?.circuitState) {
    response.setHeader("x-free-llm-circuit-state", lastAttempt.circuitState);
  }
}

const ROUTING_STRATEGIES = new Set<RoutingStrategy>([
  "priority",
  "fastest",
  "round-robin",
  "least-used",
  "reliability",
  "smart",
]);

const DEDUPLICATION_ENDPOINTS = new Set([
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/messages",
]);

class CapturingServerResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  private readonly headers = new Map<string, string | string[]>();
  private readonly chunks: Buffer[] = [];

  setHeader(name: string, value: number | string | readonly string[]): this {
    const normalized = Array.isArray(value)
      ? value.map(String)
      : String(value);
    this.headers.set(name.toLowerCase(), normalized);
    return this;
  }

  getHeader(name: string): string | string[] | undefined {
    return this.headers.get(name.toLowerCase());
  }

  getHeaders(): OutgoingHttpHeaders {
    return Object.fromEntries(this.headers);
  }

  hasHeader(name: string): boolean {
    return this.headers.has(name.toLowerCase());
  }

  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase());
  }

  writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | OutgoingHttpHeaders,
    headers?: OutgoingHttpHeaders,
  ): this {
    this.statusCode = statusCode;
    const suppliedHeaders = typeof statusMessageOrHeaders === "string"
      ? headers
      : statusMessageOrHeaders;
    if (suppliedHeaders) {
      for (const [name, value] of Object.entries(suppliedHeaders)) {
        if (value !== undefined) this.setHeader(name, value);
      }
    }
    this.headersSent = true;
    return this;
  }

  write(chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean {
    if (chunk !== undefined && chunk !== null) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    this.headersSent = true;
    const resolvedCallback = typeof encodingOrCallback === "function"
      ? encodingOrCallback
      : callback;
    if (typeof resolvedCallback === "function") resolvedCallback();
    return true;
  }

  end(chunk?: unknown, encodingOrCallback?: unknown, callback?: unknown): this {
    if (chunk !== undefined && chunk !== null && typeof chunk !== "function") {
      this.write(chunk);
    }
    this.headersSent = true;
    this.writableEnded = true;
    const resolvedCallback = typeof chunk === "function"
      ? chunk
      : typeof encodingOrCallback === "function"
        ? encodingOrCallback
        : callback;
    if (typeof resolvedCallback === "function") resolvedCallback();
    this.emit("finish");
    return this;
  }

  capture(): CapturedHttpResponse {
    return {
      status: this.statusCode,
      headers: Object.fromEntries(this.headers),
      body: Buffer.concat(this.chunks),
    };
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requestIdempotencyKey(request: IncomingMessage): string | undefined {
  const raw = request.headers["idempotency-key"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value && value.length <= 200 ? value : undefined;
}

function apiFormatForEndpoint(endpoint: string): ApiFormat {
  if (endpoint === "/v1/responses") return "openai-responses-compatible";
  if (endpoint === "/v1/messages") return "claude-code-compatible";
  return "openai-compatible";
}

function defaultModelForEndpoint(endpoint: string): string {
  if (endpoint === "/v1/responses") return "codex-free-router";
  if (endpoint === "/v1/messages") return "claude-free-router";
  return "free-router";
}

function approximateEndpointInputTokens(
  endpoint: string,
  body: Record<string, unknown>,
): number {
  if (endpoint === "/v1/responses") return approximateResponsesInputTokens(body);
  if (endpoint === "/v1/messages") return approximateAnthropicInputTokens(body);
  return approximateInputTokens(body);
}

function addDeduplicationSavings(
  metadata: DeduplicationMetadata,
  endpoint: string,
  body: Record<string, unknown>,
  captured: CapturedHttpResponse,
): DeduplicationMetadata {
  if (!metadata.deduplicated) return metadata;
  let payload: unknown;
  try {
    payload = JSON.parse(captured.body.toString("utf8")) as unknown;
  } catch {
    payload = undefined;
  }
  const fallbackInputTokens = approximateEndpointInputTokens(endpoint, body);
  const usage = extractTokenUsage(payload, fallbackInputTokens) ?? {
    inputTokens: fallbackInputTokens,
    outputTokens: 0,
    totalTokens: fallbackInputTokens,
    source: "estimated" as const,
  };
  return {
    ...metadata,
    estimatedInputTokensSaved: usage.inputTokens,
    estimatedOutputTokensSaved: usage.outputTokens,
    estimatedTotalTokensSaved: usage.totalTokens,
  };
}

function deduplicatedRoutingHeaders(
  captured: CapturedHttpResponse,
  metadata: DeduplicationMetadata,
  correlation: RequestCorrelation,
  latencyMs: number,
  performance?: RequestPerformanceTiming,
): RoutingHeaders {
  const headers: RoutingHeaders = {};
  for (const [name, value] of Object.entries(captured.headers)) {
    if (name.startsWith("x-free-llm-") || name === "retry-after") {
      headers[name] = singleHeader(value) ?? "";
    }
  }
  headers["x-free-llm-request-id"] = correlation.requestId;
  headers["x-free-llm-request-id-source"] = correlation.source;
  if (correlation.clientRequestId) {
    headers["x-free-llm-client-request-id"] = correlation.clientRequestId;
  } else {
    delete headers["x-free-llm-client-request-id"];
  }
  headers["x-free-llm-deduplicated"] = String(metadata.deduplicated);
  headers["x-free-llm-original-request-id"] = metadata.originalRequestId;
  headers["x-free-llm-deduplication-source"] = metadata.source;
  headers["x-free-llm-duplicate-count"] = String(metadata.duplicateCount);
  headers["x-free-llm-total-latency-ms"] = String(latencyMs);
  if (performance) Object.assign(headers, performanceHeaderRecord(performance));
  return headers;
}

async function recordDeduplicatedRequest(params: {
  routerKeyHash: string;
  account: NonNullable<Awaited<ReturnType<typeof findAccount>>>;
  endpoint: string;
  body: Record<string, unknown>;
  requestHeaders: IncomingMessage["headers"];
  response: CapturedHttpResponse;
  metadata: DeduplicationMetadata;
  correlation: RequestCorrelation;
  latencyMs: number;
  startedAt: number;
}): Promise<void> {
  const requestedModel = typeof params.body.model === "string" && params.body.model.trim()
    ? params.body.model.trim()
    : defaultModelForEndpoint(params.endpoint);
  const alias = resolveModelAlias(
    normalizeModelAliases(params.account.modelAliases),
    requestedModel,
  );
  const policy = effectiveAliasPolicy(params.account.routingPolicy, alias);
  const providerId = singleHeader(params.response.headers["x-free-llm-provider"])
    ?? "deduplicated";
  const providerModel = singleHeader(
    params.response.headers["x-free-llm-provider-model"],
  );
  let payload: unknown;
  try {
    payload = JSON.parse(params.response.body.toString("utf8")) as unknown;
  } catch {
    payload = undefined;
  }
  const usage = extractTokenUsage(
    payload,
    approximateEndpointInputTokens(params.endpoint, params.body),
  );

  const performance = buildRequestPerformanceTiming({
    startedAt: params.startedAt,
    completedAt: params.startedAt + params.latencyMs,
    deduplicated: true,
  });
  const routingHeaders = deduplicatedRoutingHeaders(
    params.response,
    params.metadata,
    params.correlation,
    params.latencyMs,
    performance,
  );
  await recordRequestLog(createRequestLog({
    routerKeyHash: params.routerKeyHash,
    requestId: params.correlation.requestId,
    ...(params.correlation.clientRequestId
      ? { clientRequestId: params.correlation.clientRequestId }
      : {}),
    requestIdSource: params.correlation.source,
    routingHeaders,
    providerId,
    ...(providerModel ? { providerModel } : {}),
    requestedModel,
    resolvedAlias: alias?.id,
    apiFormat: apiFormatForEndpoint(params.endpoint),
    endpoint: params.endpoint,
    routingStrategy: policy.strategy,
    status: params.response.status,
    latencyMs: params.latencyMs,
    startedAt: params.startedAt,
    ...(usage ? { usage } : {}),
    deduplication: params.metadata,
    performance,
    requestHeaders: params.requestHeaders,
    requestBody: params.body,
    responseText: params.response.body.toString("utf8"),
    responseContentType:
      singleHeader(params.response.headers["content-type"]) ?? null,
  }));
}

function replayCapturedResponse(
  response: ServerResponse,
  captured: CapturedHttpResponse,
  metadata: DeduplicationMetadata,
  correlation: RequestCorrelation,
  latencyMs: number,
): void {
  for (const [name, value] of Object.entries(captured.headers)) {
    if (
      [
        "connection",
        "content-length",
        "transfer-encoding",
        "x-free-llm-request-id",
        "x-free-llm-request-id-source",
        "x-free-llm-client-request-id",
        "x-free-llm-total-latency-ms",
      ].includes(name)
    ) continue;
    response.setHeader(name, value);
  }
  setRequestCorrelationHeaders(response, correlation);
  response.setHeader("x-free-llm-deduplicated", String(metadata.deduplicated));
  response.setHeader("x-free-llm-original-request-id", metadata.originalRequestId);
  response.setHeader("x-free-llm-deduplication-source", metadata.source);
  response.setHeader("x-free-llm-duplicate-count", String(metadata.duplicateCount));
  const performance = buildRequestPerformanceTiming({
    startedAt: Date.now() - latencyMs,
    completedAt: Date.now(),
    deduplicated: true,
  });
  setPerformanceHeaders(response, performance);
  response.writeHead(captured.status);
  response.end(captured.body);
}

function sendBodyParsingError(
  response: ServerResponse,
  endpoint: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : "Invalid JSON body";
  if (endpoint === "/v1/messages") {
    sendJson(response, 400, anthropicError("invalid_request_error", message));
  } else if (endpoint === "/v1/responses") {
    sendJson(response, 400, responsesError(message));
  } else {
    sendJson(response, 400, { error: { message, type: "invalid_request_error" } });
  }
}

async function handleRequestCore(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const correlation = requestCorrelation(request);
  setRequestCorrelationHeaders(response, correlation);
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  try {
    if (request.method === "HEAD" && url.pathname === "/") {
      response.writeHead(200, { "cache-control": "no-store" });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/auth/config") {
      const publishableKey = clerkPublishableKey();
      sendJson(
        response,
        publishableKey ? 200 : 503,
        publishableKey
          ? { publishableKey }
          : { error: "Authentication is not configured" },
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/user/router") {
      const userId = await sessionUserId(request);
      if (!userId) {
        sendJson(response, 401, { error: "Sign in required" });
        return;
      }
      sendJson(response, 200, { router: (await getAccountForUser(userId)) ?? null });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/accounts") {
      const userId = await sessionUserId(request);
      if (!userId) {
        sendJson(response, 401, { error: "Sign in required" });
        return;
      }
      const existing = await getAccountForUser(userId);
      if (existing) {
        sendJson(response, 200, existing);
        return;
      }
      const body = await readJsonBody(request);
      const name =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim().slice(0, 80)
          : "My router";
      sendJson(response, 201, await createAccount(name, userId));
      return;
    }

    if (
      url.pathname === "/api/me" ||
      url.pathname.startsWith("/api/providers") ||
      url.pathname.startsWith("/api/router")
    ) {
      const routerKey = bearerToken(request);
      const userId = await sessionUserId(request);
      if (!routerKey || !userId || !(await findAccountForUser(routerKey, userId))) {
        sendJson(response, 401, { error: "Signed-in router access required" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/me") {
        const payload = await providerResponse(routerKey);
        sendJson(response, payload ? 200 : 401, payload ?? { error: "Invalid router key" });
        return;
      }

      if (request.method === "PATCH" && url.pathname === "/api/router/settings") {
        const body = await readJsonBody(request);
        const routingCandidate = body.routingPolicy;
        let routingPolicy: RoutingPolicy | undefined;

        if (routingCandidate !== undefined) {
          if (!routingCandidate || typeof routingCandidate !== "object" || Array.isArray(routingCandidate)) {
            sendJson(response, 400, { error: "Routing policy must be an object" });
            return;
          }
          const candidate = routingCandidate as Record<string, unknown>;
          if (
            typeof candidate.strategy !== "string" ||
            !ROUTING_STRATEGIES.has(candidate.strategy as RoutingStrategy)
          ) {
            sendJson(response, 400, { error: "Unknown routing strategy" });
            return;
          }
          if (
            candidate.providerOrder !== undefined &&
            (!Array.isArray(candidate.providerOrder) ||
              !candidate.providerOrder.every((id) => typeof id === "string"))
          ) {
            sendJson(response, 400, { error: "Provider order must be a list of provider IDs" });
            return;
          }
          routingPolicy = {
            strategy: candidate.strategy as RoutingStrategy,
            providerOrder: Array.isArray(candidate.providerOrder)
              ? candidate.providerOrder as string[]
              : [],
          };
        }

        const name = typeof body.name === "string" ? body.name : undefined;
        if (name !== undefined && !name.trim()) {
          sendJson(response, 400, { error: "Router name cannot be empty" });
          return;
        }

        let reliabilitySettings: ReliabilitySettings | undefined;
        if (body.reliabilitySettings !== undefined) {
          try {
            reliabilitySettings = parseReliabilitySettings(body.reliabilitySettings);
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : "Invalid reliability settings",
            });
            return;
          }
        }

        let deduplicationSettings: DeduplicationSettings | undefined;
        if (body.deduplicationSettings !== undefined) {
          try {
            deduplicationSettings = parseDeduplicationSettings(
              body.deduplicationSettings,
            );
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error
                ? error.message
                : "Invalid deduplication settings",
            });
            return;
          }
        }

        let capabilityRoutingSettings: CapabilityRoutingSettings | undefined;
        if (body.capabilityRoutingSettings !== undefined) {
          capabilityRoutingSettings = normalizeCapabilityRoutingSettings(
            body.capabilityRoutingSettings,
          );
        }

        let modelAliases: ModelAlias[] | undefined;
        if (body.modelAliases !== undefined) {
          try {
            modelAliases = parseModelAliases(body.modelAliases);
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : "Invalid model aliases",
            });
            return;
          }
        }

        const account = await updateAccountSettings(routerKey, {
          ...(name !== undefined ? { name } : {}),
          ...(routingPolicy ? { routingPolicy } : {}),
          ...(reliabilitySettings ? { reliabilitySettings } : {}),
          ...(deduplicationSettings ? { deduplicationSettings } : {}),
          ...(capabilityRoutingSettings ? { capabilityRoutingSettings } : {}),
          ...(modelAliases ? { modelAliases } : {}),
        });
        sendJson(response, account ? 200 : 401, account ?? { error: "Invalid router key" });
        return;
      }

      const providerModelsMatch = url.pathname.match(
        /^\/api\/providers\/([^/]+)\/models(?:\/(test|detect))?$/,
      );
      if (providerModelsMatch?.[1] && request.method === "PUT" && !providerModelsMatch[2]) {
        const providerId = normalizeProviderId(decodeURIComponent(providerModelsMatch[1]));
        const configs = await loadProviderConfigs();
        if (!configs.some((provider) => provider.id === providerId)) {
          sendJson(response, 404, { error: "Unknown provider" });
          return;
        }
        try {
          const catalog = parseProviderModelCatalog(await readJsonBody(request));
          const account = await setProviderModelCatalog(routerKey, providerId, catalog);
          sendJson(response, account ? 200 : 401, account
            ? { account, providerId, catalog }
            : { error: "Invalid router key" });
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : "Invalid provider model catalog",
          });
        }
        return;
      }

      if (providerModelsMatch?.[1] && providerModelsMatch[2] === "detect" && request.method === "POST") {
        const providerId = normalizeProviderId(decodeURIComponent(providerModelsMatch[1]));
        const body = await readJsonBody(request);
        const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
        if (!modelId) {
          sendJson(response, 400, { error: "Enter a model ID to detect" });
          return;
        }
        try {
          const result = await detectProviderModelCapabilities({
            routerKey,
            providerId,
            modelId,
          });
          sendJson(response, 200, { providerId, modelId, ...result });
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : "Capability detection failed",
          });
        }
        return;
      }

      if (providerModelsMatch?.[1] && providerModelsMatch[2] === "test" && request.method === "POST") {
        const providerId = normalizeProviderId(decodeURIComponent(providerModelsMatch[1]));
        const body = await readJsonBody(request);
        const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
        if (!modelId) {
          sendJson(response, 400, { error: "Enter a model ID to test" });
          return;
        }
        try {
          const result = await testProviderModel({ routerKey, providerId, modelId });
          sendJson(response, 200, { providerId, modelId, ...result });
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : "Model test failed",
          });
        }
        return;
      }

      const quotaMatch = url.pathname.match(
        /^\/api\/providers\/([^/]+)\/quota$/,
      );
      if (quotaMatch?.[1] && request.method === "PUT") {
        const providerId = normalizeProviderId(decodeURIComponent(quotaMatch[1]));
        const configs = await loadProviderConfigs();
        if (!configs.some((provider) => provider.id === providerId)) {
          sendJson(response, 404, { error: "Unknown provider" });
          return;
        }
        const body = await readJsonBody(request);
        const quota = normalizeProviderQuotaConfig(body);
        if (!quota) {
          sendJson(response, 400, {
            error: "Set at least one positive daily or monthly request/token limit",
          });
          return;
        }
        const account = await setProviderQuota(routerKey, providerId, quota);
        const stats = await getRoutingStats(hashRouterKey(routerKey));
        sendJson(response, account ? 200 : 401, account
          ? {
              account,
              providerId,
              quota: providerQuotaStatus(quota, stats[providerId]?.quotaUsage) ?? null,
            }
          : { error: "Invalid router key" });
        return;
      }

      if (quotaMatch?.[1] && request.method === "DELETE") {
        const providerId = normalizeProviderId(decodeURIComponent(quotaMatch[1]));
        const account = await deleteProviderQuota(routerKey, providerId);
        sendJson(response, account ? 200 : 401, account
          ? { account, providerId, quota: null }
          : { error: "Invalid router key" });
        return;
      }

      const usageMatch = url.pathname.match(
        /^\/api\/providers\/([^/]+)\/usage$/,
      );
      if (usageMatch?.[1] && request.method === "DELETE") {
        const providerId = normalizeProviderId(decodeURIComponent(usageMatch[1]));
        const configs = await loadProviderConfigs();
        if (!configs.some((provider) => provider.id === providerId)) {
          sendJson(response, 404, { error: "Unknown provider" });
          return;
        }
        const routingStats = await clearProviderUsage(
          hashRouterKey(routerKey),
          providerId,
        );
        const account = await findAccount(routerKey);
        sendJson(response, 200, {
          providerId,
          routingStats,
          quota: providerQuotaStatus(
            account?.providerQuotas[providerId],
            routingStats.quotaUsage,
          ) ?? null,
        });
        return;
      }

      const cooldownMatch = url.pathname.match(
        /^\/api\/providers\/([^/]+)\/cooldown$/,
      );
      if (cooldownMatch?.[1] && request.method === "DELETE") {
        const providerId = normalizeProviderId(decodeURIComponent(cooldownMatch[1]));
        const configs = await loadProviderConfigs();
        if (!configs.some((provider) => provider.id === providerId)) {
          sendJson(response, 404, { error: "Unknown provider" });
          return;
        }
        const routingStats = await clearProviderCooldown(
          hashRouterKey(routerKey),
          providerId,
        );
        sendJson(response, 200, { providerId, routingStats });
        return;
      }

      const circuitMatch = url.pathname.match(
        /^\/api\/providers\/([^/]+)\/circuit(?:\/(retry))?$/,
      );
      if (circuitMatch?.[1] && request.method === "DELETE" && !circuitMatch[2]) {
        const providerId = normalizeProviderId(decodeURIComponent(circuitMatch[1]));
        const configs = await loadProviderConfigs();
        if (!configs.some((provider) => provider.id === providerId)) {
          sendJson(response, 404, { error: "Unknown provider" });
          return;
        }
        const routingStats = await resetProviderCircuit(
          hashRouterKey(routerKey),
          providerId,
        );
        sendJson(response, 200, { providerId, routingStats });
        return;
      }

      if (circuitMatch?.[1] && request.method === "POST" && circuitMatch[2] === "retry") {
        const providerId = normalizeProviderId(decodeURIComponent(circuitMatch[1]));
        const providerKeys = await getProviderKeys(routerKey);
        if (!providerKeys?.[providerId]) {
          sendJson(response, 400, { error: "Provider key is not configured" });
          return;
        }

        const routerKeyHash = hashRouterKey(routerKey);
        await prepareProviderCircuitRetry(routerKeyHash, providerId);
        const account = await findAccount(routerKey);
        const configs = await loadProviderConfigs();
        const catalogs = normalizeProviderModelCatalogMap(account?.providerModels, configs);
        const activeCatalog = catalogs[providerId];
        const activeModelId = activeCatalog?.activeModelId
          ?? configs.find((provider) => provider.id === providerId)?.model
          ?? "";
        const activeModelOption = activeCatalog?.models.find((model) => model.id === activeModelId);
        const providers = (await loadProviders(
          undefined,
          providerKeys,
          { [providerId]: activeModelId },
          activeModelOption ? { [providerId]: activeModelOption } : {},
        )).filter((provider) => provider.id === providerId);
        if (!providers.length) {
          sendJson(response, 404, { error: "Unknown or disabled provider" });
          return;
        }

        const stats = await getRoutingStats(routerKeyHash);
        const retryRouter = new ProviderRouter(providers, fetch, {
          policy: { strategy: "priority", providerOrder: [providerId] },
          stats,
          reliability: effectiveReliabilitySettings(account?.reliabilitySettings),
          capabilityUnknownMode: account?.capabilityRoutingSettings?.unknownMode ?? "flexible",
          onAttempt: (attempt) => recordRoutingAttempt(routerKeyHash, attempt),
          claimHalfOpenProbe: (candidateId) =>
            claimProviderHalfOpenProbe(routerKeyHash, candidateId),
        });

        try {
          const result = await retryRouter.chatCompletion({
            model: "free-router",
            stream: false,
            max_tokens: 8,
            messages: [
              {
                role: "user",
                content: "Reply with exactly: OK",
              },
            ],
          });
          await result.response.arrayBuffer();
          const refreshed = await getRoutingStats(routerKeyHash);
          sendJson(response, 200, {
            ok: true,
            providerId,
            routingStats: refreshed[providerId] ?? null,
          });
        } catch (error) {
          const refreshed = await getRoutingStats(routerKeyHash);
          sendJson(response, 502, {
            error: error instanceof Error ? error.message : "Recovery test failed",
            providerId,
            routingStats: refreshed[providerId] ?? null,
          });
        }
        return;
      }

      const match = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
      const matchedProviderId = match?.[1];
      if (matchedProviderId && request.method === "PUT") {
        const providerId = normalizeProviderId(decodeURIComponent(matchedProviderId));
        const configs = await loadProviderConfigs();
        if (!configs.some((provider) => provider.id === providerId)) {
          sendJson(response, 404, { error: "Unknown provider" });
          return;
        }
        const body = await readJsonBody(request);
        if (typeof body.apiKey !== "string" || body.apiKey.trim().length < 8) {
          sendJson(response, 400, { error: "Enter a valid API key" });
          return;
        }
        const account = await setProviderKey(routerKey, providerId, body.apiKey.trim());
        sendJson(response, account ? 200 : 401, account ?? { error: "Invalid router key" });
        return;
      }

      if (matchedProviderId && request.method === "DELETE") {
        const account = await deleteProviderKey(
          routerKey,
          decodeURIComponent(matchedProviderId),
        );
        sendJson(response, account ? 200 : 401, account ?? { error: "Invalid router key" });
        return;
      }
    }


    if (url.pathname === "/api/analytics") {
      const routerKey = bearerToken(request);
      const userId = await sessionUserId(request);
      if (!routerKey || !userId || !(await findAccountForUser(routerKey, userId))) {
        sendJson(response, 401, { error: "Signed-in router access required" });
        return;
      }

      const routerKeyHash = hashRouterKey(routerKey);

      if (request.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const requests = await listRequestLogs(routerKeyHash, limit);
        sendJson(response, 200, {
          requests,
          frequency: requestFrequency(requests),
          summary: analyticsSummary(requests),
        });
        return;
      }

      if (request.method === "DELETE") {
        await clearRequestLogs(routerKeyHash);
        response.writeHead(204);
        response.end();
        return;
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/models") {
      const token = routerToken(request);
      const account = token ? await findAccount(token) : undefined;
      const aliases = normalizeModelAliases(account?.modelAliases)
        .filter((alias) => alias.enabled);
      sendJson(response, 200, {
        object: "list",
        data: aliases.map((alias) => ({
          id: alias.id,
          object: "model",
          owned_by: "free-llm-router",
          display_name: alias.name,
          description: alias.description,
          routing_strategy: alias.routingStrategy,
          required_capabilities: alias.requiredCapabilities,
          eligible_providers: alias.eligibleProviderIds,
          system: alias.system === true,
        })),
      });
      return;
    }


    if (request.method === "POST" && url.pathname === "/v1/responses") {
      const token = routerToken(request);
      if (!token) {
        sendJson(response, 401, responsesError(
          "Invalid router API key",
          "authentication_error",
          "invalid_api_key",
        ));
        return;
      }

      const routerKeyHash = hashRouterKey(token);
      const providerKeys = await getProviderKeys(token);
      if (!providerKeys) {
        sendJson(response, 401, responsesError(
          "Invalid router API key",
          "authentication_error",
          "invalid_api_key",
        ));
        return;
      }

      const body = await readJsonBody(request);
      const requestedModel = typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : "codex-free-router";
      const { providers, router, policy, alias } = await createRoutedProviderRouter({
        routerKey: token,
        routerKeyHash,
        providerKeys,
        requestedModel,
        requestId: correlation.requestId,
        requestStartedAt: correlation.startedAt,
      });
      if (providers.length === 0) {
        const message = alias?.eligibleProviderIds.length
          ? `No configured provider is eligible for model alias "${alias.id}"`
          : "Add at least one provider API key in the dashboard";
        sendJson(response, 400, responsesError(
          message,
          "configuration_error",
          "providers_not_configured",
        ));
        return;
      }

      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      const upstreamBody = responsesToOpenAI(body);
      const capabilityRequirements = mergeAliasRequirements(
        detectCapabilityRequirements(body),
        alias,
      );
      const startedAt = correlation.startedAt;
      const result = await routedChatCompletion({
        router,
        upstreamBody,
        requestSignal: controller.signal,
        context: {
          routerKeyHash,
          providers,
          requestedModel,
          alias,
          policy,
          apiFormat: "openai-responses-compatible",
          endpoint: "/v1/responses",
          capabilityRequirements,
          requestHeaders: request.headers,
          requestBody: body,
          correlation,
          startedAt,
        },
      });
      const providerModel = providers.find(
        (provider) => provider.id === result.providerId,
      )?.model;
      setSuccessfulRoutingHeaders({
        response,
        result,
        requestedModel,
        alias,
        policy,
        providerModel,
        apiFormat: "openai-responses-compatible",
        startedAt,
      });

      if (body.stream === true) {
        try {
          const inputTokens = approximateResponsesInputTokens(body);
          const { response: primedUpstream, observation } = await primeStreamingResponse(
            result.response,
          );
          const selected = result.attempts.find(
            (attempt) => attempt.success && attempt.providerId === result.providerId,
          );
          const providerFirstTokenMs = observation.firstChunkAt !== undefined
            ? Math.max(
                0,
                observation.firstChunkAt -
                  (startedAt + (selected?.startedElapsedMs ?? 0)),
              )
            : undefined;
          finalizeSuccessfulAttempt({
            attempts: result.attempts,
            providerId: result.providerId,
            ...(providerFirstTokenMs !== undefined
              ? { firstTokenMs: providerFirstTokenMs }
              : {}),
          });
          const provisionalPerformance = buildRequestPerformanceTiming({
            startedAt,
            completedAt: observation.firstChunkAt ?? Date.now(),
            attempts: result.attempts,
            providerId: result.providerId,
            ...(observation.firstChunkAt !== undefined
              ? { firstTokenAt: observation.firstChunkAt }
              : {}),
          });
          setPerformanceHeaders(response, provisionalPerformance);
          announcePerformanceTrailers(response);

          const capturedResponse = await streamOpenAIAsResponses({
            upstream: primedUpstream,
            response,
            requestedModel,
            requestBody: body,
            inputTokens,
          });
          const streamCompletedAt = observation.completedAt ?? Date.now();
          const usage = await captureProviderUsage({
            routerKeyHash,
            providerId: result.providerId,
            payload: capturedResponse,
            fallbackInputTokens: inputTokens,
          });
          const completedAt = Date.now();
          const headersAt = selectedAttemptHeaderAt(
            result.attempts,
            result.providerId,
            startedAt,
          );
          const responseBodyMs = Math.max(
            0,
            streamCompletedAt - (headersAt ?? observation.firstChunkAt ?? streamCompletedAt),
          );
          const streamDurationMs = observation.firstChunkAt !== undefined
            ? Math.max(0, streamCompletedAt - observation.firstChunkAt)
            : undefined;
          finalizeSuccessfulAttempt({
            attempts: result.attempts,
            providerId: result.providerId,
            responseBodyMs,
            ...(providerFirstTokenMs !== undefined
              ? { firstTokenMs: providerFirstTokenMs }
              : {}),
            ...(streamDurationMs !== undefined ? { streamDurationMs } : {}),
            ...(usage ? { usage } : {}),
          });
          const performance = buildRequestPerformanceTiming({
            startedAt,
            completedAt,
            attempts: result.attempts,
            providerId: result.providerId,
            responseBodyMs,
            responseProcessingMs: Math.max(0, completedAt - streamCompletedAt),
            ...(observation.firstChunkAt !== undefined
              ? { firstTokenAt: observation.firstChunkAt }
              : {}),
            streamCompletedAt,
            ...(usage ? { usage } : {}),
          });
          addPerformanceTrailers(response, performance);
          await recordRequestLog(
            createRequestLog({
              routerKeyHash,
              requestId: correlation.requestId,
              ...(correlation.clientRequestId ? { clientRequestId: correlation.clientRequestId } : {}),
              requestIdSource: correlation.source,
              routingHeaders: routingHeadersWithPerformance(response, performance),
              providerId: result.providerId,
              providerModel,
              requestedModel,
              resolvedAlias: alias?.id,
              apiFormat: "openai-responses-compatible",
              endpoint: "/v1/responses",
              routingStrategy: policy.strategy,
              requiredCapabilities: result.requirements.required,
              capabilityMatch: result.capabilityMatch.level,
              providerEvaluations: result.providerEvaluations,
              providerAttempts: result.attempts,
              status: result.response.status,
              latencyMs: completedAt - startedAt,
              startedAt,
              completedAt,
              performance,
              ...(usage ? { usage } : {}),
              requestHeaders: request.headers,
              requestBody: body,
              responseText: JSON.stringify(capturedResponse),
              responseContentType: "application/json",
            }),
          );
          response.end();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!response.headersSent) {
            sendJson(response, 502, responsesError(message, "api_error", "upstream_error"));
          } else if (!response.writableEnded) {
            response.write(
              `event: error\ndata: ${JSON.stringify({
                type: "error",
                error: { message, type: "api_error", code: "upstream_error", request_id: correlation.requestId },
              })}\n\n`,
            );
            response.end();
          }
        }
        return;
      }

      const responseBodyStartedAt = Date.now();
      const upstreamText = result.response.body
        ? await result.response.text()
        : "";
      const responseBodyCompletedAt = Date.now();
      const upstreamPayload = JSON.parse(upstreamText) as unknown;
      const payload = openAIToResponses(upstreamPayload, requestedModel, body);
      const responseText = JSON.stringify(payload);
      const usage = await captureProviderUsage({
        routerKeyHash,
        providerId: result.providerId,
        payload,
        fallbackInputTokens: approximateResponsesInputTokens(body),
      });
      const completedAt = Date.now();
      const responseBodyMs = responseBodyCompletedAt - responseBodyStartedAt;
      finalizeSuccessfulAttempt({
        attempts: result.attempts,
        providerId: result.providerId,
        responseBodyMs,
        ...(usage ? { usage } : {}),
      });
      const performance = buildRequestPerformanceTiming({
        startedAt,
        completedAt,
        attempts: result.attempts,
        providerId: result.providerId,
        responseBodyMs,
        responseProcessingMs: completedAt - responseBodyCompletedAt,
        ...(usage ? { usage } : {}),
      });
      setPerformanceHeaders(response, performance);
      await recordRequestLog(
        createRequestLog({
          routerKeyHash,
          requestId: correlation.requestId,
          ...(correlation.clientRequestId ? { clientRequestId: correlation.clientRequestId } : {}),
          requestIdSource: correlation.source,
          routingHeaders: routingHeadersWithPerformance(response, performance),
          providerId: result.providerId,
          providerModel,
          requestedModel,
          resolvedAlias: alias?.id,
          apiFormat: "openai-responses-compatible",
          endpoint: "/v1/responses",
          routingStrategy: policy.strategy,
          requiredCapabilities: result.requirements.required,
          capabilityMatch: result.capabilityMatch.level,
          providerEvaluations: result.providerEvaluations,
          providerAttempts: result.attempts,
          status: 200,
          latencyMs: completedAt - startedAt,
          startedAt,
          completedAt,
          performance,
          ...(usage ? { usage } : {}),
          requestHeaders: request.headers,
          requestBody: body,
          responseText,
          responseContentType: "application/json",
        }),
      );
      sendJson(response, 200, payload);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      const token = routerToken(request);
      if (!token || !(await getProviderKeys(token))) {
        sendJson(response, 401, anthropicError(
          "authentication_error",
          "Invalid router API key",
        ));
        return;
      }
      const body = await readJsonBody(request);
      sendJson(response, 200, { input_tokens: approximateAnthropicInputTokens(body) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/messages") {
      const token = routerToken(request);
      if (!token) {
        sendJson(response, 401, anthropicError(
          "authentication_error",
          "Invalid router API key",
        ));
        return;
      }

      const routerKeyHash = hashRouterKey(token);
      const providerKeys = await getProviderKeys(token);
      if (!providerKeys) {
        sendJson(response, 401, anthropicError(
          "authentication_error",
          "Invalid router API key",
        ));
        return;
      }

      const body = await readJsonBody(request);
      const requestedModel = typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : "claude-free-router";
      const { providers, router, policy, alias } = await createRoutedProviderRouter({
        routerKey: token,
        routerKeyHash,
        providerKeys,
        requestedModel,
        requestId: correlation.requestId,
        requestStartedAt: correlation.startedAt,
      });
      if (providers.length === 0) {
        const message = alias?.eligibleProviderIds.length
          ? `No configured provider is eligible for model alias "${alias.id}"`
          : "Add at least one provider API key in the dashboard";
        sendJson(response, 400, anthropicError(
          "invalid_request_error",
          message,
        ));
        return;
      }

      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      const upstreamBody = anthropicToOpenAI(body);
      const capabilityRequirements = mergeAliasRequirements(
        detectCapabilityRequirements(body),
        alias,
      );
      const startedAt = correlation.startedAt;
      const result = await routedChatCompletion({
        router,
        upstreamBody,
        requestSignal: controller.signal,
        context: {
          routerKeyHash,
          providers,
          requestedModel,
          alias,
          policy,
          apiFormat: "claude-code-compatible",
          endpoint: "/v1/messages",
          capabilityRequirements,
          requestHeaders: request.headers,
          requestBody: body,
          correlation,
          startedAt,
        },
      });
      const providerModel = providers.find(
        (provider) => provider.id === result.providerId,
      )?.model;
      const latencyMs = Date.now() - startedAt;
      setSuccessfulRoutingHeaders({
        response,
        result,
        requestedModel,
        alias,
        policy,
        providerModel,
        apiFormat: "claude-code-compatible",
        startedAt,
      });

      if (body.stream === true) {
        try {
          const inputTokens = approximateAnthropicInputTokens(body);
          const { response: primedUpstream, observation } = await primeStreamingResponse(
            result.response,
          );
          const selected = result.attempts.find(
            (attempt) => attempt.success && attempt.providerId === result.providerId,
          );
          const providerFirstTokenMs = observation.firstChunkAt !== undefined
            ? Math.max(
                0,
                observation.firstChunkAt -
                  (startedAt + (selected?.startedElapsedMs ?? 0)),
              )
            : undefined;
          finalizeSuccessfulAttempt({
            attempts: result.attempts,
            providerId: result.providerId,
            ...(providerFirstTokenMs !== undefined
              ? { firstTokenMs: providerFirstTokenMs }
              : {}),
          });
          const provisionalPerformance = buildRequestPerformanceTiming({
            startedAt,
            completedAt: observation.firstChunkAt ?? Date.now(),
            attempts: result.attempts,
            providerId: result.providerId,
            ...(observation.firstChunkAt !== undefined
              ? { firstTokenAt: observation.firstChunkAt }
              : {}),
          });
          setPerformanceHeaders(response, provisionalPerformance);
          announcePerformanceTrailers(response);

          const capturedMessage = await streamOpenAIAsAnthropic({
            upstream: primedUpstream,
            response,
            requestedModel,
            inputTokens,
          });
          const streamCompletedAt = observation.completedAt ?? Date.now();
          const usage = await captureProviderUsage({
            routerKeyHash,
            providerId: result.providerId,
            payload: capturedMessage,
            fallbackInputTokens: inputTokens,
          });
          const completedAt = Date.now();
          const headersAt = selectedAttemptHeaderAt(
            result.attempts,
            result.providerId,
            startedAt,
          );
          const responseBodyMs = Math.max(
            0,
            streamCompletedAt - (headersAt ?? observation.firstChunkAt ?? streamCompletedAt),
          );
          const streamDurationMs = observation.firstChunkAt !== undefined
            ? Math.max(0, streamCompletedAt - observation.firstChunkAt)
            : undefined;
          finalizeSuccessfulAttempt({
            attempts: result.attempts,
            providerId: result.providerId,
            responseBodyMs,
            ...(providerFirstTokenMs !== undefined
              ? { firstTokenMs: providerFirstTokenMs }
              : {}),
            ...(streamDurationMs !== undefined ? { streamDurationMs } : {}),
            ...(usage ? { usage } : {}),
          });
          const performance = buildRequestPerformanceTiming({
            startedAt,
            completedAt,
            attempts: result.attempts,
            providerId: result.providerId,
            responseBodyMs,
            responseProcessingMs: Math.max(0, completedAt - streamCompletedAt),
            ...(observation.firstChunkAt !== undefined
              ? { firstTokenAt: observation.firstChunkAt }
              : {}),
            streamCompletedAt,
            ...(usage ? { usage } : {}),
          });
          addPerformanceTrailers(response, performance);
          await recordRequestLog(
            createRequestLog({
              routerKeyHash,
              requestId: correlation.requestId,
              ...(correlation.clientRequestId ? { clientRequestId: correlation.clientRequestId } : {}),
              requestIdSource: correlation.source,
              routingHeaders: routingHeadersWithPerformance(response, performance),
              providerId: result.providerId,
              providerModel,
              requestedModel,
              resolvedAlias: alias?.id,
              apiFormat: "claude-code-compatible",
              endpoint: "/v1/messages",
              routingStrategy: policy.strategy,
              requiredCapabilities: result.requirements.required,
              capabilityMatch: result.capabilityMatch.level,
              providerEvaluations: result.providerEvaluations,
              providerAttempts: result.attempts,
              status: result.response.status,
              latencyMs: completedAt - startedAt,
              startedAt,
              completedAt,
              performance,
              ...(usage ? { usage } : {}),
              requestHeaders: request.headers,
              requestBody: body,
              responseText: JSON.stringify(capturedMessage),
              responseContentType: "application/json",
            }),
          );
          response.end();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!response.headersSent) {
            sendJson(response, 502, anthropicError("api_error", message));
          } else if (!response.writableEnded) {
            response.write(
              `event: error\ndata: ${JSON.stringify(anthropicError("api_error", message, { request_id: correlation.requestId }))}\n\n`,
            );
            response.end();
          }
        }
        return;
      }

      const responseBodyStartedAt = Date.now();
      const upstreamText = result.response.body
        ? await result.response.text()
        : "";
      const responseBodyCompletedAt = Date.now();
      const upstreamPayload = JSON.parse(upstreamText) as unknown;
      const payload = openAIToAnthropic(upstreamPayload, requestedModel);
      const responseText = JSON.stringify(payload);
      const usage = await captureProviderUsage({
        routerKeyHash,
        providerId: result.providerId,
        payload,
        fallbackInputTokens: approximateAnthropicInputTokens(body),
      });
      const completedAt = Date.now();
      const responseBodyMs = responseBodyCompletedAt - responseBodyStartedAt;
      finalizeSuccessfulAttempt({
        attempts: result.attempts,
        providerId: result.providerId,
        responseBodyMs,
        ...(usage ? { usage } : {}),
      });
      const performance = buildRequestPerformanceTiming({
        startedAt,
        completedAt,
        attempts: result.attempts,
        providerId: result.providerId,
        responseBodyMs,
        responseProcessingMs: completedAt - responseBodyCompletedAt,
        ...(usage ? { usage } : {}),
      });
      setPerformanceHeaders(response, performance);
      await recordRequestLog(
        createRequestLog({
          routerKeyHash,
          requestId: correlation.requestId,
          ...(correlation.clientRequestId ? { clientRequestId: correlation.clientRequestId } : {}),
          requestIdSource: correlation.source,
          routingHeaders: routingHeadersWithPerformance(response, performance),
          providerId: result.providerId,
          providerModel,
          requestedModel,
          resolvedAlias: alias?.id,
          apiFormat: "claude-code-compatible",
          endpoint: "/v1/messages",
          routingStrategy: policy.strategy,
          requiredCapabilities: result.requirements.required,
          capabilityMatch: result.capabilityMatch.level,
          providerEvaluations: result.providerEvaluations,
          providerAttempts: result.attempts,
          status: 200,
          latencyMs: completedAt - startedAt,
          startedAt,
          completedAt,
          performance,
          ...(usage ? { usage } : {}),
          requestHeaders: request.headers,
          requestBody: body,
          responseText,
          responseContentType: "application/json",
        }),
      );
      sendJson(response, 200, payload);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      const routerKey = bearerToken(request);
      if (!routerKey) {
        sendJson(response, 401, {
          error: { message: "Invalid router API key", type: "authentication_error" },
        });
        return;
      }
      const routerKeyHash = hashRouterKey(routerKey);
      const providerKeys = await getProviderKeys(routerKey);
      if (!providerKeys) {
        sendJson(response, 401, {
          error: { message: "Invalid router API key", type: "authentication_error" },
        });
        return;
      }

      const body = await readJsonBody(request);
      const requestedModel = typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : "free-router";
      const { providers, router, policy, alias } = await createRoutedProviderRouter({
        routerKey,
        routerKeyHash,
        providerKeys,
        requestedModel,
        requestId: correlation.requestId,
        requestStartedAt: correlation.startedAt,
      });
      if (providers.length === 0) {
        const message = alias?.eligibleProviderIds.length
          ? `No configured provider is eligible for model alias "${alias.id}"`
          : "Add at least one provider API key in the dashboard";
        sendJson(response, 400, {
          error: {
            message,
            type: "configuration_error",
          },
        });
        return;
      }

      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      const capabilityRequirements = mergeAliasRequirements(
        detectCapabilityRequirements(body),
        alias,
      );
      const startedAt = correlation.startedAt;
      const result = await routedChatCompletion({
        router,
        upstreamBody: body,
        requestSignal: controller.signal,
        context: {
          routerKeyHash,
          providers,
          requestedModel,
          alias,
          policy,
          apiFormat: "openai-compatible",
          endpoint: "/v1/chat/completions",
          capabilityRequirements,
          requestHeaders: request.headers,
          requestBody: body,
          correlation,
          startedAt,
        },
      });
      const providerModel = providers.find(
        (provider) => provider.id === result.providerId,
      )?.model;
      const latencyMs = Date.now() - startedAt;

      response.statusCode = result.response.status;
      setSuccessfulRoutingHeaders({
        response,
        result,
        requestedModel,
        alias,
        policy,
        providerModel,
        apiFormat: "openai-compatible",
        startedAt,
      });
      for (const header of ["content-type", "cache-control"]) {
        const value = result.response.headers.get(header);
        if (value) response.setHeader(header, value);
      }

      if (body.stream === true) {
        const { response: primedUpstream, observation } = await primeStreamingResponse(
          result.response,
        );
        const selected = result.attempts.find(
          (attempt) => attempt.success && attempt.providerId === result.providerId,
        );
        const providerFirstTokenMs = observation.firstChunkAt !== undefined
          ? Math.max(
              0,
              observation.firstChunkAt -
                (startedAt + (selected?.startedElapsedMs ?? 0)),
            )
          : undefined;
        finalizeSuccessfulAttempt({
          attempts: result.attempts,
          providerId: result.providerId,
          ...(providerFirstTokenMs !== undefined
            ? { firstTokenMs: providerFirstTokenMs }
            : {}),
        });
        const provisionalPerformance = buildRequestPerformanceTiming({
          startedAt,
          completedAt: observation.firstChunkAt ?? Date.now(),
          attempts: result.attempts,
          providerId: result.providerId,
          ...(observation.firstChunkAt !== undefined
            ? { firstTokenAt: observation.firstChunkAt }
            : {}),
        });
        setPerformanceHeaders(response, provisionalPerformance);
        announcePerformanceTrailers(response);
        await pipeStreamingBody(primedUpstream.body, response);
        const streamCompletedAt = observation.completedAt ?? Date.now();
        const usage = await captureProviderUsage({
          routerKeyHash,
          providerId: result.providerId,
          payload: {},
          fallbackInputTokens: approximateInputTokens(body),
        });
        const completedAt = Date.now();
        const headersAt = selectedAttemptHeaderAt(
          result.attempts,
          result.providerId,
          startedAt,
        );
        const responseBodyMs = Math.max(
          0,
          streamCompletedAt - (headersAt ?? observation.firstChunkAt ?? streamCompletedAt),
        );
        const streamDurationMs = observation.firstChunkAt !== undefined
          ? Math.max(0, streamCompletedAt - observation.firstChunkAt)
          : undefined;
        finalizeSuccessfulAttempt({
          attempts: result.attempts,
          providerId: result.providerId,
          responseBodyMs,
          ...(providerFirstTokenMs !== undefined
            ? { firstTokenMs: providerFirstTokenMs }
            : {}),
          ...(streamDurationMs !== undefined ? { streamDurationMs } : {}),
          ...(usage ? { usage } : {}),
        });
        const performance = buildRequestPerformanceTiming({
          startedAt,
          completedAt,
          attempts: result.attempts,
          providerId: result.providerId,
          responseBodyMs,
          responseProcessingMs: Math.max(0, completedAt - streamCompletedAt),
          ...(observation.firstChunkAt !== undefined
            ? { firstTokenAt: observation.firstChunkAt }
            : {}),
          streamCompletedAt,
          ...(usage ? { usage } : {}),
        });
        addPerformanceTrailers(response, performance);
        await recordRequestLog(
          createStreamingRequestLog({
            routerKeyHash,
            requestId: correlation.requestId,
            ...(correlation.clientRequestId ? { clientRequestId: correlation.clientRequestId } : {}),
            requestIdSource: correlation.source,
            routingHeaders: routingHeadersWithPerformance(response, performance),
            providerId: result.providerId,
            providerModel,
            requestedModel,
            resolvedAlias: alias?.id,
            apiFormat: "openai-compatible",
            endpoint: "/v1/chat/completions",
            routingStrategy: policy.strategy,
            requiredCapabilities: result.requirements.required,
            capabilityMatch: result.capabilityMatch.level,
            providerEvaluations: result.providerEvaluations,
            providerAttempts: result.attempts,
            status: result.response.status,
            latencyMs: completedAt - startedAt,
            startedAt,
            completedAt,
            performance,
            ...(usage ? { usage } : {}),
            requestHeaders: request.headers,
            requestBody: body,
          }),
        );
        response.end();
        return;
      }

      const responseBodyStartedAt = Date.now();
      const responseText = result.response.body ? await result.response.text() : "";
      const responseBodyCompletedAt = Date.now();
      let responsePayload: unknown;
      try {
        responsePayload = JSON.parse(responseText) as unknown;
      } catch {
        responsePayload = undefined;
      }
      const usage = await captureProviderUsage({
        routerKeyHash,
        providerId: result.providerId,
        payload: responsePayload,
        fallbackInputTokens: approximateInputTokens(body),
      });
      const completedAt = Date.now();
      const responseBodyMs = responseBodyCompletedAt - responseBodyStartedAt;
      finalizeSuccessfulAttempt({
        attempts: result.attempts,
        providerId: result.providerId,
        responseBodyMs,
        ...(usage ? { usage } : {}),
      });
      const performance = buildRequestPerformanceTiming({
        startedAt,
        completedAt,
        attempts: result.attempts,
        providerId: result.providerId,
        responseBodyMs,
        responseProcessingMs: completedAt - responseBodyCompletedAt,
        ...(usage ? { usage } : {}),
      });
      setPerformanceHeaders(response, performance);
      await recordRequestLog(
        createRequestLog({
          routerKeyHash,
          requestId: correlation.requestId,
          ...(correlation.clientRequestId ? { clientRequestId: correlation.clientRequestId } : {}),
          requestIdSource: correlation.source,
          routingHeaders: routingHeadersWithPerformance(response, performance),
          providerId: result.providerId,
          providerModel,
          requestedModel,
          resolvedAlias: alias?.id,
          apiFormat: "openai-compatible",
          endpoint: "/v1/chat/completions",
          routingStrategy: policy.strategy,
          requiredCapabilities: result.requirements.required,
          capabilityMatch: result.capabilityMatch.level,
          providerEvaluations: result.providerEvaluations,
          providerAttempts: result.attempts,
          status: result.response.status,
          latencyMs: completedAt - startedAt,
          startedAt,
          completedAt,
          performance,
          ...(usage ? { usage } : {}),
          requestHeaders: request.headers,
          requestBody: body,
          responseText,
          responseContentType: result.response.headers.get("content-type"),
        }),
      );
      response.end(responseText);
      return;
    }

    if (request.method === "GET") {
      const asset = await readPublicFile(url.pathname);
      if (asset) {
        response.writeHead(200, {
          "content-type": asset.contentType,
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "permissions-policy": "camera=(), microphone=(), geolocation=()",
          "content-security-policy":
            "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net https://*.clerk.accounts.dev https://clerk.llmrouter.dpdns.org https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.clerk.accounts.dev https://clerk.llmrouter.dpdns.org https://api.clerk.com https://clerk-telemetry.com https://*.clerk-telemetry.com; img-src 'self' data: https://img.clerk.com; worker-src 'self' blob:; frame-src 'self' https://*.clerk.accounts.dev https://clerk.llmrouter.dpdns.org https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://*.clerk.accounts.dev https://clerk.llmrouter.dpdns.org",
        });
        response.end(asset.body);
        return;
      }
    }

    sendJson(response, 404, { error: { message: "Not found", type: "not_found" } });
  } catch (error) {
    if (response.headersSent) {
      if (!response.writableEnded) response.end();
      return;
    }

    setFailureRoutingHeaders(response, error, correlation);
    const isAnthropicRequest = url.pathname.startsWith("/v1/messages");
    const isResponsesRequest = url.pathname === "/v1/responses";
    if (error instanceof AllProvidersQuotaExhaustedError) {
      const retryAfterSeconds = Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000));
      const details = {
        retryAt: new Date(error.retryAt).toISOString(),
        retryAfterSeconds,
        providers: error.providers.map((provider) => ({
          ...provider,
          resetAt: new Date(provider.resetAt).toISOString(),
        })),
      };
      response.setHeader("retry-after", String(retryAfterSeconds));
      response.setHeader("x-free-llm-quota-reset-at", details.retryAt);

      if (isAnthropicRequest) {
        sendJson(response, 429, anthropicError(
          "rate_limit_error",
          error.message,
          details,
        ));
      } else if (isResponsesRequest) {
        const payload = responsesError(
          error.message,
          "rate_limit_error",
          "providers_quota_exhausted",
        );
        const errorBody = payload.error as Record<string, unknown>;
        errorBody.details = details;
        sendJson(response, 429, payload);
      } else {
        sendJson(response, 429, {
          error: {
            message: error.message,
            type: "providers_quota_exhausted",
            code: "providers_quota_exhausted",
            details,
          },
        });
      }
      return;
    }

    if (error instanceof AllProvidersCoolingDownError) {
      const retryAfterSeconds = Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000));
      const details = {
        retryAt: new Date(error.retryAt).toISOString(),
        retryAfterSeconds,
        providers: error.providers.map((provider) => ({
          ...provider,
          cooldownUntil: new Date(provider.cooldownUntil).toISOString(),
        })),
      };
      response.setHeader("retry-after", String(retryAfterSeconds));
      response.setHeader("x-free-llm-cooldown-until", details.retryAt);

      if (isAnthropicRequest) {
        sendJson(response, 429, anthropicError(
          "rate_limit_error",
          error.message,
          details,
        ));
      } else if (isResponsesRequest) {
        const payload = responsesError(
          error.message,
          "rate_limit_error",
          "providers_cooling_down",
        );
        const errorBody = payload.error as Record<string, unknown>;
        errorBody.details = details;
        sendJson(response, 429, payload);
      } else {
        sendJson(response, 429, {
          error: {
            message: error.message,
            type: "providers_cooling_down",
            code: "providers_cooling_down",
            details,
          },
        });
      }
      return;
    }

    if (error instanceof AllProvidersUnavailableError) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((error.retryAt - Date.now()) / 1_000),
      );
      const details = {
        retryAt: new Date(error.retryAt).toISOString(),
        retryAfterSeconds,
        providers: error.providers.map((provider) => ({
          ...provider,
          retryAt: new Date(provider.retryAt).toISOString(),
        })),
      };
      response.setHeader("retry-after", String(retryAfterSeconds));
      response.setHeader("x-free-llm-retry-at", details.retryAt);

      if (isAnthropicRequest) {
        sendJson(
          response,
          503,
          anthropicError("api_error", error.message, details),
        );
      } else if (isResponsesRequest) {
        const payload = responsesError(
          error.message,
          "server_error",
          "providers_unavailable",
        );
        const errorBody = payload.error as Record<string, unknown>;
        errorBody.details = details;
        sendJson(response, 503, payload);
      } else {
        sendJson(response, 503, {
          error: {
            message: error.message,
            type: "providers_unavailable",
            code: "providers_unavailable",
            details,
          },
        });
      }
      return;
    }

    if (error instanceof NoCompatibleProvidersError) {
      const details = {
        requiredCapabilities: error.requirements.required,
        providers: error.providers,
      };
      if (isAnthropicRequest) {
        sendJson(response, 400, anthropicError(
          "invalid_request_error",
          error.message,
          details,
        ));
      } else if (isResponsesRequest) {
        const payload = responsesError(
          error.message,
          "invalid_request_error",
          "no_compatible_provider",
        );
        const errorBody = payload.error as Record<string, unknown>;
        errorBody.details = details;
        sendJson(response, 400, payload);
      } else {
        sendJson(response, 400, {
          error: {
            message: error.message,
            type: "no_compatible_provider",
            ...details,
          },
        });
      }
      return;
    }

    if (error instanceof AllProvidersFailedError) {
      if (isAnthropicRequest) {
        sendJson(response, 503, anthropicError(
          "overloaded_error",
          error.message,
          { attempts: error.attempts },
        ));
      } else if (isResponsesRequest) {
        const payload = responsesError(
          error.message,
          "providers_exhausted",
          "providers_exhausted",
        );
        const errorBody = payload.error as Record<string, unknown>;
        errorBody.attempts = error.attempts;
        sendJson(response, 503, payload);
      } else {
        sendJson(response, 503, {
          error: {
            message: error.message,
            type: "providers_exhausted",
            attempts: error.attempts,
          },
        });
      }
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    if (isAnthropicRequest) {
      sendJson(response, 400, anthropicError("invalid_request_error", message));
    } else if (isResponsesRequest) {
      sendJson(response, 400, responsesError(message));
    } else {
      sendJson(response, 400, {
        error: { message, type: "invalid_request_error" },
      });
    }
  }
}

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const correlation = requestCorrelation(request);
  setRequestCorrelationHeaders(response, correlation);
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );
  const endpoint = url.pathname;
  if (request.method === "POST" && DEDUPLICATION_ENDPOINTS.has(endpoint)) {
    response.setHeader("x-free-llm-deduplicated", "false");
  }

  if (request.method !== "POST" || !DEDUPLICATION_ENDPOINTS.has(endpoint)) {
    await handleRequestCore(request, response);
    return;
  }

  const token = endpoint === "/v1/chat/completions"
    ? bearerToken(request)
    : routerToken(request);
  if (!token) {
    await handleRequestCore(request, response);
    return;
  }

  const account = await findAccount(token);
  if (!account) {
    await handleRequestCore(request, response);
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    setFailureRoutingHeaders(response, error, correlation);
    sendBodyParsingError(response, endpoint, error);
    return;
  }
  (request as IncomingMessage & { body?: unknown }).body = body;

  const idempotencyKey = requestIdempotencyKey(request);
  const bypassReason = deduplicationBypassReason({
    body,
    settings: account.deduplicationSettings,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  if (bypassReason) {
    response.setHeader("x-free-llm-deduplication-bypass", bypassReason);
    await handleRequestCore(request, response);
    return;
  }

  const routerKeyHash = hashRouterKey(token);
  const key = createRequestFingerprint({
    routerKeyHash,
    endpoint,
    body,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  const startedAt = Date.now();

  try {
    const result = await executeDeduplicated({
      key,
      windowMs: account.deduplicationSettings.windowMs,
      requestId: correlation.requestId,
      execute: async () => {
        const capture = new CapturingServerResponse();
        await handleRequestCore(
          request,
          capture as unknown as ServerResponse,
        );
        if (!capture.writableEnded) capture.end();
        return capture.capture();
      },
    });

    const metadata = addDeduplicationSavings(
      result.metadata,
      endpoint,
      body,
      result.response,
    );
    if (metadata.deduplicated) {
      try {
        await recordDeduplicatedRequest({
          routerKeyHash,
          account,
          endpoint,
          body,
          requestHeaders: request.headers,
          response: result.response,
          metadata,
          correlation,
          latencyMs: Date.now() - startedAt,
          startedAt,
        });
      } catch (analyticsError) {
        console.warn("Failed to record deduplicated request:", analyticsError);
      }
    }
    replayCapturedResponse(
      response,
      result.response,
      metadata,
      correlation,
      Date.now() - startedAt,
    );
  } catch (error) {
    if (!response.headersSent) {
      setFailureRoutingHeaders(response, error, correlation);
      sendBodyParsingError(response, endpoint, error);
    } else if (!response.writableEnded) {
      response.end();
    }
  }
}

export async function startServer(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });

  server.listen(port, () => {
    console.log(`Free LLM Router: http://localhost:${port}`);
    console.log(`Router dashboard: http://localhost:${port}/dashboard`);
    console.log(`OpenAI-compatible endpoint: http://localhost:${port}/v1/chat/completions`);
    console.log(`Codex Responses endpoint: http://localhost:${port}/v1/responses`);
    console.log(`Claude Code gateway: http://localhost:${port}`);
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
