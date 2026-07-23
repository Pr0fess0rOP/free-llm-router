import type {
  CapabilityMatch,
  CapabilityObservationSource,
  CapabilityRequirements,
  CapabilityRoutingSettings,
  CapabilitySupport,
  ModelCapabilityProfile,
  ProviderCapabilities,
  ProviderCapabilityName,
  ProviderConfig,
  ProviderModelOption,
} from "./types.js";

export const PROVIDER_CAPABILITY_NAMES: ProviderCapabilityName[] = [
  "streaming",
  "tools",
  "jsonMode",
  "structuredOutputs",
  "vision",
  "reasoning",
  "embeddings",
];

export const DEFAULT_CAPABILITY_ROUTING_SETTINGS: CapabilityRoutingSettings = {
  unknownMode: "flexible",
};

export function normalizeCapabilityRoutingSettings(
  value: unknown,
): CapabilityRoutingSettings {
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<CapabilityRoutingSettings>
    : {};
  return {
    unknownMode: candidate.unknownMode === "strict" ? "strict" : "flexible",
  };
}

const UNKNOWN_CAPABILITIES: ProviderCapabilities = {
  streaming: "unknown",
  tools: "unknown",
  jsonMode: "unknown",
  structuredOutputs: "unknown",
  vision: "unknown",
  reasoning: "unknown",
  embeddings: "unknown",
};

/**
 * Registry values are deliberately conservative. "unknown" means the router
 * may still try the provider, while "unsupported" is a hard incompatibility.
 * Provider config entries can override any value without changing code.
 */
