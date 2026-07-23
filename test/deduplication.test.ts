import assert from "node:assert/strict";
import test from "node:test";
import {
  clearDeduplicationCache,
  createRequestFingerprint,
  deduplicationBypassReason,
  executeDeduplicated,
  normalizeDeduplicationSettings,
  parseDeduplicationSettings,
} from "../src/deduplication.js";

const defaults = normalizeDeduplicationSettings(undefined);

test("normalizes and validates request deduplication settings", () => {
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.windowMs, 30_000);
  assert.equal(defaults.automaticFingerprinting, true);
  assert.equal(defaults.bypassToolRequests, true);
  assert.throws(
    () => parseDeduplicationSettings({ windowMs: 500 }),
    /between 1 and 300 seconds/,
  );
  assert.equal(
    parseDeduplicationSettings({ enabled: false, windowMs: 60_000 }).enabled,
    false,
  );
});

test("creates stable fingerprints scoped by router and endpoint", () => {
  const left = createRequestFingerprint({
    routerKeyHash: "router-a",
    endpoint: "/v1/chat/completions",
    body: { model: "free-router", temperature: 0, messages: [{ content: "Hi", role: "user" }] },
  });
  const reordered = createRequestFingerprint({
    routerKeyHash: "router-a",
    endpoint: "/v1/chat/completions",
    body: { messages: [{ role: "user", content: "Hi" }], temperature: 0, model: "free-router", stream: false },
  });
  const differentRouter = createRequestFingerprint({
    routerKeyHash: "router-b",
    endpoint: "/v1/chat/completions",
    body: { model: "free-router", temperature: 0, messages: [{ content: "Hi", role: "user" }] },
  });
  assert.equal(left, reordered);
  assert.notEqual(left, differentRouter);
});

test("uses conservative automatic bypass rules but allows explicit idempotency keys", () => {
  assert.equal(deduplicationBypassReason({
    body: { stream: true },
    settings: defaults,
  }), "streaming_request");
  assert.equal(deduplicationBypassReason({
    body: { tools: [{ type: "function" }] },
    settings: defaults,
  }), "tool_request");
  assert.equal(deduplicationBypassReason({
    body: { messages: [{ content: [{ type: "image_url", image_url: { url: "x" } }] }] },
    settings: defaults,
  }), "multimodal_request");
  assert.equal(deduplicationBypassReason({
    body: { temperature: 0.7 },
    settings: defaults,
  }), "non_deterministic_request");
  assert.equal(deduplicationBypassReason({
    body: { temperature: 0.7, tools: [{ type: "function" }] },
    settings: defaults,
    idempotencyKey: "explicit-operation",
  }), undefined);
  assert.equal(deduplicationBypassReason({
    body: { temperature: 0 },
    settings: { ...defaults, requireIdempotencyKey: true },
  }), "idempotency_key_required");
});

test("coalesces in-flight work and reuses only successful completed responses", async () => {
  clearDeduplicationCache();
  let calls = 0;
  const execute = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"ok":true}'),
    };
  };
  const [first, second] = await Promise.all([
    executeDeduplicated({ key: "same", windowMs: 1_000, execute }),
    executeDeduplicated({ key: "same", windowMs: 1_000, execute }),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.metadata.deduplicated, false);
  assert.equal(second.metadata.deduplicated, true);
  assert.equal(second.metadata.source, "in-flight");

  const third = await executeDeduplicated({ key: "same", windowMs: 1_000, execute });
  assert.equal(calls, 1);
  assert.equal(third.metadata.source, "completed");

  await new Promise((resolve) => setTimeout(resolve, 1_050));
  const expired = await executeDeduplicated({ key: "same", windowMs: 1_000, execute });
  assert.equal(calls, 2);
  assert.equal(expired.metadata.deduplicated, false);

  let failedCalls = 0;
  const failed = async () => {
    failedCalls += 1;
    return { status: 503, headers: {}, body: Buffer.from("failed") };
  };
  await executeDeduplicated({ key: "failure", windowMs: 1_000, execute: failed });
  await executeDeduplicated({ key: "failure", windowMs: 1_000, execute: failed });
  assert.equal(failedCalls, 2);
  clearDeduplicationCache();
});
