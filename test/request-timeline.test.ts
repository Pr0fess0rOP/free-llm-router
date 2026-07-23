import assert from "node:assert/strict";
import test from "node:test";
import { buildRequestTimeline } from "../src/request-timeline.js";

test("builds a chronological provider-attempt timeline with skip, retry, cooldown, and success events", () => {
  const startedAt = Date.parse("2026-07-20T20:00:00.000Z");
  const timeline = buildRequestTimeline({
    startedAt,
    completedAt: startedAt + 2_500,
    latencyMs: 2_500,
    status: 200,
    providerId: "healthy",
    requestedModel: "free-router",
    resolvedAlias: "free-router",
    routingStrategy: "priority",
    requiredCapabilities: ["vision"],
    providerEvaluations: [
      {
        providerId: "unsupported",
        match: {
          level: "incompatible",
          supported: [],
          unknown: [],
          unsupported: ["vision"],
        },
        state: "incompatible",
      },
      {
        providerId: "limited",
        match: {
          level: "full",
          supported: ["vision"],
          unknown: [],
          unsupported: [],
        },
        state: "cooldown",
        cooldownUntil: startedAt + 60_000,
        cooldownReason: "rate_limit",
      },
      {
        providerId: "failing",
        match: {
          level: "full",
          supported: ["vision"],
          unknown: [],
          unsupported: [],
        },
        state: "cooldown",
        candidateRank: 1,
        cooldownUntil: startedAt + 60_000,
        cooldownReason: "rate_limit",
      },
      {
        providerId: "healthy",
        match: {
          level: "full",
          supported: ["vision"],
          unknown: [],
          unsupported: [],
        },
        state: "candidate",
        candidateRank: 2,
      },
    ],
    providerAttempts: [
      {
        providerId: "failing",
        success: false,
        status: 429,
        message: "rate limited",
        latencyMs: 1_000,
        attemptNumber: 1,
        startedAt: new Date(startedAt + 10).toISOString(),
        completedAt: new Date(startedAt + 1_010).toISOString(),
        startedElapsedMs: 10,
        completedElapsedMs: 1_010,
        totalElapsedMs: 1_010,
        providerTimeoutMs: 4_000,
        retryable: true,
        retryDelayMs: 500,
        cooldownUntil: startedAt + 61_010,
        cooldownReason: "rate_limit",
        retryAfterSeconds: 60,
      },
      {
        providerId: "healthy",
        success: true,
        status: 200,
        latencyMs: 900,
        attemptNumber: 2,
        startedAt: new Date(startedAt + 1_510).toISOString(),
        completedAt: new Date(startedAt + 2_410).toISOString(),
        startedElapsedMs: 1_510,
        completedElapsedMs: 2_410,
        totalElapsedMs: 2_410,
        providerTimeoutMs: 4_000,
      },
    ],
  });

  const types = timeline.map((event) => event.type);
  assert.deepEqual(types.slice(0, 4), [
    "request_received",
    "authentication_succeeded",
    "alias_resolved",
    "routing_started",
  ]);
  assert.ok(types.includes("provider_skipped"));
  assert.equal(types.filter((type) => type === "provider_attempt_started").length, 2);
  assert.ok(types.includes("provider_attempt_failed"));
  assert.ok(types.includes("cooldown_started"));
  assert.ok(types.includes("retry_scheduled"));
  assert.ok(types.includes("provider_attempt_succeeded"));
  assert.equal(types.at(-1), "response_returned");
  assert.equal(
    timeline.every((event, index) => index === 0 || event.elapsedMs >= timeline[index - 1]!.elapsedMs),
    true,
  );
  assert.equal(
    timeline.find((event) => event.type === "provider_skipped" && event.providerId === "unsupported")?.details?.state,
    "incompatible",
  );
});

