import type {
  AttemptFailure,
  CapabilityMatch,
  CapabilityRequirements,
  CapabilityUnknownMode,
  ProviderAttemptMetric,
  ProviderCapabilityName,
  ProviderCandidateEvaluation,
  ProviderFailureType,
  ProviderFailoverReason,
  ProviderRoutingStats,
  ProviderRuntime,
  ReliabilitySettings,
  RetryStopReason,
  RoutingPolicy,
} from "./types.js";
import {
  detectCapabilityRequirements,
  matchProviderCapabilities,
} from "./provider-capabilities.js";
import { providerQuotaStatus } from "./provider-quotas.js";
import { normalizeReliabilitySettings } from "./reliability-settings.js";

const MAX_RATE_LIMIT_COOLDOWN_MS = 24 * 60 * 60_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30_000;
const CIRCUIT_FAILURE_THRESHOLD = 3;

function inferUnsupportedCapabilities(
  status: number,
  message: string,
  required: ProviderCapabilityName[],
): ProviderCapabilityName[] {
  if (![400, 404, 415, 422].includes(status) || required.length === 0) return [];
  const text = message.toLowerCase();
  const patterns: Partial<Record<ProviderCapabilityName, RegExp>> = {
    streaming: /(stream|sse).*(not supported|unsupported|unavailable)|does not support.*stream/,
    tools: /(tool|function call).*(not supported|unsupported|unavailable)|does not support.*(tool|function)/,
    jsonMode: /(json mode|response_format).*(not supported|unsupported|invalid)|does not support.*json/,
    structuredOutputs: /(json schema|structured output).*(not supported|unsupported|invalid)|does not support.*schema/,
    vision: /(image|vision|multimodal).*(not supported|unsupported|invalid)|does not support.*(image|vision)/,
    reasoning: /(reasoning|thinking).*(not supported|unsupported|invalid)|does not support.*(reasoning|thinking)/,
    embeddings: /(embedding).*(not supported|unsupported|invalid)|does not support.*embedding/,
  };
  return required.filter((capability) => patterns[capability]?.test(text));
}

const CIRCUIT_OPEN_DURATIONS_MS = [2, 5, 10, 15].map(
  (minutes) => minutes * 60_000,
);

export function parseRetryAfterMs(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) {
    return Math.min(
      MAX_RATE_LIMIT_COOLDOWN_MS,
      Math.max(0, Math.round(seconds * 1_000)),
    );
  }

  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.min(MAX_RATE_LIMIT_COOLDOWN_MS, Math.max(0, date - now));
}

function rateLimitCooldownMs(
  rateLimitCount: number,
  baseMs = DEFAULT_RATE_LIMIT_COOLDOWN_MS,
): number {
  const multipliers = [1, 2, 4, 10, 20, 30];
  const multiplier =
    multipliers[
      Math.min(Math.max(rateLimitCount - 1, 0), multipliers.length - 1)
    ] ?? 30;
  return Math.min(Math.max(1_000, baseMs) * multiplier, 15 * 60_000);
}

function circuitOpenDurationMs(openCount: number): number {
  return (
    CIRCUIT_OPEN_DURATIONS_MS[
      Math.min(Math.max(openCount - 1, 0), CIRCUIT_OPEN_DURATIONS_MS.length - 1)
    ] ?? 15 * 60_000
  );
}


export function providerFailoverReason(
  status: number,
): ProviderFailoverReason | undefined {
  switch (status) {
    case 401:
      return "provider_authentication_failed";
    case 403:
      return "provider_access_denied";
    case 404:
      return "provider_model_or_endpoint_unavailable";
    default:
      return undefined;
  }
}

export function classifyProviderFailure(
  status: number | undefined,
  error?: unknown,
): ProviderFailureType | undefined {
  if (status !== undefined && status >= 500 && status <= 599) {
    return "server_error";
  }
  if (status === 408) return "timeout";
  if (!error) return undefined;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("aborterror")
  ) {
    return "timeout";
  }
  if (
    normalized.includes("fetch failed") ||
    normalized.includes("econn") ||
    normalized.includes("enotfound") ||
    normalized.includes("dns") ||
    normalized.includes("socket") ||
    normalized.includes("network") ||
    normalized.includes("connection")
  ) {
    return "connection_error";
  }
  return "connection_error";
}

export class AllProvidersFailedError extends Error {
  constructor(
    public readonly attempts: AttemptFailure[],
    public readonly providerEvaluations: ProviderCandidateEvaluation[] = [],
    public readonly providerAttempts: ProviderAttemptMetric[] = [],
    public readonly retryStopReason?: RetryStopReason,
  ) {
    super("All configured providers failed");
  }
}

export class AllProvidersCoolingDownError extends Error {
  public readonly retryAt: number;

  constructor(
    public readonly providers: Array<{
      providerId: string;
      cooldownUntil: number;
      cooldownReason: "rate_limit";
    }>,
    public readonly providerAttempts: ProviderAttemptMetric[] = [],
  ) {
    super("All compatible providers are temporarily cooling down");
    this.retryAt = Math.min(...providers.map((provider) => provider.cooldownUntil));
  }
}

export class AllProvidersQuotaExhaustedError extends Error {
  public readonly retryAt: number;

  constructor(
    public readonly providers: Array<{
      providerId: string;
      resetAt: number;
      consumedPercent: number;
      exhaustedLimits: Array<
        "daily_requests" | "monthly_requests" | "daily_tokens" | "monthly_tokens"
      >;
    }>,
  ) {
    super("All compatible providers have exhausted their configured quota");
    this.retryAt = Math.min(...providers.map((provider) => provider.resetAt));
  }
}

