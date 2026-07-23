import type {
  DeduplicationMetadata,
  ProviderAttemptMetric,
  ProviderCandidateEvaluation,
  ProviderCapabilityName,
  RequestTimelineEvent,
  RequestTimelineEventType,
  RoutingStrategy,
  RequestIdSource,
} from "./types.js";
import { normalizeProviderId } from "./provider-identities.js";

interface TimelineParams {
  requestId?: string;
  clientRequestId?: string;
  requestIdSource?: RequestIdSource;
  startedAt?: number;
  completedAt?: number;
  latencyMs: number;
  status: number;
  providerId: string;
  requestedModel?: string;
  resolvedAlias?: string;
  routingStrategy?: RoutingStrategy;
  requiredCapabilities?: ProviderCapabilityName[];
  providerEvaluations?: ProviderCandidateEvaluation[];
  providerAttempts?: ProviderAttemptMetric[];
  deduplication?: DeduplicationMetadata;
  streaming?: boolean;
}

function clampElapsed(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.round(value), Math.max(0, maximum)));
}

function stateDetail(evaluation: ProviderCandidateEvaluation): string {
  switch (evaluation.state) {
    case "incompatible":
      return evaluation.match.unsupported.length
        ? `Skipped because required support is unavailable: ${evaluation.match.unsupported.join(", ")}.`
        : evaluation.match.unknown.length
          ? `Skipped by strict capability mode because support is unknown: ${evaluation.match.unknown.join(", ")}.`
          : "Skipped because the provider is incompatible with this request.";
    case "cooldown":
      return `Skipped during a rate-limit cooldown${evaluation.cooldownUntil ? ` until ${new Date(evaluation.cooldownUntil).toISOString()}` : ""}.`;
    case "quota-exhausted":
      return `Skipped because configured quota is exhausted${evaluation.quotaExhaustedLimits?.length ? ` (${evaluation.quotaExhaustedLimits.join(", ")})` : ""}.`;
    case "circuit-open":
      return `Skipped because the circuit is open${evaluation.circuitOpenUntil ? ` until ${new Date(evaluation.circuitOpenUntil).toISOString()}` : ""}.`;
    case "half-open":
      return "Selected as the protected half-open recovery probe.";
    default:
      return evaluation.quotaWarning
        ? "Eligible, but deprioritized because configured quota is near its warning threshold."
        : `Eligible with a ${evaluation.match.level} capability match.`;
  }
}


function capabilityEvidenceDetail(evaluation: ProviderCandidateEvaluation): string {
  const entries = [
    ...evaluation.match.supported.map((name) => [name, "supported"] as const),
    ...evaluation.match.unknown.map((name) => [name, "unknown"] as const),
    ...evaluation.match.unsupported.map((name) => [name, "unsupported"] as const),
  ];
  if (!entries.length) return "";
  return entries
    .map(([name, value]) => {
      const source = name === "contextWindow"
        ? undefined
        : evaluation.capabilitySources?.[name];
      return `${name}: ${value}${source ? ` (${source})` : ""}`;
    })
    .join(", ");
}

function retryStopDetail(reason: ProviderAttemptMetric["retryStopReason"]): string {
  switch (reason) {
    case "maximum_attempts_reached": return "Retrying stopped because the maximum provider-attempt count was reached.";
    case "total_request_deadline_exceeded": return "Retrying stopped because the total request deadline was reached.";
    case "error_not_retryable": return "Retrying stopped because this failure is not configured as retryable.";
    case "no_more_candidates": return "Retrying stopped because no additional eligible provider remained.";
    default: return "Retrying stopped.";
  }
}


function immediateFailoverDetail(reason: ProviderAttemptMetric["failoverReason"]): string {
  switch (reason) {
    case "provider_authentication_failed":
      return "The provider rejected its configured credential, so the router will immediately try the next eligible provider.";
    case "provider_access_denied":
      return "This provider denied access to the requested resource, so the router will immediately try the next eligible provider.";
    case "provider_model_or_endpoint_unavailable":
      return "The requested model or endpoint is unavailable on this provider, so the router will immediately try the next eligible provider.";
    case "provider_capability_unsupported":
      return "The active model clearly rejected a required capability, so the registry was updated and the router will immediately try the next eligible provider.";
    default:
      return "This provider-specific failure does not invalidate the client request, so the router will immediately try the next eligible provider.";
  }
}

