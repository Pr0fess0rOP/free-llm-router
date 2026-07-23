/**
 * Canonical provider identities intentionally describe the provider only.
 * Model names belong in the provider model catalog, never in provider IDs.
 */
export const LEGACY_PROVIDER_ID_MAP: Readonly<Record<string, string>> = {
  "openrouter-qwen": "openrouter",
  "groq-llama": "groq",
  "nvidia-nemotron": "nvidia",
  "cerebras-gpt-oss": "cerebras",
  "github-models": "github",
};

export function normalizeProviderId(value: string): string {
  const id = value.trim();
  return LEGACY_PROVIDER_ID_MAP[id] ?? id;
}

/**
 * Rewrites legacy provider IDs embedded in human-readable persisted text.
 * Provider models are intentionally unaffected because the replacements are
 * limited to the exact former provider identifiers.
 */
export function normalizeProviderText(value: string): string {
  let normalized = value;
  for (const [legacyId, canonicalId] of Object.entries(LEGACY_PROVIDER_ID_MAP)) {
    normalized = normalized.replaceAll(legacyId, canonicalId);
  }
  return normalized;
}

export function normalizeProviderIds(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map(normalizeProviderId))];
}

/**
 * Canonical entries win when a stored object contains both a canonical ID and
 * its former model-coupled ID. Legacy entries fill only missing canonical keys.
 */
export function normalizeProviderRecord<T>(
  value: Record<string, T> | undefined,
): Record<string, T> {
  if (!value) return {};
  const result: Record<string, T> = {};

  for (const [providerId, item] of Object.entries(value)) {
    const canonicalId = normalizeProviderId(providerId);
    if (canonicalId === providerId) result[canonicalId] = item;
  }
  for (const [providerId, item] of Object.entries(value)) {
    const canonicalId = normalizeProviderId(providerId);
    if (!(canonicalId in result)) result[canonicalId] = item;
  }

  return result;
}