const PROVIDER_CAPABILITY_REGISTRY: Record<string, Partial<ProviderCapabilities>> = {
  "openrouter": {
    streaming: "supported",
    tools: "supported",
    jsonMode: "supported",
    structuredOutputs: "unknown",
    vision: "unsupported",
    reasoning: "unsupported",
    embeddings: "unsupported",
    contextWindow: 262_144,
    verifiedAt: "2026-07-17",
    source: "provider-model-card",
  },
  "groq": {
    streaming: "supported",
    tools: "supported",
    jsonMode: "supported",
    structuredOutputs: "unknown",
    vision: "unsupported",
    reasoning: "unknown",
    embeddings: "unsupported",
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
    verifiedAt: "2026-07-17",
    source: "provider-model-card",
  },
  "nvidia": {
    streaming: "supported",
    tools: "supported",
    jsonMode: "unknown",
    structuredOutputs: "unknown",
    vision: "unsupported",
    reasoning: "supported",
    embeddings: "unsupported",
    contextWindow: 1_048_576,
    verifiedAt: "2026-07-17",
    source: "provider-model-card",
  },
  "cerebras": {
    streaming: "supported",
    tools: "supported",
    jsonMode: "supported",
    structuredOutputs: "unknown",
    vision: "unsupported",
    reasoning: "supported",
    embeddings: "unsupported",
    contextWindow: 131_072,
    verifiedAt: "2026-07-17",
    source: "provider-docs",
  },
  mistral: {
    streaming: "supported",
    tools: "supported",
    jsonMode: "supported",
    structuredOutputs: "supported",
    vision: "supported",
    reasoning: "supported",
    embeddings: "unsupported",
    contextWindow: 262_144,
    verifiedAt: "2026-07-17",
    source: "provider-model-card",
  },
  aion: {
    streaming: "supported",
    tools: "unknown",
    jsonMode: "unknown",
    structuredOutputs: "unknown",
    vision: "unsupported",
    reasoning: "unknown",
    embeddings: "unsupported",
  },
  zai: {
    streaming: "supported",
    tools: "supported",
    jsonMode: "unknown",
    structuredOutputs: "unknown",
    vision: "unsupported",
    reasoning: "supported",
    embeddings: "unsupported",
    contextWindow: 131_072,
  },
  "github": {
    streaming: "supported",
    tools: "supported",
    jsonMode: "supported",
    structuredOutputs: "supported",
    vision: "supported",
    reasoning: "unsupported",
    embeddings: "unsupported",
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
  },
  "hugging-face": {
    streaming: "supported",
    tools: "unknown",
    jsonMode: "unknown",
    structuredOutputs: "unknown",
    vision: "unsupported",
    reasoning: "unsupported",
    embeddings: "unsupported",
    contextWindow: 131_072,
  },
  "kilo-code": {
    streaming: "supported",
    tools: "unknown",
    jsonMode: "unknown",
    structuredOutputs: "unknown",
    vision: "unknown",
    reasoning: "unknown",
    embeddings: "unsupported",
    source: "dynamic-model-route",
  },
  modelscope: {
    streaming: "supported",
    tools: "supported",
    jsonMode: "unknown",
    structuredOutputs: "unknown",
    vision: "unsupported",
    reasoning: "supported",
    embeddings: "unsupported",
    contextWindow: 262_144,
  },
  sambanova: {
    streaming: "supported",
    tools: "unknown",
    jsonMode: "unknown",
    structuredOutputs: "unknown",
    vision: "unsupported",
    reasoning: "unknown",
    embeddings: "unsupported",
    contextWindow: 131_072,
  },
  siliconflow: {
    streaming: "supported",
    tools: "supported",
    jsonMode: "unknown",
    structuredOutputs: "unknown",
    vision: "unsupported",
    reasoning: "supported",
    embeddings: "unsupported",
    contextWindow: 40_960,
  },
  together: {
    streaming: "supported", tools: "supported", jsonMode: "unknown",
    structuredOutputs: "unknown", vision: "unknown", reasoning: "unknown",
    embeddings: "supported", verifiedAt: "2026-07-21", source: "provider-docs",
  },
  fireworks: {
    streaming: "supported", tools: "supported", jsonMode: "supported",
    structuredOutputs: "supported", vision: "unknown", reasoning: "supported",
    embeddings: "supported", verifiedAt: "2026-07-21", source: "provider-docs",
  },
  deepinfra: {
    streaming: "supported", tools: "unknown", jsonMode: "unknown",
    structuredOutputs: "unknown", vision: "unknown", reasoning: "unknown",
    embeddings: "supported", verifiedAt: "2026-07-21", source: "provider-docs",
  },
  gemini: {
    streaming: "supported", tools: "supported", jsonMode: "supported",
    structuredOutputs: "supported", vision: "supported", reasoning: "supported",
    embeddings: "unknown", verifiedAt: "2026-07-21", source: "provider-docs",
  },
  xai: {
    streaming: "supported", tools: "supported", jsonMode: "supported",
    structuredOutputs: "supported", vision: "supported", reasoning: "supported",
    embeddings: "unsupported", verifiedAt: "2026-07-21", source: "provider-docs",
  },
  novita: {
    streaming: "supported", tools: "supported", jsonMode: "unknown",
    structuredOutputs: "unknown", vision: "unknown", reasoning: "supported",
    embeddings: "supported", verifiedAt: "2026-07-21", source: "provider-docs",
  },
  baseten: {
    streaming: "supported", tools: "supported", jsonMode: "supported",
    structuredOutputs: "supported", vision: "unknown", reasoning: "unknown",
    embeddings: "unknown", verifiedAt: "2026-07-21", source: "provider-docs",
  },
  cohere: {
    streaming: "supported", tools: "supported", jsonMode: "supported",
    structuredOutputs: "supported", vision: "unknown", reasoning: "unknown",
    embeddings: "supported", verifiedAt: "2026-07-21", source: "provider-docs",
  },
  anthropic: {
    streaming: "supported", tools: "supported", jsonMode: "unknown",
    structuredOutputs: "unknown", vision: "supported", reasoning: "supported",
    embeddings: "unsupported", verifiedAt: "2026-07-21", source: "provider-docs",
    notes: "OpenAI-compatible response_format is limited; use model probes or overrides.",
  },
  openai: {
    streaming: "supported", tools: "supported", jsonMode: "supported",
    structuredOutputs: "supported", vision: "supported", reasoning: "supported",
    embeddings: "supported", verifiedAt: "2026-07-21", source: "provider-docs",
  },
  deepseek: {
    streaming: "supported", tools: "supported", jsonMode: "supported",
    structuredOutputs: "unknown", vision: "unsupported", reasoning: "supported",
    embeddings: "unsupported", verifiedAt: "2026-07-21", source: "provider-docs",
  },
  perplexity: {
    streaming: "supported", tools: "unknown", jsonMode: "unknown",
    structuredOutputs: "unknown", vision: "unknown", reasoning: "supported",
    embeddings: "unsupported", verifiedAt: "2026-07-21", source: "provider-docs",
  },
  friendli: {
    streaming: "supported", tools: "supported", jsonMode: "supported",
    structuredOutputs: "supported", vision: "unknown", reasoning: "supported",
    embeddings: "unknown", verifiedAt: "2026-07-21", source: "provider-docs",
  },

};

