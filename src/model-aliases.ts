import type {
  CapabilityRequirements,
  ModelAlias,
  ModelAliasRoutingStrategy,
  ProviderCapabilityName,
  RoutingPolicy,
  RoutingStrategy,
} from "./types.js";
import { PROVIDER_CAPABILITY_NAMES } from "./provider-capabilities.js";
import { normalizeReliabilityOverrides } from "./reliability-settings.js";
import { normalizeProviderIds } from "./provider-identities.js";

const ROUTING_STRATEGIES = new Set<RoutingStrategy>([
  "priority",
  "fastest",
  "round-robin",
  "least-used",
  "reliability",
  "smart",
]);

const ALIAS_STRATEGIES = new Set<ModelAliasRoutingStrategy>([
  "inherit",
  ...ROUTING_STRATEGIES,
]);

const CAPABILITY_NAMES = new Set<ProviderCapabilityName>(
  PROVIDER_CAPABILITY_NAMES,
);

export const REQUIRED_SYSTEM_ALIAS_IDS = new Set([
  "free-router",
  "codex-free-router",
  "claude-free-router",
]);

const LEGACY_PRECREATED_MODEL_ALIASES: ModelAlias[] = [
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

export const DEFAULT_MODEL_ALIASES: ModelAlias[] = [
  {
    id: "free-router",
    name: "Free Router",
    description: "General OpenAI-compatible routing using the router-wide policy.",
    enabled: true,
    routingStrategy: "inherit",
    requiredCapabilities: [],
    eligibleProviderIds: [],
    providerOrder: [],
    system: true,
  },
  {
    id: "codex-free-router",
    name: "Codex Router",
    description: "Default virtual model for Codex and the Responses API.",
    enabled: true,
    routingStrategy: "inherit",
    requiredCapabilities: [],
    eligibleProviderIds: [],
    providerOrder: [],
    system: true,
  },
  {
    id: "claude-free-router",
    name: "Claude Router",
    description: "Default virtual model for Claude Code and Anthropic clients.",
    enabled: true,
    routingStrategy: "inherit",
    requiredCapabilities: [],
    eligibleProviderIds: [],
    providerOrder: [],
    system: true,
  },
];

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isLegacyPrecreatedAlias(alias: ModelAlias): boolean {
  const legacy = LEGACY_PRECREATED_MODEL_ALIASES.find((item) => item.id === alias.id);
  if (!legacy) return false;

  return alias.name === legacy.name &&
    alias.description === legacy.description &&
    alias.enabled === legacy.enabled &&
    alias.routingStrategy === legacy.routingStrategy &&
    sameStrings(alias.requiredCapabilities, legacy.requiredCapabilities) &&
    sameStrings(alias.eligibleProviderIds, legacy.eligibleProviderIds) &&
    sameStrings(alias.providerOrder, legacy.providerOrder);
}

function cloneAlias(alias: ModelAlias): ModelAlias {
  return {
    ...alias,
    requiredCapabilities: [...alias.requiredCapabilities],
    eligibleProviderIds: [...alias.eligibleProviderIds],
    providerOrder: [...alias.providerOrder],
    ...(alias.reliabilityOverrides
      ? {
          reliabilityOverrides: {
            ...alias.reliabilityOverrides,
            ...(alias.reliabilityOverrides.retryStatusCodes
              ? { retryStatusCodes: [...alias.reliabilityOverrides.retryStatusCodes] }
              : {}),
            ...(alias.reliabilityOverrides.providerTimeoutOverrides
              ? { providerTimeoutOverrides: { ...alias.reliabilityOverrides.providerTimeoutOverrides } }
              : {}),
          },
        }
      : {}),
  };
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
}

function normalizeAliasId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{1,63}$/.test(id) ? id : undefined;
}

