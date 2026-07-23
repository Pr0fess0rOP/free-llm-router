import type {
  ProviderAttemptMetric,
  ProviderAttemptTimingBreakdown,
  RequestPerformanceTiming,
  TokenUsage,
} from "./types.js";

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value ?? 0)) : 0;
}

export function successfulAttempt(
  attempts: ProviderAttemptMetric[],
  providerId?: string,
): ProviderAttemptMetric | undefined {
  return [...attempts]
    .reverse()
    .find((attempt) => attempt.success && (!providerId || attempt.providerId === providerId));
}

export function finalizeSuccessfulAttempt(params: {
  attempts: ProviderAttemptMetric[];
  providerId: string;
  responseBodyMs?: number;
  firstTokenMs?: number;
  streamDurationMs?: number;
  usage?: TokenUsage;
}): ProviderAttemptMetric | undefined {
  const attempt = successfulAttempt(params.attempts, params.providerId);
  if (!attempt) return undefined;
  if (params.responseBodyMs !== undefined) {
    attempt.responseBodyMs = nonNegative(params.responseBodyMs);
  }
  if (params.firstTokenMs !== undefined) {
    attempt.firstTokenMs = nonNegative(params.firstTokenMs);
  }
  if (params.streamDurationMs !== undefined) {
    attempt.streamDurationMs = nonNegative(params.streamDurationMs);
  }
  const outputTokens = params.usage?.outputTokens ?? 0;
  if (outputTokens > 0 && (params.streamDurationMs ?? 0) > 0) {
    attempt.tokensPerSecond = Number(
      (outputTokens / ((params.streamDurationMs ?? 0) / 1_000)).toFixed(2),
    );
  }
  return attempt;
}

function attemptBreakdown(
  attempt: ProviderAttemptMetric,
  index: number,
): ProviderAttemptTimingBreakdown {
  return {
    attempt: attempt.attemptNumber ?? index + 1,
    providerId: attempt.providerId,
    success: attempt.success,
    latencyMs: nonNegative(attempt.latencyMs),
    ...(attempt.headersLatencyMs !== undefined
      ? { headersLatencyMs: nonNegative(attempt.headersLatencyMs) }
      : {}),
    ...(attempt.responseBodyMs !== undefined
      ? { responseBodyMs: nonNegative(attempt.responseBodyMs) }
      : {}),
    ...(attempt.firstTokenMs !== undefined
      ? { firstTokenMs: nonNegative(attempt.firstTokenMs) }
      : {}),
    ...(attempt.streamDurationMs !== undefined
      ? { streamDurationMs: nonNegative(attempt.streamDurationMs) }
      : {}),
    ...(attempt.tokensPerSecond !== undefined
      ? { tokensPerSecond: attempt.tokensPerSecond }
      : {}),
    ...(attempt.providerTimeoutMs !== undefined
      ? { timeoutMs: nonNegative(attempt.providerTimeoutMs) }
      : {}),
    ...(attempt.retryDelayMs !== undefined
      ? { retryDelayMs: nonNegative(attempt.retryDelayMs) }
      : {}),
    ...(attempt.status !== undefined ? { status: attempt.status } : {}),
    ...(attempt.failureType ? { failureType: attempt.failureType } : {}),
    ...(attempt.startedAt ? { startedAt: attempt.startedAt } : {}),
    ...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}),
  };
}

export function buildRequestPerformanceTiming(params: {
  startedAt: number;
  completedAt?: number;
  attempts?: ProviderAttemptMetric[];
  providerId?: string;
  responseBodyMs?: number;
  responseProcessingMs?: number;
  firstTokenAt?: number;
  streamCompletedAt?: number;
  usage?: TokenUsage;
  deduplicated?: boolean;
}): RequestPerformanceTiming {
  const completedAt = params.completedAt ?? Date.now();
  const attempts = params.attempts ?? [];
  const selected = successfulAttempt(attempts, params.providerId);
  const firstAttemptStartedAt = attempts
    .map((attempt) => attempt.startedElapsedMs)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b)[0];
  const totalLatencyMs = nonNegative(completedAt - params.startedAt);
  const routerPreparationMs = nonNegative(firstAttemptStartedAt ?? totalLatencyMs);
  const providerLatencyMs = params.deduplicated
    ? 0
    : attempts.reduce((sum, attempt) => sum + nonNegative(attempt.latencyMs), 0);
  const providerHeadersMs = params.deduplicated
    ? 0
    : attempts.reduce(
        (sum, attempt) => sum + nonNegative(attempt.headersLatencyMs ?? attempt.latencyMs),
        0,
      );
  const retryDelayMs = params.deduplicated
    ? 0
    : attempts.reduce((sum, attempt) => sum + nonNegative(attempt.retryDelayMs), 0);
  const responseBodyMs = params.deduplicated
    ? 0
    : nonNegative(params.responseBodyMs ?? selected?.responseBodyMs);
  const responseProcessingMs = nonNegative(params.responseProcessingMs);
  const firstTokenMs = params.firstTokenAt !== undefined
    ? nonNegative(params.firstTokenAt - params.startedAt)
    : selected?.firstTokenMs !== undefined && selected.startedElapsedMs !== undefined
      ? nonNegative(selected.startedElapsedMs + selected.firstTokenMs)
      : undefined;
  const providerFirstTokenMs = selected?.firstTokenMs !== undefined
    ? nonNegative(selected.firstTokenMs)
    : undefined;
  const streamDurationMs = params.streamCompletedAt !== undefined && params.firstTokenAt !== undefined
    ? nonNegative(params.streamCompletedAt - params.firstTokenAt)
    : selected?.streamDurationMs !== undefined
      ? nonNegative(selected.streamDurationMs)
      : undefined;
  const outputTokens = params.usage?.outputTokens ?? 0;
  const tokensPerSecond = outputTokens > 0 && (streamDurationMs ?? 0) > 0
    ? Number((outputTokens / ((streamDurationMs ?? 0) / 1_000)).toFixed(2))
    : selected?.tokensPerSecond;
  const routerOverheadMs = nonNegative(
    totalLatencyMs -
      routerPreparationMs -
      providerLatencyMs -
      retryDelayMs -
      responseProcessingMs,
  );
  const stages: Array<[string, number]> = [
    ["Router preparation", routerPreparationMs],
    ["Provider processing", providerLatencyMs],
    ["Retry delay", retryDelayMs],
    ["Response processing", responseProcessingMs],
    ["Router overhead", routerOverheadMs],
  ];
  if (streamDurationMs !== undefined) stages.push(["Streaming", streamDurationMs]);
  const slowestStage = stages.sort((a, b) => b[1] - a[1])[0]?.[0];

  return {
    totalLatencyMs,
    routerPreparationMs,
    routerOverheadMs,
    providerLatencyMs,
    providerHeadersMs,
    responseBodyMs,
    responseProcessingMs,
    retryDelayMs,
    ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
    ...(providerFirstTokenMs !== undefined ? { providerFirstTokenMs } : {}),
    ...(streamDurationMs !== undefined ? { streamDurationMs } : {}),
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
    ...(slowestStage ? { slowestStage } : {}),
    ...(params.deduplicated ? { deduplicated: true } : {}),
    attempts: attempts.map(attemptBreakdown),
  };
}
