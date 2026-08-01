import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  localNodeVerificationKey,
  resetLocalNodeSigningKeyCache,
  signLocalNodeRequest,
  verifyLocalNodeRequestToken,
} from "../src/local-nodes/local-node-request-auth.js";
import { startLocalAgent } from "../src/local-nodes/agent/server.js";
import type { LocalAgentConfig } from "../src/local-nodes/agent/local-node-config.js";

function agentConfig(params: {
  publicKey: string;
  keyId: string;
  ollamaPort: number;
  firstTokenTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxQueueSize?: number;
  totalTimeoutMs?: number;
}): LocalAgentConfig {
  return {
    nodeId: "node_limits",
    ownerAccountId: "account_limits",
    name: "Limits agent",
    routerBaseUrl: "http://router.invalid",
    verificationPublicKey: params.publicKey,
    verificationKeyId: params.keyId,
    credential: { storage: "file", value: "fln_test", account: "node_limits" },
    allowedModels: ["qwen:latest"],
    models: [{
      nodeId: "node_limits",
      modelId: "qwen:latest",
      enabled: true,
      installed: true,
      capabilities: {
        streaming: "supported", tools: "unknown", vision: "unknown",
        reasoning: "unknown", structuredOutputs: "unknown",
      },
      health: "unknown",
    }],
    limits: {
      maxConcurrentRequests: 1,
      maxQueueSize: params.maxQueueSize ?? 0,
      maxInputBytes: 10_000,
      maxOutputTokens: 32,
      firstTokenTimeoutMs: params.firstTokenTimeoutMs ?? 100,
      idleTimeoutMs: params.idleTimeoutMs ?? 100,
      totalTimeoutMs: params.totalTimeoutMs ?? 2_000,
    },
    agentPort: 0,
    ollamaBaseUrl: `http://127.0.0.1:${params.ollamaPort}`,
    cliVersion: "test",
  };
}

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

