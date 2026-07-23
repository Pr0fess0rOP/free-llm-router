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

test("Claude Code-compatible messages, streaming, and token counting", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "free-llm-anthropic-"));
  process.env.ACCOUNTS_PATH = path.join(directory, "accounts.json");
  process.env.ANALYTICS_PATH = path.join(directory, "analytics.json");
  process.env.ROUTING_STATE_PATH = path.join(directory, "routing-state.json");
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  let lastUpstreamBody: Record<string, unknown> | undefined;
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    lastUpstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;

    if (lastUpstreamBody.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"id":"chatcmpl_stream","choices":[{"delta":{"content":"Checking"},"finish_reason":null}]}\n\n');
      response.write('data: {"id":"chatcmpl_stream","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]},"finish_reason":null}]}\n\n');
      response.write('data: {"id":"chatcmpl_stream","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":9}}\n\n');
      response.end("data: [DONE]\n\n");
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl_nonstream",
      choices: [{
        message: { role: "assistant", content: "Hello from the router" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    }));
  });
  const upstreamPort = await listen(upstream);

  const providersPath = path.join(directory, "providers.json");
  await writeFile(providersPath, JSON.stringify({
    providers: [{
      id: "mock",
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      model: "mock-coder",
      enabled: true,
    }],
  }));
  process.env.PROVIDERS_CONFIG = providersPath;

  const { routerKey } = await createAccount("Test router");
  await setProviderKey(routerKey, "mock", "mock-provider-key");

  const gateway = createServer((request, response) => {
    void handleRequest(request, response);
  });
  const gatewayPort = await listen(gateway);
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;

  try {
    const nonstreamResponse = await fetch(`${baseUrl}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${routerKey}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-free-router",
        max_tokens: 100,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    assert.equal(nonstreamResponse.status, 200);
    assert.equal(nonstreamResponse.headers.get("x-free-llm-provider"), "mock");
    const nonstream = await nonstreamResponse.json() as Record<string, unknown>;
    assert.equal(nonstream.type, "message");
    assert.equal(nonstream.model, "claude-free-router");
    assert.deepEqual(nonstream.content, [{ type: "text", text: "Hello from the router" }]);
    assert.equal((lastUpstreamBody?.model), "mock-coder");

    const streamResponse = await fetch(`${baseUrl}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        "x-api-key": routerKey,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-free-router",
        max_tokens: 100,
        stream: true,
        tools: [{
          name: "read_file",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        }],
        messages: [{ role: "user", content: "Read README.md" }],
      }),
    });
    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get("content-type") ?? "", /text\/event-stream/);
    const streamText = await streamResponse.text();
    assert.match(streamText, /event: message_start/);
    assert.match(streamText, /"type":"text_delta","text":"Checking"/);
    assert.match(streamText, /"type":"tool_use","id":"call_123","name":"read_file"/);
    assert.match(streamText, /"type":"input_json_delta","partial_json":"\{\\"path\\":\\"README.md\\"\}"/);
    assert.match(streamText, /"stop_reason":"tool_use"/);
    assert.match(streamText, /event: message_stop/);

    const logs = await listRequestLogs(hashRouterKey(routerKey));
    const streamLog = logs.find((entry) => {
      const requestBody = entry.request as { stream?: boolean } | undefined;
      return requestBody?.stream === true;
    });
    assert.ok(streamLog);
    assert.equal(streamLog.apiFormat, "claude-code-compatible");
    assert.equal(streamLog.endpoint, "/v1/messages");
    assert.notEqual(
      streamLog.response,
      "Streaming response was forwarded to the client and was not captured.",
    );
    const capturedResponse = streamLog.response as {
      content?: Array<{ type?: string; text?: string; name?: string }>;
      stop_reason?: string;
    };
    assert.equal(capturedResponse.stop_reason, "tool_use");
    assert.ok(capturedResponse.content?.some((block) => (
      block.type === "text" && block.text === "Checking"
    )));
    assert.ok(capturedResponse.content?.some((block) => (
      block.type === "tool_use" && block.name === "read_file"
    )));

    const upstreamTools = lastUpstreamBody?.tools;
    assert.ok(Array.isArray(upstreamTools));
    assert.equal((upstreamTools[0] as { type?: string }).type, "function");

    const tokenResponse = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "x-api-key": routerKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-free-router",
        messages: [{ role: "user", content: "Count me" }],
      }),
    });
    assert.equal(tokenResponse.status, 200);
    const tokenBody = await tokenResponse.json() as { input_tokens: number };
    assert.ok(tokenBody.input_tokens > 0);

    const openAIResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${routerKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "free-router",
        stream: false,
        messages: [{ role: "user", content: "Test OpenAI compatibility" }],
      }),
    });
    assert.equal(openAIResponse.status, 200);
    const openAILogs = await listRequestLogs(hashRouterKey(routerKey));
    const openAILog = openAILogs.find((entry) => entry.endpoint === "/v1/chat/completions");
    assert.ok(openAILog);
    assert.equal(openAILog.apiFormat, "openai-compatible");

    const modelsResponse = await fetch(`${baseUrl}/v1/models?limit=1000`);
    const models = await modelsResponse.json() as { data: Array<{ id: string }> };
    assert.ok(models.data.some((model) => model.id === "claude-free-router"));
  } finally {
    await new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
