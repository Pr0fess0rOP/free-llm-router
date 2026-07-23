import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequestLog, listRequestLogs } from "../src/analytics.js";
import {
  analyzeToolActivity,
  detectClientApplication,
  summarizeRequestAnalytics,
} from "../src/request-analytics.js";

test("detects common client applications without retaining raw sensitive headers", () => {
  assert.equal(detectClientApplication({ "user-agent": "codex-cli/1.2.3" }).id, "codex-cli");
  assert.equal(detectClientApplication({ "user-agent": "claude-code/2.0" }).id, "claude-code");
  assert.equal(detectClientApplication({ "user-agent": "curl/8.7.1" }).id, "curl");
  const python = detectClientApplication({
    "user-agent": "custom",
    "x-stainless-lang": "python",
    "x-stainless-package-version": "1.99.0",
    authorization: "Bearer secret",
  });
  assert.deepEqual(python, {
    id: "openai-python",
    name: "OpenAI Python SDK",
    detectedBy: "stainless",
    language: "python",
    sdkVersion: "1.99.0",
  });
  assert.equal(JSON.stringify(python).includes("secret"), false);
});

test("captures tool calls and structured-output validation across API response shapes", () => {
  const openai = analyzeToolActivity({
    body: {
      tools: [{ type: "function", function: { name: "search_docs" } }],
      response_format: { type: "json_object" },
    },
    responsePayload: {
      choices: [{ message: {
        content: "{\"ok\":true}",
        tool_calls: [{ function: { name: "search_docs" } }],
      } }],
    },
    status: 200,
    streaming: false,
  });
  assert.equal(openai.toolRequest, true);
  assert.deepEqual(openai.requestedToolNames, ["search_docs"]);
  assert.deepEqual(openai.generatedToolNames, ["search_docs"]);
  assert.equal(openai.outcome, "generated");
  assert.equal(openai.structuredOutputValidation, "valid");

  const anthropic = analyzeToolActivity({
    body: { tools: [{ name: "weather" }] },
    responsePayload: { content: [{ type: "tool_use", name: "weather" }] },
    status: 200,
    streaming: false,
  });
  assert.deepEqual(anthropic.generatedToolNames, ["weather"]);

  const responses = analyzeToolActivity({
    body: { tools: [{ type: "function", name: "lookup" }] },
    responsePayload: { output: [{ type: "function_call", name: "lookup" }] },
    status: 200,
    streaming: false,
  });
  assert.deepEqual(responses.generatedToolNames, ["lookup"]);
});

test("creates analytics dimensions and aggregates tokens, fallback paths, clients, and attempts", () => {
  const original = createRequestLog({
    routerKeyHash: "router",
    requestHeaders: {
      "user-agent": "openai-python/1.0",
      "x-stainless-lang": "python",
      authorization: "Bearer should-never-be-stored",
    },
    providerId: "mistral",
    providerModel: "model",
    requestedModel: "free-router",
    resolvedAlias: "free-router",
    apiFormat: "openai-compatible",
    endpoint: "/v1/chat/completions",
    routingStrategy: "priority",
    providerAttempts: [
      { providerId: "groq", success: false, status: 503, latencyMs: 10 },
      { providerId: "mistral", success: true, status: 200, latencyMs: 20 },
    ],
    status: 200,
    latencyMs: 30,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, source: "reported" },
    requestBody: {
      model: "free-router",
      tools: [{ type: "function", function: { name: "lookup" } }],
      messages: [{ role: "user", content: "hello" }],
    },
    responseText: JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name: "lookup" } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    responseContentType: "application/json",
  });

  const deduplicated = {
    ...original,
    id: "deduplicated",
    requestId: "req_duplicate",
    deduplication: {
      deduplicated: true,
      originalRequestId: original.requestId ?? "req_original",
      source: "completed" as const,
      duplicateCount: 1,
      providerCallAvoided: true,
      estimatedRequestsSaved: 1,
    },
  };

  assert.equal(original.clientApplication?.id, "openai-python");
  assert.equal(original.fallbackUsed, true);
  assert.deepEqual(original.fallbackPath, ["groq", "mistral"]);
  assert.equal(original.toolAnalytics?.generatedToolCallCount, 1);
  assert.equal(JSON.stringify(original).includes("should-never-be-stored"), false);

  const summary = summarizeRequestAnalytics([original, deduplicated]);
  assert.equal(summary.totalRequests, 2);
  assert.equal(summary.totalTokens, 15, "deduplicated traffic must not double-count upstream tokens");
  assert.equal(summary.fallbackRequests, 1);
  assert.equal(summary.averageProviderAttempts, 2);
  assert.equal(summary.generatedToolCalls, 2, "tool analytics are request-level, including reused responses");
  assert.equal(summary.fallbackPaths[0]?.path.join(" → "), "groq → mistral");
  assert.equal(summary.topClient?.id, "openai-python");
  assert.equal(summary.providers.find((provider) => provider.providerId === "mistral")?.successRate, 1);
});

