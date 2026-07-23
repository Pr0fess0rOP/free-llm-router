import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAccount,
  hashRouterKey,
  setProviderKey,
  updateAccountSettings,
} from "../src/accounts.js";
import { listRequestLogs } from "../src/analytics.js";
import { handleRequest } from "../src/server.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return address.port;
}

test("Responses API and Codex-compatible streaming tool loop", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "free-llm-responses-"));
  process.env.ACCOUNTS_PATH = path.join(directory, "accounts.json");
  process.env.ANALYTICS_PATH = path.join(directory, "analytics.json");
  process.env.ROUTING_STATE_PATH = path.join(directory, "routing-state.json");
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  const upstreamBodies: Array<Record<string, unknown>> = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    upstreamBodies.push(body);

    if (body.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"id":"chatcmpl_stream","choices":[{"delta":{"content":"Inspecting "},"finish_reason":null}]}\n\n');
      response.write('data: {"id":"chatcmpl_stream","choices":[{"delta":{"content":"the project."},"finish_reason":null}]}\n\n');
      response.write('data: {"id":"chatcmpl_stream","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_shell_1","function":{"name":"run_shell","arguments":"{\\"command\\":\\"npm test\\"}"}}]},"finish_reason":null}]}\n\n');
      response.write('data: {"id":"chatcmpl_stream","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":31,"completion_tokens":12,"total_tokens":43}}\n\n');
      response.end("data: [DONE]\n\n");
      return;
    }

    const tools = Array.isArray(body.tools) ? body.tools : [];
    const firstTool = tools.find((tool) => (
      typeof tool === "object" && tool !== null
    )) as Record<string, unknown> | undefined;
    const firstFunction = firstTool?.function as Record<string, unknown> | undefined;
    const toolName = typeof firstFunction?.name === "string"
      ? firstFunction.name
      : undefined;
    const toolArguments = toolName === "apply_patch"
      ? '{"input":"*** Begin Patch\\n*** End Patch"}'
      : toolName === "mcp__demo__lookup"
        ? '{"query":"router"}'
        : '{"path":"README.md"}';

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl_nonstream",
      created: 1_720_000_000,
      choices: [{
        message: {
          role: "assistant",
          content: "Router Responses API is working.",
          tool_calls: toolName
            ? [{
                id: `call_${toolName}`,
                type: "function",
                function: { name: toolName, arguments: toolArguments },
              }]
            : undefined,
        },
        finish_reason: toolName ? "tool_calls" : "stop",
      }],
      usage: { prompt_tokens: 18, completion_tokens: 7, total_tokens: 25 },
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

  const { routerKey, account } = await createAccount("Responses router");
  await setProviderKey(routerKey, "mock", "mock-provider-key");
  await updateAccountSettings(routerKey, {
    routingPolicy: { strategy: "smart", providerOrder: ["mock"] },
    modelAliases: [
      ...account.modelAliases,
      {
        id: "test-coder",
        name: "Test Coder",
        description: "Integration-test alias",
        enabled: true,
        routingStrategy: "fastest",
        requiredCapabilities: ["tools"],
        eligibleProviderIds: ["mock"],
        providerOrder: ["mock"],
      },
    ],
  });

  const gateway = createServer((request, response) => {
    void handleRequest(request, response);
  });
  const gatewayPort = await listen(gateway);
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;

  try {
    const nonstreamResponse = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${routerKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codex-free-router",
        instructions: "You are a coding agent.",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Read the README" }],
        }],
        tools: [{
          type: "function",
          name: "read_file",
          description: "Read a project file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
          strict: true,
        }],
        stream: false,
        store: false,
      }),
    });

    assert.equal(nonstreamResponse.status, 200);
    assert.equal(nonstreamResponse.headers.get("x-free-llm-provider"), "mock");
    assert.equal(
      nonstreamResponse.headers.get("x-free-llm-api-format"),
      "openai-responses-compatible",
    );
    assert.equal(nonstreamResponse.headers.get("x-free-llm-routing-policy"), "smart");
    const nonstream = await nonstreamResponse.json() as {
      object: string;
      model: string;
      status: string;
      output: Array<Record<string, unknown>>;
      usage: { input_tokens: number; output_tokens: number };
    };
    assert.equal(nonstream.object, "response");
    assert.equal(nonstream.model, "codex-free-router");
    assert.equal(nonstream.status, "completed");
    assert.ok(nonstream.output.some((item) => item.type === "message"));
    const functionCall = nonstream.output.find((item) => item.type === "function_call");
    assert.ok(functionCall);
    assert.equal(functionCall.name, "read_file");
    assert.equal(functionCall.call_id, "call_read_file");
    assert.equal(nonstream.usage.input_tokens, 18);
    assert.equal(nonstream.usage.output_tokens, 7);

    const firstUpstreamBody = upstreamBodies.at(-1);
    assert.equal(firstUpstreamBody?.model, "mock-coder");
    assert.equal(firstUpstreamBody?.stream, false);
    assert.equal(firstUpstreamBody?.max_tokens, 4096);
    const firstMessages = firstUpstreamBody?.messages as Array<Record<string, unknown>>;
    assert.equal(firstMessages[0]?.role, "system");
    assert.equal(firstMessages[0]?.content, "You are a coding agent.");
    assert.equal(firstMessages[1]?.role, "user");
    const firstTools = firstUpstreamBody?.tools as Array<Record<string, unknown>>;
    assert.equal(firstTools[0]?.type, "function");
    assert.equal(
      (firstTools[0]?.function as Record<string, unknown>)?.name,
      "read_file",
    );

    const toolResultResponse = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "x-api-key": routerKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codex-free-router",
        input: [
          { role: "user", content: "Read README.md" },
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_read_1",
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
          {
            type: "function_call_output",
            call_id: "call_read_1",
            output: "# Free LLM Router",
          },
        ],
      }),
    });
    assert.equal(toolResultResponse.status, 200);
    const toolLoopUpstreamBody = upstreamBodies.at(-1);
    const toolLoopMessages = toolLoopUpstreamBody?.messages as Array<Record<string, unknown>>;
    assert.ok(toolLoopMessages.some((message) => (
      message.role === "assistant" && Array.isArray(message.tool_calls)
    )));
    assert.ok(toolLoopMessages.some((message) => (
      message.role === "tool"
      && message.tool_call_id === "call_read_1"
      && message.content === "# Free LLM Router"
    )));

    const customToolResponse = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${routerKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codex-free-router",
        input: "Apply this patch",
        tools: [{
          type: "custom",
          name: "apply_patch",
          description: "Apply a patch in freeform syntax",
          format: { type: "grammar", syntax: "lark", definition: "start: /.+/s" },
        }],
      }),
    });
    assert.equal(customToolResponse.status, 200);
    const customPayload = await customToolResponse.json() as {
      output: Array<Record<string, unknown>>;
    };
    const customCall = customPayload.output.find((item) => item.type === "custom_tool_call");
    assert.ok(customCall);
    assert.equal(customCall.name, "apply_patch");
    assert.equal(customCall.input, "*** Begin Patch\n*** End Patch");
    const customUpstream = upstreamBodies.at(-1);
    const customTools = customUpstream?.tools as Array<Record<string, unknown>>;
    assert.equal(
      (customTools[0]?.function as Record<string, unknown>)?.name,
      "apply_patch",
    );

    const namespaceToolResponse = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${routerKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codex-free-router",
        input: "Look up router",
        tools: [{
          type: "namespace",
          name: "mcp__demo__",
          description: "Demo MCP tools",
          tools: [{
            type: "function",
            name: "lookup",
            description: "Look up a value",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
          }],
        }],
      }),
    });
    assert.equal(namespaceToolResponse.status, 200);
    const namespacePayload = await namespaceToolResponse.json() as {
      output: Array<Record<string, unknown>>;
    };
    const namespaceCall = namespacePayload.output.find((item) => item.type === "function_call");
    assert.ok(namespaceCall);
    assert.equal(namespaceCall.name, "lookup");
    assert.equal(namespaceCall.namespace, "mcp__demo__");
    const namespaceUpstream = upstreamBodies.at(-1);
    const namespaceTools = namespaceUpstream?.tools as Array<Record<string, unknown>>;
    assert.equal(
      (namespaceTools[0]?.function as Record<string, unknown>)?.name,
      "mcp__demo__lookup",
    );

    const parallelToolResults = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${routerKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codex-free-router",
        input: [
          { role: "user", content: "Run both checks" },
          {
            type: "function_call",
            call_id: "call_one",
            name: "first_check",
            arguments: "{}",
          },
          {
            type: "function_call",
            call_id: "call_two",
            name: "second_check",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "call_one", output: "one" },
          { type: "function_call_output", call_id: "call_two", output: "two" },
        ],
      }),
    });
    assert.equal(parallelToolResults.status, 200);
    const parallelUpstream = upstreamBodies.at(-1);
    const parallelMessages = parallelUpstream?.messages as Array<Record<string, unknown>>;
    const parallelAssistant = parallelMessages.find((message) => (
      message.role === "assistant" && Array.isArray(message.tool_calls)
    ));
    assert.equal(
      (parallelAssistant?.tool_calls as Array<unknown>)?.length,
      2,
    );

    const streamResponse = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${routerKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codex-free-router",
        input: "Inspect this repository and run its tests.",
        stream: true,
        tools: [{
          type: "function",
          name: "run_shell",
          description: "Run a command in the repository",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        }],
      }),
    });

    assert.equal(streamResponse.status, 200);
    assert.match(streamResponse.headers.get("content-type") ?? "", /text\/event-stream/);
    const streamText = await streamResponse.text();
    assert.match(streamText, /event: response\.created/);
    assert.match(streamText, /event: response\.in_progress/);
    assert.match(streamText, /event: response\.output_text\.delta/);
    assert.match(streamText, /"delta":"Inspecting "/);
    assert.match(streamText, /event: response\.function_call_arguments\.delta/);
    assert.match(streamText, /"call_id":"call_shell_1"/);
    assert.match(streamText, /event: response\.function_call_arguments\.done/);
    assert.match(streamText, /event: response\.completed/);
    assert.match(streamText, /"status":"completed"/);

    const logs = await listRequestLogs(hashRouterKey(routerKey));
    assert.ok(logs.some((entry) => entry.routingStrategy === "smart"));
    const responsesLogs = logs.filter((entry) => entry.endpoint === "/v1/responses");
    assert.ok(responsesLogs.length >= 3);
    assert.ok(responsesLogs.every((entry) => (
      entry.apiFormat === "openai-responses-compatible"
    )));
    const streamLog = responsesLogs.find((entry) => {
      const requestBody = entry.request as { stream?: boolean } | undefined;
      return requestBody?.stream === true;
    });
    assert.ok(streamLog);
    const capturedResponse = streamLog.response as {
      object?: string;
      status?: string;
      output?: Array<Record<string, unknown>>;
    };
    assert.equal(capturedResponse.object, "response");
    assert.equal(capturedResponse.status, "completed");
    assert.ok(capturedResponse.output?.some((item) => item.type === "message"));
    assert.ok(capturedResponse.output?.some((item) => item.type === "function_call"));

    const aliasResponse = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${routerKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "test-coder",
        input: "Use the provided tool.",
        tools: [{
          type: "function",
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        }],
        stream: false,
      }),
    });
    assert.equal(aliasResponse.status, 200);
    assert.equal(aliasResponse.headers.get("x-free-llm-model-alias"), "test-coder");
    assert.equal(aliasResponse.headers.get("x-free-llm-routing-policy"), "fastest");
    assert.equal(aliasResponse.headers.get("x-free-llm-provider-model"), "mock-coder");

    const modelsResponse = await fetch(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${routerKey}` },
    });
    assert.equal(modelsResponse.status, 200);
    const models = await modelsResponse.json() as { data: Array<{ id: string }> };
    assert.ok(models.data.some((model) => model.id === "codex-free-router"));
    assert.ok(models.data.some((model) => model.id === "test-coder"));

    const aliasLog = (await listRequestLogs(hashRouterKey(routerKey)))
      .find((entry) => entry.resolvedAlias === "test-coder");
    assert.equal(aliasLog?.requestedModel, "test-coder");
    assert.equal(aliasLog?.routingStrategy, "fastest");
  } finally {
    await new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});