function normalizeAlias(value: unknown): ModelAlias | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ModelAlias>;
  const id = normalizeAliasId(candidate.id);
  if (!id) return undefined;

  const routingStrategy = ALIAS_STRATEGIES.has(
    candidate.routingStrategy as ModelAliasRoutingStrategy,
  )
    ? (candidate.routingStrategy as ModelAliasRoutingStrategy)
    : "inherit";

  const requiredCapabilities = uniqueStrings(candidate.requiredCapabilities)
    .filter((item): item is ProviderCapabilityName =>
      CAPABILITY_NAMES.has(item as ProviderCapabilityName),
    );

  const defaultAlias = DEFAULT_MODEL_ALIASES.find((alias) => alias.id === id);
  const name = typeof candidate.name === "string" && candidate.name.trim()
    ? candidate.name.trim().slice(0, 80)
    : defaultAlias?.name ?? id;
  const description = typeof candidate.description === "string"
    ? candidate.description.trim().slice(0, 240)
    : defaultAlias?.description;

  const reliabilityOverrides = normalizeReliabilityOverrides(
    candidate.reliabilityOverrides,
  );

  return {
    id,
    name,
    ...(description ? { description } : {}),
    enabled: REQUIRED_SYSTEM_ALIAS_IDS.has(id)
      ? true
      : candidate.enabled !== false,
    routingStrategy,
    requiredCapabilities,
    eligibleProviderIds: normalizeProviderIds(uniqueStrings(candidate.eligibleProviderIds)),
    providerOrder: normalizeProviderIds(uniqueStrings(candidate.providerOrder)),
    ...(reliabilityOverrides ? { reliabilityOverrides } : {}),
    ...(REQUIRED_SYSTEM_ALIAS_IDS.has(id) ? { system: true } : {}),
  };
}

export function normalizeModelAliases(value: unknown): ModelAlias[] {
  if (!Array.isArray(value)) return DEFAULT_MODEL_ALIASES.map(cloneAlias);

  const aliases: ModelAlias[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, 30)) {
    const alias = normalizeAlias(item);
    if (!alias || seen.has(alias.id) || isLegacyPrecreatedAlias(alias)) continue;
    seen.add(alias.id);
    aliases.push(alias);
  }

  const missingSystemAliases = DEFAULT_MODEL_ALIASES
    .filter((alias) => alias.system && !seen.has(alias.id))
    .map(cloneAlias);

  return [...missingSystemAliases, ...aliases];
}

export function parseModelAliases(value: unknown): ModelAlias[] {
  if (!Array.isArray(value)) {
    throw new Error("Model aliases must be an array");
  }
  const parsed = normalizeModelAliases(value);
  const submittedIds = value.map((item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? normalizeAliasId((item as Record<string, unknown>).id)
      : undefined,
  );
  if (submittedIds.some((id) => !id)) {
    throw new Error(
      "Each model alias needs a lowercase ID using letters, numbers, dots, underscores, or hyphens",
    );
  }
  if (new Set(submittedIds).size !== submittedIds.length) {
    throw new Error("Model alias IDs must be unique");
  }
  return parsed;
}

export function resolveModelAlias(
  aliases: ModelAlias[],
  requestedModel: string,
): ModelAlias | undefined {
  const id = requestedModel.trim().toLowerCase();
  return aliases.find((alias) => alias.enabled && alias.id === id);
}

export function effectiveAliasPolicy(
  routerPolicy: RoutingPolicy,
  alias: ModelAlias | undefined,
): RoutingPolicy {
  const strategy = alias && alias.routingStrategy !== "inherit"
    ? alias.routingStrategy
    : routerPolicy.strategy;
  const providerOrder = alias?.providerOrder.length
    ? alias.providerOrder
    : routerPolicy.providerOrder;
  return { strategy, providerOrder: [...providerOrder] };
}

export function mergeAliasRequirements(
  requirements: CapabilityRequirements,
  alias: ModelAlias | undefined,
): CapabilityRequirements {
  return {
    ...requirements,
    required: [...new Set([
      ...requirements.required,
      ...(alias?.requiredCapabilities ?? []),
    ])],
  };
}
