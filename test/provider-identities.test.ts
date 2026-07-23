import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeProviderId,
  normalizeProviderIds,
  normalizeProviderRecord,
} from "../src/provider-identities.js";

test("normalizes legacy model-coupled provider IDs", () => {
  assert.equal(normalizeProviderId("openrouter-qwen"), "openrouter");
  assert.equal(normalizeProviderId("groq-llama"), "groq");
  assert.equal(normalizeProviderId("nvidia-nemotron"), "nvidia");
  assert.equal(normalizeProviderId("cerebras-gpt-oss"), "cerebras");
  assert.equal(normalizeProviderId("github-models"), "github");
  assert.equal(normalizeProviderId("mistral"), "mistral");
});

test("deduplicates canonical and legacy provider IDs", () => {
  assert.deepEqual(
    normalizeProviderIds(["openrouter-qwen", "openrouter", "groq-llama"]),
    ["openrouter", "groq"],
  );
});

test("canonical provider records win over legacy duplicates", () => {
  assert.deepEqual(
    normalizeProviderRecord({
      "openrouter-qwen": "legacy-key",
      openrouter: "canonical-key",
      "groq-llama": "groq-key",
    }),
    { openrouter: "canonical-key", groq: "groq-key" },
  );
});