export class AllProvidersUnavailableError extends Error {
  public readonly retryAt: number;

  constructor(
    public readonly providers: Array<{
      providerId: string;
      state: "cooldown" | "circuit-open" | "half-open";
      retryAt: number;
      failureType?: ProviderFailureType;
    }>,
    public readonly providerAttempts: ProviderAttemptMetric[] = [],
  ) {
    super("All compatible providers are temporarily unavailable");
    this.retryAt = Math.min(...providers.map((provider) => provider.retryAt));
  }
}

export class NoCompatibleProvidersError extends Error {
  constructor(
    public readonly requirements: CapabilityRequirements,
    public readonly providers: Array<{
      providerId: string;
      match: CapabilityMatch;
    }>,
  ) {
    super("No configured provider is compatible with this request");
  }
}

export interface ProviderRouterOptions {
  policy?: RoutingPolicy;
  stats?: Record<string, ProviderRoutingStats>;
  roundRobinCursor?: number;
  onAttempt?: (attempt: ProviderAttemptMetric) => void | Promise<void>;
  claimHalfOpenProbe?: (providerId: string) => boolean | Promise<boolean>;
  reliability?: ReliabilitySettings;
  requestId?: string;
  requestStartedAt?: number;
  capabilityUnknownMode?: CapabilityUnknownMode;
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `${response.status} ${response.statusText}`.trim();
  try {
    const body = (await response.clone().json()) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof body.error === "string") return body.error;
    return body.error?.message ?? body.message ?? fallback;
  } catch {
    return fallback;
  }
}

async function validateSuccessfulResponse(
  response: Response,
  streaming: boolean,
): Promise<string | undefined> {
  if (streaming) {
    return response.body ? undefined : "Provider returned an empty streaming response";
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) return undefined;
  try {
    const body = await response.clone().json();
    if (!body || typeof body !== "object") {
      return "Provider returned a malformed JSON response";
    }
    return undefined;
  } catch {
    return "Provider returned invalid JSON";
  }
}

async function waitForRetryDelay(
  delayMs: number,
  requestSignal?: AbortSignal,
): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => requestSignal?.removeEventListener("abort", abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(requestSignal?.reason ?? new Error("Request aborted during retry delay"));
    };
    if (requestSignal?.aborted) {
      abort();
      return;
    }
    requestSignal?.addEventListener("abort", abort, { once: true });
  });
}

function compareNumbers(left: number, right: number): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function attemptTiming(startedAt: number, requestStartedAt: number): Pick<
  ProviderAttemptMetric,
  "startedAt" | "completedAt" | "startedElapsedMs" | "completedElapsedMs" | "totalElapsedMs"
> {
  const completedAt = Date.now();
  const completedElapsedMs = completedAt - requestStartedAt;
  return {
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    startedElapsedMs: Math.max(0, startedAt - requestStartedAt),
    completedElapsedMs,
    totalElapsedMs: completedElapsedMs,
  };
}

export class ProviderRouter {
  private readonly policy: RoutingPolicy;
  private readonly stats: Record<string, ProviderRoutingStats>;
  private readonly reliability: ReliabilitySettings;

  constructor(
    private readonly providers: ProviderRuntime[],
    private readonly fetcher: typeof fetch = fetch,
    private readonly options: ProviderRouterOptions = {},
  ) {
    this.policy = options.policy ?? { strategy: "priority", providerOrder: [] };
    this.stats = options.stats ?? {};
    this.reliability = normalizeReliabilitySettings(options.reliability);

    for (const provider of this.providers) {
      const stats = this.stats[provider.id];
      provider.cooldownUntil = Math.max(
        provider.cooldownUntil ?? 0,
        stats?.cooldownUntil ?? 0,
      );
      provider.failures = stats?.rateLimitCount ?? provider.failures ?? 0;
      provider.circuitState = stats?.circuitState ?? provider.circuitState ?? "closed";
      provider.circuitOpenUntil = Math.max(
        provider.circuitOpenUntil ?? 0,
        stats?.circuitOpenUntil ?? 0,
      );
      provider.circuitFailureCount =
        stats?.circuitFailureCount ?? provider.circuitFailureCount ?? 0;
      provider.circuitOpenCount =
        stats?.circuitOpenCount ?? provider.circuitOpenCount ?? 0;
      provider.halfOpenProbeActive =
        stats?.halfOpenProbeActive ?? provider.halfOpenProbeActive ?? false;
      const quotaUsage = stats?.quotaUsage ?? provider.quotaUsage;
      if (quotaUsage) provider.quotaUsage = quotaUsage;
    }
  }

  listProviders(): Array<{
    id: string;
    model: string;
    available: boolean;
    cooldownUntil: number;
    circuitState: ProviderRuntime["circuitState"];
    circuitOpenUntil: number;
    capabilities: ProviderRuntime["capabilities"];
    quota: ReturnType<typeof providerQuotaStatus>;
  }> {
    const now = Date.now();
    return this.providers.map((provider) => {
      const quota = providerQuotaStatus(provider.quotaConfig, provider.quotaUsage, now);
      return {
      id: provider.id,
      model: provider.model,
      available:
        provider.cooldownUntil <= now &&
        provider.circuitState === "closed" &&
        quota?.exhausted !== true,
      cooldownUntil: provider.cooldownUntil,
      circuitState: provider.circuitState,
      circuitOpenUntil: provider.circuitOpenUntil,
      capabilities: provider.capabilities,
      quota,
    };
    });
  }

