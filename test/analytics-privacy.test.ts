import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequestLog, createStreamingRequestLog, listRequestLogs } from "../src/analytics.js";

const logOptions = {
  routerKeyHash: "privacy-test", providerId: "provider", providerModel: "exact-model",
  apiFormat: "openai-compatible" as const, endpoint: "/v1/chat/completions", status: 200, latencyMs: 1,
};

test("analytics redacts credential variants before clipping JSON and encoded tool output", () => {
  const fields = ["apiKey", "API_KEY", "access_token", "refreshToken", "client-secret", "routerKey", "deviceCredential", "X-Api-Key", "Authorization", "cookie", "OPENAI_API_KEY", "LOCAL_NODE_SIGNING_PRIVATE_KEY"];
  const secrets = Object.fromEntries(fields.map((name) => [name, "sensitive-marker"]));
  const requestBody = {
    model: "free-router", temperature: 0, top_p: 0.5, max_tokens: 8192,
    response_format: { type: "json_object" }, reasoning_effort: "high",
    metadata: secrets, input: [{ type: "function_call_output", output: JSON.stringify(secrets) }],
    prompt: "[SOURCE] normal text",
  };
  const entry = createRequestLog({
    ...logOptions, requestBody,
    upstreamRequestBody: { ...requestBody, max_tokens: 2048 },
    responseText: JSON.stringify({ ...secrets, large: "x".repeat(9000) }),
    responseContentType: "application/json",
  });
  assert.equal(JSON.stringify(entry).includes("sensitive-marker"), false);
  const incoming = entry.request as typeof requestBody;
  assert.equal(incoming.temperature, 0);
  assert.equal(incoming.reasoning_effort, "high");
  assert.equal(incoming.response_format.type, "json_object");
  assert.equal(incoming.prompt, requestBody.prompt);
  assert.equal((entry.upstreamRequest as typeof requestBody).model, "exact-model");
  assert.equal((entry.upstreamRequest as typeof requestBody).max_tokens, 2048);
  const streamed = createStreamingRequestLog({ ...logOptions, requestBody, upstreamRequestBody: requestBody });
  assert.equal((streamed.request as typeof requestBody).response_format.type, "json_object");
  assert.equal(JSON.stringify(streamed).includes("sensitive-marker"), false);
  const text = createRequestLog({
    ...logOptions, requestBody: {},
    responseText: "api_key=sensitive-marker&other=safe Bearer another-sensitive-marker",
    responseContentType: "text/plain",
  });
  assert.equal(JSON.stringify(text).includes("sensitive-marker"), false);
  assert.match(String(text.response), /other=safe/);
});

test("historical analytics snapshots are redacted when read", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "flr-analytics-privacy-"));
  const names = ["ANALYTICS_PATH", "KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.ANALYTICS_PATH = path.join(directory, "analytics.json");
  try {
    const entry = createRequestLog({ ...logOptions, requestBody: {}, responseText: "{}", responseContentType: "application/json" });
    entry.request = { apiKey: "historical-sensitive-marker" };
    entry.response = { access_token: "historical-sensitive-marker" };
    entry.upstreamRequest = { clientSecret: "historical-sensitive-marker" };
    await writeFile(process.env.ANALYTICS_PATH, JSON.stringify({ requests: [entry] }));
    const logs = await listRequestLogs(logOptions.routerKeyHash);
    assert.equal(logs.length, 1);
    assert.equal(JSON.stringify(logs).includes("historical-sensitive-marker"), false);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
