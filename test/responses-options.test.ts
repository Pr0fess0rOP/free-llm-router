import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAccount, hashRouterKey, setProviderKey } from "../src/accounts.js";
import { listRequestLogs } from "../src/analytics.js";
import { detectCapabilityRequirements } from "../src/provider-capabilities.js";
import { openAIToResponses, responsesToOpenAI } from "../src/responses.js";
import { handleRequest } from "../src/server.js";

test("Responses conversion forwards reasoning effort and preserves explicit conversation messages", () => {
  const converted = responsesToOpenAI({
    input: [
      { role: "user", content: "My name is Alex" },
      { role: "assistant", content: "Hello Alex" },
      { role: "user", content: "What is my name?" },
    ],
    reasoning: { effort: "high" }, store: false,
  });
  assert.equal(converted.reasoning_effort, "high");
  assert.equal((converted.messages as unknown[]).length, 3);
  assert.equal(responsesToOpenAI({ input: "Hello", reasoning: { effort: "none" } }).reasoning_effort, "none");
  assert.deepEqual(detectCapabilityRequirements({ reasoning: { effort: "none" } }).required, []);
  const result = openAIToResponses({
    choices: [{ message: { content: "Hi" } }],
    usage: { completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } },
  }, "free-router", { input: "Hello", reasoning: { effort: "high" }, store: false });
  assert.equal((result.usage as { output_tokens_details: { reasoning_tokens: number } }).output_tokens_details.reasoning_tokens, 2);
  assert.equal(result.store, false);
  assert.equal(result.previous_response_id, null);
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("unsupported Responses state returns 400 and analytics keeps incoming and gateway request parameters", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "flr-responses-options-"));
  const files = {
    ACCOUNTS_PATH: "accounts.json", ANALYTICS_PATH: "analytics.json", ROUTING_STATE_PATH: "routing.json",
    LOCAL_NODES_PATH: "nodes.json", PROVIDERS_CONFIG: "providers.json",
  };
  const names = [...Object.keys(files), "KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  for (const [name, file] of Object.entries(files)) process.env[name] = path.join(directory, file);
  const received: Record<string, unknown>[] = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    received.push(body);
    if (body.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } },
    }));
  });
  const gateway = createServer((request, response) => void handleRequest(request, response));
  try {
    const upstreamUrl = await listen(upstream);
    await writeFile(process.env.PROVIDERS_CONFIG!, JSON.stringify({
      providers: [{ id: "mock", baseUrl: upstreamUrl, model: "exact-model" }],
    }));
    const owner = await createAccount("Responses options");
    await setProviderKey(owner.routerKey, "mock", "test-key");
    const url = await listen(gateway);
    const send = (options: Record<string, unknown>) => fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.routerKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "free-router", input: "Hello", ...options }),
    });
    for (const invalid of [
      { previous_response_id: "resp_previous" }, { conversation: "conv_previous" },
      { store: true }, { background: true }, { reasoning: { summary: "auto" } },
      { reasoning: { effort: "invalid" } },
      { input: [{ type: "item_reference", id: "item_previous" }] },
      { include: ["reasoning.encrypted_content"] },
    ]) {
      const response = await send(invalid);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error.message, /unsupported|Unsupported/);
    }
    assert.equal(received.length, 0);
    for (const stream of [false, true]) {
      const response = await send({
        input: `Hello ${stream}`, stream, store: false, temperature: 0, max_output_tokens: 64,
        reasoning: { effort: "high" }, text: { format: { type: "json_object" } },
      });
      assert.equal(response.status, 200);
      await response.text();
      const body = received.at(-1)!;
      assert.equal(body.model, "exact-model");
      assert.equal(body.reasoning_effort, "high");
      assert.equal(body.temperature, 0);
      assert.equal(body.max_tokens, 64);
      assert.deepEqual(body.response_format, { type: "json_object" });
    }
    const logs = await listRequestLogs(hashRouterKey(owner.routerKey));
    assert.equal(logs.length, 2);
    for (const entry of logs) {
      const incoming = entry.request as Record<string, unknown>;
      const outgoing = entry.upstreamRequest as Record<string, unknown>;
      assert.equal(incoming.temperature, 0);
      assert.equal(incoming.max_output_tokens, 64);
      assert.deepEqual(incoming.reasoning, { effort: "high" });
      assert.equal(outgoing.reasoning_effort, "high");
      assert.equal(outgoing.model, "exact-model");
      assert.equal(outgoing.max_tokens, 64);
      assert.deepEqual(outgoing.response_format, { type: "json_object" });
    }
  } finally {
    await Promise.all([close(gateway), close(upstream)]);
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
