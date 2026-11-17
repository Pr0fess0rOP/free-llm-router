import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverProviderModels,
  ProviderModelDiscoveryError,
} from "../src/provider-model-discovery.js";

const provider = { id: "groq", baseUrl: "https://provider.example/openai/v1/", model: "default" };

test("reads and normalizes a model list with the saved key", async () => {
  const models = await discoverProviderModels(provider, "saved-key", async (input, init) => {
    assert.equal(String(input), "https://provider.example/openai/v1/models");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer saved-key");
    return Response.json({
      data: [
        { id: "org/model:free", name: "Model", context_length: 8192, ignored: true },
        { id: "org/model:free" },
        { id: "invalid model id" },
        { id: "other-model", context_length: -1 },
      ],
    });
  });
  assert.deepEqual(models, [
    { id: "org/model:free", name: "Model", contextLength: 8192 },
    { id: "other-model" },
  ]);
});

test("paginates Anthropic and Cohere catalogs using their native fields", async () => {
  const anthropic = await discoverProviderModels({ ...provider, id: "anthropic" }, "saved-key", async (input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-api-key"), "saved-key");
    assert.ok(headers.has("anthropic-version"));
    const cursor = new URL(String(input)).searchParams.get("after_id");
    if (!cursor) {
      return Response.json({ data: [{ id: "claude-a", display_name: "Claude A" }], has_more: true, last_id: "claude-a" });
    }
    assert.equal(cursor, "claude-a");
    return Response.json({ data: [{ id: "claude-b", max_input_tokens: 4096 }], has_more: false });
  });
  assert.deepEqual(anthropic, [{ id: "claude-a", name: "Claude A" }, { id: "claude-b", contextLength: 4096 }]);

  const cohere = await discoverProviderModels({
    ...provider,
    id: "cohere",
    modelListUrl: "https://provider.example/v1/models",
  }, "saved-key", async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/v1/models");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer saved-key");
    return url.searchParams.get("page_token") === "page+2"
      ? Response.json({ models: [{ name: "command-b" }] })
      : Response.json({ models: [{ name: "command-a" }], next_page_token: "page+2" });
  });
  assert.deepEqual(cohere, [{ id: "command-a" }, { id: "command-b" }]);
});

test("keeps credentials out of public overrides and handles unavailable catalogs", async () => {
  const models = await discoverProviderModels({
    ...provider,
    modelListUrl: "https://catalog.example/models",
    headers: { "x-provider-secret": "secret" },
  }, "saved-key", async (input, init) => {
    assert.equal(String(input), "https://catalog.example/models");
    assert.deepEqual([...new Headers(init?.headers)], [["accept", "application/json"]]);
    return Response.json({ data: [{ id: "public-model" }] });
  });
  assert.deepEqual(models, [{ id: "public-model" }]);

  await assert.rejects(
    discoverProviderModels(provider, undefined, async () => assert.fail("Unexpected upstream request")),
    (error: unknown) => error instanceof ProviderModelDiscoveryError && error.status === 400,
  );
  await assert.rejects(
    discoverProviderModels(provider, "saved-key", async () => new Response(null, { status: 404 })),
    /enter a model ID manually/,
  );
  await assert.rejects(
    discoverProviderModels(provider, "saved-key", async () => Response.json({ error: { message: "upstream details" } })),
    /unrecognized model list/,
  );
});
