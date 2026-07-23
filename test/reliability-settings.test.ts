import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RELIABILITY_SETTINGS,
  effectiveReliabilitySettings,
  normalizeReliabilitySettings,
} from "../src/reliability-settings.js";

test("normalizes configurable retry, timeout, and provider override settings", () => {
  const settings = normalizeReliabilitySettings({
    providerTimeoutMs: 12_000,
    totalRequestTimeoutMs: 45_000,
    maxProviderAttempts: 4,
    initialBackoffMs: 100,
    maxBackoffMs: 1_600,
    backoffMultiplier: 2.5,
    useJitter: false,
    retryStatusCodes: [503, 429, 503],
    retryNetworkErrors: false,
    retryMalformedResponses: false,
    streamingConnectionTimeoutMs: 20_000,
    halfOpenProbeTimeoutMs: 5_000,
    providerTimeoutOverrides: { groq: 3_000 },
  });

  assert.deepEqual(settings, {
    providerTimeoutMs: 12_000,
    totalRequestTimeoutMs: 45_000,
    maxProviderAttempts: 4,
    initialBackoffMs: 100,
    maxBackoffMs: 1_600,
    backoffMultiplier: 2.5,
    useJitter: false,
    retryStatusCodes: [429, 503],
    retryNetworkErrors: false,
    retryMalformedResponses: false,
    streamingConnectionTimeoutMs: 20_000,
    halfOpenProbeTimeoutMs: 5_000,
    providerTimeoutOverrides: { groq: 3_000 },
  });
});

test("supports an empty retry-status list and alias-level primary overrides", () => {
  const settings = effectiveReliabilitySettings(
    {
      ...DEFAULT_RELIABILITY_SETTINGS,
      retryStatusCodes: [],
    },
    {
      reliabilityOverrides: {
        providerTimeoutMs: 4_000,
        totalRequestTimeoutMs: 12_000,
        maxProviderAttempts: 2,
      },
    },
  );

  assert.deepEqual(settings.retryStatusCodes, []);
  assert.equal(settings.providerTimeoutMs, 4_000);
  assert.equal(settings.totalRequestTimeoutMs, 12_000);
  assert.equal(settings.maxProviderAttempts, 2);
  assert.equal(settings.retryNetworkErrors, true);
});
