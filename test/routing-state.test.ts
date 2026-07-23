import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  claimProviderHalfOpenProbe,
  clearProviderCooldown,
  clearProviderUsage,
  getRoutingStats,
  prepareProviderCircuitRetry,
  nextRoundRobinCursor,
  recordProviderTokenUsage,
  recordRoutingAttempt,
  resetProviderCircuit,
} from "../src/routing-state.js";

test("persists routing performance and round-robin position", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-routing-"));
  const previousPath = process.env.ROUTING_STATE_PATH;
  process.env.ROUTING_STATE_PATH = path.join(directory, "routing-state.json");

  try {
    await recordRoutingAttempt("router-hash", {
      providerId: "groq",
      success: true,
      status: 200,
      latencyMs: 250,
    });
    await recordRoutingAttempt("router-hash", {
      providerId: "groq",
      success: false,
      status: 429,
      message: "rate limited",
      latencyMs: 100,
      cooldownUntil: Date.now() + 120_000,
      cooldownReason: "rate_limit",
      retryAfterSeconds: 120,
    });

    await recordProviderTokenUsage("router-hash", "groq", {
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
      source: "reported",
    });

    const statsWithUsage = await getRoutingStats("router-hash");
    assert.equal(statsWithUsage.groq?.quotaUsage?.daily.requests, 2);
    assert.equal(statsWithUsage.groq?.quotaUsage?.daily.successfulRequests, 1);
    assert.equal(statsWithUsage.groq?.quotaUsage?.daily.failedRequests, 1);
    assert.equal(statsWithUsage.groq?.quotaUsage?.daily.totalTokens, 16);

    const resetUsage = await clearProviderUsage("router-hash", "groq");
    assert.equal(resetUsage.quotaUsage?.daily.requests, 0);
    assert.equal(resetUsage.quotaUsage?.daily.totalTokens, 0);

    const stats = await getRoutingStats("router-hash");
    assert.equal(stats.groq?.attempts, 2);
    assert.equal(stats.groq?.successes, 1);
    assert.equal(stats.groq?.failures, 1);
    assert.equal(stats.groq?.lastStatus, 429);
    assert.equal(stats.groq?.lastError, "rate limited");
    assert.equal(stats.groq?.rateLimitCount, 1);
    assert.equal(stats.groq?.cooldownReason, "rate_limit");
    assert.equal(stats.groq?.lastRetryAfterSeconds, 120);
    assert.ok((stats.groq?.cooldownUntil ?? 0) > Date.now());

    const cleared = await clearProviderCooldown("router-hash", "groq");
    assert.equal(cleared.rateLimitCount, 0);
    assert.equal(cleared.cooldownUntil, undefined);


    await recordRoutingAttempt("router-hash", {
      providerId: "groq",
      success: false,
      status: 503,
      message: "service unavailable",
      latencyMs: 80,
      failureType: "server_error",
      circuitAction: "opened",
      circuitState: "open",
      circuitOpenUntil: Date.now() + 120_000,
      circuitFailureCount: 3,
      circuitOpenCount: 1,
      halfOpenProbeActive: false,
    });

    const circuitStats = await getRoutingStats("router-hash");
    assert.equal(circuitStats.groq?.circuitState, "open");
    assert.equal(circuitStats.groq?.circuitFailureCount, 3);
    assert.equal(circuitStats.groq?.lastFailureType, "server_error");

    await prepareProviderCircuitRetry("router-hash", "groq");
    assert.equal(await claimProviderHalfOpenProbe("router-hash", "groq"), true);
    assert.equal(await claimProviderHalfOpenProbe("router-hash", "groq"), false);

    const reset = await resetProviderCircuit("router-hash", "groq");
    assert.equal(reset.circuitState, "closed");
    assert.equal(reset.circuitFailureCount, 0);
    assert.equal(reset.halfOpenProbeActive, false);

    assert.equal(await nextRoundRobinCursor("router-hash", 2), 0);
    assert.equal(await nextRoundRobinCursor("router-hash", 2), 1);

    assert.equal(await nextRoundRobinCursor("router-hash", 2), 0);
  } finally {
    if (previousPath === undefined) delete process.env.ROUTING_STATE_PATH;
    else process.env.ROUTING_STATE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});


test("migrates legacy provider IDs in persisted routing health and quota state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-routing-provider-migration-"));
  const statePath = path.join(directory, "routing-state.json");
  const previousPath = process.env.ROUTING_STATE_PATH;
  process.env.ROUTING_STATE_PATH = statePath;

  try {
    await writeFile(statePath, JSON.stringify({
      routers: {
        "router-hash": {
          cursor: 0,
          providers: {
            "groq-llama": {
              providerId: "groq-llama",
              attempts: 3,
              successes: 2,
              failures: 1,
              successScore: 0.8,
              consecutiveFailures: 0,
              rateLimitCount: 0,
              circuitState: "closed",
              circuitFailureCount: 0,
              circuitOpenCount: 0,
              halfOpenProbeActive: false
            }
          }
        }
      }
    }, null, 2));

    const stats = await getRoutingStats("router-hash");
    assert.equal(stats.groq?.providerId, "groq");
    assert.equal(stats.groq?.attempts, 3);
    assert.equal(stats["groq-llama"], undefined);

    const rewritten = JSON.parse(await readFile(statePath, "utf8"));
    assert.ok(rewritten.routers["router-hash"].providers.groq);
    assert.equal(rewritten.routers["router-hash"].providers["groq-llama"], undefined);
  } finally {
    if (previousPath === undefined) delete process.env.ROUTING_STATE_PATH;
    else process.env.ROUTING_STATE_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
