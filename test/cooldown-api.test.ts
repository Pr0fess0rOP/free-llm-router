import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccount, setProviderKey } from "../src/accounts.js";
import { handleRequest } from "../src/server.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return address.port;
}

test("gateway persists a 429 cooldown and skips the provider on the next request", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "free-llm-cooldown-api-"));
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
    response.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "2",
    });
    response.end(JSON.stringify({ error: { message: "rate limited" } }));
  });
  const upstreamPort = await listen(upstream);

  const providersPath = path.join(directory, "providers.json");
  await writeFile(providersPath, JSON.stringify({
    providers: [{
      id: "mock",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      model: "mock-model",
      cooldownMs: 1_000,
      enabled: true,
    }],
  }));
  process.env.PROVIDERS_CONFIG = providersPath;

  const { routerKey } = await createAccount("Cooldown router");
  await setProviderKey(routerKey, "mock", "mock-provider-key");

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
    assert.equal(first.status, 429);
    assert.equal(first.headers.get("retry-after"), "2");
    const firstBody = await first.json() as { error?: { type?: string } };
    assert.equal(firstBody.error?.type, "providers_cooling_down");
    assert.equal(upstreamCalls, 1);

    const second = await fetch(endpoint, requestInit);
    assert.equal(second.status, 429);
    assert.equal(upstreamCalls, 1, "cooling provider should be skipped without an upstream call");
  } finally {
    await new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