const MODEL_CAPABILITY_REGISTRY: Record<string, ModelCapabilityProfile> = {};

export interface EffectiveModelCapabilities {
  capabilities: ProviderCapabilities;
  sources: Partial<Record<ProviderCapabilityName, CapabilityObservationSource>>;
}

export function resolveEffectiveModelCapabilities(
  provider: Pick<ProviderConfig, "id" | "capabilities">,
  model?: Pick<ProviderModelOption, "id" | "capabilities">,
): EffectiveModelCapabilities {
  const providerCapabilities = resolveProviderCapabilities(provider);
  const known = model?.id
    ? MODEL_CAPABILITY_REGISTRY[`${provider.id}:${model.id}`] ?? MODEL_CAPABILITY_REGISTRY[model.id]
    : undefined;
  const output: ProviderCapabilities = { ...providerCapabilities };
  const sources: Partial<Record<ProviderCapabilityName, CapabilityObservationSource>> = {};

  for (const name of PROVIDER_CAPABILITY_NAMES) {
    const override = model?.capabilities?.[name];
    const registered = known?.[name];
    if (override && typeof override === "object" && "value" in override) {
      output[name] = override.value;
      sources[name] = override.source;
    } else if (registered && typeof registered === "object" && "value" in registered) {
      output[name] = registered.value;
      sources[name] = "catalog";
    } else {
      sources[name] = "provider";
    }
  }

  const contextWindow = model?.capabilities?.contextWindow ?? known?.contextWindow;
  const maxOutputTokens = model?.capabilities?.maxOutputTokens ?? known?.maxOutputTokens;
  if (contextWindow) output.contextWindow = contextWindow;
  if (maxOutputTokens) output.maxOutputTokens = maxOutputTokens;
  if (model?.id) output.source = `model:${model.id}`;
  return { capabilities: output, sources };
}

function isCapabilitySupport(value: unknown): value is CapabilitySupport {
  return value === "supported" || value === "unsupported" || value === "unknown";
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

export function resolveProviderCapabilities(
  provider: Pick<ProviderConfig, "id" | "capabilities">,
): ProviderCapabilities {
  const registered = PROVIDER_CAPABILITY_REGISTRY[provider.id] ?? {};
  const overrides = provider.capabilities ?? {};
  const merged = { ...UNKNOWN_CAPABILITIES, ...registered, ...overrides };

  const output: ProviderCapabilities = {
    streaming: isCapabilitySupport(merged.streaming) ? merged.streaming : "unknown",
    tools: isCapabilitySupport(merged.tools) ? merged.tools : "unknown",
    jsonMode: isCapabilitySupport(merged.jsonMode) ? merged.jsonMode : "unknown",
    structuredOutputs: isCapabilitySupport(merged.structuredOutputs)
      ? merged.structuredOutputs
      : "unknown",
    vision: isCapabilitySupport(merged.vision) ? merged.vision : "unknown",
    reasoning: isCapabilitySupport(merged.reasoning) ? merged.reasoning : "unknown",
    embeddings: isCapabilitySupport(merged.embeddings) ? merged.embeddings : "unknown",
  };

  const contextWindow = positiveInteger(merged.contextWindow);
  const maxOutputTokens = positiveInteger(merged.maxOutputTokens);
  if (contextWindow) output.contextWindow = contextWindow;
  if (maxOutputTokens) output.maxOutputTokens = maxOutputTokens;
  if (typeof merged.verifiedAt === "string") output.verifiedAt = merged.verifiedAt;
  if (typeof merged.source === "string") output.source = merged.source;
  if (typeof merged.notes === "string") output.notes = merged.notes;

  return output;
}

function hasImageContent(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return false;
  }
  if (Array.isArray(value)) return value.some((item) => hasImageContent(item, depth + 1));
  if (typeof value !== "object") return false;

  const object = value as Record<string, unknown>;
  const type = typeof object.type === "string" ? object.type.toLowerCase() : "";
  if (["image", "image_url", "input_image"].includes(type)) return true;
  if (typeof object.image_url === "string" || typeof object.image_url === "object") return true;
  if (typeof object.source === "object" && type === "image") return true;

  return Object.values(object).some((item) => hasImageContent(item, depth + 1));
}