test("historical records without P4.4 fields remain aggregatable", () => {
  const summary = summarizeRequestAnalytics([{
    status: 200,
    providerId: "legacy-provider",
    apiFormat: "openai-compatible",
  }]);
  assert.equal(summary.totalRequests, 1);
  assert.equal(summary.averageProviderAttempts, 1);
  assert.equal(summary.topClient?.id, "unknown");
  assert.equal(summary.providers[0]?.providerId, "legacy-provider");
});


test("normalizes legacy provider IDs when historical request logs are read", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-analytics-provider-migration-"));
  const analyticsPath = path.join(directory, "analytics.json");
  const previousPath = process.env.ANALYTICS_PATH;
  process.env.ANALYTICS_PATH = analyticsPath;

  try {
    await writeFile(analyticsPath, JSON.stringify({
      requests: [{
        id: "legacy-log",
        requestId: "req_legacy",
        routerKeyHash: "router-hash",
        createdAt: new Date().toISOString(),
        providerId: "openrouter-qwen",
        providerModel: "qwen/qwen3-coder:free",
        status: 200,
        latencyMs: 12,
        providerAttempts: [{
          providerId: "openrouter-qwen",
          providerModel: "qwen/qwen3-coder:free",
          success: true,
          status: 200,
          latencyMs: 10
        }],
        providerEvaluations: [{
          providerId: "groq-llama",
          match: { level: "full", supported: [], unknown: [], unsupported: [] },
          state: "candidate",
          candidateRank: 2
        }],
        fallbackPath: ["openrouter-qwen", "groq-llama"],
        routingHeaders: { "x-free-llm-provider": "openrouter-qwen" },
        performance: {
          totalLatencyMs: 12,
          routerPreparationMs: 2,
          routerOverheadMs: 2,
          providerLatencyMs: 10,
          providerHeadersMs: 10,
          responseBodyMs: 0,
          responseProcessingMs: 0,
          retryDelayMs: 0,
          attempts: [{ attempt: 1, providerId: "openrouter-qwen", success: true, latencyMs: 10 }]
        },
        timeline: [{
          id: "event-1",
          type: "provider_attempt_succeeded",
          timestamp: new Date().toISOString(),
          elapsedMs: 10,
          title: "openrouter-qwen succeeded — HTTP 200",
          detail: "Completed through openrouter-qwen.",
          providerId: "openrouter-qwen",
          tone: "success",
          details: {
            providerId: "openrouter-qwen",
            fallbackPath: ["openrouter-qwen", "groq-llama"]
          }
        }],
        request: {},
        response: {}
      }]
    }, null, 2));

    const [log] = await listRequestLogs("router-hash");
    assert.equal(log?.providerId, "openrouter");
    assert.equal(log?.providerModel, "qwen/qwen3-coder:free");
    assert.equal(log?.providerAttempts?.[0]?.providerId, "openrouter");
    assert.equal(log?.providerEvaluations?.[0]?.providerId, "groq");
    assert.deepEqual(log?.fallbackPath, ["openrouter", "groq"]);
    assert.equal(log?.routingHeaders?.["x-free-llm-provider"], "openrouter");
    assert.equal(log?.performance?.attempts[0]?.providerId, "openrouter");
    assert.equal(log?.timeline?.[0]?.providerId, "openrouter");
    assert.equal(log?.timeline?.[0]?.title, "openrouter succeeded — HTTP 200");
    assert.equal(log?.timeline?.[0]?.detail, "Completed through openrouter.");
    assert.deepEqual(log?.timeline?.[0]?.details, {
      providerId: "openrouter",
      fallbackPath: ["openrouter", "groq"]
    });
  } finally {
    if (previousPath === undefined) delete process.env.ANALYTICS_PATH;
    else process.env.ANALYTICS_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
