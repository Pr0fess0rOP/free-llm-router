import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccount } from "../src/accounts.js";
import { runLocalNodeCliCommand } from "../src/local-nodes/agent/cli-commands.js";
import { sendLocalNodeHeartbeat } from "../src/local-nodes/agent/heartbeat.js";
import { loadLocalAgentConfig } from "../src/local-nodes/agent/local-node-config.js";
import { registerAgentEndpoint } from "../src/local-nodes/agent/node-api.js";
import { discoverRuntimeModels, runtimeConnection } from "../src/local-nodes/agent/runtime.js";
import { startLocalAgent } from "../src/local-nodes/agent/server.js";
import { resetLocalNodeSigningKeyCache } from "../src/local-nodes/local-node-request-auth.js";
import { createLocalNodePairingCode } from "../src/local-nodes/pairing-service.js";
import { handleRequest } from "../src/server.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
}

test("rejects LM Studio origins outside loopback or with a path", () => {
  for (const origin of ["http://example.com:1234", "http://localhost:1234/v1"]) {
    assert.throws(() => runtimeConnection({ runtime: "lmstudio", runtimeBaseUrl: origin }), /LM Studio URL/);
  }
  assert.equal(runtimeConnection({ runtime: "lmstudio" }).origin, "http://127.0.0.1:1234");
});

test("reports which LM Studio address failed during model discovery", async () => {
  await assert.rejects(
    discoverRuntimeModels({ runtime: "lmstudio", runtimeBaseUrl: "http://127.0.0.1:2345" }, [], async () => {
      throw new TypeError("fetch failed");
    }),
    /Could not reach LM Studio at http:\/\/127\.0\.0\.1:2345.*Developer tab.*--lmstudio-url/,
  );
});

test("pairs LM Studio, syncs model availability, streams, and reconnects from saved config", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "freellm-lmstudio-"));
  const fileSettings = {
    ACCOUNTS_PATH: "accounts.json",
    LOCAL_NODES_PATH: "nodes.json",
    LOCAL_NODE_SIGNING_KEY_PATH: "signing.json",
    ROUTING_STATE_PATH: "routing.json",
    ANALYTICS_PATH: "analytics.json",
    PROVIDERS_CONFIG: "providers.json",
    FREE_LLM_LOCAL_NODE_CONFIG: "agent.json",
  };
  const envNames = [
    ...Object.keys(fileSettings), "LOCAL_NODE_ALLOW_HTTP_LOOPBACK", "LMSTUDIO_API_TOKEN",
    "KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  ];
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
  for (const [name, file] of Object.entries(fileSettings)) process.env[name] = path.join(directory, file);
  process.env.LOCAL_NODE_ALLOW_HTTP_LOOPBACK = "true";
  process.env.LMSTUDIO_API_TOKEN = "local-runtime-test-token";
  resetLocalNodeSigningKeyCache();
  await writeFile(path.join(directory, "providers.json"), '{"providers":[]}');

  let modelVisible = false;
  const upstreamCalls: Array<{ url: string | undefined; authorization: string | undefined }> = [];
  const mockStudio = createServer(async (request, response) => {
    upstreamCalls.push({ url: request.url, authorization: request.headers.authorization });
    if (request.headers.authorization !== "Bearer local-runtime-test-token") {
      response.writeHead(401).end();
      return;
    }
    if (request.url === "/api/v1/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ models: [
        { type: "embedding", key: "embedding-only", loaded_instances: [] },
        {
          type: "llm", key: "owner/example-llm", display_name: "Example LLM",
          capabilities: { vision: false, trained_for_tool_use: true, reasoning: { allowed_options: ["off", "on"] } },
          loaded_instances: [],
        },
      ] }));
      return;
    }
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        data: modelVisible ? [{ id: "owner/example-llm" }, { id: "embedding-only" }] : [],
      }));
      return;
    }
    if (request.url === "/v1/chat/completions") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.model !== "owner/example-llm" || body.stream !== true) {
        response.writeHead(400).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"Studio reply"}}]}\n\ndata: [DONE]\n\n');
      return;
    }
    response.writeHead(404).end();
  });
  const gateway = createServer((request, response) => void handleRequest(request, response));
  let agent: Awaited<ReturnType<typeof startLocalAgent>> | undefined;
  try {
    const [studioUrl, routerUrl] = await Promise.all([listen(mockStudio), listen(gateway)]);
    const owner = await createAccount("LM Studio owner");
    const pairing = await createLocalNodePairingCode(owner.account.id);
    await runLocalNodeCliCommand("connect", [
      "lmstudio", "--code", pairing.code, "--router-url", routerUrl, "--lmstudio-url", studioUrl,
      "--models", "owner/example-llm", "--name", "Studio test", "--no-start",
    ], { cliVersion: "0.8.0" });

    assert.doesNotMatch(await readFile(path.join(directory, "agent.json"), "utf8"), /local-runtime-test-token/);
    const config = await loadLocalAgentConfig();
    assert.ok(config);
    assert.equal(config.runtime, "lmstudio");
    assert.equal(config.runtimeBaseUrl, studioUrl);
    assert.deepEqual(config.models.map(({ modelId }) => modelId), ["owner/example-llm"]);
    assert.equal(config.models[0]?.available, false);
    assert.equal(config.models[0]?.capabilities.reasoning, "supported");
    assert.equal(config.models[0]?.capabilities.vision, "unsupported");
    config.agentPort = 0;
    agent = await startLocalAgent(config);
    await registerAgentEndpoint(config, `http://127.0.0.1:${agent.port}`);
    await sendLocalNodeHeartbeat(config, agent);

    const route = () => fetch(`${routerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.routerKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "free-router", stream: true, messages: [{ role: "user", content: "Hello" }] }),
    });
    const unavailable = await route();
    assert.equal(unavailable.status, 400);
    await unavailable.body?.cancel();
    modelVisible = true;
    const active = await sendLocalNodeHeartbeat(config, agent);
    assert.equal(active.models[0]?.available, true);
    assert.equal(active.models[0]?.loaded, false);
    const stream = await route();
    assert.equal(stream.status, 200);
    assert.match(await stream.text(), /Studio reply/);

    delete process.env.LMSTUDIO_API_TOKEN;
    assert.equal((await sendLocalNodeHeartbeat(config, agent)).status, "offline");
    assert.equal(config.models[0]?.installed, true);
    process.env.LMSTUDIO_API_TOKEN = "local-runtime-test-token";
    await agent.close();
    agent = undefined;
    const saved = await loadLocalAgentConfig();
    assert.ok(saved);
    agent = await startLocalAgent(saved);
    await registerAgentEndpoint(saved, `http://127.0.0.1:${agent.port}`);
    const reconnected = await sendLocalNodeHeartbeat(saved, agent);
    assert.equal(reconnected.id, active.id);
    assert.equal(reconnected.status, "online");
    assert.match(await (await route()).text(), /Studio reply/);
    assert.ok(upstreamCalls.filter((call) => call.url === "/v1/chat/completions")
      .every((call) => call.authorization === "Bearer local-runtime-test-token"));
  } finally {
    await agent?.close();
    await Promise.all([close(gateway), close(mockStudio)]);
    for (const name of envNames) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetLocalNodeSigningKeyCache();
    await rm(directory, { recursive: true, force: true });
  }
});
