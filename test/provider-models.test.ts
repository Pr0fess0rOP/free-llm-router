import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAccount,
  findAccount,
  hashRouterKey,
  setProviderKey,
  setProviderModelCatalog,
  updateProviderModelCapabilitiesByHash,
} from "../src/accounts.js";
import {
  normalizeProviderModelCatalog,
  normalizeProviderModelCatalogMap,
  parseProviderModelCatalog,
} from "../src/provider-models.js";
import { detectProviderModelCapabilities, handleRequest } from "../src/server.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return address.port;
}

test("migrates the legacy single provider model into a one-active-model catalog", () => {
  assert.deepEqual(normalizeProviderModelCatalog(undefined, "qwen/qwen3-coder:free"), {
    activeModelId: "qwen/qwen3-coder:free",
    models: [{ id: "qwen/qwen3-coder:free", status: "unknown" }],
  });
  const mapped = normalizeProviderModelCatalogMap({}, [{
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen3-coder:free",
  }]);
  assert.equal(mapped["openrouter"]?.activeModelId, "qwen/qwen3-coder:free");
  assert.equal(mapped["openrouter"]?.models.length, 1);
});

test("validates saved provider models and requires exactly one active saved ID", () => {
  const parsed = parseProviderModelCatalog({
    activeModelId: "qwen/qwen3-coder-next",
    models: [
      { id: "qwen/qwen3-coder:free", status: "unavailable" },
      { id: "qwen/qwen3-coder-next", status: "healthy" },
    ],
  });
  assert.equal(parsed.activeModelId, "qwen/qwen3-coder-next");
  assert.throws(() => parseProviderModelCatalog({
    activeModelId: "missing",
    models: [{ id: "saved", status: "unknown" }],
  }), /Select one saved model as active/);
  assert.throws(() => parseProviderModelCatalog({
    activeModelId: "bad model",
    models: [{ id: "bad model" }],
  }), /Model IDs cannot contain spaces/);
});

test("routes only through the active saved model and tracks model health separately from provider health", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "free-llm-provider-models-"));
  const previous = {
    accounts: process.env.ACCOUNTS_PATH,
    analytics: process.env.ANALYTICS_PATH,
    routing: process.env.ROUTING_STATE_PATH,
    providers: process.env.PROVIDERS_CONFIG,
  };
  process.env.ACCOUNTS_PATH = path.join(directory, "accounts.json");
  process.env.ANALYTICS_PATH = path.join(directory, "analytics.json");
  process.env.ROUTING_STATE_PATH = path.join(directory, "routing-state.json");
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  const receivedModels: string[] = [];
  const firstUpstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
    receivedModels.push(body.model);
    const available = body.model === "qwen/qwen3-coder-next";
    response.writeHead(available ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(available
      ? { choices: [{ message: { role: "assistant", content: "active model works" } }] }
      : { error: { message: "This model is unavailable" } }));
  });
  const firstPort = await listen(firstUpstream);
  const fallbackUpstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "fallback" } }] }));
  });
  const fallbackPort = await listen(fallbackUpstream);

  const providersPath = path.join(directory, "providers.json");
  await writeFile(providersPath, JSON.stringify({ providers: [
    { id: "openrouter", baseUrl: `http://127.0.0.1:${firstPort}`, model: "qwen/qwen3-coder:free", priority: 10 },
    { id: "groq", baseUrl: `http://127.0.0.1:${fallbackPort}`, model: "llama-model", priority: 20 },
  ] }));
  process.env.PROVIDERS_CONFIG = providersPath;

  const { routerKey } = await createAccount("Provider model catalog router");
  await setProviderKey(routerKey, "openrouter", "openrouter-key");
  await setProviderKey(routerKey, "groq", "groq-key");
  await setProviderModelCatalog(routerKey, "openrouter", {
    activeModelId: "qwen/qwen3-coder-next",
    models: [
      { id: "qwen/qwen3-coder:free", status: "unknown" },
      { id: "qwen/qwen3-coder-next", status: "unknown" },
    ],
  });

  const gateway = createServer((request, response) => void handleRequest(request, response));
  const gatewayPort = await listen(gateway);

  try {
    const success = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${routerKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "free-router", messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(success.status, 200);
    assert.equal(success.headers.get("x-free-llm-provider-model"), "qwen/qwen3-coder-next");
    assert.deepEqual(receivedModels, ["qwen/qwen3-coder-next"]);
    assert.equal((await findAccount(routerKey))?.providerModels["openrouter"]?.models
      .find((model) => model.id === "qwen/qwen3-coder-next")?.status, "healthy");

    await setProviderModelCatalog(routerKey, "openrouter", {
      activeModelId: "qwen/qwen3-coder:free",
      models: [
        { id: "qwen/qwen3-coder:free", status: "unknown" },
        { id: "qwen/qwen3-coder-next", status: "healthy" },
      ],
    });
    const fallback = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${routerKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "free-router", messages: [{ role: "user", content: "hello again" }] }),
    });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.headers.get("x-free-llm-provider"), "groq");
    const stored = await findAccount(routerKey);
    const failedModel = stored?.providerModels["openrouter"]?.models
      .find((model) => model.id === "qwen/qwen3-coder:free");
    assert.equal(failedModel?.status, "unavailable");
    assert.equal(failedModel?.lastStatus, 404);
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => firstUpstream.close(() => resolve()));
    await new Promise<void>((resolve) => fallbackUpstream.close(() => resolve()));
    if (previous.accounts === undefined) delete process.env.ACCOUNTS_PATH; else process.env.ACCOUNTS_PATH = previous.accounts;
    if (previous.analytics === undefined) delete process.env.ANALYTICS_PATH; else process.env.ANALYTICS_PATH = previous.analytics;
    if (previous.routing === undefined) delete process.env.ROUTING_STATE_PATH; else process.env.ROUTING_STATE_PATH = previous.routing;
    if (previous.providers === undefined) delete process.env.PROVIDERS_CONFIG; else process.env.PROVIDERS_CONFIG = previous.providers;
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizes model capability profiles and preserves manual overrides", () => {
  const catalog = parseProviderModelCatalog({
    activeModelId: "custom/model",
    models: [{
      id: "custom/model",
      status: "unknown",
      capabilities: {
        tools: {
          value: "supported",
          source: "user",
          lastVerifiedAt: "2026-07-21T00:00:00.000Z",
        },
        vision: {
          value: "unsupported",
          source: "probe",
          evidence: {
            status: 400,
            message: "Images are not supported",
            observedAt: "2026-07-21T00:00:00.000Z",
          },
        },
      },
    }],
  });

  const model = catalog.models[0]!;
  assert.equal(model.capabilities?.tools?.value, "supported");
  assert.equal(model.capabilities?.tools?.source, "user");
  assert.equal(model.capabilities?.vision?.value, "unsupported");
  assert.equal(model.capabilities?.vision?.evidence?.status, 400);
});


