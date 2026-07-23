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

test("gateway opens a persistent circuit after repeated 503 failures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "free-llm-circuit-api-"));
  process.env.ACCOUNTS_PATH = path.join(directory, "accounts.json");
  process.env.ANALYTICS_PATH = path.join(directory, "analytics.json");
  process.env.ROUTING_STATE_PATH = path.join(directory, "routing-state.json");
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  let upstreamCalls = 0;
  const upstream = createServer((_request, response) => {
    upstreamCalls += 1;
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "service unavailable" } }));
  });
  const upstreamPort = await listen(upstream);

  const providersPath = path.join(directory, "providers.json");
  await writeFile(providersPath, JSON.stringify({
    providers: [{
      id: "mock-circuit",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      model: "mock-model",
      enabled: true,
    }],
  }));
  process.env.PROVIDERS_CONFIG = providersPath;

  const { routerKey } = await createAccount("Circuit router");
  await setProviderKey(routerKey, "mock-circuit", "mock-provider-key");

  const gateway = createServer((request, response) => {
    void handleRequest(request, response);
  });
  const gatewayPort = await listen(gateway);
  const endpoint = `http://127.0.0.1:${gatewayPort}/v1/chat/completions`;
  const requestInit = {
    method: "POST",
    headers: {
      authorization: `Bearer ${routerKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "free-router",
      messages: [{ role: "user", content: "hello" }],
    }),
  } as const;

  try {
    const first = await fetch(endpoint, requestInit);
    const second = await fetch(endpoint, requestInit);
    assert.equal(first.status, 503);
    assert.equal(second.status, 503);
    assert.equal(upstreamCalls, 2);

    const third = await fetch(endpoint, requestInit);
    assert.equal(third.status, 503);
    const thirdBody = await third.json() as { error?: { type?: string } };
    assert.equal(thirdBody.error?.type, "providers_unavailable");
    assert.equal(upstreamCalls, 3);

    const fourth = await fetch(endpoint, requestInit);
    assert.equal(fourth.status, 503);
    assert.equal(upstreamCalls, 3, "open circuit should skip the upstream provider");
    assert.ok(Number(fourth.headers.get("retry-after")) >= 1);


    const logs = await listRequestLogs(hashRouterKey(routerKey));
    assert.equal(logs.length, 4, "every failed gateway request should appear in analytics");
    assert.ok(logs.every((entry) => entry.status === 503));
    assert.ok(logs.every((entry) => entry.providerId === "mock-circuit"));
    assert.ok(logs.every((entry) => entry.apiFormat === "openai-compatible"));
    assert.ok(logs.every((entry) => entry.endpoint === "/v1/chat/completions"));

    const exhaustedLog = logs.find((entry) => {
      const payload = entry.response as { error?: { type?: string } };
      return payload.error?.type === "providers_exhausted";
    });
    assert.ok(exhaustedLog, "upstream failures should preserve provider attempt details");
    const exhaustedPayload = exhaustedLog.response as {
      error?: { attempts?: Array<{ provider?: string; status?: number }> };
    };
    assert.equal(exhaustedPayload.error?.attempts?.[0]?.provider, "mock-circuit");
    assert.equal(exhaustedPayload.error?.attempts?.[0]?.status, 503);
  } finally {
    await new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
