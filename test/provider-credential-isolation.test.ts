import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccount, deleteProviderKey, setProviderKey } from "../src/accounts.js";
import { loadProviders } from "../src/config.js";
import { handleRequest } from "../src/server.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
}

test("account routing excludes deployment credentials across every API format", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "flr-credential-isolation-"));
  const files = {
    ACCOUNTS_PATH: "accounts.json",
    ANALYTICS_PATH: "analytics.json",
    ROUTING_STATE_PATH: "routing.json",
    LOCAL_NODES_PATH: "nodes.json",
    PROVIDERS_CONFIG: "providers.json",
  };
  const envNames = [
    ...Object.keys(files), "ACCOUNT_ENCRYPTION_KEY", "FLR_TEST_DEPLOYMENT_KEY",
    "KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  ];
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
  for (const [name, file] of Object.entries(files)) process.env[name] = path.join(directory, file);
  process.env.ACCOUNT_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
  process.env.FLR_TEST_DEPLOYMENT_KEY = "host-environment-key";

  const upstreamCredentials: Array<string | undefined> = [];
  const upstream = createServer((_request, response) => {
    upstreamCredentials.push(_request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "test-completion",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  const gateway = createServer((request, response) => void handleRequest(request, response));
  try {
    const upstreamUrl = await listen(upstream);
    await writeFile(process.env.PROVIDERS_CONFIG!, JSON.stringify({ providers: [
      { id: "environment-provider", baseUrl: upstreamUrl, model: "environment-model", apiKeyEnv: "FLR_TEST_DEPLOYMENT_KEY" },
      { id: "inline-provider", baseUrl: upstreamUrl, model: "inline-model", apiKey: "host-inline-key" },
      { id: "anonymous-provider", baseUrl: upstreamUrl, model: "anonymous-model" },
      { id: "disabled-provider", baseUrl: upstreamUrl, model: "disabled-model", enabled: false },
    ] }));

    const deploymentProviders = await loadProviders();
    assert.equal(deploymentProviders.find(({ id }) => id === "environment-provider")?.apiKeyValue, "host-environment-key");
    assert.equal(deploymentProviders.find(({ id }) => id === "inline-provider")?.apiKeyValue, "host-inline-key");
    assert.deepEqual(await loadProviders(undefined, {}), []);
    assert.deepEqual(await loadProviders(undefined, {
      "environment-provider": "", "inline-provider": "   ", "disabled-provider": "saved-disabled-key",
    }), []);

    const empty = await createAccount("Empty account");
    const first = await createAccount("First account");
    const second = await createAccount("Second account");
    await setProviderKey(first.routerKey, "environment-provider", "first-account-key");
    await setProviderKey(second.routerKey, "inline-provider", "second-account-key");
    const gatewayUrl = await listen(gateway);
    let sequence = 0;
    const send = async (routerKey: string, endpoint: string) => {
      const prompt = `Hello ${++sequence}`;
      const body = endpoint === "/v1/responses"
        ? { model: "codex-free-router", input: prompt }
        : {
            model: endpoint === "/v1/messages" ? "claude-free-router" : "free-router",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 16,
          };
      const response = await fetch(`${gatewayUrl}${endpoint}`, {
        method: "POST",
        headers: { authorization: `Bearer ${routerKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await response.text();
      return response.status;
    };
    for (const endpoint of ["/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
      const before = upstreamCredentials.length;
      assert.equal(await send(empty.routerKey, endpoint), 400);
      assert.equal(upstreamCredentials.length, before, "An unconfigured account must never call upstream");
      assert.equal(await send(first.routerKey, endpoint), 200);
      assert.equal(upstreamCredentials.at(-1), "Bearer first-account-key");
      assert.equal(await send(second.routerKey, endpoint), 200);
      assert.equal(upstreamCredentials.at(-1), "Bearer second-account-key");
    }
    await deleteProviderKey(first.routerKey, "environment-provider");
    await deleteProviderKey(second.routerKey, "inline-provider");
    const beforeRemoval = upstreamCredentials.length;
    assert.equal(await send(first.routerKey, "/v1/chat/completions"), 400);
    assert.equal(await send(second.routerKey, "/v1/chat/completions"), 400);
    assert.equal(upstreamCredentials.length, beforeRemoval);
    assert.ok(upstreamCredentials.every((credential) =>
      credential === "Bearer first-account-key" || credential === "Bearer second-account-key",
    ));
  } finally {
    await Promise.all([close(gateway), close(upstream)]);
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
