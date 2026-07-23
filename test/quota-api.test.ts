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
  setProviderQuota,
} from "../src/accounts.js";
import { listRequestLogs } from "../src/analytics.js";
import { getRoutingStats } from "../src/routing-state.js";
import { handleRequest } from "../src/server.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return address.port;
}

test("tracks usage across every API format and blocks requests at quota", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "free-llm-quota-api-"));
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
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `chatcmpl_${upstreamCalls}`,
      choices: [{
        message: { role: "assistant", content: "quota test" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
    }));
  });
  const upstreamPort = await listen(upstream);

  const providersPath = path.join(directory, "providers.json");
  await writeFile(providersPath, JSON.stringify({
    providers: [{
      id: "mock",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      model: "mock-model",
      enabled: true,
    }],
  }));
  process.env.PROVIDERS_CONFIG = providersPath;

  const { routerKey } = await createAccount("Quota router");
  await setProviderKey(routerKey, "mock", "mock-provider-key");
  await setProviderQuota(routerKey, "mock", {
    dailyRequestLimit: 3,
    dailyTokenLimit: 100,
    warningThresholdPercent: 80,
  });

  const gateway = createServer((request, response) => {
    void handleRequest(request, response);
  });
  const gatewayPort = await listen(gateway);
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;
  const headers = {
    authorization: `Bearer ${routerKey}`,
    "content-type": "application/json",
  };

  try {
    const chat = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "free-router",
        messages: [{ role: "user", content: "chat" }],
      }),
    });
    assert.equal(chat.status, 200);

    const responses = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "codex-free-router",
        input: "responses",
        stream: false,
      }),
    });
    assert.equal(responses.status, 200);

    const anthropic = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": routerKey,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-free-router",
        max_tokens: 50,
        messages: [{ role: "user", content: "anthropic" }],
      }),
    });
    assert.equal(anthropic.status, 200);
    assert.equal(upstreamCalls, 3);

    const stats = await getRoutingStats(hashRouterKey(routerKey));
    assert.equal(stats.mock?.quotaUsage?.daily.requests, 3);
    assert.equal(stats.mock?.quotaUsage?.daily.successfulRequests, 3);
    assert.equal(stats.mock?.quotaUsage?.daily.totalTokens, 30);
    assert.equal(stats.mock?.quotaUsage?.lastTokenUsageSource, "reported");

    const blocked = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "free-router",
        messages: [{ role: "user", content: "blocked" }],
      }),
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("x-free-llm-quota-reset-at") !== null, true);
    const blockedBody = await blocked.json() as { error?: { type?: string } };
    assert.equal(blockedBody.error?.type, "providers_quota_exhausted");
    assert.equal(upstreamCalls, 3, "quota exhaustion must skip the upstream call");

    const logs = await listRequestLogs(hashRouterKey(routerKey));
    assert.equal(logs.length, 4);
    const successfulLogs = logs.filter((entry) => entry.status === 200);
    assert.deepEqual(
      successfulLogs.map((entry) => entry.usage?.totalTokens).sort((a, b) => Number(a) - Number(b)),
      [10, 10, 10],
    );
    const failure = logs.find((entry) => entry.status === 429);
    assert.equal(
      failure?.providerEvaluations?.[0]?.state,
      "quota-exhausted",
    );
  } finally {
    await new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
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
