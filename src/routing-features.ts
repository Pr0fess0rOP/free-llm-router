import type { RoutingFeatureSettings } from "./types.js";

export const DEFAULT_ROUTING_FEATURE_SETTINGS: RoutingFeatureSettings = {
  aliasPolicyOverrides: true,
  capabilityMatching: true,
  quotaProtection: true,
  rateLimitCooldowns: true,
  circuitBreaker: true,
  automaticFailover: true,
  localLlmRouting: true,
  capabilityLearning: true,
};

export function normalizeRoutingFeatureSettings(
  value: unknown,
): RoutingFeatureSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_ROUTING_FEATURE_SETTINGS };
  }

  const candidate = value as Partial<RoutingFeatureSettings>;
  return Object.fromEntries(
    Object.entries(DEFAULT_ROUTING_FEATURE_SETTINGS).map(([key, fallback]) => [
      key,
      candidate[key as keyof RoutingFeatureSettings] === undefined
        ? fallback
        : candidate[key as keyof RoutingFeatureSettings] === true,
    ]),
  ) as unknown as RoutingFeatureSettings;
}

export function parseRoutingFeatureSettings(
  value: unknown,
): RoutingFeatureSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Routing feature settings must be an object");
  }
  return normalizeRoutingFeatureSettings(value);
}
