import type {
  CapabilityMatch,
  CapabilityObservationSource,
  CapabilityRequirements,
  CapabilityRoutingSettings,
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

export interface EffectiveModelCapabilities {
  capabilities: ProviderCapabilities;
  sources: Partial<Record<ProviderCapabilityName, CapabilityObservationSource>>;
}

export function resolveEffectiveModelCapabilities(
  provider: Pick<ProviderConfig, "id" | "capabilities">,
  model?: Pick<ProviderModelOption, "id" | "capabilities">,
): EffectiveModelCapabilities {
  const providerCapabilities = resolveProviderCapabilities(provider);
  const output: ProviderCapabilities = { ...providerCapabilities };
  const sources: Partial<Record<ProviderCapabilityName, CapabilityObservationSource>> = {};

  for (const name of PROVIDER_CAPABILITY_NAMES) {
    const override = model?.capabilities?.[name];
    if (override && override.source !== "catalog" && override.source !== "provider") {
      output[name] = override.value;
      sources[name] = override.source;
    }
  }

  const contextWindow = model?.capabilities?.contextWindow;
  const maxOutputTokens = model?.capabilities?.maxOutputTokens;
  if (contextWindow) output.contextWindow = contextWindow;
  if (maxOutputTokens) output.maxOutputTokens = maxOutputTokens;
  if (model?.id) output.source = `model:${model.id}`;
  return { capabilities: output, sources };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

export function resolveProviderCapabilities(
  provider: Pick<ProviderConfig, "id" | "capabilities">,
): ProviderCapabilities {
  const output = { ...UNKNOWN_CAPABILITIES };
  const contextWindow = positiveInteger(provider.capabilities?.contextWindow);
  const maxOutputTokens = positiveInteger(provider.capabilities?.maxOutputTokens);
  if (contextWindow) output.contextWindow = contextWindow;
  if (maxOutputTokens) output.maxOutputTokens = maxOutputTokens;
  if (typeof provider.capabilities?.notes === "string") output.notes = provider.capabilities.notes;

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
