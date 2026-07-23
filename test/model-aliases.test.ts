import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveAliasPolicy,
  mergeAliasRequirements,
  normalizeModelAliases,
  parseModelAliases,
  resolveModelAlias,
} from "../src/model-aliases.js";

test("provides only the required system aliases by default", () => {
  const aliases = normalizeModelAliases(undefined);
  assert.deepEqual(aliases.map((alias) => alias.id), [
    "free-router",
    "codex-free-router",
    "claude-free-router",
  ]);
  assert.ok(aliases.every((alias) => alias.system));
});

test("normalizes custom aliases and restores required system aliases", () => {
  const aliases = parseModelAliases([{
    id: "CUSTOM-ROUTER",
    name: "Custom Router",
    enabled: true,
    routingStrategy: "fastest",
    requiredCapabilities: ["vision", "not-real"],
    eligibleProviderIds: ["mistral", "mistral"],
    providerOrder: ["mistral"],
  }]);

  const custom = resolveModelAlias(aliases, "custom-router");
  assert.equal(custom?.routingStrategy, "fastest");
  assert.deepEqual(custom?.requiredCapabilities, ["vision"]);
  assert.deepEqual(custom?.eligibleProviderIds, ["mistral"]);
  assert.ok(aliases.some((alias) => alias.id === "free-router"));
});

test("alias policy and capability requirements override router defaults", () => {
  const alias = parseModelAliases([{
    id: "coding-router",
    name: "Coding Router",
    enabled: true,
    routingStrategy: "smart",
    requiredCapabilities: ["streaming", "tools"],
    eligibleProviderIds: [],
    providerOrder: [],
  }]).find((item) => item.id === "coding-router");
  assert.ok(alias);
  assert.deepEqual(
    effectiveAliasPolicy(
      { strategy: "priority", providerOrder: ["first", "second"] },
      { ...alias, providerOrder: ["second", "first"] },
    ),
    { strategy: "smart", providerOrder: ["second", "first"] },
  );
  assert.deepEqual(
    mergeAliasRequirements({ required: ["vision"] }, alias),
    { required: ["vision", "streaming", "tools"] },
  );
});

test("removes aliases that were automatically seeded by older releases", () => {
  const legacyAliases = [
    {
      id: "fast-router",
      name: "Fast Router",
      description: "Prefer the provider with the lowest observed latency.",
      enabled: true,
      routingStrategy: "fastest",
      requiredCapabilities: [],
      eligibleProviderIds: [],
      providerOrder: [],
    },
    {
      id: "reliable-router",
      name: "Reliable Router",
      description: "Prefer providers with the strongest recent success history.",
      enabled: true,
      routingStrategy: "reliability",
      requiredCapabilities: [],
      eligibleProviderIds: [],
      providerOrder: [],
    },
    {
      id: "coding-router",
      name: "Coding Router",
      description: "Require streaming and tool support, then use smart routing.",
      enabled: true,
      routingStrategy: "smart",
      requiredCapabilities: ["streaming", "tools"],
      eligibleProviderIds: [],
      providerOrder: [],
    },
    {
      id: "vision-router",
      name: "Vision Router",
      description: "Only route to providers that can process image input.",
      enabled: true,
      routingStrategy: "reliability",
      requiredCapabilities: ["vision"],
      eligibleProviderIds: [],
      providerOrder: [],
    },
    {
      id: "reasoning-router",
      name: "Reasoning Router",
      description: "Require reasoning support and balance quality with speed.",
      enabled: true,
      routingStrategy: "smart",
      requiredCapabilities: ["reasoning"],
      eligibleProviderIds: [],
      providerOrder: [],
    },
    {
      id: "structured-router",
      name: "Structured Router",
      description: "Require strict structured-output support.",
      enabled: true,
      routingStrategy: "reliability",
      requiredCapabilities: ["structuredOutputs"],
      eligibleProviderIds: [],
      providerOrder: [],
    },
  ];

  assert.deepEqual(
    normalizeModelAliases(legacyAliases).map((alias) => alias.id),
    ["free-router", "codex-free-router", "claude-free-router"],
  );
});

test("preserves a customized alias that reuses a former starter ID", () => {
  const aliases = normalizeModelAliases([{
    id: "fast-router",
    name: "My Fast Router",
    description: "A custom latency-sensitive route.",
    enabled: true,
    routingStrategy: "fastest",
    requiredCapabilities: ["streaming"],
    eligibleProviderIds: ["groq"],
    providerOrder: ["groq"],
  }]);

  assert.ok(aliases.some((alias) => alias.id === "fast-router"));
});
