import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccount, hashRouterKey, setProviderKey } from "../src/accounts.js";
import { analyticsSummary, listRequestLogs } from "../src/analytics.js";
import { handleRequest } from "../src/server.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return address.port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

test("records P4.4 client and tool analytics across all three API formats", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "free-llm-advanced-analytics-"));
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
    const body = await jsonBody(request);
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const first = tools[0] as { function?: { name?: string }; name?: string } | undefined;
    const name = first?.function?.name ?? first?.name;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl_analytics",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "mock-model",
      choices: [{
        index: 0,
        message: name
          ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: "{}" } }] }
          : { role: "assistant", content: "ok" },
        finish_reason: name ? "tool_calls" : "stop",
      }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const providersPath = path.join(directory, "providers.json");
  await writeFile(providersPath, JSON.stringify({ providers: [{
    id: "mock-analytics",
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    model: "mock-model",
    enabled: true,
  }] }));
  process.env.PROVIDERS_CONFIG = providersPath;

  const { routerKey } = await createAccount("Advanced analytics router");
  await setProviderKey(routerKey, "mock-analytics", "mock-provider-key");
  const gateway = createServer((request, response) => void handleRequest(request, response));
  const gatewayPort = await listen(gateway);
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;

  try {
    const cases = [
      {
        endpoint: "/v1/chat/completions",
        clientId: "openai-python",
        headers: { "user-agent": "openai-python/1.0", "x-stainless-lang": "python" },
        body: {
          model: "free-router",
          messages: [{ role: "user", content: "search" }],
          tools: [{ type: "function", function: { name: "search_docs", parameters: { type: "object" } } }],
        },
      },
      {
        endpoint: "/v1/responses",
        clientId: "codex-cli",
        headers: { "user-agent": "codex-cli/1.0" },
        body: {
          model: "codex-free-router",
          input: "lookup",
          tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
        },
      },
      {
        endpoint: "/v1/messages",
        clientId: "claude-code",
        headers: { "user-agent": "claude-code/1.0", "anthropic-version": "2023-06-01" },
        body: {
          model: "claude-free-router",
          max_tokens: 64,
          messages: [{ role: "user", content: "weather" }],
          tools: [{ name: "weather", input_schema: { type: "object" } }],
        },
      },
    ] as const;

    for (const item of cases) {
      const result = await fetch(`${baseUrl}${item.endpoint}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${routerKey}`,
          "content-type": "application/json",
          ...item.headers,
        },
        body: JSON.stringify(item.body),
      });
      const responseText = await result.text();
      assert.equal(result.status, 200, `${item.endpoint} should succeed: ${responseText}`);
    }

    const logs = await listRequestLogs(hashRouterKey(routerKey), 10);
    assert.equal(logs.length, 3);
    for (const item of cases) {
      const log = logs.find((entry) => entry.endpoint === item.endpoint);
      assert.ok(log);
      assert.equal(log.clientApplication?.id, item.clientId);
      assert.equal(log.toolAnalytics?.toolRequest, true);
      assert.equal(log.toolAnalytics?.generatedToolCallCount, 1);
      assert.equal(log.providerAttemptCount, 1);
      assert.equal(log.fallbackUsed, false);
      assert.equal(log.usage?.totalTokens, 16);
    }

    const summary = analyticsSummary(logs);
    assert.equal(summary.totalTokens, 48);
    assert.equal(summary.toolEnabledRequests, 3);
    assert.equal(summary.generatedToolCalls, 3);
    assert.equal(summary.averageProviderAttempts, 1);
    assert.equal(summary.fallbackRate, 0);
    assert.equal(summary.clients.length, 3);
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
