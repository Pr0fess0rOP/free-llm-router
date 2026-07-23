import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRequestPerformanceTiming,
  finalizeSuccessfulAttempt,
} from "../src/performance-timing.js";
import type { ProviderAttemptMetric } from "../src/types.js";

test("builds internally consistent non-streaming and retry timing breakdowns", () => {
  const attempts: ProviderAttemptMetric[] = [
    {
      providerId: "groq",
      success: false,
      status: 503,
      latencyMs: 120,
      headersLatencyMs: 95,
      retryDelayMs: 50,
      attemptNumber: 1,
      startedElapsedMs: 20,
    },
    {
      providerId: "mistral",
      success: true,
      status: 200,
      latencyMs: 210,
      headersLatencyMs: 150,
      attemptNumber: 2,
      startedElapsedMs: 190,
    },
  ];
  finalizeSuccessfulAttempt({
    attempts,
    providerId: "mistral",
    responseBodyMs: 40,
  });
  const performance = buildRequestPerformanceTiming({
    startedAt: 1_000,
    completedAt: 1_500,
    attempts,
    providerId: "mistral",
    responseBodyMs: 40,
    responseProcessingMs: 20,
  });

  assert.equal(performance.totalLatencyMs, 500);
  assert.equal(performance.routerPreparationMs, 20);
  assert.equal(performance.providerLatencyMs, 330);
  assert.equal(performance.providerHeadersMs, 245);
  assert.equal(performance.retryDelayMs, 50);
  assert.equal(performance.responseBodyMs, 40);
  assert.equal(performance.responseProcessingMs, 20);
  assert.equal(performance.routerOverheadMs, 80);
  assert.equal(performance.attempts.length, 2);
  assert.equal(performance.attempts[1]?.responseBodyMs, 40);
});

test("captures first-token, stream duration, throughput, and deduplication reuse", () => {
  const attempts: ProviderAttemptMetric[] = [{
    providerId: "stream-provider",
    success: true,
    status: 200,
    latencyMs: 400,
    headersLatencyMs: 80,
    attemptNumber: 1,
    startedElapsedMs: 10,
  }];
  const usage = {
    inputTokens: 20,
    outputTokens: 40,
    totalTokens: 60,
    source: "reported" as const,
  };
  finalizeSuccessfulAttempt({
    attempts,
    providerId: "stream-provider",
    responseBodyMs: 320,
    firstTokenMs: 100,
    streamDurationMs: 1_000,
    usage,
  });
  const performance = buildRequestPerformanceTiming({
    startedAt: 2_000,
    completedAt: 3_200,
    attempts,
    providerId: "stream-provider",
    responseBodyMs: 320,
    firstTokenAt: 2_110,
    streamCompletedAt: 3_110,
    responseProcessingMs: 90,
    usage,
  });

  assert.equal(performance.firstTokenMs, 110);
  assert.equal(performance.providerFirstTokenMs, 100);
  assert.equal(performance.streamDurationMs, 1_000);
  assert.equal(performance.tokensPerSecond, 40);

  const reused = buildRequestPerformanceTiming({
    startedAt: 4_000,
    completedAt: 4_012,
    deduplicated: true,
  });
  assert.equal(reused.deduplicated, true);
  assert.equal(reused.providerLatencyMs, 0);
  assert.equal(reused.retryDelayMs, 0);
  assert.equal(reused.totalLatencyMs, 12);
});
