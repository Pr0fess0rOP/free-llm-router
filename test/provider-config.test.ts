import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Hugging Face uses the hosted OpenAI-compatible router endpoint", async () => {
  const providerFile = JSON.parse(
    await readFile(new URL("providers.json", root), "utf8"),
  ) as { providers: Array<{ id: string; baseUrl: string }> };
  const huggingFace = providerFile.providers.find(
    (provider) => provider.id === "hugging-face",
  );

  assert.ok(huggingFace, "Hugging Face provider should exist");
  assert.equal(huggingFace.baseUrl, "https://router.huggingface.co/v1");
  assert.doesNotMatch(huggingFace.baseUrl, /127\.0\.0\.1|localhost/);
});


test("default provider IDs contain only provider identities", async () => {
  const providerFile = JSON.parse(
    await readFile(new URL("providers.json", root), "utf8"),
  ) as { providers: Array<{ id: string; model: string }> };
  const ids = providerFile.providers.map((provider) => provider.id);

  assert.ok(ids.includes("openrouter"));
  assert.ok(ids.includes("groq"));
  assert.ok(ids.includes("nvidia"));
  assert.ok(ids.includes("cerebras"));
  assert.ok(ids.includes("github"));
  assert.ok(!ids.includes("openrouter-qwen"));
  assert.ok(!ids.includes("groq-llama"));
  assert.ok(!ids.includes("nvidia-nemotron"));
  assert.ok(!ids.includes("cerebras-gpt-oss"));
  assert.equal(
    providerFile.providers.find((provider) => provider.id === "openrouter")?.model,
    "qwen/qwen3-coder:free",
  );
});


test("expanded provider catalog includes the 13 requested providers and official endpoints", async () => {
  const providerFile = JSON.parse(
    await readFile(new URL("providers.json", root), "utf8"),
  ) as { providers: Array<{ id: string; baseUrl: string; apiKeyEnv?: string; model: string }> };
  const expected: Record<string, string> = {
    together: "https://api.together.ai/v1",
    fireworks: "https://api.fireworks.ai/inference/v1",
    deepinfra: "https://api.deepinfra.com/v1/openai",
    gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
    xai: "https://api.x.ai/v1",
    novita: "https://api.novita.ai/openai/v1",
    baseten: "https://inference.baseten.co/v1",
    cohere: "https://api.cohere.ai/compatibility/v1",
    anthropic: "https://api.anthropic.com/v1",
    openai: "https://api.openai.com/v1",
    deepseek: "https://api.deepseek.com",
    perplexity: "https://api.perplexity.ai",
    friendli: "https://api.friendli.ai/serverless/v1",
  };

  assert.equal(providerFile.providers.length, 26);
  for (const [id, baseUrl] of Object.entries(expected)) {
    const provider = providerFile.providers.find((candidate) => candidate.id === id);
    assert.ok(provider, `${id} should exist`);
    assert.equal(provider.baseUrl, baseUrl);
    assert.ok(provider.apiKeyEnv, `${id} should define an environment variable`);
    assert.ok(provider.model, `${id} should include an initial model catalog entry`);
  }
});

test("expanded providers have catalog metadata and local logo assets", async () => {
  const logoMap = JSON.parse(
    await readFile(new URL("provider-logo-map.json", root), "utf8"),
  ) as Record<string, { name: string; logo: string }>;
  const ids = [
    "together", "fireworks", "deepinfra", "gemini", "xai", "novita",
    "baseten", "cohere", "anthropic", "openai", "deepseek", "perplexity", "friendli",
  ];
  for (const id of ids) {
    assert.ok(logoMap[id]?.name, `${id} should have display metadata`);
    assert.equal(logoMap[id]?.logo, `/assets/providers/${id}.svg`);
    const asset = await readFile(new URL(`public/assets/providers/${id}.svg`, root), "utf8");
    assert.match(asset, /<svg/);
  }
});

test("README documents the current feature guide and Hugging Face endpoint", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");

  assert.match(readme, /## Feature Guide with Examples/);
  assert.match(readme, /Request lifecycle/);
  assert.match(readme, /Retry and failover/);
  assert.match(readme, /Circuit breaker/);
  assert.match(readme, /Model aliases/);
  assert.match(readme, /Model-Aware Capability Registry/);
  assert.match(readme, /Analysis logs/);
  assert.match(readme, /Full Provider-Attempt Timeline/);
  assert.match(readme, /Copy timeline/);
  assert.match(readme, /P4\.1[^\n]*\[x\]|\[x\][^\n]*P4\.1/);
  assert.match(readme, /Provider Quota and Usage Tracking/);
  assert.match(readme, /providers_quota_exhausted/);
  assert.match(readme, /P3\.4.*Provider quota and usage tracking/);
  assert.match(readme, /Configurable Retry and Timeout Controls/);
  assert.match(readme, /P3\.5.*Configurable retry and timeout controls/);
  assert.match(readme, /P3\.5[^\n]*\[x\]|\[x\][^\n]*P3\.5/);
  assert.match(readme, /Request Deduplication and Idempotency/);
  assert.match(readme, /Idempotency-Key/);
  assert.match(readme, /x-free-llm-deduplicated/);
  assert.match(readme, /P3\.6[^\n]*\[x\]|\[x\][^\n]*P3\.6/);
  assert.match(readme, /## Request IDs and Routing Headers/);
  assert.match(readme, /x-free-llm-request-id/);
  assert.match(readme, /x-free-llm-provider-attempts/);
  assert.match(readme, /request_id/);
  assert.match(readme, /P4\.2[^\n]*\[x\]|\[x\][^\n]*P4\.2/);
  assert.match(readme, /## Performance Timing Breakdown/);
  assert.match(readme, /x-free-llm-first-token-ms/);
  assert.match(readme, /streamDurationMs/);
  assert.match(readme, /Copy timings/);
  assert.match(readme, /P4\.3[^\n]*\[x\]|\[x\][^\n]*P4\.3/);
  assert.match(readme, /https:\/\/router\.huggingface\.co\/v1/);
  assert.match(readme, /Provider Model Catalog/);
  assert.match(readme, /P2\.6.*Provider model catalogs/);
  assert.match(readme, /P2\.7.*Model-aware capability registry/);
  assert.match(readme, /Provider Identity and Model Separation/);
  assert.match(readme, /P2\.8.*Canonical provider-only identities/);
  assert.match(readme, /Expanded Provider Catalog/);
  assert.match(readme, /Together AI/);
  assert.match(readme, /FriendliAI/);
  assert.match(readme, /## Roadmap/);
  assert.match(readme, /Phase 1 — API Compatibility/);
  assert.match(readme, /P3\.2.*Circuit breakers/);
  assert.match(readme, /Phase 9 — Platform Features/);
});
