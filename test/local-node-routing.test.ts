import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccount, hashRouterKey, setProviderKey, updateAccountSettings } from "../src/accounts.js";
import { startLocalAgent } from "../src/local-nodes/agent/server.js";
import type { LocalAgentConfig } from "../src/local-nodes/agent/local-node-config.js";
import {
  localNodeVerificationKey,
  resetLocalNodeSigningKeyCache,
} from "../src/local-nodes/local-node-request-auth.js";
import {
  createLocalNodePairingCode,
  pairLocalNode,
} from "../src/local-nodes/pairing-service.js";
import {
  getLocalNode,
  localProviderId,
  recordLocalNodeHeartbeat,
  registerLocalNodeEndpoint,
  updateLocalNode,
  updateLocalNodeModel,
} from "../src/local-nodes/local-node-service.js";
import { getRoutingStats } from "../src/routing-state.js";
import { handleRequest } from "../src/server.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return address.port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
}

test("local routing supports prefer-local, cloud fallback, local-only, and account isolation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-local-routing-"));
  const envNames = [
    "ACCOUNTS_PATH", "LOCAL_NODES_PATH", "LOCAL_NODE_SIGNING_KEY_PATH",
    "ROUTING_STATE_PATH", "ANALYTICS_PATH", "PROVIDERS_CONFIG",
    "ACCOUNT_ENCRYPTION_KEY", "LOCAL_NODE_ALLOW_HTTP_LOOPBACK",
    "FREE_LLM_LOCAL_NODE_CONFIG", "KV_REST_API_URL", "KV_REST_API_TOKEN",
    "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  ] as const;
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
  process.env.ACCOUNTS_PATH = path.join(directory, "accounts.json");
  process.env.LOCAL_NODES_PATH = path.join(directory, "nodes.json");
  process.env.LOCAL_NODE_SIGNING_KEY_PATH = path.join(directory, "signing.json");
  process.env.ROUTING_STATE_PATH = path.join(directory, "routing.json");
  process.env.ANALYTICS_PATH = path.join(directory, "analytics.json");
  process.env.ACCOUNT_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
  process.env.LOCAL_NODE_ALLOW_HTTP_LOOPBACK = "true";
  process.env.FREE_LLM_LOCAL_NODE_CONFIG = path.join(directory, "agent.json");
  resetLocalNodeSigningKeyCache();

  let localMode: "success" | "failure" | "first-timeout" | "post-token-failure" = "success";
  let cloudCalls = 0;
  const ollama = createServer(async (request, response) => {
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (localMode === "failure") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Local model unavailable" } }));
      return;
    }
    if (localMode === "first-timeout") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      await new Promise((resolve) => setTimeout(resolve, 200));
      response.end("data: [DONE]\n\n");
      return;
    }
    if (body.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "local_stream", choices: [{ delta: { content: "LOCAL" } }] })}\n\n`);
      if (localMode === "post-token-failure") {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "local_response",
      choices: [{ message: { role: "assistant", content: "LOCAL" } }],
    }));
  });
  const cloud = createServer(async (request, response) => {
    cloudCalls += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "CLOUD" } }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "cloud_response",
      choices: [{ message: { role: "assistant", content: "CLOUD" } }],
    }));
  });
  const ollamaPort = await listen(ollama);
  const cloudPort = await listen(cloud);
  const providersPath = path.join(directory, "providers.json");
  await writeFile(providersPath, JSON.stringify({ providers: [{
    id: "cloud",
    baseUrl: `http://127.0.0.1:${cloudPort}/v1`,
    model: "cloud-model",
    capabilities: {
      streaming: "supported", tools: "supported", jsonMode: "supported",
      structuredOutputs: "supported", vision: "supported", reasoning: "supported",
      embeddings: "unsupported",
    },
  }] }));
  process.env.PROVIDERS_CONFIG = providersPath;

  const gateway = createServer((request, response) => void handleRequest(request, response));
  const gatewayPort = await listen(gateway);
  let agent: Awaited<ReturnType<typeof startLocalAgent>> | undefined;
  try {
    const owner = await createAccount("Local owner");
    await setProviderKey(owner.routerKey, "cloud", "cloud-secret");
    const pairing = await createLocalNodePairingCode(owner.account.id);
    const paired = await pairLocalNode({
      code: pairing.code,
      name: "Routing node",
      runtime: "ollama",
      models: [{ id: "qwen:latest", enabled: true }],
    });
    const localId = localProviderId(paired.node.id, "qwen:latest");
    const verification = await localNodeVerificationKey();
    const agentConfig: LocalAgentConfig = {
      nodeId: paired.node.id,
      ownerAccountId: owner.account.id,
      name: paired.node.name,
      routerBaseUrl: `http://127.0.0.1:${gatewayPort}`,
      verificationPublicKey: verification.publicKey,
      verificationKeyId: verification.keyId,
      credential: { storage: "file", value: paired.deviceCredential, account: paired.node.id },
      allowedModels: ["qwen:latest"],
      models: paired.node.models,
      limits: { ...paired.node.limits, firstTokenTimeoutMs: 80, idleTimeoutMs: 80 },
      agentPort: 0,
      ollamaBaseUrl: `http://127.0.0.1:${ollamaPort}`,
      cliVersion: "test",
    };
    agent = await startLocalAgent(agentConfig);
    await registerLocalNodeEndpoint(paired.node.id, `http://127.0.0.1:${agent.port}`);
    await recordLocalNodeHeartbeat(paired.node.id, {
      agentVersion: "test",
      activeRequests: 0,
      maxConcurrentRequests: 1,
      models: [{ id: "qwen:latest", installed: true }],
    });
    await updateLocalNode(owner.account.id, paired.node.id, { routingMode: "prefer-local" });

    let routeSequence = 0;
    const route = async (routerKey: string, stream = false, extra: Record<string, unknown> = {}) => fetch(
      `http://127.0.0.1:${gatewayPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${routerKey}` },
        body: JSON.stringify({ model: "free-router", stream, messages: [{ role: "user", content: `Hi ${routeSequence += 1}` }], ...extra }),
      },
    );

    const preferred = await route(owner.routerKey);
    assert.equal(preferred.status, 200);
    assert.equal(preferred.headers.get("x-free-llm-provider"), localProviderId(paired.node.id, "qwen:latest"));
    assert.equal(((await preferred.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content, "LOCAL");

    const streamed = await route(owner.routerKey, true);
    assert.equal(streamed.status, 200);
    assert.equal(streamed.headers.get("x-free-llm-provider"), localProviderId(paired.node.id, "qwen:latest"));
    assert.match(await streamed.text(), /LOCAL/);

    await updateLocalNode(owner.account.id, paired.node.id, { routingMode: "normal" });
    const normalOrder = await route(owner.routerKey);
    assert.equal(normalOrder.headers.get("x-free-llm-provider"), "cloud");
    await updateAccountSettings(owner.routerKey, {
      routingPolicy: { strategy: "priority", providerOrder: [localId, "cloud"] },
    });
    const configuredNormalOrder = await route(owner.routerKey);
    assert.equal(configuredNormalOrder.headers.get("x-free-llm-provider"), localId);
    await updateLocalNode(owner.account.id, paired.node.id, { routingMode: "prefer-local" });

    await updateLocalNodeModel(owner.account.id, paired.node.id, "qwen:latest", {
      capabilities: { tools: "unsupported" },
    });
    const capabilityFallback = await route(owner.routerKey, false, {
      tools: [{ type: "function", function: { name: "noop", parameters: { type: "object" } } }],
    });
    assert.equal(capabilityFallback.headers.get("x-free-llm-provider"), "cloud");
    await updateLocalNodeModel(owner.account.id, paired.node.id, "qwen:latest", {
      capabilities: { tools: "supported" },
    });

    await updateLocalNode(owner.account.id, paired.node.id, { limits: { maxInputBytes: 1_024 } });
    const sizeFallback = await route(owner.routerKey, false, {
      messages: [{ role: "user", content: "x".repeat(2_000) }],
    });
    assert.equal(sizeFallback.headers.get("x-free-llm-provider"), "cloud");
    await updateLocalNode(owner.account.id, paired.node.id, { limits: { maxInputBytes: 2 * 1024 * 1024 } });

    localMode = "failure";
    const fallback = await route(owner.routerKey);
    assert.equal(fallback.status, 200);
    assert.equal(fallback.headers.get("x-free-llm-provider"), "cloud");
    assert.equal(((await fallback.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content, "CLOUD");

    localMode = "first-timeout";
    const preTokenFallback = await route(owner.routerKey, true);
    assert.equal(preTokenFallback.headers.get("x-free-llm-provider"), "cloud");
    assert.match(await preTokenFallback.text(), /CLOUD/);

    localMode = "post-token-failure";
    const cloudsBeforePostTokenFailure = cloudCalls;
    const postTokenFailure = await route(owner.routerKey, true);
    assert.equal(postTokenFailure.headers.get("x-free-llm-provider"), localProviderId(paired.node.id, "qwen:latest"));
    assert.match(await postTokenFailure.text(), /local_node_stream_error/);
    assert.equal(cloudCalls, cloudsBeforePostTokenFailure);
    const localAfterStreamFailure = await getLocalNode(owner.account.id, paired.node.id);
    assert.equal(localAfterStreamFailure?.models[0]?.health, "error");
    assert.match(localAfterStreamFailure?.models[0]?.lastError ?? "", /after output started/);
    const statsAfterStreamFailure = await getRoutingStats(hashRouterKey(owner.routerKey));
    assert.ok((statsAfterStreamFailure[localId]?.failures ?? 0) >= 1);
    assert.equal(statsAfterStreamFailure[localId]?.lastFailureType, "connection_error");

    const other = await createAccount("Other account");
    await setProviderKey(other.routerKey, "cloud", "cloud-secret");
    localMode = "success";
    const isolated = await route(other.routerKey);
    assert.equal(isolated.headers.get("x-free-llm-provider"), "cloud");

    await updateLocalNode(owner.account.id, paired.node.id, { routingMode: "local-only" });
    const localOnlySuccess = await route(owner.routerKey);
    assert.equal(localOnlySuccess.headers.get("x-free-llm-provider"), localId);
    await recordLocalNodeHeartbeat(paired.node.id, {
      agentVersion: "test",
      activeRequests: 0,
      maxConcurrentRequests: 1,
    }, Date.now() - 91_000);
    const unavailable = await route(owner.routerKey);
    assert.equal(unavailable.status, 400);
    assert.match(await unavailable.text(), /Local-only routing is enabled/);
  } finally {
    await agent?.close().catch(() => undefined);
    await close(gateway);
    await close(ollama);
    await close(cloud);
    resetLocalNodeSigningKeyCache();
    for (const name of envNames) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
