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
import { generateRequestId, validClientRequestId } from "../src/request-ids.js";
import { DEFAULT_RELIABILITY_SETTINGS } from "../src/reliability-settings.js";
import { handleRequest } from "../src/server.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return address.port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
}

test("generates collision-resistant IDs and validates safe client IDs", () => {
  const ids = new Set(Array.from({ length: 5_000 }, generateRequestId));
  assert.equal(ids.size, 5_000);
  for (const id of ids) assert.match(id, /^req_[a-f0-9]{32}$/);
  assert.equal(validClientRequestId("client-job_42:retry.1"), "client-job_42:retry.1");
  assert.equal(validClientRequestId("contains spaces"), undefined);
  assert.equal(validClientRequestId("x".repeat(129)), undefined);
});

test("correlates request IDs, routing headers, upstream attempts, errors, Analysis, streaming, and deduplication", async () => {
  clearDeduplicationCache();
  const directory = await mkdtemp(path.join(tmpdir(), "free-llm-request-ids-"));
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

  const upstreamRequestIds: string[] = [];
  const upstream = createServer(async (request, response) => {
    upstreamRequestIds.push(String(request.headers["x-request-id"] ?? ""));
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const text = JSON.stringify(body).toLowerCase();
    if (text.includes("force failure")) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "forced outage" } }));
      return;
    }
    if (body.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl_stream",
        choices: [{ delta: { role: "assistant", content: "streamed" }, index: 0 }],
      })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl_request_id",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const providersPath = path.join(directory, "providers.json");
  await writeFile(providersPath, JSON.stringify({ providers: [{
    id: "correlation-provider",
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    model: "correlation-model",
    enabled: true,
  }] }));
  process.env.PROVIDERS_CONFIG = providersPath;

  const { routerKey } = await createAccount("Request ID router");
  await setProviderKey(routerKey, "correlation-provider", "provider-key");
  await updateAccountSettings(routerKey, {
    reliabilitySettings: {
      ...DEFAULT_RELIABILITY_SETTINGS,
      maxProviderAttempts: 1,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      useJitter: false,
    },
  });

  const gateway = createServer((request, response) => void handleRequest(request, response));
  const gatewayPort = await listen(gateway);
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;
  const cases = [
    {
      endpoint: "/v1/chat/completions",
      clientRequestId: "client-chat-001",
      body: { model: "free-router", temperature: 0, messages: [{ role: "user", content: "chat" }] },
      headers: {},
    },
    {
      endpoint: "/v1/responses",
      clientRequestId: "client-responses-001",
      body: { model: "codex-free-router", temperature: 0, input: "responses" },
      headers: {},
    },
    {
      endpoint: "/v1/messages",
      clientRequestId: "client-claude-001",
      body: { model: "claude-free-router", temperature: 0, max_tokens: 32, messages: [{ role: "user", content: "claude" }] },
      headers: { "anthropic-version": "2023-06-01" },
    },
  ] as const;

  try {
    for (const item of cases) {
      const response = await fetch(`${baseUrl}${item.endpoint}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${routerKey}`,
          "content-type": "application/json",
          "x-request-id": item.clientRequestId,
          ...item.headers,
        },
        body: JSON.stringify(item.body),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-free-llm-request-id"), item.clientRequestId);
      assert.equal(response.headers.get("x-free-llm-request-id-source"), "client");
      assert.equal(response.headers.get("x-free-llm-client-request-id"), item.clientRequestId);
      assert.equal(response.headers.get("x-free-llm-provider"), "correlation-provider");
      assert.equal(response.headers.get("x-free-llm-provider-model"), "correlation-model");
      assert.equal(response.headers.get("x-free-llm-provider-attempts"), "1");
      assert.equal(response.headers.get("x-free-llm-fallback-used"), "false");
      assert.equal(response.headers.get("x-free-llm-deduplicated"), "false");
      assert.equal(response.headers.get("x-free-llm-routing-strategy"), "priority");
      assert.match(response.headers.get("x-free-llm-total-latency-ms") ?? "", /^\d+$/);
      await response.arrayBuffer();
    }
    assert.deepEqual(upstreamRequestIds.slice(0, 3), cases.map((item) => item.clientRequestId));

    const invalidId = "invalid id with spaces";
    const invalidResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${routerKey}`,
        "content-type": "application/json",
        "x-request-id": invalidId,
      },
      body: JSON.stringify({ model: "free-router", temperature: 0, messages: [{ role: "user", content: "invalid id" }] }),
    });
    const replacementId = invalidResponse.headers.get("x-free-llm-request-id") ?? "";
    assert.match(replacementId, /^req_[a-f0-9]{32}$/);
    assert.equal(invalidResponse.headers.get("x-free-llm-request-id-source"), "generated");
    assert.equal(invalidResponse.headers.get("x-free-llm-client-request-id"), null);
    await invalidResponse.arrayBuffer();
    assert.equal(upstreamRequestIds.at(-1), replacementId);

    const failureId = "client-failure-001";
    const failed = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${routerKey}`,
        "content-type": "application/json",
        "x-request-id": failureId,
      },
      body: JSON.stringify({ model: "free-router", temperature: 0, messages: [{ role: "user", content: "force failure" }] }),
    });
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("x-free-llm-request-id"), failureId);
    assert.equal(failed.headers.get("x-free-llm-provider-attempts"), "1");
    assert.equal(failed.headers.get("x-free-llm-retry-stop-reason"), "maximum_attempts_reached");
    const failedPayload = await failed.json() as { error: { request_id?: string } };
    assert.equal(failedPayload.error.request_id, failureId);

    const authFailure = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer invalid", "content-type": "application/json" },
      body: JSON.stringify({ input: "unauthorized" }),
    });
    const authRequestId = authFailure.headers.get("x-free-llm-request-id") ?? "";
    assert.match(authRequestId, /^req_/);
    const authPayload = await authFailure.json() as { error: { request_id?: string } };
    assert.equal(authPayload.error.request_id, authRequestId);

    const streamId = "client-stream-001";
    const streamed = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${routerKey}`,
        "content-type": "application/json",
        "x-request-id": streamId,
      },
      body: JSON.stringify({
        model: "free-router",
        stream: true,
        messages: [{ role: "user", content: "stream" }],
      }),
    });
    assert.equal(streamed.status, 200);
    assert.equal(streamed.headers.get("x-free-llm-request-id"), streamId);
    assert.equal(streamed.headers.get("x-free-llm-provider-attempts"), "1");
    assert.match(await streamed.text(), /\[DONE\]/);

    const duplicateBody = {
      model: "free-router",
      temperature: 0,
      messages: [{ role: "user", content: "deduplicate correlation" }],
    };
    const dedupCall = (id: string) => fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${routerKey}`,
        "content-type": "application/json",
        "x-request-id": id,
      },
      body: JSON.stringify(duplicateBody),
    });
    const [left, right] = await Promise.all([
      dedupCall("client-dedup-left"),
      dedupCall("client-dedup-right"),
    ]);
    const responses = [left, right];
    assert.deepEqual(
      responses.map((response) => response.headers.get("x-free-llm-request-id")).sort(),
      ["client-dedup-left", "client-dedup-right"],
    );
    const duplicate = responses.find((response) => response.headers.get("x-free-llm-deduplicated") === "true");
    const original = responses.find((response) => response.headers.get("x-free-llm-deduplicated") === "false");
    assert.ok(duplicate);
    assert.ok(original);
    assert.equal(
      duplicate.headers.get("x-free-llm-original-request-id"),
      original.headers.get("x-free-llm-request-id"),
    );
    await Promise.all(responses.map((response) => response.arrayBuffer()));

    const logs = await listRequestLogs(hashRouterKey(routerKey), 50);
    for (const item of cases) {
      const log = logs.find((entry) => entry.requestId === item.clientRequestId);
      assert.ok(log, `${item.clientRequestId} should be searchable in Analysis`);
      assert.equal(log.clientRequestId, item.clientRequestId);
      assert.equal(log.requestIdSource, "client");
      assert.equal(log.routingHeaders?.["x-free-llm-request-id"], item.clientRequestId);
      assert.equal(log.routingHeaders?.["x-free-llm-provider-attempts"], "1");
      assert.match(log.timeline?.[0]?.detail ?? "", new RegExp(item.clientRequestId));
    }
    const failedLog = logs.find((entry) => entry.requestId === failureId);
    assert.equal(failedLog?.status, 503);
    assert.equal(failedLog?.routingHeaders?.["x-free-llm-retry-stop-reason"], "maximum_attempts_reached");
    const duplicateLog = logs.find((entry) => entry.deduplication?.deduplicated === true && entry.requestId?.startsWith("client-dedup"));
    assert.ok(duplicateLog);
    assert.notEqual(duplicateLog.requestId, duplicateLog.deduplication?.originalRequestId);
    assert.equal(duplicateLog.routingHeaders?.["x-free-llm-original-request-id"], duplicateLog.deduplication?.originalRequestId);
  } finally {
    await close(gateway);
    await close(upstream);
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
