import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAccount,
  setProviderKey,
  setProviderModelCatalog,
  setProviderQuota,
} from "../src/accounts.js";
import { directProviderPlaygroundRequest } from "../src/server.js";
import { getRoutingStats } from "../src/routing-state.js";
import { hashRouterKey } from "../src/accounts.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test port");
      resolve(address.port);
    });
  });
}

test("direct playground calls one exact saved provider model and respects quota", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "free-llm-playground-"));
  const previous = {
    accounts: process.env.ACCOUNTS_PATH,
    analytics: process.env.ANALYTICS_PATH,
    routing: process.env.ROUTING_STATE_PATH,
    providers: process.env.PROVIDERS_CONFIG,
  };
  process.env.ACCOUNTS_PATH = path.join(directory, "accounts.json");
  process.env.ANALYTICS_PATH = path.join(directory, "analytics.json");
  process.env.ROUTING_STATE_PATH = path.join(directory, "routing.json");
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  const receivedModels: string[] = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
    receivedModels.push(body.model);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl_direct",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "direct works" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const providersPath = path.join(directory, "providers.json");
  await writeFile(providersPath, JSON.stringify({ providers: [{
    id: "direct-provider",
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    model: "fallback-model",
    priority: 10,
  }] }));
  process.env.PROVIDERS_CONFIG = providersPath;

  try {
    const { routerKey } = await createAccount("Direct playground router");
    await setProviderKey(routerKey, "direct-provider", "provider-key");
    await setProviderModelCatalog(routerKey, "direct-provider", {
      activeModelId: "model-a",
      models: [
        { id: "model-a", status: "unknown" },
        { id: "model-b", status: "unknown" },
      ],
    });
    await setProviderQuota(routerKey, "direct-provider", {
      dailyRequestLimit: 1,
      warningThresholdPercent: 80,
    });

    const first = await directProviderPlaygroundRequest({
      routerKey,
      providerId: "direct-provider",
      modelId: "model-b",
      apiFormat: "openai-compatible",
      requestBody: {
        model: "ignored-alias",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 32,
      },
    });

    assert.equal(first.ok, true);
    assert.equal(first.providerId, "direct-provider");
    assert.equal(first.modelId, "model-b");
    assert.ok(first.latencyMs >= 0);
    assert.deepEqual(receivedModels, ["model-b"]);
    assert.equal((first.response as { choices?: Array<{ message?: { content?: string } }> })
      .choices?.[0]?.message?.content, "direct works");

    const stats = await getRoutingStats(hashRouterKey(routerKey));
    assert.equal(stats["direct-provider"]?.quotaUsage?.daily.requests, 1);
    assert.equal(stats["direct-provider"]?.quotaUsage?.daily.totalTokens, 5);
    assert.equal(stats["direct-provider"]?.attempts, 0);

    const second = await directProviderPlaygroundRequest({
      routerKey,
      providerId: "direct-provider",
      modelId: "model-a",
      apiFormat: "openai-compatible",
      requestBody: {
        model: "ignored-alias",
        messages: [{ role: "user", content: "hello again" }],
      },
    });
    assert.equal(second.ok, false);
    assert.equal(second.status, 429);
    assert.deepEqual(receivedModels, ["model-b"]);
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    if (previous.accounts === undefined) delete process.env.ACCOUNTS_PATH; else process.env.ACCOUNTS_PATH = previous.accounts;
    if (previous.analytics === undefined) delete process.env.ANALYTICS_PATH; else process.env.ANALYTICS_PATH = previous.analytics;
    if (previous.routing === undefined) delete process.env.ROUTING_STATE_PATH; else process.env.ROUTING_STATE_PATH = previous.routing;
    if (previous.providers === undefined) delete process.env.PROVIDERS_CONFIG; else process.env.PROVIDERS_CONFIG = previous.providers;
    await rm(directory, { recursive: true, force: true });
  }
});
