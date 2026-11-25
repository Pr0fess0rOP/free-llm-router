import assert from "node:assert/strict";
import test from "node:test";
import { inspectProviderResponse } from "../src/provider-response.js";
import { ProviderRouter } from "../src/router.js";
import { resolveProviderCapabilities } from "../src/provider-capabilities.js";
import type { ProviderRuntime } from "../src/types.js";

function provider(id: string): ProviderRuntime {
  return {
    id, model: id, baseUrl: `https://${id}.invalid/v1`, apiKeyValue: "test",
    capabilities: resolveProviderCapabilities({ id }),
    cooldownUntil: 0, failures: 0, circuitState: "closed", circuitOpenUntil: 0,
    circuitFailureCount: 0, circuitOpenCount: 0, halfOpenProbeActive: false,
  };
}

function completion(content: unknown) {
  return { choices: [{ message: { role: "assistant", content } }] };
}

test("malformed successful provider responses fail over before success is recorded", async () => {
  for (const invalid of [
    {}, [], { choices: [] }, { choices: [{}] }, completion(null), completion(42),
    { error: { message: "Failed" }, ...completion("unexpected") },
  ]) {
    const router = new ProviderRouter(
      [provider("first"), provider("second")],
      async (input) => Response.json(String(input).includes("first.invalid") ? invalid : completion("OK")),
    );
    const result = await router.chatCompletion({ messages: [{ role: "user", content: "Hello" }] });
    assert.equal(result.providerId, "second", JSON.stringify(invalid));
    assert.equal(result.attempts[0]?.success, false);
    assert.equal(result.attempts[0]?.failureType, "malformed_response");
    assert.deepEqual(await result.response.json(), completion("OK"));
  }
  for (const invalid of ["<html>upstream error</html>", ""]) {
    const inspected = await inspectProviderResponse(new Response(invalid), {});
    assert.match(inspected.error ?? "", /invalid JSON/);
  }
});

test("valid tool-only, refusal, and text completions retain their response bodies", async () => {
  for (const message of [
    { role: "assistant", content: "Hello" },
    { role: "assistant", content: "" },
    { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    { role: "assistant", content: null, refusal: "Cannot assist" },
    { role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name: "lookup", arguments: "{}" } }] },
  ]) {
    const payload = { choices: [{ message }] };
    const result = await inspectProviderResponse(Response.json(payload), {});
    assert.equal(result.error, undefined);
    assert.deepEqual(await result.response.json(), payload);
  }
});

test("capability learning requires observable JSON, tool, or reasoning evidence", async () => {
  const body = {
    response_format: { type: "json_object" },
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    reasoning_effort: "high",
  };
  const ignored = await inspectProviderResponse(Response.json(completion("ordinary text")), body);
  assert.deepEqual(ignored.observedSupportedCapabilities, []);
  const json = await inspectProviderResponse(Response.json(completion('{"ok":true}')), body);
  assert.deepEqual(json.observedSupportedCapabilities, ["jsonMode"]);
  const array = await inspectProviderResponse(Response.json(completion("[1,2]")), body);
  assert.deepEqual(array.observedSupportedCapabilities, []);
  const tool = await inspectProviderResponse(Response.json({
    choices: [{ message: {
      content: null,
      tool_calls: [{ type: "function", function: { name: "lookup", arguments: "{}" } }],
      reasoning_content: "Observed reasoning field",
    } }],
  }), body);
  assert.deepEqual(tool.observedSupportedCapabilities, ["tools", "reasoning"]);
  const inventedTool = await inspectProviderResponse(Response.json({
    choices: [{ message: { tool_calls: [{ function: { name: "unrequested", arguments: "{}" } }] } }],
  }), body);
  assert.deepEqual(inventedTool.observedSupportedCapabilities, []);
  const vision = await inspectProviderResponse(Response.json(completion("red")), {
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "test" } }] }],
  });
  assert.deepEqual(vision.observedSupportedCapabilities, []);
});

test("schema support is learned only for outputs that validate against the requested schema", async () => {
  const body = {
    response_format: { type: "json_schema", json_schema: { name: "result", schema: {
      type: "object",
      properties: { ok: { type: "boolean" }, count: { type: "integer", minimum: 1 } },
      required: ["ok", "count"],
      additionalProperties: false,
    } } },
  };
  for (const output of [{ ok: true }, { ok: "true", count: 1 }, { ok: true, count: 0 }, { ok: true, count: 1, extra: 1 }]) {
    const result = await inspectProviderResponse(Response.json(completion(JSON.stringify(output))), body);
    assert.deepEqual(result.observedSupportedCapabilities, []);
  }
  const valid = await inspectProviderResponse(Response.json(completion('{"ok":true,"count":1}')), body);
  assert.deepEqual(valid.observedSupportedCapabilities, ["structuredOutputs"]);
  const unknownSchema = await inspectProviderResponse(Response.json(completion("{}")), {
    response_format: { type: "json_schema", json_schema: { schema: { unsupportedKeyword: true } } },
  });
  assert.deepEqual(unknownSchema.observedSupportedCapabilities, []);
});

test("the router records validated capability evidence instead of requested flags", async () => {
  const router = new ProviderRouter([provider("first")], async () => Response.json(completion("No tool call")));
  const result = await router.chatCompletion({
    messages: [{ role: "user", content: "Hello" }],
    tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
  });
  assert.deepEqual(result.attempts[0]?.requiredCapabilities, ["tools"]);
  assert.deepEqual(result.attempts[0]?.observedSupportedCapabilities, []);
});

test("stream validation rejects empty and non-SSE responses and preserves split completion chunks", async () => {
  for (const response of [
    Response.json(completion("plain JSON")),
    new Response("", { headers: { "content-type": "text/event-stream" } }),
    new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
    new Response('data: {"error":"failed"}\n\n', { headers: { "content-type": "text/event-stream" } }),
  ]) {
    const inspected = await inspectProviderResponse(response, { stream: true });
    assert.ok(inspected.error);
    assert.deepEqual(inspected.observedSupportedCapabilities, []);
  }
  const parts = [": keepalive\n\ndata: {", '"choices":[{"delta":{"content":"Hello"}}]}\n\n', "data: [DONE]\n\n"];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
  const result = await inspectProviderResponse(new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  }), { stream: true, response_format: { type: "json_object" } });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.observedSupportedCapabilities, ["streaming"]);
  assert.equal(await result.response.text(), parts.join(""));
});