export function buildRequestTimeline(params: TimelineParams): RequestTimelineEvent[] {
  const providerId = normalizeProviderId(params.providerId);
  const providerEvaluations = params.providerEvaluations?.map((evaluation) => ({
    ...evaluation,
    providerId: normalizeProviderId(evaluation.providerId),
  }));
  const providerAttempts = params.providerAttempts?.map((attempt) => ({
    ...attempt,
    providerId: normalizeProviderId(attempt.providerId),
  }));
  const completedAt = params.completedAt ?? Date.now();
  const startedAt = params.startedAt ?? completedAt - Math.max(0, params.latencyMs);
  const duration = Math.max(0, completedAt - startedAt, params.latencyMs);
  const events: Array<RequestTimelineEvent & { sequence: number }> = [];
  let sequence = 0;

  const add = (
    type: RequestTimelineEventType,
    elapsedMs: number,
    title: string,
    tone: RequestTimelineEvent["tone"],
    options: {
      detail?: string;
      providerId?: string;
      details?: Record<string, unknown>;
    } = {},
  ) => {
    const elapsed = clampElapsed(elapsedMs, duration);
    sequence += 1;
    events.push({
      id: `evt_${String(sequence).padStart(3, "0")}`,
      type,
      timestamp: new Date(startedAt + elapsed).toISOString(),
      elapsedMs: elapsed,
      title,
      tone,
      ...(options.detail ? { detail: options.detail } : {}),
      ...(options.providerId ? { providerId: options.providerId } : {}),
      ...(options.details ? { details: options.details } : {}),
      sequence,
    });
  };

  add("request_received", 0, "Request received", "neutral", {
    detail: params.requestedModel
      ? `The gateway received a request for model “${params.requestedModel}” with request ID ${params.requestId ?? "unavailable"}.`
      : `The gateway received the request with request ID ${params.requestId ?? "unavailable"}.`,
    details: {
      requestId: params.requestId,
      requestIdSource: params.requestIdSource,
      clientRequestId: params.clientRequestId,
    },
  });
  add("authentication_succeeded", Math.min(1, duration), "Router key accepted", "success", {
    detail: "The private router key was validated and its isolated provider configuration was loaded.",
  });

  if (params.resolvedAlias) {
    add("alias_resolved", Math.min(2, duration), `Alias “${params.resolvedAlias}” resolved`, "neutral", {
      detail: `Applied ${params.routingStrategy ?? "configured"} routing${params.requiredCapabilities?.length ? ` with required capabilities: ${params.requiredCapabilities.join(", ")}` : ""}.`,
      details: {
        alias: params.resolvedAlias,
        routingStrategy: params.routingStrategy,
        requiredCapabilities: params.requiredCapabilities ?? [],
      },
    });
  }

  if (params.deduplication?.deduplicated) {
    add("deduplication_reused", Math.min(3, duration), "Identical request reused", "success", {
      detail: `Reused the ${params.deduplication.source === "in-flight" ? "in-flight operation" : "completed response"} from ${params.deduplication.originalRequestId}; no additional provider call was made.`,
      details: { ...params.deduplication },
    });
  } else {
    add("routing_started", Math.min(3, duration), "Providers filtered and ranked", "neutral", {
      detail: `Applied ${params.routingStrategy ?? "configured"} routing after capability, quota, cooldown, and circuit checks.`,
      details: {
        routingStrategy: params.routingStrategy,
        requiredCapabilities: params.requiredCapabilities ?? [],
      },
    });
  }

  const attempts = Array.isArray(providerAttempts) ? providerAttempts : [];
  const attemptedIds = new Set(attempts.map((attempt) => attempt.providerId));
  const evaluationElapsed = Math.min(4, duration);
  for (const evaluation of providerEvaluations ?? []) {
    const attempted = attemptedIds.has(evaluation.providerId);
    if (!attempted && evaluation.state !== "candidate" && evaluation.state !== "half-open") {
      add("provider_skipped", evaluationElapsed, `${evaluation.providerId} skipped`, "warning", {
        providerId: evaluation.providerId,
        detail: `${stateDetail(evaluation)}${capabilityEvidenceDetail(evaluation) ? ` Evidence: ${capabilityEvidenceDetail(evaluation)}.` : ""}`,
        details: { ...evaluation },
      });
      continue;
    }
    if (evaluation.candidateRank !== undefined || attempted) {
      const modelSuffix = evaluation.providerModel ? ` using model ${evaluation.providerModel}` : "";
      const capabilityEvidence = capabilityEvidenceDetail(evaluation);
      const rankingDetail = evaluation.state === "half-open"
        ? "Selected as the protected half-open recovery probe."
        : evaluation.quotaWarning
          ? `Eligible with a ${evaluation.match.level} capability match, but ranked behind healthier quota capacity${capabilityEvidence ? ` (${capabilityEvidence})` : ""}.`
          : `Eligible with a ${evaluation.match.level} capability match${modelSuffix}${capabilityEvidence ? ` (${capabilityEvidence})` : ""}.`;
      add("provider_ranked", evaluationElapsed, `${evaluation.providerId} ranked${evaluation.candidateRank ? ` #${evaluation.candidateRank}` : ""}`, evaluation.quotaWarning ? "warning" : "neutral", {
        providerId: evaluation.providerId,
        detail: rankingDetail,
        details: { ...evaluation },
      });
    }
  }

  for (const [index, attempt] of attempts.entries()) {
    const rawCompletedElapsed = attempt.completedElapsedMs
      ?? attempt.totalElapsedMs
      ?? duration;
    const rawStartedElapsed = attempt.startedElapsedMs
      ?? Math.max(0, rawCompletedElapsed - (attempt.latencyMs ?? 0));
    const startedElapsed = Math.max(evaluationElapsed, rawStartedElapsed);
    const completedElapsed = Math.max(startedElapsed, rawCompletedElapsed);
    const attemptNumber = attempt.attemptNumber ?? index + 1;
    add("provider_attempt_started", startedElapsed, `Attempt ${attemptNumber} started — ${attempt.providerId}`, "neutral", {
      providerId: attempt.providerId,
      detail: `${attempt.providerModel ? `Model: ${attempt.providerModel}. ` : ""}Upstream timeout: ${attempt.providerTimeoutMs ?? "default"}${attempt.providerTimeoutMs ? " ms" : ""}.`,
      details: {
        attemptNumber,
        providerTimeoutMs: attempt.providerTimeoutMs,
        providerModel: attempt.providerModel,
        startedAt: attempt.startedAt,
      },
    });

    if (attempt.success) {
      add("provider_attempt_succeeded", completedElapsed, `${attempt.providerId} succeeded${attempt.status ? ` — HTTP ${attempt.status}` : ""}`, "success", {
        providerId: attempt.providerId,
        detail: `Provider completed the request in ${attempt.latencyMs} ms.`,
        details: { ...attempt },
      });
    } else {
      add("provider_attempt_failed", completedElapsed, `${attempt.providerId} failed${attempt.status ? ` — HTTP ${attempt.status}` : ""}`, "error", {
        providerId: attempt.providerId,
        detail: attempt.message ?? `${attempt.failureType ?? "Upstream failure"} after ${attempt.latencyMs} ms.`,
        details: { ...attempt },
      });
    }

    if (attempt.cooldownUntil) {
      add("cooldown_started", completedElapsed, `Cooldown started for ${attempt.providerId}`, "warning", {
        providerId: attempt.providerId,
        detail: `New requests will skip this provider until ${new Date(attempt.cooldownUntil).toISOString()}.`,
        details: {
          cooldownUntil: attempt.cooldownUntil,
          retryAfterSeconds: attempt.retryAfterSeconds,
          reason: attempt.cooldownReason,
        },
      });
    }

    if (attempt.circuitAction && attempt.circuitAction !== "none") {
      add("circuit_state_changed", completedElapsed, `Circuit ${attempt.circuitAction} for ${attempt.providerId}`, attempt.circuitAction === "closed" ? "success" : "warning", {
        providerId: attempt.providerId,
        detail: attempt.circuitOpenUntil
          ? `Circuit state is ${attempt.circuitState} until ${new Date(attempt.circuitOpenUntil).toISOString()}.`
          : `Circuit state changed to ${attempt.circuitState ?? attempt.circuitAction}.`,
        details: {
          circuitAction: attempt.circuitAction,
          circuitState: attempt.circuitState,
          circuitOpenUntil: attempt.circuitOpenUntil,
          circuitFailureCount: attempt.circuitFailureCount,
          circuitOpenCount: attempt.circuitOpenCount,
        },
      });
    }

    if (attempt.recoveryAction === "immediate_failover" && !attempt.retryStopReason) {
      add("provider_failover", completedElapsed, "Immediate failover to next provider", "warning", {
        providerId: attempt.providerId,
        detail: immediateFailoverDetail(attempt.failoverReason),
        details: {
          recoveryAction: attempt.recoveryAction,
          failoverReason: attempt.failoverReason,
          status: attempt.status,
        },
      });
    }

    if (attempt.retryDelayMs !== undefined && attempt.retryable !== false) {
      add("retry_scheduled", completedElapsed, `Retry scheduled after ${attempt.retryDelayMs} ms`, "warning", {
        providerId: attempt.providerId,
        detail: "The router will continue with the next eligible provider after the configured backoff.",
        details: {
          retryDelayMs: attempt.retryDelayMs,
          retryable: attempt.retryable,
        },
      });
    }
    if (attempt.retryStopReason) {
      add("retry_stopped", completedElapsed, "Retrying stopped", "warning", {
        providerId: attempt.providerId,
        detail: retryStopDetail(attempt.retryStopReason),
        details: { retryStopReason: attempt.retryStopReason },
      });
    }
  }

  const successful = params.status >= 200 && params.status < 300;
  add(successful ? "response_returned" : "request_failed", duration,
    successful
      ? params.streaming ? "Streaming response handed to client" : "Response returned to client"
      : "Request failed",
    successful ? "success" : "error", {
      ...(providerId !== "router" && providerId !== "deduplicated"
        ? { providerId }
        : {}),
      detail: successful
        ? `Completed with HTTP ${params.status}${providerId ? ` through ${providerId}` : ""}.`
        : `Completed with HTTP ${params.status} after ${duration} ms.`,
      details: {
        status: params.status,
        providerId,
        latencyMs: duration,
      },
    });

  return events
    .sort((left, right) => left.elapsedMs - right.elapsedMs || left.sequence - right.sequence)
    .map(({ sequence: _sequence, ...event }) => event);
}
