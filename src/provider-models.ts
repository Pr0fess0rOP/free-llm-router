import type {
  ProviderAttemptMetric,
  ProviderConfig,
  CapabilityObservationSource,
  CapabilitySupport,
  ModelCapabilityProfile,
  ModelCapabilityState,
  ProviderCapabilityName,
  ProviderModelCatalog,
  ProviderModelOption,
  ProviderModelStatus,
} from "./types.js";
import { PROVIDER_CAPABILITY_NAMES } from "./provider-capabilities.js";
import { normalizeProviderId } from "./provider-identities.js";

const MODEL_ID_MAX_LENGTH = 240;

const CAPABILITY_SOURCES = new Set<CapabilityObservationSource>([
  "user", "probe", "runtime", "catalog", "provider",
]);

function capabilitySupport(value: unknown): CapabilitySupport | undefined {
  return value === "supported" || value === "unsupported" || value === "unknown"
    ? value
    : undefined;
}

function capabilitySource(value: unknown): CapabilityObservationSource | undefined {
  return CAPABILITY_SOURCES.has(value as CapabilityObservationSource)
    ? value as CapabilityObservationSource
    : undefined;
}

function normalizeCapabilityState(value: unknown): ModelCapabilityState | undefined {
  if (typeof value === "string") {
    const support = capabilitySupport(value);
    return support ? { value: support, source: "user" } : undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ModelCapabilityState>;
  const support = capabilitySupport(candidate.value);
  const source = capabilitySource(candidate.source);
  if (!support || !source) return undefined;
  const lastVerifiedAt = typeof candidate.lastVerifiedAt === "string"
    && !Number.isNaN(Date.parse(candidate.lastVerifiedAt))
    ? candidate.lastVerifiedAt
    : undefined;
  const evidenceCandidate = candidate.evidence;
  const evidence = evidenceCandidate && typeof evidenceCandidate === "object"
    && !Array.isArray(evidenceCandidate)
    && typeof evidenceCandidate.observedAt === "string"
    && !Number.isNaN(Date.parse(evidenceCandidate.observedAt))
    ? {
        observedAt: evidenceCandidate.observedAt,
        ...(Number.isInteger(Number(evidenceCandidate.status))
          ? { status: Number(evidenceCandidate.status) } : {}),
        ...(typeof evidenceCandidate.message === "string" && evidenceCandidate.message.trim()
          ? { message: evidenceCandidate.message.trim().slice(0, 500) } : {}),
        ...(typeof evidenceCandidate.requestId === "string" && evidenceCandidate.requestId.trim()
          ? { requestId: evidenceCandidate.requestId.trim().slice(0, 160) } : {}),
      }
    : undefined;
  return {
    value: support,
    source,
    ...(lastVerifiedAt ? { lastVerifiedAt } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

export function normalizeModelCapabilityProfile(value: unknown): ModelCapabilityProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const profile: ModelCapabilityProfile = {};
  for (const name of PROVIDER_CAPABILITY_NAMES) {
    const state = normalizeCapabilityState(candidate[name]);
    if (state) profile[name] = state;
  }
  for (const name of ["contextWindow", "maxOutputTokens"] as const) {
    const numeric = Number(candidate[name]);
    if (Number.isInteger(numeric) && numeric > 0) profile[name] = numeric;
  }
  return Object.keys(profile).length ? profile : undefined;
}

export function normalizeProviderModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!id || id.length > MODEL_ID_MAX_LENGTH || /\s|[\u0000-\u001f\u007f]/.test(id)) {
    return undefined;
  }
  return id;
}

function normalizeStatus(value: unknown): ProviderModelStatus {
  return ["unknown", "healthy", "unavailable", "unauthorized", "rate-limited", "error"].includes(String(value))
    ? value as ProviderModelStatus
    : "unknown";
}

function normalizeOption(value: unknown): ProviderModelOption | undefined {
  if (typeof value === "string") {
    const id = normalizeProviderModelId(value);
    return id ? { id, status: "unknown" } : undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ProviderModelOption>;
  const id = normalizeProviderModelId(candidate.id);
  if (!id) return undefined;
  const lastStatus = Number(candidate.lastStatus);
  const lastError = typeof candidate.lastError === "string"
    ? candidate.lastError.trim().slice(0, 500)
    : undefined;
  const lastCheckedAt = typeof candidate.lastCheckedAt === "string" && !Number.isNaN(Date.parse(candidate.lastCheckedAt))
    ? candidate.lastCheckedAt
    : undefined;
  const capabilities = normalizeModelCapabilityProfile(candidate.capabilities);
  return {
    id,
    status: normalizeStatus(candidate.status),
    ...(Number.isInteger(lastStatus) && lastStatus >= 100 && lastStatus <= 599 ? { lastStatus } : {}),
    ...(lastError ? { lastError } : {}),
    ...(lastCheckedAt ? { lastCheckedAt } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

export function normalizeProviderModelCatalog(
  value: unknown,
  fallbackModel?: string,
): ProviderModelCatalog | undefined {
  const fallback = normalizeProviderModelId(fallbackModel);
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<ProviderModelCatalog>
    : undefined;
  const models: ProviderModelOption[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(candidate?.models) ? candidate.models : []) {
    const option = normalizeOption(raw);
    if (!option || seen.has(option.id)) continue;
    seen.add(option.id);
    models.push(option);
  }
  const requestedActive = normalizeProviderModelId(candidate?.activeModelId);
  if (requestedActive && !seen.has(requestedActive)) {
    models.push({ id: requestedActive, status: "unknown" });
    seen.add(requestedActive);
  }
  if (fallback && models.length === 0) {
    models.push({ id: fallback, status: "unknown" });
    seen.add(fallback);
  }
  if (models.length === 0) return undefined;
  const activeModelId = requestedActive && seen.has(requestedActive)
    ? requestedActive
    : fallback && seen.has(fallback)
      ? fallback
      : models[0]!.id;
  return { activeModelId, models };
}

export function normalizeProviderModelCatalogMap(
  value: unknown,
  providers: ProviderConfig[] = [],
): Record<string, ProviderModelCatalog> {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const result: Record<string, ProviderModelCatalog> = {};
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  for (const [providerId, raw] of Object.entries(source)) {
    const canonicalId = normalizeProviderId(providerId);
    const catalog = normalizeProviderModelCatalog(raw, providerById.get(canonicalId)?.model);
    if (catalog && (!result[canonicalId] || canonicalId === providerId)) result[canonicalId] = catalog;
  }
  for (const provider of providers) {
    if (!result[provider.id]) {
      const catalog = normalizeProviderModelCatalog(undefined, provider.model);
      if (catalog) result[provider.id] = catalog;
    }
  }
  return result;
}

export function parseProviderModelCatalog(value: unknown): ProviderModelCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider model catalog must be an object");
  }
  const candidate = value as Partial<ProviderModelCatalog>;
  if (!Array.isArray(candidate.models) || candidate.models.length === 0) {
    throw new Error("A provider must have at least one saved model");
  }
  const submittedIds = candidate.models.map((item) =>
    normalizeProviderModelId(typeof item === "string" ? item : item?.id),
  );
  if (submittedIds.some((id) => !id)) throw new Error("Model IDs cannot contain spaces and must be 240 characters or fewer");
  if (new Set(submittedIds).size !== submittedIds.length) throw new Error("Model IDs must be unique for a provider");
  const active = normalizeProviderModelId(candidate.activeModelId);
  if (!active || !submittedIds.includes(active)) {
    throw new Error("Select one saved model as active");
  }
  const normalized = normalizeProviderModelCatalog(candidate);
  if (!normalized) throw new Error("Enter at least one valid model ID");
  return { ...normalized, activeModelId: active };
}

export function statusFromAttempt(attempt: ProviderAttemptMetric): ProviderModelStatus {
  if (attempt.success) return "healthy";
  if (attempt.status === 401 || attempt.status === 403) return "unauthorized";
  if (attempt.status === 404) return "unavailable";
  if (attempt.status === 429) return "rate-limited";
  return "error";
}

export function statusFromHttpStatus(status: number): ProviderModelStatus {
  if (status >= 200 && status < 300) return "healthy";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "unavailable";
  if (status === 429) return "rate-limited";
  return "error";
}