test("short-lived Ed25519 node tokens enforce issuer, audience, owner, model, and expiry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-node-signing-"));
  const previousPath = process.env.LOCAL_NODE_SIGNING_KEY_PATH;
  process.env.LOCAL_NODE_SIGNING_KEY_PATH = path.join(directory, "signing.json");
  resetLocalNodeSigningKeyCache();
  try {
    const verification = await localNodeVerificationKey();
    const now = Date.now();
    const token = await signLocalNodeRequest({
      nodeId: "node_1",
      ownerAccountId: "account_1",
      requestId: "req_1",
      model: "qwen:latest",
      now,
    });
    const claims = verifyLocalNodeRequestToken({
      token,
      publicKey: verification.publicKey,
      expectedNodeId: "node_1",
      expectedOwnerAccountId: "account_1",
      expectedModel: "qwen:latest",
      now,
    });
    assert.equal(claims.requestId, "req_1");
    assert.throws(() => verifyLocalNodeRequestToken({
      token,
      publicKey: verification.publicKey,
      expectedNodeId: "node_other",
      expectedOwnerAccountId: "account_1",
      expectedModel: "qwen:latest",
      now,
    }), /audience/);
    assert.throws(() => verifyLocalNodeRequestToken({
      token,
      publicKey: verification.publicKey,
      expectedNodeId: "node_1",
      expectedOwnerAccountId: "account_other",
      expectedModel: "qwen:latest",
      now,
    }), /owner/);
    assert.throws(() => verifyLocalNodeRequestToken({
      token,
      publicKey: verification.publicKey,
      expectedNodeId: "node_1",
      expectedOwnerAccountId: "account_1",
      expectedModel: "llama:latest",
      now,
    }), /model/);
    const tokenParts = token.split(".");
    tokenParts[2] = `${tokenParts[2]!.startsWith("a") ? "b" : "a"}${tokenParts[2]!.slice(1)}`;
    const tampered = tokenParts.join(".");
    assert.throws(() => verifyLocalNodeRequestToken({
      token: tampered,
      publicKey: verification.publicKey,
      expectedNodeId: "node_1",
      expectedOwnerAccountId: "account_1",
      expectedModel: "qwen:latest",
      now,
    }), /signature/);
    assert.throws(() => verifyLocalNodeRequestToken({
      token,
      publicKey: verification.publicKey,
      expectedNodeId: "node_1",
      expectedOwnerAccountId: "account_1",
      expectedModel: "qwen:latest",
      now: now + 61_000,
    }), /expired/);
  } finally {
    resetLocalNodeSigningKeyCache();
    if (previousPath === undefined) delete process.env.LOCAL_NODE_SIGNING_KEY_PATH;
    else process.env.LOCAL_NODE_SIGNING_KEY_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("agent enforces first-token, idle, concurrency, and client-cancellation behavior", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-agent-limits-"));
  const previousSigning = process.env.LOCAL_NODE_SIGNING_KEY_PATH;
  const previousConfig = process.env.FREE_LLM_LOCAL_NODE_CONFIG;
  process.env.LOCAL_NODE_SIGNING_KEY_PATH = path.join(directory, "signing.json");
  process.env.FREE_LLM_LOCAL_NODE_CONFIG = path.join(directory, "agent.json");
  resetLocalNodeSigningKeyCache();
  let mode: "first-timeout" | "idle-timeout" | "total-timeout" | "hold" | "cancel" = "first-timeout";
  let releaseHold: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  let markCancelled: (() => void) | undefined;
  const started = () => new Promise<void>((resolve) => { markStarted = resolve; });
  const cancelled = () => new Promise<void>((resolve) => { markCancelled = resolve; });
  const ollama = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume */ }
    markStarted?.();
    if (mode === "first-timeout") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      await new Promise((resolve) => setTimeout(resolve, 250));
      response.end("data: [DONE]\n\n");
      return;
    }
    if (mode === "idle-timeout") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: {\"choices\":[{\"delta\":{\"content\":\"A\"}}]}\n\n");
      await new Promise((resolve) => setTimeout(resolve, 250));
      response.end("data: [DONE]\n\n");
      return;
    }
    if (mode === "total-timeout") {
      await new Promise((resolve) => setTimeout(resolve, 250));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "late" } }] }));
      return;
    }
    request.once("aborted", () => markCancelled?.());
    response.once("close", () => markCancelled?.());
    await new Promise<void>((resolve) => { releaseHold = resolve; });
    if (!response.destroyed) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
    }
  });
  const ollamaPort = await listen(ollama);
  const verification = await localNodeVerificationKey();
  const config = agentConfig({
    publicKey: verification.publicKey,
    keyId: verification.keyId,
    ollamaPort,
    firstTokenTimeoutMs: 50,
    idleTimeoutMs: 50,
    maxQueueSize: 1,
    totalTimeoutMs: 100,
  });
  const agent = await startLocalAgent(config);
  const endpoint = `http://127.0.0.1:${agent.port}/v1/chat/completions`;
  const send = async (requestId: string, stream: boolean, signal?: AbortSignal) => {
    const token = await signLocalNodeRequest({
      nodeId: config.nodeId,
      ownerAccountId: config.ownerAccountId,
      requestId,
      model: "qwen:latest",
    });
    return fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "qwen:latest", messages: [], stream }),
      ...(signal ? { signal } : {}),
    });
  };
  try {
    const noToken = await send("req_first_timeout", true);
    assert.equal(noToken.status, 502);
    assert.match(await noToken.text(), /first token/);

    mode = "idle-timeout";
    const idle = await send("req_idle_timeout", true);
    assert.equal(idle.status, 200);
    assert.match(await idle.text(), /local_node_stream_error/);

    mode = "total-timeout";
    const total = await send("req_total_timeout", false);
    assert.equal(total.status, 502);
    assert.match(await total.text(), /total timeout/);
    config.limits.totalTimeoutMs = 2_000;

    mode = "hold";
    const firstStarted = started();
    const first = send("req_concurrency_1", false);
    await firstStarted;
    const second = send("req_concurrency_2", false);
    while (agent.queuedRequests() !== 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const busy = await send("req_concurrency_3", false);
    assert.equal(busy.status, 429);
    const secondStarted = started();
    (releaseHold as (() => void) | undefined)?.();
    assert.equal((await first).status, 200);
    await secondStarted;
    (releaseHold as (() => void) | undefined)?.();
    assert.equal((await second).status, 200);

    mode = "cancel";
    releaseHold = undefined;
    const cancellationStarted = started();
    const upstreamCancelled = cancelled();
    const controller = new AbortController();
    const cancelledFetch = send("req_cancel", false, controller.signal);
    await cancellationStarted;
    controller.abort();
    await assert.rejects(cancelledFetch, /abort/i);
    await Promise.race([
      upstreamCancelled,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Ollama request was not cancelled")), 1_000)),
    ]);
    (releaseHold as (() => void) | undefined)?.();
  } finally {
    releaseHold?.();
    await agent.close();
    await close(ollama);
    resetLocalNodeSigningKeyCache();
    if (previousSigning === undefined) delete process.env.LOCAL_NODE_SIGNING_KEY_PATH;
    else process.env.LOCAL_NODE_SIGNING_KEY_PATH = previousSigning;
    if (previousConfig === undefined) delete process.env.FREE_LLM_LOCAL_NODE_CONFIG;
    else process.env.FREE_LLM_LOCAL_NODE_CONFIG = previousConfig;
    await rm(directory, { recursive: true, force: true });
  }
});

