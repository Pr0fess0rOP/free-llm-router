import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAccount,
  hashRouterKey,
  setProviderKey,
  updateAccountSettings,
} from "../src/accounts.js";
import { listRequestLogs } from "../src/analytics.js";
import { clearDeduplicationCache } from "../src/deduplication.js";
import { getRoutingStats } from "../src/routing-state.js";
import { handleRequest } from "../src/server.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return address.port;
}

test("deduplicates safe requests across all API formats and protects quota accounting", async () => {
  clearDeduplicationCache();
  const directory = await mkdtemp(path.join(tmpdir(), "free-llm-dedup-api-"));
  const previous = {
    accounts: process.env.ACCOUNTS_PATH,
    analytics: process.env.ANALYTICS_PATH,
    routing: process.env.ROUTING_STATE_PATH,
    providers: process.env.PROVIDERS_CONFIG,
  };
  process.env.ACCOUNTS_PATH = path.join(directory, "accounts.json");
  process.env.ANALYTICS_PATH = path.join(directory, "analytics.json");
  process.env.ROUTING_STATE_PATH = path.join(directory, "routing-state.json");
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  let upstreamCalls = 0;
  const upstream = createServer(async (_request, response) => {
    upstreamCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 70));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `chatcmpl_${upstreamCalls}`,
      choices: [{ message: { role: "assistant", content: "same result" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const providersPath = path.join(directory, "providers.json");
  await writeFile(providersPath, JSON.stringify({ providers: [{
    id: "dedup-provider",
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    model: "dedup-model",
    priority: 1,
    enabled: true,
  }] }));
  process.env.PROVIDERS_CONFIG = providersPath;

  const { routerKey } = await createAccount("Dedup router");
  await setProviderKey(routerKey, "dedup-provider", "provider-key");
  const saved = await updateAccountSettings(routerKey, {
    deduplicationSettings: {
      enabled: true,
      windowMs: 30_000,
      automaticFingerprinting: true,
      requireIdempotencyKey: false,
      bypassToolRequests: true,
      bypassMultimodalRequests: true,
      bypassNonDeterministicRequests: true,
    },
  });
  assert.equal(saved?.deduplicationSettings.windowMs, 30_000);

  const gateway = createServer((request, response) => void handleRequest(request, response));
  const gatewayPort = await listen(gateway);
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;
  const cases = [
    {
      endpoint: "/v1/chat/completions",
      body: { model: "free-router", temperature: 0, messages: [{ role: "user", content: "chat dedup" }] },
      headers: {},
    },
    {
      endpoint: "/v1/responses",
      body: { model: "codex-free-router", temperature: 0, input: "responses dedup" },
      headers: {},
    },
    {
      endpoint: "/v1/messages",
      body: { model: "claude-free-router", temperature: 0, max_tokens: 32, messages: [{ role: "user", content: "claude dedup" }] },
      headers: { "anthropic-version": "2023-06-01" },
    },
  ] as const;

  try {
    for (const item of cases) {
      const call = () => fetch(`${baseUrl}${item.endpoint}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${routerKey}`,
          "content-type": "application/json",
          ...item.headers,
        },
        body: JSON.stringify(item.body),
      });
      const [left, right] = await Promise.all([call(), call()]);
      assert.equal(left.status, 200);
      assert.equal(right.status, 200);
      const dedupHeaders = [
        left.headers.get("x-free-llm-deduplicated"),
        right.headers.get("x-free-llm-deduplicated"),
      ].sort();
      assert.deepEqual(dedupHeaders, ["false", "true"]);
      assert.equal(
        left.headers.get("x-free-llm-original-request-id"),
        right.headers.get("x-free-llm-original-request-id"),
      );
      assert.deepEqual(await left.json(), await right.json());

      const cached = await call();
      assert.equal(cached.headers.get("x-free-llm-deduplicated"), "true");
      assert.equal(cached.headers.get("x-free-llm-deduplication-source"), "completed");
      await cached.arrayBuffer();
    }

    assert.equal(upstreamCalls, 3, "one upstream call should serve three callers per API format");
    const stats = await getRoutingStats(hashRouterKey(routerKey));
    assert.equal(stats["dedup-provider"]?.attempts, 3);
    assert.equal(stats["dedup-provider"]?.quotaUsage?.daily.requests, 3);
    assert.equal(stats["dedup-provider"]?.quotaUsage?.daily.totalTokens, 21);

    const logs = await listRequestLogs(hashRouterKey(routerKey), 20);
    assert.equal(logs.length, 9);
    const duplicates = logs.filter((entry) => entry.deduplication?.deduplicated);
    assert.equal(duplicates.length, 6);
    assert.ok(duplicates.some((entry) => entry.deduplication?.source === "in-flight"));
    assert.ok(duplicates.some((entry) => entry.deduplication?.source === "completed"));
    for (const duplicate of duplicates) {
      assert.equal(duplicate.deduplication?.providerCallAvoided, true);
      assert.equal(duplicate.deduplication?.estimatedRequestsSaved, 1);
      assert.equal(duplicate.deduplication?.estimatedTotalTokensSaved, 7);
      assert.match(duplicate.deduplication?.originalRequestId ?? "", /^req_/);
    }
  } finally {
    await new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    clearDeduplicationCache();
    if (previous.accounts === undefined) delete process.env.ACCOUNTS_PATH;
    else process.env.ACCOUNTS_PATH = previous.accounts;
    if (previous.analytics === undefined) delete process.env.ANALYTICS_PATH;
    else process.env.ANALYTICS_PATH = previous.analytics;
    if (previous.routing === undefined) delete process.env.ROUTING_STATE_PATH;
    else process.env.ROUTING_STATE_PATH = previous.routing;
    if (previous.providers === undefined) delete process.env.PROVIDERS_CONFIG;
    else process.env.PROVIDERS_CONFIG = previous.providers;
    await rm(directory, { recursive: true, force: true });
  }
});

test("scopes deduplication by router, fingerprints settings, bypasses unsafe requests, and does not cache failures", async () => {
  clearDeduplicationCache();
  const directory = await mkdtemp(path.join(tmpdir(), "free-llm-dedup-safety-"));
  const previous = {
    accounts: process.env.ACCOUNTS_PATH,
    analytics: process.env.ANALYTICS_PATH,
    routing: process.env.ROUTING_STATE_PATH,
    providers: process.env.PROVIDERS_CONFIG,
  };
  process.env.ACCOUNTS_PATH = path.join(directory, "accounts.json");
  process.env.ANALYTICS_PATH = path.join(directory, "analytics.json");
  process.env.ROUTING_STATE_PATH = path.join(directory, "routing-state.json");
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  let calls = 0;
  let fail = false;
  const upstream = createServer((_request, response) => {
    calls += 1;
    if (fail) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "temporary failure" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `chatcmpl_${calls}`,
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const providersPath = path.join(directory, "providers.json");
  await writeFile(providersPath, JSON.stringify({ providers: [{
    id: "provider",
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    model: "model",
    enabled: true,
  }] }));
  process.env.PROVIDERS_CONFIG = providersPath;

  const first = await createAccount("First");
  const second = await createAccount("Second");
  await setProviderKey(first.routerKey, "provider", "first-provider-key");
  await setProviderKey(second.routerKey, "provider", "second-provider-key");
  const gateway = createServer((request, response) => void handleRequest(request, response));
  const gatewayPort = await listen(gateway);
  const endpoint = `http://127.0.0.1:${gatewayPort}/v1/chat/completions`;
  const request = (routerKey: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${routerKey}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const base = { model: "free-router", temperature: 0, messages: [{ role: "user", content: "same" }] };

  try {
    await request(first.routerKey, base);
    await request(second.routerKey, base);
    assert.equal(calls, 2, "accounts must never share deduplication entries");

    await request(first.routerKey, { ...base, max_tokens: 10 });
    await request(first.routerKey, { ...base, max_tokens: 20 });
    assert.equal(calls, 4, "different generation settings require different fingerprints");

    const unsafe = await request(first.routerKey, { ...base, temperature: 0.8 });
    assert.equal(unsafe.headers.get("x-free-llm-deduplication-bypass"), "non_deterministic_request");
    await request(first.routerKey, { ...base, temperature: 0.8 });
    assert.equal(calls, 6);

    await request(first.routerKey, { ...base, temperature: 0.8 }, { "idempotency-key": "explicit-random-operation" });
    const explicitDuplicate = await request(first.routerKey, { ...base, temperature: 0.9 }, { "idempotency-key": "explicit-random-operation" });
    assert.equal(explicitDuplicate.headers.get("x-free-llm-deduplicated"), "true");
    assert.equal(calls, 7, "an explicit idempotency key should override automatic safety bypasses");

    fail = true;
    const failureBody = { ...base, messages: [{ role: "user", content: "failure is not cached" }] };
    const failedOne = await request(first.routerKey, failureBody);
    const failedTwo = await request(first.routerKey, failureBody);
    assert.equal(failedOne.status, 503);
    assert.equal(failedTwo.status, 503);
    assert.equal(calls, 9, "completed failures must not be reused");
  } finally {
    await new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    clearDeduplicationCache();
    if (previous.accounts === undefined) delete process.env.ACCOUNTS_PATH;
    else process.env.ACCOUNTS_PATH = previous.accounts;
    if (previous.analytics === undefined) delete process.env.ANALYTICS_PATH;
    else process.env.ANALYTICS_PATH = previous.analytics;
    if (previous.routing === undefined) delete process.env.ROUTING_STATE_PATH;
    else process.env.ROUTING_STATE_PATH = previous.routing;
    if (previous.providers === undefined) delete process.env.PROVIDERS_CONFIG;
    else process.env.PROVIDERS_CONFIG = previous.providers;
    await rm(directory, { recursive: true, force: true });
  }
});
