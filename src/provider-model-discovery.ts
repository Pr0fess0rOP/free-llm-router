import { normalizeProviderModelId } from "./provider-models.js";
import type { ProviderConfig } from "./types.js";

interface DiscoveredModel {
  id: string;
  name?: string;
  contextLength?: number;
}

export class ProviderModelDiscoveryError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export async function discoverProviderModels(
  provider: ProviderConfig,
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<DiscoveredModel[]> {
  const baseUrl = new URL(provider.baseUrl);
  const url = new URL(provider.modelListUrl ?? `${provider.baseUrl.replace(/\/+$/, "")}/models`);
  // Cross-origin catalog overrides are public endpoints.
  const authenticated = url.origin === baseUrl.origin;
  if (authenticated && !apiKey) {
    throw new ProviderModelDiscoveryError(400, "Save a provider API key to browse its models.");
  }

  const headers = new Headers({ accept: "application/json" });
  if (authenticated && apiKey) {
    for (const [name, value] of Object.entries(provider.headers ?? {})) {
      headers.set(name, value);
    }
    if (provider.id === "anthropic") {
      headers.set("x-api-key", apiKey);
      if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
      url.searchParams.set("limit", "100");
    } else {
      headers.set("authorization", `Bearer ${apiKey}`);
    }
  }

  const models = new Map<string, DiscoveredModel>();
  const cursors = new Set<string>();
  const signal = AbortSignal.timeout(15_000);
  for (let page = 0; page < 20; page += 1) {
    let response: Response;
    let payload: unknown;
    try {
      response = await fetcher(url, { headers, redirect: "error", signal });
      if (response.ok) payload = await response.json();
      else await response.body?.cancel();
    } catch {
      if (signal.aborted) {
        throw new ProviderModelDiscoveryError(504, "The provider model list timed out. Try again.");
      }
      throw new ProviderModelDiscoveryError(502, "Could not read the provider model list. Try again.");
    }

    if (!response.ok) {
      const status = response.status;
      if ([404, 405, 410, 501].includes(status)) {
        throw new ProviderModelDiscoveryError(502, "This provider did not expose a model list. You can enter a model ID manually.");
      }
      if (status === 401 || status === 403) {
        throw new ProviderModelDiscoveryError(502, "The provider denied access to its model list. Check the saved API key and its permissions.");
      }
      throw new ProviderModelDiscoveryError(502, `The provider model list request failed (HTTP ${status}).`);
    }

    const envelope = objectRecord(payload);
    const entries = Array.isArray(payload) ? payload : envelope?.data ?? envelope?.models;
    if (!Array.isArray(entries)) {
      throw new ProviderModelDiscoveryError(502, "The provider returned an unrecognized model list. You can enter a model ID manually.");
    }
    for (const entry of entries) {
      const record = objectRecord(entry);
      const modelId = record
        ? record.id ?? (provider.id === "cohere" ? record.name : undefined)
        : entry;
      const id = normalizeProviderModelId(modelId);
      if (!id || models.has(id)) continue;
      const displayName = record?.display_name ?? record?.name;
      const name = typeof displayName === "string" ? displayName.trim().slice(0, 240) : "";
      const contextLength = record?.context_length ?? record?.max_input_tokens;
      models.set(id, {
        id,
        ...(name && name !== id ? { name } : {}),
        ...(typeof contextLength === "number" && Number.isSafeInteger(contextLength) && contextLength > 0
          ? { contextLength }
          : {}),
      });
    }

    const pageToken = typeof envelope?.next_page_token === "string" ? envelope.next_page_token : "";
    if (!pageToken && envelope?.has_more !== true) {
      if (entries.length && !models.size) {
        throw new ProviderModelDiscoveryError(502, "The provider model list contained no usable model IDs. You can enter a model ID manually.");
      }
      return [...models.values()];
    }
    const cursor = pageToken || normalizeProviderModelId(envelope?.last_id);
    if (!cursor || cursors.has(cursor)) break;
    cursors.add(cursor);
    url.searchParams.set(pageToken ? "page_token" : "after_id", cursor);
  }
  throw new ProviderModelDiscoveryError(502, "The provider did not return a complete model list. You can enter a model ID manually.");
}
