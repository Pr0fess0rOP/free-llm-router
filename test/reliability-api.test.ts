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
import { DEFAULT_RELIABILITY_SETTINGS } from "../src/reliability-settings.js";
import { handleRequest } from "../src/server.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return address.port;
}

test("persists retry settings and records successful failover attempts for every API format", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "free-llm-reliability-api-"));
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

  let failingCalls = 0;
  const failingUpstream = createServer((_request, response) => {
    failingCalls += 1;
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "temporary outage" } }));
  });
  const failingPort = await listen(failingUpstream);

  let healthyCalls = 0;
  const healthyUpstream = createServer((_request, response) => {
    healthyCalls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `chatcmpl_${healthyCalls}`,
      choices: [{
        message: { role: "assistant", content: "recovered" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }));
  });
  const healthyPort = await listen(healthyUpstream);

  const providersPath = path.join(directory, "providers.json");
  await writeFile(providersPath, JSON.stringify({
    providers: [
      {
        id: "failing",
        baseUrl: `http://127.0.0.1:${failingPort}`,
        model: "failing-model",
        priority: 10,
        enabled: true,
      },
      {
        id: "healthy",
        baseUrl: `http://127.0.0.1:${healthyPort}`,
        model: "healthy-model",
        priority: 20,
        enabled: true,
      },
    ],
  }));
  process.env.PROVIDERS_CONFIG = providersPath;

  const { routerKey } = await createAccount("Reliability API router");
  await setProviderKey(routerKey, "failing", "failing-key");
  await setProviderKey(routerKey, "healthy", "healthy-key");
  const saved = await updateAccountSettings(routerKey, {
    routingPolicy: {
      strategy: "priority",
      providerOrder: ["failing", "healthy"],
    },
    reliabilitySettings: {
      ...DEFAULT_RELIABILITY_SETTINGS,
      providerTimeoutMs: 4_000,
      totalRequestTimeoutMs: 12_000,
      maxProviderAttempts: 2,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      useJitter: false,
    },
  });
  assert.equal(saved?.reliabilitySettings.maxProviderAttempts, 2);
  assert.equal(saved?.reliabilitySettings.totalRequestTimeoutMs, 12_000);

  const gateway = createServer((request, response) => {
    void handleRequest(request, response);
  });
  const gatewayPort = await listen(gateway);
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;

  const requests = [
    {
      endpoint: "/v1/chat/completions",
      headers: {},
      body: {
        model: "free-router",
        messages: [{ role: "user", content: "chat" }],
      },
    },
    {
      endpoint: "/v1/responses",
      headers: {},
      body: { model: "codex-free-router", input: "responses" },
    },
    {
      endpoint: "/v1/messages",
      headers: { "anthropic-version": "2023-06-01" },
      body: {
        model: "claude-free-router",
        max_tokens: 32,
        messages: [{ role: "user", content: "claude" }],
      },
    },
  ] as const;

  try {
    for (const request of requests) {
      const response = await fetch(`${baseUrl}${request.endpoint}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${routerKey}`,
          "content-type": "application/json",
          ...request.headers,
        },
        body: JSON.stringify(request.body),
      });
      assert.equal(response.status, 200, `${request.endpoint} should fail over successfully`);
    }

    assert.equal(failingCalls, 3);
    assert.equal(healthyCalls, 3);

    const logs = await listRequestLogs(hashRouterKey(routerKey));
    assert.equal(logs.length, 3);
    for (const request of requests) {
      const log = logs.find((entry) => entry.endpoint === request.endpoint);
      assert.ok(log, `${request.endpoint} should have an Analysis record`);
      assert.equal(log.providerId, "healthy");
      assert.equal(log.providerAttempts?.length, 2);
      assert.equal(log.providerAttempts?.[0]?.providerId, "failing");
      assert.equal(log.providerAttempts?.[0]?.status, 503);
      assert.equal(log.providerAttempts?.[0]?.retryable, true);
      assert.equal(log.providerAttempts?.[0]?.retryDelayMs, 0);
      assert.equal(log.providerAttempts?.[1]?.providerId, "healthy");
      assert.equal(log.providerAttempts?.[1]?.success, true);
      assert.match(log.providerAttempts?.[0]?.startedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
      assert.match(log.providerAttempts?.[1]?.completedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
      const timelineTypes = log.timeline?.map((event) => event.type) ?? [];
      assert.equal(timelineTypes[0], "request_received");
      assert.ok(timelineTypes.includes("alias_resolved"));
      assert.equal(timelineTypes.filter((type) => type === "provider_attempt_started").length, 2);
      assert.ok(timelineTypes.includes("provider_attempt_failed"));
      assert.ok(timelineTypes.includes("retry_scheduled"));
      assert.ok(timelineTypes.includes("provider_attempt_succeeded"));
      assert.equal(timelineTypes.at(-1), "response_returned");
    }
  } finally {
    await new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => failingUpstream.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => healthyUpstream.close((error) => error ? reject(error) : resolve()));
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

test("provider-specific 404 failures immediately fail over for every API format", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "free-llm-provider-failover-api-"));
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

  let unavailableCalls = 0;
  const unavailableUpstream = createServer((_request, response) => {
    unavailableCalls += 1;
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: {
        message: "This model is unavailable for free. The paid version is available under another slug.",
      },
    }));
  });
  const unavailablePort = await listen(unavailableUpstream);

  let healthyCalls = 0;
  const healthyUpstream = createServer((_request, response) => {
    healthyCalls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `chatcmpl_failover_${healthyCalls}`,
      choices: [{
        message: { role: "assistant", content: "recovered after provider-specific 404" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    }));
  });
  const healthyPort = await listen(healthyUpstream);

  const providersPath = path.join(directory, "providers.json");
  await writeFile(providersPath, JSON.stringify({
    providers: [
      {
        id: "openrouter",
        baseUrl: `http://127.0.0.1:${unavailablePort}`,
        model: "unavailable-free-model",
        priority: 10,
        enabled: true,
      },
      {
        id: "groq",
        baseUrl: `http://127.0.0.1:${healthyPort}`,
        model: "healthy-model",
        priority: 20,
        enabled: true,
      },
    ],
  }));
  process.env.PROVIDERS_CONFIG = providersPath;

  const { routerKey } = await createAccount("Provider-specific failover router");
  await setProviderKey(routerKey, "openrouter", "openrouter-key");
  await setProviderKey(routerKey, "groq", "groq-key");
  await updateAccountSettings(routerKey, {
    routingPolicy: {
      strategy: "priority",
      providerOrder: ["openrouter", "groq"],
    },
    reliabilitySettings: {
      ...DEFAULT_RELIABILITY_SETTINGS,
      maxProviderAttempts: 2,
      initialBackoffMs: 2_000,
      maxBackoffMs: 2_000,
      useJitter: false,
    },
  });

  const gateway = createServer((request, response) => {
    void handleRequest(request, response);
  });
  const gatewayPort = await listen(gateway);
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;
  const requests = [
    {
      endpoint: "/v1/chat/completions",
      headers: {},
      body: {
        model: "free-router",
        messages: [{ role: "user", content: "chat" }],
      },
    },
    {
      endpoint: "/v1/responses",
      headers: {},
      body: { model: "codex-free-router", input: "responses" },
    },
    {
      endpoint: "/v1/messages",
      headers: { "anthropic-version": "2023-06-01" },
      body: {
        model: "claude-free-router",
        max_tokens: 32,
        messages: [{ role: "user", content: "claude" }],
      },
    },
  ] as const;

  try {
    for (const request of requests) {
      const response = await fetch(`${baseUrl}${request.endpoint}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${routerKey}`,
          "content-type": "application/json",
          ...request.headers,
        },
        body: JSON.stringify(request.body),
      });
      assert.equal(response.status, 200, `${request.endpoint} should immediately fail over after 404`);
      assert.equal(response.headers.get("x-free-llm-provider"), "groq");
      assert.equal(response.headers.get("x-free-llm-provider-attempts"), "2");
      assert.equal(response.headers.get("x-free-llm-fallback-used"), "true");
    }

    assert.equal(unavailableCalls, 3);
    assert.equal(healthyCalls, 3);

    const logs = await listRequestLogs(hashRouterKey(routerKey));
    assert.equal(logs.length, 3);
    for (const request of requests) {
      const log = logs.find((entry) => entry.endpoint === request.endpoint);
      assert.ok(log, `${request.endpoint} should have an Analysis record`);
      assert.equal(log.providerId, "groq");
      assert.equal(log.providerAttempts?.length, 2);
      assert.equal(log.providerAttempts?.[0]?.status, 404);
      assert.equal(log.providerAttempts?.[0]?.retryable, false);
      assert.equal(log.providerAttempts?.[0]?.recoveryAction, "immediate_failover");
      assert.equal(
        log.providerAttempts?.[0]?.failoverReason,
        "provider_model_or_endpoint_unavailable",
      );
      assert.equal(log.providerAttempts?.[0]?.retryDelayMs, undefined);
      const timelineTypes = log.timeline?.map((event) => event.type) ?? [];
      assert.ok(timelineTypes.includes("provider_failover"));
      assert.equal(timelineTypes.includes("retry_scheduled"), false);
      assert.ok(timelineTypes.includes("provider_attempt_succeeded"));
      assert.equal(timelineTypes.at(-1), "response_returned");
    }
  } finally {
    await new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => unavailableUpstream.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => healthyUpstream.close((error) => error ? reject(error) : resolve()));
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
