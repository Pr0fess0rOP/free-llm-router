import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccount, hashRouterKey, setProviderKey } from "../src/accounts.js";
import { listRequestLogs } from "../src/analytics.js";
import { handleRequest } from "../src/server.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return address.port;
}

test("failed provider authentication requests appear in Analysis for every API format", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "free-llm-failed-analytics-"));
  process.env.ACCOUNTS_PATH = path.join(directory, "accounts.json");
  process.env.ANALYTICS_PATH = path.join(directory, "analytics.json");
  process.env.ROUTING_STATE_PATH = path.join(directory, "routing-state.json");
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  const upstream = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: { message: "Invalid provider API key" },
    }));
  });
  const upstreamPort = await listen(upstream);

  const providersPath = path.join(directory, "providers.json");
  await writeFile(providersPath, JSON.stringify({
    providers: [{
      id: "mock-auth",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      model: "mock-model",
      enabled: true,
    }],
  }));
  process.env.PROVIDERS_CONFIG = providersPath;

  const { routerKey } = await createAccount("Failed analytics router");
  await setProviderKey(routerKey, "mock-auth", "intentionally-wrong-key");

  const gateway = createServer((request, response) => {
    void handleRequest(request, response);
  });
  const gatewayPort = await listen(gateway);
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;

  const requests = [
    {
      endpoint: "/v1/chat/completions",
      apiFormat: "openai-compatible",
      body: {
        model: "free-router",
        messages: [{ role: "user", content: "hello" }],
      },
    },
    {
      endpoint: "/v1/messages",
      apiFormat: "claude-code-compatible",
      body: {
        model: "claude-free-router",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      },
    },
    {
      endpoint: "/v1/responses",
      apiFormat: "openai-responses-compatible",
      body: {
        model: "codex-free-router",
        input: "hello",
      },
    },
  ] as const;

  try {
    for (const request of requests) {
      const result = await fetch(`${baseUrl}${request.endpoint}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${routerKey}`,
          "content-type": "application/json",
          ...(request.endpoint === "/v1/messages"
            ? { "anthropic-version": "2023-06-01" }
            : {}),
        },
        body: JSON.stringify(request.body),
      });
      assert.equal(result.status, 503);
    }

    const logs = await listRequestLogs(hashRouterKey(routerKey));
    assert.equal(logs.length, requests.length);

    for (const request of requests) {
      const log = logs.find((entry) => entry.endpoint === request.endpoint);
      assert.ok(log, `${request.endpoint} failure should be recorded`);
      assert.equal(log.apiFormat, request.apiFormat);
      assert.equal(log.providerId, "mock-auth");
      assert.equal(log.providerModel, "mock-model");
      assert.equal(log.status, 503);

      const payload = log.response as {
        error?: {
          type?: string;
          attempts?: Array<{ provider?: string; status?: number; message?: string }>;
        };
      };
      assert.equal(payload.error?.type, "providers_exhausted");
      assert.equal(payload.error?.attempts?.[0]?.provider, "mock-auth");
      assert.equal(payload.error?.attempts?.[0]?.status, 401);
      assert.equal(payload.error?.attempts?.[0]?.message, "Invalid provider API key");
      assert.equal(log.providerAttempts?.length, 1);
      assert.equal(log.providerAttempts?.[0]?.providerId, "mock-auth");
      assert.equal(log.providerAttempts?.[0]?.status, 401);
      assert.equal(log.providerAttempts?.[0]?.retryStopReason, "no_more_candidates");
      assert.equal(log.providerAttempts?.[0]?.recoveryAction, "stop");
      assert.equal(log.providerAttempts?.[0]?.failoverReason, "provider_authentication_failed");
      const timelineTypes = log.timeline?.map((event) => event.type) ?? [];
      assert.equal(timelineTypes[0], "request_received");
      assert.ok(timelineTypes.includes("provider_attempt_started"));
      assert.ok(timelineTypes.includes("provider_attempt_failed"));
      assert.ok(timelineTypes.includes("retry_stopped"));
      assert.equal(timelineTypes.at(-1), "request_failed");
      assert.equal(
        log.timeline?.find((event) => event.type === "provider_attempt_failed")?.details?.status,
        401,
      );
    }
  } finally {
    await new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
