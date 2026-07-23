import assert from "node:assert/strict";
import test from "node:test";
import {
  detectCapabilityRequirements,
  matchProviderCapabilities,
  resolveProviderCapabilities,
} from "../src/provider-capabilities.js";

test("detects tools, streaming, structured outputs, vision, and reasoning", () => {
  const requirements = detectCapabilityRequirements({
    stream: true,
    reasoning: { effort: "high" },
    tools: [{ type: "function", name: "lookup" }],
    text: {
      format: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object" },
      },
    },
    input: [{
      role: "user",
      content: [{ type: "input_image", image_url: "https://example.com/a.png" }],
    }],
  });

  assert.deepEqual(new Set(requirements.required), new Set([
    "streaming",
    "tools",
    "structuredOutputs",
    "vision",
    "reasoning",
  ]));
});

test("detects Anthropic thinking as a reasoning requirement", () => {
  const requirements = detectCapabilityRequirements({
    thinking: { type: "enabled", budget_tokens: 512 },
    messages: [{ role: "user", content: "Think carefully" }],
  });

  assert.deepEqual(requirements.required, ["reasoning"]);
});

test("registry values can be overridden from provider configuration", () => {
  const capabilities = resolveProviderCapabilities({
    id: "groq",
    capabilities: {
      vision: "supported",
      contextWindow: 8_192,
      notes: "Custom proxy adds image preprocessing",
    },
  });

  assert.equal(capabilities.tools, "supported");
  assert.equal(capabilities.vision, "supported");
  assert.equal(capabilities.contextWindow, 8_192);
  assert.equal(capabilities.notes, "Custom proxy adds image preprocessing");
});

test("unknown support is a partial match rather than a hard failure", () => {
  const capabilities = resolveProviderCapabilities({ id: "unregistered" });
  const match = matchProviderCapabilities(capabilities, {
    required: ["tools"],
  });

  assert.equal(match.level, "partial");
  assert.deepEqual(match.unknown, ["tools"]);
  assert.deepEqual(match.unsupported, []);
});

test("model capability overrides take precedence over provider defaults", async () => {
  const { resolveEffectiveModelCapabilities } = await import("../src/provider-capabilities.js");
  const effective = resolveEffectiveModelCapabilities(
    {
      id: "groq",
      capabilities: { vision: "unsupported", tools: "supported" },
    },
    {
      id: "custom/groq-model",
      capabilities: {
        vision: { value: "supported", source: "user", lastVerifiedAt: "2026-07-21T00:00:00.000Z" },
        tools: { value: "unknown", source: "probe", lastVerifiedAt: "2026-07-21T00:00:00.000Z" },
      },
    },
  );

  assert.equal(effective.capabilities.vision, "supported");
  assert.equal(effective.sources.vision, "user");
  assert.equal(effective.capabilities.tools, "unknown");
  assert.equal(effective.sources.tools, "probe");
  assert.equal(effective.sources.streaming, "provider");
});

test("strict capability mode rejects unknown required capabilities", () => {
  const capabilities = resolveProviderCapabilities({ id: "unregistered" });
  const flexible = matchProviderCapabilities(capabilities, { required: ["tools"] }, "flexible");
  const strict = matchProviderCapabilities(capabilities, { required: ["tools"] }, "strict");

  assert.equal(flexible.level, "partial");
  assert.equal(strict.level, "incompatible");
  assert.deepEqual(strict.unknown, ["tools"]);
});
