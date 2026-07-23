import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
}

function numericHeader(response: Response, name: string): number {
  const raw = response.headers.get(name);
  assert.match(raw ?? "", /^\d+(?:\.\d+)?$/, `${name} should be numeric`);
  return Number(raw);
}

test("records normalized performance timing and headers across all API formats", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "free-llm-performance-"));
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

  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    if (body.stream === true) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      await new Promise((resolve) => setTimeout(resolve, 35));
      response.write('data: {"choices":[{"delta":{"content":"hello"},"index":0}]}\n\n');
      await new Promise((resolve) => setTimeout(resolve, 25));
      response.end('data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl_timing",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const providersPath = path.join(directory, "providers.json");
  await writeFile(providersPath, JSON.stringify({ providers: [{
    id: "timing-provider",
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    model: "timing-model",
    enabled: true,
  }] }));
  process.env.PROVIDERS_CONFIG = providersPath;

  const { routerKey } = await createAccount("Performance router");
  await setProviderKey(routerKey, "timing-provider", "provider-key");
  const gateway = createServer((request, response) => void handleRequest(request, response));
  const gatewayPort = await listen(gateway);
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;

  try {
    const cases = [
      ["/v1/chat/completions", { model: "free-router", messages: [{ role: "user", content: "chat" }] }],
      ["/v1/responses", { model: "codex-free-router", input: "responses" }],
      ["/v1/messages", { model: "claude-free-router", max_tokens: 32, messages: [{ role: "user", content: "claude" }] }],
    ] as const;
    for (const [endpoint, body] of cases) {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: { authorization: `Bearer ${routerKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      const total = numericHeader(response, "x-free-llm-total-latency-ms");
      const provider = numericHeader(response, "x-free-llm-provider-latency-ms");
      numericHeader(response, "x-free-llm-router-latency-ms");
      numericHeader(response, "x-free-llm-retry-delay-ms");
      assert.ok(total >= provider);
      await response.arrayBuffer();
    }

    const stream = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${routerKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "free-router",
        stream: true,
        messages: [{ role: "user", content: "stream" }],
      }),
    });
    assert.equal(stream.status, 200);
    assert.ok(numericHeader(stream, "x-free-llm-first-token-ms") >= 35);
    await stream.text();

    const logs = await listRequestLogs(hashRouterKey(routerKey), 10);
    assert.equal(logs.length, 4);
    for (const log of logs) {
      assert.ok(log.performance);
      assert.equal(log.performance.totalLatencyMs, log.latencyMs);
      assert.ok(log.performance.providerLatencyMs >= 0);
      assert.equal(log.performance.attempts.length, 1);
    }
    const streamLog = logs.find((log) => log.request && JSON.stringify(log.request).includes('"stream":true'));
    assert.ok(streamLog?.performance?.firstTokenMs !== undefined);
    assert.ok(streamLog?.performance?.streamDurationMs !== undefined);
    assert.ok((streamLog?.performance?.streamDurationMs ?? -1) >= 0);
  } finally {
    await close(gateway);
    await close(upstream);
    if (previous.accounts === undefined) delete process.env.ACCOUNTS_PATH; else process.env.ACCOUNTS_PATH = previous.accounts;
    if (previous.analytics === undefined) delete process.env.ANALYTICS_PATH; else process.env.ANALYTICS_PATH = previous.analytics;
    if (previous.routing === undefined) delete process.env.ROUTING_STATE_PATH; else process.env.ROUTING_STATE_PATH = previous.routing;
    if (previous.providers === undefined) delete process.env.PROVIDERS_CONFIG; else process.env.PROVIDERS_CONFIG = previous.providers;
    await rm(directory, { recursive: true, force: true });
  }
});
