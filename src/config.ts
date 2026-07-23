import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderConfig, ProviderModelOption, ProviderRuntime, RouterConfig } from "./types.js";
import { resolveEffectiveModelCapabilities } from "./provider-capabilities.js";
import { normalizeProviderId, normalizeProviderRecord } from "./provider-identities.js";

function isProviderConfig(value: unknown): value is ProviderConfig {
  if (!value || typeof value !== "object") return false;
  const provider = value as Record<string, unknown>;
  return (
    typeof provider.id === "string" &&
    typeof provider.baseUrl === "string" &&
    typeof provider.model === "string" &&
    (provider.apiKeyEnv === undefined || typeof provider.apiKeyEnv === "string") &&
    (provider.apiKey === undefined || typeof provider.apiKey === "string")
  );
}

export async function loadProviderConfigs(
  configPath = process.env.PROVIDERS_CONFIG ?? "providers.json",
): Promise<ProviderConfig[]> {
  const absolutePath = path.resolve(configPath);
  const raw = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<RouterConfig>;

  if (!Array.isArray(parsed.providers) || !parsed.providers.every(isProviderConfig)) {
    throw new Error(`Invalid provider configuration in ${absolutePath}`);
  }

  const ids = new Set<string>();
  const providers = parsed.providers.map((provider) => ({
    ...provider,
    id: normalizeProviderId(provider.id),
  }));
  for (const provider of providers) {
    if (ids.has(provider.id)) {
      throw new Error(`Duplicate provider id after canonicalization: ${provider.id}`);
    }
    ids.add(provider.id);
  }

  return providers;
}

export async function loadProviders(
  configPath = process.env.PROVIDERS_CONFIG ?? "providers.json",
  providerKeys: Record<string, string> = {},
  activeModels: Record<string, string> = {},
  activeModelOptions: Record<string, ProviderModelOption> = {},
): Promise<ProviderRuntime[]> {
  const providerConfigs = await loadProviderConfigs(configPath);
  const normalizedProviderKeys = normalizeProviderRecord(providerKeys);
  const normalizedActiveModels = normalizeProviderRecord(activeModels);
  const normalizedActiveModelOptions = normalizeProviderRecord(activeModelOptions);

  return providerConfigs
    .filter((provider) => provider.enabled !== false)
    .map((provider) => {
      const apiKeyValue =
        normalizedProviderKeys[provider.id] ??
        (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : provider.apiKey);

      const model = normalizedActiveModels[provider.id] ?? provider.model;
      const effective = resolveEffectiveModelCapabilities(
        provider,
        normalizedActiveModelOptions[provider.id] ?? { id: model },
      );
      return {
        ...provider,
        model,
        capabilities: effective.capabilities,
        capabilitySources: effective.sources,
        baseUrl: provider.baseUrl.replace(/\/+$/, ""),
        apiKeyValue,
        cooldownUntil: 0,
        failures: 0,
        circuitState: "closed" as const,
        circuitOpenUntil: 0,
        circuitFailureCount: 0,
        circuitOpenCount: 0,
        halfOpenProbeActive: false,
      };
    })
    .filter((provider) => {
      if (provider.apiKeyEnv && !provider.apiKeyValue) {
        console.warn(
          `Skipping ${provider.id}: environment variable ${provider.apiKeyEnv} is empty`,
        );
        return false;
      }
      return true;
    });
}