test("protects higher-confidence model capability sources from runtime downgrades", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "free-llm-capability-precedence-"));
  const previous = process.env.ACCOUNTS_PATH;
  process.env.ACCOUNTS_PATH = path.join(directory, "accounts.json");
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  try {
    const { routerKey } = await createAccount("Capability precedence router");
    await setProviderModelCatalog(routerKey, "custom-provider", {
      activeModelId: "custom/model",
      models: [{
        id: "custom/model",
        status: "unknown",
        capabilities: {
          tools: { value: "supported", source: "user" },
          vision: { value: "supported", source: "probe" },
        },
      }],
    });

    await updateProviderModelCapabilitiesByHash(
      hashRouterKey(routerKey),
      "custom-provider",
      "custom/model",
      {
        tools: { value: "unsupported", source: "runtime" },
        vision: { value: "unsupported", source: "runtime" },
        reasoning: { value: "supported", source: "runtime" },
      },
    );
    await updateProviderModelCapabilitiesByHash(
      hashRouterKey(routerKey),
      "custom-provider",
      "custom/model",
      { reasoning: { value: "unknown", source: "probe" } },
    );

    const model = (await findAccount(routerKey))?.providerModels["custom-provider"]?.models[0];
    assert.equal(model?.capabilities?.tools?.value, "supported");
    assert.equal(model?.capabilities?.tools?.source, "user");
    assert.equal(model?.capabilities?.vision?.value, "supported");
    assert.equal(model?.capabilities?.vision?.source, "probe");
    assert.equal(model?.capabilities?.reasoning?.value, "supported");
    assert.equal(model?.capabilities?.reasoning?.source, "runtime");
  } finally {
    if (previous === undefined) delete process.env.ACCOUNTS_PATH;
    else process.env.ACCOUNTS_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("detects and persists per-model capabilities with controlled probes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "free-llm-capability-probes-"));
  const previous = {
    accounts: process.env.ACCOUNTS_PATH,
    providers: process.env.PROVIDERS_CONFIG,
  };
  process.env.ACCOUNTS_PATH = path.join(directory, "accounts.json");
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
      : {};
    const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : [];
    const content = messages[0]?.content;
    const isVision = Array.isArray(content);
    if (request.url === "/embeddings") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Embeddings are not supported" } }));
      return;
    }
    if (isVision) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Image input is not supported by this model" } }));
      return;
    }
    if (body.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }] })}\n\n`);
      return;
    }
    if (Array.isArray(body.tools)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_probe", type: "function", function: { name: "capability_probe", arguments: "{}" } }],
      } }] }));
      return;
    }
    if (body.response_format) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ ok: true }) } }] }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
  });
  const port = await listen(upstream);
  const providersPath = path.join(directory, "providers.json");
  await writeFile(providersPath, JSON.stringify({ providers: [{
    id: "probe-provider",
    baseUrl: `http://127.0.0.1:${port}`,
    model: "probe/model",
    priority: 10,
  }] }));
  process.env.PROVIDERS_CONFIG = providersPath;

  try {
    const { routerKey } = await createAccount("Capability probe router");
    await setProviderKey(routerKey, "probe-provider", "probe-key");
    await setProviderModelCatalog(routerKey, "probe-provider", {
      activeModelId: "probe/model",
      models: [{ id: "probe/model", status: "unknown" }],
    });

    const detected = await detectProviderModelCapabilities({
      routerKey,
      providerId: "probe-provider",
      modelId: "probe/model",
    });
    assert.equal(detected.results.streaming?.value, "supported");
    assert.equal(detected.results.tools?.value, "supported");
    assert.equal(detected.results.vision?.value, "unsupported");
    assert.equal(detected.results.embeddings?.value, "unsupported");
    assert.equal(detected.results.vision?.source, "probe");
    assert.match(detected.results.vision?.evidence?.message ?? "", /image input/i);

    const model = (await findAccount(routerKey))?.providerModels["probe-provider"]?.models[0];
    assert.equal(model?.capabilities?.tools?.value, "supported");
    assert.equal(model?.capabilities?.vision?.value, "unsupported");
    assert.equal(model?.capabilities?.embeddings?.evidence?.status, 404);
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    if (previous.accounts === undefined) delete process.env.ACCOUNTS_PATH;
    else process.env.ACCOUNTS_PATH = previous.accounts;
    if (previous.providers === undefined) delete process.env.PROVIDERS_CONFIG;
    else process.env.PROVIDERS_CONFIG = previous.providers;
    await rm(directory, { recursive: true, force: true });
  }
});