  async chatCompletion(
    incomingBody: Record<string, unknown>,
    requestSignal?: AbortSignal,
    requirements: CapabilityRequirements = detectCapabilityRequirements(incomingBody),
  ): Promise<{
    response: Response;
    providerId: string;
    requirements: CapabilityRequirements;
    capabilityMatch: CapabilityMatch;
    providerEvaluations: ProviderCandidateEvaluation[];
    attempts: ProviderAttemptMetric[];
  }> {
    const requestStartedAt = this.options.requestStartedAt ?? Date.now();
    const { candidates, evaluations } = await this.orderedCandidates(requirements);
    const failures: AttemptFailure[] = [];
    const providerAttempts: ProviderAttemptMetric[] = [];
    let finalStopReason: RetryStopReason | undefined;

    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const provider = candidates[candidateIndex]!;
      const attemptNumber = providerAttempts.length + 1;
      const elapsedBeforeAttempt = Date.now() - requestStartedAt;
      const remainingTotalMs = this.reliability.totalRequestTimeoutMs - elapsedBeforeAttempt;
      if (remainingTotalMs <= 0) {
        finalStopReason = "total_request_deadline_exceeded";
        break;
      }
      if (attemptNumber > this.reliability.maxProviderAttempts) {
        finalStopReason = "maximum_attempts_reached";
        break;
      }

      const isHalfOpen = provider.circuitState === "half-open";
      const configuredTimeoutMs = this.providerTimeoutMs(
        provider,
        incomingBody.stream === true,
        isHalfOpen,
      );
      const timeoutMs = Math.max(1, Math.min(configuredTimeoutMs, remainingTotalMs));
      const deadlineControlsTimeout = remainingTotalMs <= configuredTimeoutMs;
      const controller = new AbortController();
      let providerTimedOut = false;
      let totalDeadlineTimedOut = false;
      const timeout = setTimeout(() => {
        providerTimedOut = true;
        totalDeadlineTimedOut = deadlineControlsTimeout;
        controller.abort(new Error(
          deadlineControlsTimeout
            ? "Total request deadline exceeded"
            : "Provider request timed out",
        ));
      }, timeoutMs);
      const abortFromRequest = () => controller.abort(requestSignal?.reason);
      requestSignal?.addEventListener("abort", abortFromRequest, { once: true });
      const startedAt = Date.now();

      try {
        const response = await this.fetcher(`${provider.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(provider.apiKeyValue
              ? { authorization: `Bearer ${provider.apiKeyValue}` }
              : {}),
            ...provider.headers,
            ...(this.options.requestId
              ? { "x-request-id": this.options.requestId }
              : {}),
          },
          body: JSON.stringify({
            ...incomingBody,
            model: provider.model,
          }),
          signal: controller.signal,
        });

        const headersLatencyMs = Date.now() - startedAt;
        if (response.ok) {
          const malformed = await validateSuccessfulResponse(
            response,
            incomingBody.stream === true,
          );
          const latencyMs = Date.now() - startedAt;
          if (!malformed) {
            provider.failures = 0;
            provider.circuitState = "closed";
            provider.circuitOpenUntil = 0;
            provider.circuitFailureCount = 0;
            provider.circuitOpenCount = 0;
            provider.halfOpenProbeActive = false;
            await this.emitAttempt(providerAttempts, {
              providerId: provider.id,
              providerModel: provider.model,
              success: true,
              status: response.status,
              latencyMs,
              headersLatencyMs,
              attemptNumber,
              providerTimeoutMs: timeoutMs,
              ...attemptTiming(startedAt, requestStartedAt),
              circuitAction: isHalfOpen ? "closed" : "none",
              circuitState: "closed",
              circuitFailureCount: 0,
              circuitOpenCount: 0,
              halfOpenProbeActive: false,
              requiredCapabilities: [...requirements.required],
              observedSupportedCapabilities: [...requirements.required],
            });
            return {
              response,
              providerId: provider.id,
              requirements,
              capabilityMatch: matchProviderCapabilities(
                provider.capabilities,
                requirements,
                this.options.capabilityUnknownMode ?? "flexible",
              ),
              providerEvaluations: evaluations,
              attempts: providerAttempts,
            };
          }

          const retry = this.retryDecision({
            retryable: this.reliability.retryMalformedResponses,
            attemptNumber,
            candidateIndex,
            candidateCount: candidates.length,
            requestStartedAt,
          });
          failures.push({
            provider: provider.id,
            providerModel: provider.model,
            status: 502,
            message: malformed,
            retryable: this.reliability.retryMalformedResponses,
            ...(retry.stopReason ? { retryStopReason: retry.stopReason } : {}),
          });
          await this.recordCircuitFailure(
            provider,
            evaluations,
            "malformed_response",
            malformed,
            latencyMs,
            502,
            isHalfOpen,
            providerAttempts,
            {
              attemptNumber,
              headersLatencyMs,
              providerTimeoutMs: timeoutMs,
              retryable: this.reliability.retryMalformedResponses,
              ...(retry.delayMs !== undefined ? { retryDelayMs: retry.delayMs } : {}),
              ...(retry.stopReason ? { retryStopReason: retry.stopReason } : {}),
              ...attemptTiming(startedAt, requestStartedAt),
            },
          );
          if (!retry.retry) {
            finalStopReason = retry.stopReason;
            break;
          }
          clearTimeout(timeout);
          requestSignal?.removeEventListener("abort", abortFromRequest);
          await waitForRetryDelay(retry.delayMs ?? 0, requestSignal);
          continue;
        }

        const message = await readErrorMessage(response);
        const latencyMs = Date.now() - startedAt;
        const observedUnsupportedCapabilities = inferUnsupportedCapabilities(
          response.status,
          message,
          requirements.required,
        );
        const failoverReason = observedUnsupportedCapabilities.length
          ? "provider_capability_unsupported" as const
          : providerFailoverReason(response.status);
        const retryable = failoverReason === undefined
          && this.reliability.retryStatusCodes.includes(response.status);
        const recovery = failoverReason
          ? this.immediateFailoverDecision({
              attemptNumber,
              candidateIndex,
              candidateCount: candidates.length,
              requestStartedAt,
            })
          : this.retryDecision({
              retryable,
              attemptNumber,
              candidateIndex,
              candidateCount: candidates.length,
              requestStartedAt,
            });
        const recoveryAction = recovery.retry
          ? failoverReason ? "immediate_failover" : "retry_with_backoff"
          : "stop";
        failures.push({
          provider: provider.id,
          status: response.status,
          message,
          retryable,
          recoveryAction,
          ...(failoverReason ? { failoverReason } : {}),
          ...(recovery.stopReason ? { retryStopReason: recovery.stopReason } : {}),
        });

        if (response.status === 429) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          const priorCount =
            this.stats[provider.id]?.rateLimitCount ?? provider.failures ?? 0;
          const currentCount = priorCount + 1;
          const fallbackMs = rateLimitCooldownMs(
            currentCount,
            provider.cooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
          );
          const cooldownMs = Math.min(
            MAX_RATE_LIMIT_COOLDOWN_MS,
            Math.max(retryAfterMs ?? 0, fallbackMs),
          );
          provider.failures = currentCount;
          provider.cooldownUntil = Date.now() + cooldownMs;
          if (isHalfOpen) {
            provider.circuitState = "closed";
            provider.circuitOpenUntil = 0;
            provider.circuitFailureCount = 0;
            provider.circuitOpenCount = 0;
            provider.halfOpenProbeActive = false;
          }
          const evaluation = evaluations.find(
            (candidate) => candidate.providerId === provider.id,
          );
          if (evaluation) {
            evaluation.state = "cooldown";
            evaluation.cooldownUntil = provider.cooldownUntil;
            evaluation.cooldownReason = "rate_limit";
          }

          await this.emitAttempt(providerAttempts, {
            providerId: provider.id,
            providerModel: provider.model,
            success: false,
            status: response.status,
            message,
            latencyMs,
            headersLatencyMs,
            attemptNumber,
            providerTimeoutMs: timeoutMs,
            retryable,
            recoveryAction,
            ...(failoverReason ? { failoverReason } : {}),
            ...(recovery.delayMs !== undefined ? { retryDelayMs: recovery.delayMs } : {}),
            ...(recovery.stopReason ? { retryStopReason: recovery.stopReason } : {}),
            ...attemptTiming(startedAt, requestStartedAt),
            cooldownUntil: provider.cooldownUntil,
            cooldownReason: "rate_limit",
            circuitAction: isHalfOpen ? "closed" : "none",
            circuitState: provider.circuitState,
            circuitFailureCount: provider.circuitFailureCount,
            circuitOpenCount: provider.circuitOpenCount,
            halfOpenProbeActive: false,
            requiredCapabilities: [...requirements.required],
            ...(observedUnsupportedCapabilities.length
              ? { observedUnsupportedCapabilities } : {}),
            ...(retryAfterMs !== undefined
              ? { retryAfterSeconds: Math.ceil(retryAfterMs / 1_000) }
              : {}),
          });
        } else {
          const failureType = classifyProviderFailure(response.status);
          if (failureType) {
            await this.recordCircuitFailure(
              provider,
              evaluations,
              failureType,
              message,
              latencyMs,
              response.status,
              isHalfOpen,
              providerAttempts,
              {
                attemptNumber,
                providerTimeoutMs: timeoutMs,
                retryable,
                recoveryAction,
                ...(failoverReason ? { failoverReason } : {}),
                ...(recovery.delayMs !== undefined ? { retryDelayMs: recovery.delayMs } : {}),
                ...(recovery.stopReason ? { retryStopReason: recovery.stopReason } : {}),
                ...attemptTiming(startedAt, requestStartedAt),
                requiredCapabilities: [...requirements.required],
                ...(observedUnsupportedCapabilities.length
                  ? { observedUnsupportedCapabilities } : {}),
              },
            );
          } else {
            await this.emitAttempt(providerAttempts, {
              providerId: provider.id,
              providerModel: provider.model,
              success: false,
              status: response.status,
              message,
              latencyMs,
              headersLatencyMs,
              attemptNumber,
              providerTimeoutMs: timeoutMs,
              retryable,
              recoveryAction,
              ...(failoverReason ? { failoverReason } : {}),
              ...(recovery.delayMs !== undefined ? { retryDelayMs: recovery.delayMs } : {}),
              ...(recovery.stopReason ? { retryStopReason: recovery.stopReason } : {}),
              ...attemptTiming(startedAt, requestStartedAt),
              circuitState: provider.circuitState,
              circuitFailureCount: provider.circuitFailureCount,
              circuitOpenCount: provider.circuitOpenCount,
              halfOpenProbeActive: false,
              requiredCapabilities: [...requirements.required],
              ...(observedUnsupportedCapabilities.length
                ? { observedUnsupportedCapabilities } : {}),
            });
          }
        }

        if (!recovery.retry) {
          finalStopReason = recovery.stopReason;
          break;
        }
        clearTimeout(timeout);
        requestSignal?.removeEventListener("abort", abortFromRequest);
        if (recovery.delayMs !== undefined) {
          await waitForRetryDelay(recovery.delayMs, requestSignal);
        }
      } catch (error) {
        if (requestSignal?.aborted && !providerTimedOut) throw error;
        const message = totalDeadlineTimedOut
          ? "Total request deadline exceeded"
          : providerTimedOut
            ? "Provider request timed out"
            : error instanceof Error ? error.message : String(error);
        const failureType = classifyProviderFailure(undefined, new Error(message));
        const retryable = !totalDeadlineTimedOut && this.reliability.retryNetworkErrors;
        const retry = totalDeadlineTimedOut
          ? { retry: false, stopReason: "total_request_deadline_exceeded" as const }
          : this.retryDecision({
              retryable,
              attemptNumber,
              candidateIndex,
              candidateCount: candidates.length,
              requestStartedAt,
            });
        failures.push({
          provider: provider.id,
          providerModel: provider.model,
          message,
          retryable,
          ...(retry.stopReason ? { retryStopReason: retry.stopReason } : {}),
        });
        await this.recordCircuitFailure(
          provider,
          evaluations,
          failureType ?? "connection_error",
          message,
          Date.now() - startedAt,
          undefined,
          isHalfOpen,
          providerAttempts,
          {
            attemptNumber,
            providerTimeoutMs: timeoutMs,
            retryable,
            ...(retry.delayMs !== undefined ? { retryDelayMs: retry.delayMs } : {}),
            ...(retry.stopReason ? { retryStopReason: retry.stopReason } : {}),
            ...attemptTiming(startedAt, requestStartedAt),
          },
        );
        if (!retry.retry) {
          finalStopReason = retry.stopReason;
          break;
        }
        clearTimeout(timeout);
        requestSignal?.removeEventListener("abort", abortFromRequest);
        await waitForRetryDelay(retry.delayMs ?? 0, requestSignal);
      } finally {
        clearTimeout(timeout);
        requestSignal?.removeEventListener("abort", abortFromRequest);
      }
    }

    this.throwIfEveryProviderUnavailable(requirements, providerAttempts);
    throw new AllProvidersFailedError(
      failures,
      evaluations,
      providerAttempts,
      finalStopReason ?? "no_more_candidates",
    );
  }

  private providerTimeoutMs(
    provider: ProviderRuntime,
    streaming: boolean,
    halfOpen: boolean,
  ): number {
    if (halfOpen) return this.reliability.halfOpenProbeTimeoutMs;
    const override = this.reliability.providerTimeoutOverrides[provider.id];
    if (override) return override;
    if (provider.timeoutMs) return provider.timeoutMs;
    return streaming
      ? this.reliability.streamingConnectionTimeoutMs
      : this.reliability.providerTimeoutMs;
  }

  private retryDelayMs(attemptNumber: number): number {
    const base = Math.min(
      this.reliability.maxBackoffMs,
      this.reliability.initialBackoffMs *
        Math.pow(this.reliability.backoffMultiplier, Math.max(0, attemptNumber - 1)),
    );
    if (!this.reliability.useJitter || base <= 0) return Math.round(base);
    return Math.round(base * (0.5 + Math.random()));
  }

  private immediateFailoverDecision(params: {
    attemptNumber: number;
    candidateIndex: number;
    candidateCount: number;
    requestStartedAt: number;
  }): { retry: boolean; delayMs?: number; stopReason?: RetryStopReason } {
    if (params.attemptNumber >= this.reliability.maxProviderAttempts) {
      return { retry: false, stopReason: "maximum_attempts_reached" };
    }
    if (params.candidateIndex >= params.candidateCount - 1) {
      return { retry: false, stopReason: "no_more_candidates" };
    }
    if (Date.now() - params.requestStartedAt >= this.reliability.totalRequestTimeoutMs) {
      return { retry: false, stopReason: "total_request_deadline_exceeded" };
    }
    return { retry: true };
  }

  private retryDecision(params: {
    retryable: boolean;
    attemptNumber: number;
    candidateIndex: number;
    candidateCount: number;
    requestStartedAt: number;
  }): { retry: boolean; delayMs?: number; stopReason?: RetryStopReason } {
    if (!params.retryable) {
      return { retry: false, stopReason: "error_not_retryable" };
    }
    if (params.attemptNumber >= this.reliability.maxProviderAttempts) {
      return { retry: false, stopReason: "maximum_attempts_reached" };
    }
    if (params.candidateIndex >= params.candidateCount - 1) {
      return { retry: false, stopReason: "no_more_candidates" };
    }
    const delayMs = this.retryDelayMs(params.attemptNumber);
    const elapsedMs = Date.now() - params.requestStartedAt;
    if (elapsedMs + delayMs >= this.reliability.totalRequestTimeoutMs) {
      return { retry: false, stopReason: "total_request_deadline_exceeded" };
    }
    return { retry: true, delayMs };
  }

  private async emitAttempt(
    attempts: ProviderAttemptMetric[],
    attempt: ProviderAttemptMetric,
  ): Promise<void> {
    attempts.push(attempt);
    await this.options.onAttempt?.(attempt);
  }

  private async recordCircuitFailure(
    provider: ProviderRuntime,
    evaluations: ProviderCandidateEvaluation[],
    failureType: ProviderFailureType,
    message: string,
    latencyMs: number,
    status: number | undefined,
    isHalfOpen: boolean,
    attempts: ProviderAttemptMetric[],
    retryMetadata: Pick<ProviderAttemptMetric,
      | "attemptNumber"
      | "providerTimeoutMs"
      | "headersLatencyMs"
      | "retryable"
      | "recoveryAction"
      | "failoverReason"
      | "retryDelayMs"
      | "retryStopReason"
      | "startedAt"
      | "completedAt"
      | "startedElapsedMs"
      | "completedElapsedMs"
      | "totalElapsedMs"
      | "requiredCapabilities"
      | "observedUnsupportedCapabilities"
    >,
  ): Promise<void> {
    const failureCount = isHalfOpen
      ? Math.max(CIRCUIT_FAILURE_THRESHOLD, provider.circuitFailureCount + 1)
      : provider.circuitFailureCount + 1;
    const shouldOpen = isHalfOpen || failureCount >= CIRCUIT_FAILURE_THRESHOLD;
    let circuitAction: ProviderAttemptMetric["circuitAction"] = "none";

    if (shouldOpen) {
      const openCount = provider.circuitOpenCount + 1;
      provider.circuitState = "open";
      provider.circuitOpenCount = openCount;
      provider.circuitFailureCount = failureCount;
      provider.circuitOpenUntil = Date.now() + circuitOpenDurationMs(openCount);
      provider.halfOpenProbeActive = false;
      circuitAction = isHalfOpen ? "reopened" : "opened";
      const evaluation = evaluations.find(
        (candidate) => candidate.providerId === provider.id,
      );
      if (evaluation) {
        evaluation.state = "circuit-open";
        evaluation.circuitState = "open";
        evaluation.circuitOpenUntil = provider.circuitOpenUntil;
        evaluation.circuitFailureCount = failureCount;
        evaluation.circuitOpenCount = openCount;
        evaluation.lastFailureType = failureType;
        evaluation.halfOpenProbeActive = false;
      }
    } else {
      provider.circuitFailureCount = failureCount;
    }

    await this.emitAttempt(attempts, {
      providerId: provider.id,
      providerModel: provider.model,
      success: false,
      ...(status !== undefined ? { status } : {}),
      message,
      latencyMs,
      failureType,
      circuitAction,
      circuitState: provider.circuitState,
      ...(provider.circuitOpenUntil > 0
        ? { circuitOpenUntil: provider.circuitOpenUntil }
        : {}),
      circuitFailureCount: provider.circuitFailureCount,
      circuitOpenCount: provider.circuitOpenCount,
      halfOpenProbeActive: provider.halfOpenProbeActive,
      ...retryMetadata,
    });
  }

  private async orderedCandidates(
    requirements: CapabilityRequirements,
  ): Promise<{ candidates: ProviderRuntime[]; evaluations: ProviderCandidateEvaluation[] }> {
    const matches = new Map(
      this.providers.map((provider) => [
        provider.id,
        matchProviderCapabilities(
          provider.capabilities,
          requirements,
          this.options.capabilityUnknownMode ?? "flexible",
        ),
      ]),
    );
    const compatibleProviders = this.providers.filter(
      (provider) => matches.get(provider.id)?.level !== "incompatible",
    );

    if (compatibleProviders.length === 0) {
      throw new NoCompatibleProvidersError(
        requirements,
        this.providers.map((provider) => ({
          providerId: provider.id,
          providerModel: provider.model,
          match: matches.get(provider.id) ?? {
            level: "partial",
            supported: [],
            unknown: requirements.required,
            unsupported: [],
          },
        })),
      );
    }

    const now = Date.now();
    const quotaStatuses = new Map(
      compatibleProviders.map((provider) => [
        provider.id,
        providerQuotaStatus(provider.quotaConfig, provider.quotaUsage, now),
      ]),
    );
    const quotaAvailable = compatibleProviders.filter(
      (provider) => quotaStatuses.get(provider.id)?.exhausted !== true,
    );

    if (quotaAvailable.length === 0) {
      throw new AllProvidersQuotaExhaustedError(
        compatibleProviders.map((provider) => {
          const quota = quotaStatuses.get(provider.id);
          return {
            providerId: provider.id,
            resetAt: quota?.nextResetAt ?? now + 60_000,
            consumedPercent: quota?.consumedPercent ?? 100,
            exhaustedLimits: quota?.exhaustedLimits ?? [],
          };
        }),
      );
    }

    const cooldownFree = quotaAvailable.filter(
      (provider) => provider.cooldownUntil <= now,
    );
    const closedProviders = cooldownFree.filter(
      (provider) => provider.circuitState === "closed",
    );
    const recoverableProviders = cooldownFree.filter(
      (provider) =>
        (provider.circuitState === "open" && provider.circuitOpenUntil <= now) ||
        provider.circuitState === "half-open",
    );

    let halfOpenProvider: ProviderRuntime | undefined;
    const orderedRecoverable = this.orderByMatch(recoverableProviders, matches);
    for (const provider of orderedRecoverable) {
      const claimed = this.options.claimHalfOpenProbe
        ? await this.options.claimHalfOpenProbe(provider.id)
        : true;
      if (!claimed) continue;
      provider.circuitState = "half-open";
      provider.halfOpenProbeActive = true;
      halfOpenProvider = provider;
      break;
    }

    const orderedClosed = this.orderByMatch(closedProviders, matches);
    const candidates = [
      ...(halfOpenProvider ? [halfOpenProvider] : []),
      ...orderedClosed,
    ];

    if (candidates.length === 0) {
      this.throwUnavailableFromProviders(quotaAvailable);
    }

    const candidateRanks = new Map(
      candidates.map((provider, index) => [provider.id, index + 1]),
    );
    const evaluations: ProviderCandidateEvaluation[] = this.providers.map((provider) => {
      const match = matches.get(provider.id) ?? {
        level: "partial" as const,
        supported: [],
        unknown: requirements.required,
        unsupported: [],
      };

      if (match.level === "incompatible") {
        return { providerId: provider.id, providerModel: provider.model, match, ...(provider.capabilitySources ? { capabilitySources: provider.capabilitySources } : {}), state: "incompatible" };
      }

      const quota = quotaStatuses.get(provider.id);
      const quotaDetails = quota
        ? {
            quotaWarning: quota.warning,
            quotaExhausted: quota.exhausted,
            quotaConsumedPercent: quota.consumedPercent,
            quotaRemainingRatio: quota.remainingRatio,
            ...(quota.nextResetAt !== undefined ? { quotaResetAt: quota.nextResetAt } : {}),
            quotaExhaustedLimits: quota.exhaustedLimits,
          }
        : {};

      if (quota?.exhausted) {
        return {
          providerId: provider.id,
          providerModel: provider.model,
          match,
          ...(provider.capabilitySources ? { capabilitySources: provider.capabilitySources } : {}),
          state: "quota-exhausted",
          ...quotaDetails,
        };
      }

      if (provider.cooldownUntil > now) {
        return {
          providerId: provider.id,
          providerModel: provider.model,
          match,
          ...(provider.capabilitySources ? { capabilitySources: provider.capabilitySources } : {}),
          state: "cooldown",
          cooldownUntil: provider.cooldownUntil,
          cooldownReason: "rate_limit",
          ...quotaDetails,
        };
      }

      if (provider.id === halfOpenProvider?.id) {
        const candidateRank = candidateRanks.get(provider.id);
        const lastFailureType = this.stats[provider.id]?.lastFailureType;
        return {
          providerId: provider.id,
          providerModel: provider.model,
          match,
          ...(provider.capabilitySources ? { capabilitySources: provider.capabilitySources } : {}),
          state: "half-open",
          ...(candidateRank !== undefined ? { candidateRank } : {}),
          circuitState: "half-open",
          circuitOpenUntil: provider.circuitOpenUntil,
          circuitFailureCount: provider.circuitFailureCount,
          circuitOpenCount: provider.circuitOpenCount,
          halfOpenProbeActive: true,
          ...(lastFailureType ? { lastFailureType } : {}),
          ...quotaDetails,
        };
      }

      if (provider.circuitState !== "closed") {
        const lastFailureType = this.stats[provider.id]?.lastFailureType;
        return {
          providerId: provider.id,
          providerModel: provider.model,
          match,
          ...(provider.capabilitySources ? { capabilitySources: provider.capabilitySources } : {}),
          state: "circuit-open",
          circuitState: provider.circuitState,
          circuitOpenUntil: provider.circuitOpenUntil,
          circuitFailureCount: provider.circuitFailureCount,
          circuitOpenCount: provider.circuitOpenCount,
          halfOpenProbeActive: provider.halfOpenProbeActive,
          ...(lastFailureType ? { lastFailureType } : {}),
          ...quotaDetails,
        };
      }

      const candidateRank = candidateRanks.get(provider.id);
      return {
        providerId: provider.id,
        providerModel: provider.model,
        match,
        ...(provider.capabilitySources ? { capabilitySources: provider.capabilitySources } : {}),
        state: "candidate",
        ...(candidateRank !== undefined ? { candidateRank } : {}),
        ...quotaDetails,
      };
    });

    return { candidates, evaluations };
  }

  private orderByMatch(
    providers: ProviderRuntime[],
    matches: Map<string, CapabilityMatch>,
  ): ProviderRuntime[] {
    const fullMatches = providers.filter(
      (provider) => matches.get(provider.id)?.level === "full",
    );
    const partialMatches = providers.filter(
      (provider) => matches.get(provider.id)?.level === "partial",
    );
    return [
      ...this.orderQuotaAwarePool(fullMatches),
      ...this.orderQuotaAwarePool(partialMatches),
    ];
  }

  private orderQuotaAwarePool(pool: ProviderRuntime[]): ProviderRuntime[] {
    const healthy = pool.filter(
      (provider) =>
        providerQuotaStatus(provider.quotaConfig, provider.quotaUsage)?.warning !== true,
    );
    const warning = pool.filter(
      (provider) =>
        providerQuotaStatus(provider.quotaConfig, provider.quotaUsage)?.warning === true,
    );
    const orderedWarning = this.orderPool(warning);
    orderedWarning.sort((left, right) => {
      const leftRemaining = providerQuotaStatus(
        left.quotaConfig,
        left.quotaUsage,
      )?.remainingRatio ?? 1;
      const rightRemaining = providerQuotaStatus(
        right.quotaConfig,
        right.quotaUsage,
      )?.remainingRatio ?? 1;
      return compareNumbers(rightRemaining, leftRemaining);
    });
    return [...this.orderPool(healthy), ...orderedWarning];
  }

  private throwIfEveryProviderUnavailable(
    requirements: CapabilityRequirements,
    attempts: ProviderAttemptMetric[] = [],
  ): void {
    const compatible = this.providers.filter(
      (provider) =>
        matchProviderCapabilities(
          provider.capabilities,
          requirements,
          this.options.capabilityUnknownMode ?? "flexible",
        ).level !== "incompatible" &&
        providerQuotaStatus(provider.quotaConfig, provider.quotaUsage)?.exhausted !== true,
    );
    const now = Date.now();
    if (
      compatible.length > 0 &&
      compatible.every(
        (provider) =>
          provider.cooldownUntil > now || provider.circuitState !== "closed",
      )
    ) {
      this.throwUnavailableFromProviders(compatible, attempts);
    }
  }

  private throwUnavailableFromProviders(
    providers: ProviderRuntime[],
    attempts: ProviderAttemptMetric[] = [],
  ): never {
    const now = Date.now();
    const cooldowns = providers.filter((provider) => provider.cooldownUntil > now);
    if (cooldowns.length === providers.length) {
      throw new AllProvidersCoolingDownError(
        cooldowns.map((provider) => ({
          providerId: provider.id,
          cooldownUntil: provider.cooldownUntil,
          cooldownReason: "rate_limit",
        })),
        attempts,
      );
    }

    throw new AllProvidersUnavailableError(
      providers.map((provider) => {
        if (provider.cooldownUntil > now) {
          return {
            providerId: provider.id,
            state: "cooldown" as const,
            retryAt: provider.cooldownUntil,
          };
        }
        const state = provider.circuitState === "half-open"
          ? "half-open" as const
          : "circuit-open" as const;
        const failureType = this.stats[provider.id]?.lastFailureType;
        return {
          providerId: provider.id,
          state,
          retryAt: Math.max(provider.circuitOpenUntil, now + 1_000),
          ...(failureType ? { failureType } : {}),
        };
      }),
      attempts,
    );
  }

  private orderPool(pool: ProviderRuntime[]): ProviderRuntime[] {
    const base = [...pool].sort((left, right) => this.comparePriority(left, right));

    switch (this.policy.strategy) {
      case "round-robin":
        return this.rotate(base, this.options.roundRobinCursor ?? 0);
      case "least-used":
        return [...base].sort((left, right) => {
          const leftStats = this.stats[left.id];
          const rightStats = this.stats[right.id];
          const usageComparison = compareNumbers(
            leftStats?.attempts ?? 0,
            rightStats?.attempts ?? 0,
          );
          if (usageComparison !== 0) return usageComparison;
          const leftUsed = Date.parse(leftStats?.lastUsedAt ?? "1970-01-01");
          const rightUsed = Date.parse(rightStats?.lastUsedAt ?? "1970-01-01");
          if (leftUsed !== rightUsed) return leftUsed - rightUsed;
          return this.comparePriority(left, right);
        });
      case "fastest":
        return [...base].sort((left, right) =>
          this.compareExploration(left, right) ||
          compareNumbers(
            this.stats[left.id]?.averageLatencyMs ?? Number.MAX_SAFE_INTEGER,
            this.stats[right.id]?.averageLatencyMs ?? Number.MAX_SAFE_INTEGER,
          ) ||
          this.comparePriority(left, right),
        );
      case "reliability":
        return [...base].sort((left, right) =>
          this.compareExploration(left, right) ||
          compareNumbers(
            this.stats[right.id]?.successScore ?? 0.75,
            this.stats[left.id]?.successScore ?? 0.75,
          ) ||
          compareNumbers(
            this.stats[left.id]?.averageLatencyMs ?? Number.MAX_SAFE_INTEGER,
            this.stats[right.id]?.averageLatencyMs ?? Number.MAX_SAFE_INTEGER,
          ) ||
          this.comparePriority(left, right),
        );
      case "smart":
        return [...base].sort((left, right) =>
          compareNumbers(this.smartScore(right, base), this.smartScore(left, base)) ||
          this.comparePriority(left, right),
        );
      case "priority":
      default:
        return base;
    }
  }

  private compareExploration(
    left: ProviderRuntime,
    right: ProviderRuntime,
  ): number {
    const leftNeedsSamples = (this.stats[left.id]?.attempts ?? 0) < 2;
    const rightNeedsSamples = (this.stats[right.id]?.attempts ?? 0) < 2;
    if (leftNeedsSamples === rightNeedsSamples) return 0;
    return leftNeedsSamples ? -1 : 1;
  }

  private smartScore(
    provider: ProviderRuntime,
    base: ProviderRuntime[],
  ): number {
    const stats = this.stats[provider.id];
    const reliability = stats?.successScore ?? 0.75;
    const latency = stats?.averageLatencyMs ?? 2_000;
    const latencyScore = 1 / (1 + latency / 1_000);
    const usageScore = 1 / (1 + (stats?.attempts ?? 0) / 10);
    const orderIndex = Math.max(
      0,
      base.findIndex((candidate) => candidate.id === provider.id),
    );
    const priorityScore = 1 / (1 + orderIndex);
    const failurePenalty = Math.min(stats?.consecutiveFailures ?? 0, 5) * 0.08;
    const explorationBonus = (stats?.attempts ?? 0) < 2 ? 0.08 : 0;
    const quotaScore = providerQuotaStatus(
      provider.quotaConfig,
      provider.quotaUsage,
    )?.remainingRatio ?? 1;

    return (
      reliability * 0.42 +
      latencyScore * 0.2 +
      usageScore * 0.12 +
      quotaScore * 0.18 +
      priorityScore * 0.08 +
      explorationBonus -
      failurePenalty
    );
  }

  private comparePriority(
    left: ProviderRuntime,
    right: ProviderRuntime,
  ): number {
    const leftRank = this.policy.providerOrder.indexOf(left.id);
    const rightRank = this.policy.providerOrder.indexOf(right.id);
    const leftOrder = leftRank >= 0 ? leftRank : Number.MAX_SAFE_INTEGER;
    const rightOrder = rightRank >= 0 ? rightRank : Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;

    const leftPriority = left.priority ?? 100;
    const rightPriority = right.priority ?? 100;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;

    return this.providers.indexOf(left) - this.providers.indexOf(right);
  }

  private rotate<T>(values: T[], cursor: number): T[] {
    if (values.length <= 1) return values;
    const start = ((cursor % values.length) + values.length) % values.length;
    return [...values.slice(start), ...values.slice(0, start)];
  }
}
