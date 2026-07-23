import assert from "node:assert/strict";
import test from "node:test";
// @ts-ignore
import {
  summarizeApiAndModelDashboard,
  summarizeApplicationDashboard,
  summarizeProviderDashboard,
} from "../public/dashboard-analytics.js";

const requests = [
  {
    status: 200,
    providerId: "mistral",
    apiFormat: "openai-compatible",
    resolvedAlias: "free-router",
    latencyMs: 240,
    usage: { inputTokens: 70, outputTokens: 30, totalTokens: 100 },
    fallbackPath: ["groq", "mistral"],
    providerAttempts: [
      { providerId: "groq", success: false, latencyMs: 120 },
      { providerId: "mistral", success: true, latencyMs: 100 },
    ],
    clientApplication: { id: "curl", name: "cURL", detectedBy: "user-agent" },
    toolAnalytics: { toolRequest: true, generatedToolCallCount: 1 },
    streaming: false,
  },
  {
    status: 200,
    providerId: "mistral",
    apiFormat: "openai-compatible",
    resolvedAlias: "free-router",
    latencyMs: 8,
    usage: { inputTokens: 70, outputTokens: 30, totalTokens: 100 },
    deduplication: { deduplicated: true },
    clientApplication: { id: "curl", name: "cURL", detectedBy: "user-agent" },
    streaming: false,
  },
  {
    status: 500,
    providerId: "groq",
    apiFormat: "openai-responses-compatible",
    resolvedAlias: "codex-free-router",
    latencyMs: 500,
    providerAttempts: [{ providerId: "groq", success: false, latencyMs: 480 }],
    clientApplication: { id: "codex-cli", name: "Codex CLI", detectedBy: "user-agent" },
    toolAnalytics: { toolRequest: true, generatedToolCallCount: 0 },
    streaming: true,
  },
];

test("provider dashboard separates attempts, completions, recoveries, and deduplicated usage", () => {
  const providers = summarizeProviderDashboard(requests);
  const mistral = providers.find((provider: any) => provider.providerId === "mistral");
  const groq = providers.find((provider: any) => provider.providerId === "groq");

  assert.equal(mistral?.completedRequests, 1);
  assert.equal(mistral?.tokens, 100);
  assert.equal(mistral?.fallbackRecoveries, 1);
  assert.equal(mistral?.successRate, 1);
  assert.equal(groq?.attempts, 2);
  assert.equal(groq?.failures, 2);
  assert.equal(groq?.fallbackStarts, 1);
});

test("API and alias dashboards include client demand but avoid duplicate provider accounting", () => {
  const dashboards = summarizeApiAndModelDashboard(requests);
  const chat = dashboards.apis.find((item: any) => item.id === "openai-compatible");
  const freeRouter = dashboards.aliases.find((item: any) => item.id === "free-router");

  assert.equal(chat?.requests, 2);
  assert.equal(chat?.upstreamRequests, 1);
  assert.equal(chat?.tokens, 100);
  assert.equal(chat?.fallbackRate, 1);
  assert.equal(freeRouter?.averageAttempts, 2);
});

test("application dashboard reports safe client dimensions and API mix", () => {
  const applications = summarizeApplicationDashboard(requests);
  const curl = applications.find((item: any) => item.id === "curl");
  const codex = applications.find((item: any) => item.id === "codex-cli");

  assert.equal(curl?.requests, 2);
  assert.equal(curl?.tokens, 100);
  assert.equal(curl?.toolRequests, 1);
  assert.equal(curl?.topApiFormat, "openai-compatible");
  assert.equal(codex?.streamingRate, 1);
  assert.equal(codex?.successRate, 0);
});