test("protected agent exposes only health, models, and authorized inference with replay and limit enforcement", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-agent-"));
  const previousPath = process.env.LOCAL_NODE_SIGNING_KEY_PATH;
  const previousConfig = process.env.FREE_LLM_LOCAL_NODE_CONFIG;
  process.env.LOCAL_NODE_SIGNING_KEY_PATH = path.join(directory, "signing.json");
  process.env.FREE_LLM_LOCAL_NODE_CONFIG = path.join(directory, "agent.json");
  resetLocalNodeSigningKeyCache();
  let upstreamCalls = 0;
  const ollama = createServer(async (request, response) => {
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    upstreamCalls += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.ok(body.max_tokens <= 8);
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }] })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chat_local",
      choices: [{ message: { role: "assistant", content: "OK" } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }));
  });
  const ollamaPort = await listen(ollama);
  const verification = await localNodeVerificationKey();
  const config: LocalAgentConfig = {
    nodeId: "node_agent",
    ownerAccountId: "account_agent",
    name: "Test agent",
    routerBaseUrl: "http://router.invalid",
    verificationPublicKey: verification.publicKey,
    verificationKeyId: verification.keyId,
    credential: { storage: "file", value: "fln_test", account: "node_agent" },
    allowedModels: ["qwen:latest"],
    models: [{
      nodeId: "node_agent",
      modelId: "qwen:latest",
      enabled: true,
      installed: true,
      capabilities: {
        streaming: "supported",
        tools: "unknown",
        vision: "unknown",
        reasoning: "unknown",
        structuredOutputs: "unknown",
      },
      health: "unknown",
      maxOutputTokens: 8,
    }],
    limits: {
      maxConcurrentRequests: 1,
      maxQueueSize: 0,
      maxInputBytes: 1_024,
      maxOutputTokens: 8,
      firstTokenTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      totalTimeoutMs: 5_000,
    },
    agentPort: 0,
    ollamaBaseUrl: `http://127.0.0.1:${ollamaPort}`,
    cliVersion: "test",
  };
  const agent = await startLocalAgent(config);
  const baseUrl = `http://127.0.0.1:${agent.port}`;
  try {
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/models`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/pull`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/delete`, { method: "DELETE" })).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/create`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen:latest", messages: [] }),
    })).status, 401);

    const token = await signLocalNodeRequest({
      nodeId: config.nodeId,
      ownerAccountId: config.ownerAccountId,
      requestId: "req_agent_1",
      model: "qwen:latest",
    });
    const successful = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-request-id": "req_agent_1",
      },
      body: JSON.stringify({
        model: "qwen:latest",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 100,
      }),
    });
    assert.equal(successful.status, 200);
    assert.equal(((await successful.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content, "OK");
    await new Promise((resolve) => setTimeout(resolve, 10));

    const replay = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "qwen:latest", messages: [] }),
    });
    const replayBody = await replay.text();
    assert.equal(replay.status, 409, replayBody);

    const streamToken = await signLocalNodeRequest({
      nodeId: config.nodeId,
      ownerAccountId: config.ownerAccountId,
      requestId: "req_agent_stream",
      model: "qwen:latest",
    });
    const streamed = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${streamToken}` },
      body: JSON.stringify({ model: "qwen:latest", messages: [], stream: true }),
    });
    assert.equal(streamed.status, 200);
    assert.match(await streamed.text(), /OK/);
    assert.equal(upstreamCalls, 2);

    const oversizedToken = await signLocalNodeRequest({
      nodeId: config.nodeId,
      ownerAccountId: config.ownerAccountId,
      requestId: "req_oversized",
      model: "qwen:latest",
    });
    const oversized = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${oversizedToken}` },
      body: JSON.stringify({ model: "qwen:latest", messages: [{ role: "user", content: "x".repeat(2_000) }] }),
    });
    assert.equal(oversized.status, 400);

    const disabledToken = await signLocalNodeRequest({
      nodeId: config.nodeId,
      ownerAccountId: config.ownerAccountId,
      requestId: "req_disabled",
      model: "disabled:latest",
    });
    const disabled = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${disabledToken}` },
      body: JSON.stringify({ model: "disabled:latest", messages: [] }),
    });
    assert.equal(disabled.status, 403);

    config.models[0]!.capabilities.tools = "unsupported";
    const capabilityToken = await signLocalNodeRequest({
      nodeId: config.nodeId,
      ownerAccountId: config.ownerAccountId,
      requestId: "req_capability",
      model: "qwen:latest",
    });
    const incompatible = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${capabilityToken}` },
      body: JSON.stringify({ model: "qwen:latest", messages: [], tools: [{ type: "function" }] }),
    });
    assert.equal(incompatible.status, 400);
    assert.match(await incompatible.text(), /does not allow tools/);
    const log = await readFile(path.join(directory, "local-node.log"), "utf8");
    assert.doesNotMatch(log, /Hello/);
    assert.equal(log.includes(token), false);
  } finally {
    await agent.close();
    await close(ollama);
    resetLocalNodeSigningKeyCache();
    if (previousPath === undefined) delete process.env.LOCAL_NODE_SIGNING_KEY_PATH;
    else process.env.LOCAL_NODE_SIGNING_KEY_PATH = previousPath;
    if (previousConfig === undefined) delete process.env.FREE_LLM_LOCAL_NODE_CONFIG;
    else process.env.FREE_LLM_LOCAL_NODE_CONFIG = previousConfig;
    await rm(directory, { recursive: true, force: true });
  }
});