function hasTools(body: Record<string, unknown>): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

function responseFormatType(body: Record<string, unknown>): string | undefined {
  const responseFormat = body.response_format;
  if (responseFormat && typeof responseFormat === "object" && !Array.isArray(responseFormat)) {
    const type = (responseFormat as Record<string, unknown>).type;
    if (typeof type === "string") return type;
  }

  const text = body.text;
  if (text && typeof text === "object" && !Array.isArray(text)) {
    const format = (text as Record<string, unknown>).format;
    if (format && typeof format === "object" && !Array.isArray(format)) {
      const type = (format as Record<string, unknown>).type;
      if (typeof type === "string") return type;
    }
  }

  const outputConfig = body.output_config;
  if (outputConfig && typeof outputConfig === "object" && !Array.isArray(outputConfig)) {
    const format = (outputConfig as Record<string, unknown>).format;
    if (format && typeof format === "object" && !Array.isArray(format)) {
      const type = (format as Record<string, unknown>).type;
      if (typeof type === "string") return type;
    }
  }

  return undefined;
}

export function detectCapabilityRequirements(
  body: Record<string, unknown>,
): CapabilityRequirements {
  const required = new Set<ProviderCapabilityName>();
  if (body.stream === true) required.add("streaming");
  if (hasTools(body)) required.add("tools");
  if (hasImageContent(body.messages) || hasImageContent(body.input)) required.add("vision");

  const formatType = responseFormatType(body);
  if (formatType === "json_object") required.add("jsonMode");
  if (formatType === "json_schema") required.add("structuredOutputs");

  if (
    (body.reasoning && typeof body.reasoning === "object")
    || typeof body.reasoning_effort === "string"
    || (body.thinking && typeof body.thinking === "object")
  ) {
    required.add("reasoning");
  }

  return { required: [...required] };
}

export function matchProviderCapabilities(
  capabilities: ProviderCapabilities,
  requirements: CapabilityRequirements,
  unknownMode: "flexible" | "strict" = "flexible",
): CapabilityMatch {
  const unsupported: Array<ProviderCapabilityName | "contextWindow"> = [];
  const unknown: ProviderCapabilityName[] = [];
  const supported: ProviderCapabilityName[] = [];

  for (const capability of requirements.required) {
    const status = capabilities[capability];
    if (status === "unsupported") unsupported.push(capability);
    else if (status === "unknown") unknown.push(capability);
    else supported.push(capability);
  }

  if (
    requirements.minimumContextTokens
    && capabilities.contextWindow
    && capabilities.contextWindow < requirements.minimumContextTokens
  ) {
    unsupported.push("contextWindow");
  }

  return {
    level: unsupported.length > 0 || (unknownMode === "strict" && unknown.length > 0)
      ? "incompatible"
      : unknown.length > 0
        ? "partial"
        : "full",
    supported,
    unknown,
    unsupported,
  };
}

export function capabilityLabel(capability: ProviderCapabilityName | "contextWindow"): string {
  const labels: Record<ProviderCapabilityName | "contextWindow", string> = {
    streaming: "Streaming",
    tools: "Tools",
    jsonMode: "JSON mode",
    structuredOutputs: "Structured output",
    vision: "Vision",
    reasoning: "Reasoning",
    embeddings: "Embeddings",
    contextWindow: "Context window",
  };
  return labels[capability];
}
