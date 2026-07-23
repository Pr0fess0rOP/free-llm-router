import assert from "node:assert/strict";
import test from "node:test";
import {
  addProviderAttemptUsage,
  addProviderTokenUsage,
  extractTokenUsage,
  normalizeProviderQuotaConfig,
  normalizeProviderQuotaUsage,
  providerQuotaStatus,
} from "../src/provider-quotas.js";

test("normalizes quota settings and reports warning and exhausted states", () => {
  const now = Date.UTC(2026, 6, 20, 12);
  const config = normalizeProviderQuotaConfig({
    dailyRequestLimit: "10",
    monthlyTokenLimit: 1000,
    warningThresholdPercent: 80,
  });
  assert.deepEqual(config, {
    dailyRequestLimit: 10,
    monthlyTokenLimit: 1000,
    warningThresholdPercent: 80,
  });

  let usage = normalizeProviderQuotaUsage(undefined, now);
  for (let index = 0; index < 8; index += 1) {
    usage = addProviderAttemptUsage(usage, true, now + index);
  }
  let status = providerQuotaStatus(config, usage, now + 20);
  assert.equal(status?.warning, true);
  assert.equal(status?.exhausted, false);
  assert.equal(status?.consumedPercent, 80);

  usage = addProviderAttemptUsage(usage, false, now + 30);
  usage = addProviderAttemptUsage(usage, false, now + 31);
  status = providerQuotaStatus(config, usage, now + 40);
  assert.equal(status?.exhausted, true);
  assert.deepEqual(status?.exhaustedLimits, ["daily_requests"]);
});

test("tracks requests and tokens in daily and monthly windows", () => {
  const now = Date.UTC(2026, 6, 20, 12);
  let usage = addProviderAttemptUsage(undefined, true, now);
  usage = addProviderTokenUsage(usage, {
    inputTokens: 12,
    outputTokens: 5,
    totalTokens: 17,
    source: "reported",
  }, now + 1);
  usage = addProviderAttemptUsage(usage, false, now + 2);

  assert.equal(usage.daily.requests, 2);
  assert.equal(usage.daily.successfulRequests, 1);
  assert.equal(usage.daily.failedRequests, 1);
  assert.equal(usage.daily.totalTokens, 17);
  assert.equal(usage.monthly.requests, 2);
  assert.equal(usage.monthly.totalTokens, 17);
  assert.equal(usage.lastTokenUsageSource, "reported");

  const nextDay = now + 24 * 60 * 60_000;
  const reset = normalizeProviderQuotaUsage(usage, nextDay);
  assert.equal(reset.daily.requests, 0);
  assert.equal(reset.daily.totalTokens, 0);
  assert.equal(reset.monthly.requests, 2);
});

test("extracts token usage from OpenAI, Responses, and Anthropic shapes", () => {
  assert.deepEqual(extractTokenUsage({
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  }), { inputTokens: 10, outputTokens: 4, totalTokens: 14, source: "reported" });

  assert.deepEqual(extractTokenUsage({
    usage: { input_tokens: 8, output_tokens: 3 },
  }), { inputTokens: 8, outputTokens: 3, totalTokens: 11, source: "reported" });

  assert.deepEqual(extractTokenUsage({}, 7), {
    inputTokens: 7,
    outputTokens: 0,
    totalTokens: 7,
    source: "estimated",
  });
  assert.deepEqual(extractTokenUsage({ usage: {} }, 5), {
    inputTokens: 5,
    outputTokens: 0,
    totalTokens: 5,
    source: "estimated",
  });
});
