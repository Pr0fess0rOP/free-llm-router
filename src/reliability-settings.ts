import type {
  ModelAlias,
  ReliabilityOverrides,
  ReliabilitySettings,
} from "./types.js";
import { normalizeProviderId } from "./provider-identities.js";

export const DEFAULT_RELIABILITY_SETTINGS: ReliabilitySettings = {
  providerTimeoutMs: 30_000,
  totalRequestTimeoutMs: 90_000,
  maxProviderAttempts: 3,
  initialBackoffMs: 250,
  maxBackoffMs: 3_000,
  backoffMultiplier: 2,
  useJitter: true,
  retryStatusCodes: [408, 409, 425, 429, 500, 502, 503, 504],
  retryNetworkErrors: true,
  retryMalformedResponses: true,
  streamingConnectionTimeoutMs: 30_000,
  halfOpenProbeTimeoutMs: 10_000,
  providerTimeoutOverrides: {},
};

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = finiteNumber(value);
  if (parsed === undefined) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = finiteNumber(value);
  if (parsed === undefined) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeRetryStatusCodes(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return [...fallback];
  const values = [...new Set(value
    .filter((item): item is number => typeof item === "number" && Number.isInteger(item))
    .filter((item) => item >= 400 && item <= 599))]
    .slice(0, 40)
    .sort((left, right) => left - right);
  return values;
}

function normalizeProviderTimeoutOverrides(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, number> = {};
  for (const [providerId, timeout] of Object.entries(value).slice(0, 100)) {
    const id = normalizeProviderId(providerId);
    if (!id) continue;
    const normalized = finiteNumber(timeout);
    if (normalized === undefined || normalized <= 0) continue;
    output[id] = boundedInteger(normalized, 30_000, 1_000, 300_000);
  }
  return output;
}

export function normalizeReliabilitySettings(value: unknown): ReliabilitySettings {
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<ReliabilitySettings>
    : {};

  const initialBackoffMs = boundedInteger(
    candidate.initialBackoffMs,
    DEFAULT_RELIABILITY_SETTINGS.initialBackoffMs,
    0,
    30_000,
  );
  const maxBackoffMs = boundedInteger(
    candidate.maxBackoffMs,
    DEFAULT_RELIABILITY_SETTINGS.maxBackoffMs,
    initialBackoffMs,
    60_000,
  );

  return {
    providerTimeoutMs: boundedInteger(
      candidate.providerTimeoutMs,
      DEFAULT_RELIABILITY_SETTINGS.providerTimeoutMs,
      1_000,
      300_000,
    ),
    totalRequestTimeoutMs: boundedInteger(
      candidate.totalRequestTimeoutMs,
      DEFAULT_RELIABILITY_SETTINGS.totalRequestTimeoutMs,
      1_000,
      600_000,
    ),
    maxProviderAttempts: boundedInteger(
      candidate.maxProviderAttempts,
      DEFAULT_RELIABILITY_SETTINGS.maxProviderAttempts,
      1,
      20,
    ),
    initialBackoffMs,
    maxBackoffMs,
    backoffMultiplier: boundedNumber(
      candidate.backoffMultiplier,
      DEFAULT_RELIABILITY_SETTINGS.backoffMultiplier,
      1,
      5,
    ),
    useJitter: typeof candidate.useJitter === "boolean"
      ? candidate.useJitter
      : DEFAULT_RELIABILITY_SETTINGS.useJitter,
    retryStatusCodes: normalizeRetryStatusCodes(
      candidate.retryStatusCodes,
      DEFAULT_RELIABILITY_SETTINGS.retryStatusCodes,
    ),
    retryNetworkErrors: typeof candidate.retryNetworkErrors === "boolean"
      ? candidate.retryNetworkErrors
      : DEFAULT_RELIABILITY_SETTINGS.retryNetworkErrors,
    retryMalformedResponses: typeof candidate.retryMalformedResponses === "boolean"
      ? candidate.retryMalformedResponses
      : DEFAULT_RELIABILITY_SETTINGS.retryMalformedResponses,
    streamingConnectionTimeoutMs: boundedInteger(
      candidate.streamingConnectionTimeoutMs,
      DEFAULT_RELIABILITY_SETTINGS.streamingConnectionTimeoutMs,
      1_000,
      300_000,
    ),
    halfOpenProbeTimeoutMs: boundedInteger(
      candidate.halfOpenProbeTimeoutMs,
      DEFAULT_RELIABILITY_SETTINGS.halfOpenProbeTimeoutMs,
      1_000,
      60_000,
    ),
    providerTimeoutOverrides: normalizeProviderTimeoutOverrides(
      candidate.providerTimeoutOverrides,
    ),
  };
}

export function normalizeReliabilityOverrides(value: unknown): ReliabilityOverrides | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ReliabilitySettings>;
  const normalized = normalizeReliabilitySettings(candidate);
  const output: ReliabilityOverrides = {};

  const numericKeys: Array<keyof Pick<ReliabilitySettings,
    | "providerTimeoutMs"
    | "totalRequestTimeoutMs"
    | "maxProviderAttempts"
    | "initialBackoffMs"
    | "maxBackoffMs"
    | "backoffMultiplier"
    | "streamingConnectionTimeoutMs"
    | "halfOpenProbeTimeoutMs"
  >> = [
    "providerTimeoutMs",
    "totalRequestTimeoutMs",
    "maxProviderAttempts",
    "initialBackoffMs",
    "maxBackoffMs",
    "backoffMultiplier",
    "streamingConnectionTimeoutMs",
    "halfOpenProbeTimeoutMs",
  ];

  for (const key of numericKeys) {
    if (candidate[key] !== undefined) {
      (output as Record<string, unknown>)[key] = normalized[key];
    }
  }

  for (const key of ["useJitter", "retryNetworkErrors", "retryMalformedResponses"] as const) {
    if (typeof candidate[key] === "boolean") output[key] = candidate[key];
  }
  if (candidate.retryStatusCodes !== undefined) {
    output.retryStatusCodes = normalized.retryStatusCodes;
  }
  if (candidate.providerTimeoutOverrides !== undefined) {
    output.providerTimeoutOverrides = normalized.providerTimeoutOverrides;
  }

  return Object.keys(output).length ? output : undefined;
}

export function effectiveReliabilitySettings(
  routerSettings: unknown,
  alias?: Pick<ModelAlias, "reliabilityOverrides">,
): ReliabilitySettings {
  const base = normalizeReliabilitySettings(routerSettings);
  const overrides = normalizeReliabilityOverrides(alias?.reliabilityOverrides);
  if (!overrides) return base;
  return normalizeReliabilitySettings({
    ...base,
    ...overrides,
    providerTimeoutOverrides: {
      ...base.providerTimeoutOverrides,
      ...(overrides.providerTimeoutOverrides ?? {}),
    },
  });
}

export function parseReliabilitySettings(value: unknown): ReliabilitySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Reliability settings must be an object");
  }
  return normalizeReliabilitySettings(value);
}