test("records deduplication reuse without inventing an upstream provider attempt", () => {
  const timeline = buildRequestTimeline({
    latencyMs: 12,
    status: 200,
    providerId: "deduplicated",
    requestedModel: "free-router",
    resolvedAlias: "free-router",
    routingStrategy: "priority",
    deduplication: {
      deduplicated: true,
      originalRequestId: "req_original",
      source: "completed",
      duplicateCount: 2,
      providerCallAvoided: true,
      estimatedRequestsSaved: 1,
    },
  });

  assert.ok(timeline.some((event) => event.type === "deduplication_reused"));
  assert.equal(timeline.some((event) => event.type === "provider_attempt_started"), false);
  assert.equal(timeline.at(-1)?.type, "response_returned");
});

test("records immediate provider failover separately from retry backoff", () => {
  const startedAt = Date.parse("2026-07-21T19:00:00.000Z");
  const timeline = buildRequestTimeline({
    startedAt,
    completedAt: startedAt + 650,
    latencyMs: 650,
    status: 200,
    providerId: "groq",
    requestedModel: "test-router",
    resolvedAlias: "test-router",
    routingStrategy: "priority",
    providerAttempts: [
      {
        providerId: "openrouter",
        success: false,
        status: 404,
        message: "This model is unavailable for free.",
        latencyMs: 145,
        attemptNumber: 1,
        startedElapsedMs: 334,
        completedElapsedMs: 479,
        providerTimeoutMs: 30_000,
        retryable: false,
        recoveryAction: "immediate_failover",
        failoverReason: "provider_model_or_endpoint_unavailable",
      },
      {
        providerId: "groq",
        success: true,
        status: 200,
        latencyMs: 120,
        attemptNumber: 2,
        startedElapsedMs: 480,
        completedElapsedMs: 600,
        providerTimeoutMs: 30_000,
      },
    ],
  });

  const failover = timeline.find((event) => event.type === "provider_failover");
  assert.ok(failover);
  assert.equal(failover.providerId, "openrouter");
  assert.match(failover.detail ?? "", /immediately try the next eligible provider/i);
  assert.equal(timeline.some((event) => event.type === "retry_scheduled"), false);
  assert.equal(timeline.some((event) => event.type === "retry_stopped"), false);
  assert.equal(timeline.at(-1)?.type, "response_returned");
});

test("canonicalizes legacy model-coupled provider IDs before composing timeline text", () => {
  const timeline = buildRequestTimeline({
    latencyMs: 676,
    status: 200,
    providerId: "openrouter-qwen",
    requestedModel: "free-router",
    resolvedAlias: "free-router",
    routingStrategy: "priority",
    providerEvaluations: [
      {
        providerId: "openrouter-qwen",
        providerModel: "poolside/laguna-s-2.1:free",
        match: { level: "full", supported: [], unknown: [], unsupported: [] },
        state: "candidate",
        candidateRank: 1,
      },
      {
        providerId: "groq-llama",
        providerModel: "llama-3.3-70b-versatile",
        match: { level: "full", supported: [], unknown: [], unsupported: [] },
        state: "candidate",
        candidateRank: 2,
      },
    ],
    providerAttempts: [
      {
        providerId: "openrouter-qwen",
        providerModel: "poolside/laguna-s-2.1:free",
        success: true,
        status: 200,
        latencyMs: 518,
        attemptNumber: 1,
        startedElapsedMs: 77,
        completedElapsedMs: 596,
        providerTimeoutMs: 30_000,
      },
    ],
  });

  const serialized = JSON.stringify(timeline);
  assert.doesNotMatch(serialized, /openrouter-qwen|groq-llama/);
  assert.equal(
    timeline.find((event) => event.type === "provider_ranked")?.providerId,
    "openrouter",
  );
  assert.match(
    timeline.find((event) => event.type === "provider_ranked")?.title ?? "",
    /^openrouter ranked #1$/,
  );
  assert.equal(
    timeline.find((event) => event.type === "provider_attempt_started")?.providerId,
    "openrouter",
  );
  assert.match(timeline.at(-1)?.detail ?? "", /through openrouter/);
});
