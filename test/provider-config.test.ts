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

