import type { LocalNodeModelInventoryItem, LocalNodeRuntime } from "../local-node-types.js";
import type { LocalAgentConfig } from "./local-node-config.js";
import {
  discoverOllamaModels,
  inspectOllamaModelInventory,
  normalizeLocalRuntimeOrigin,
  ollamaVersion,
} from "./ollama-client.js";

type RuntimeConfig = Pick<LocalAgentConfig, "runtime" | "runtimeBaseUrl" | "ollamaBaseUrl">;

export function runtimeConnection(config: RuntimeConfig) {
  const runtime: LocalNodeRuntime = config.runtime ?? "ollama";
  const label = runtime === "lmstudio" ? "LM Studio" : "Ollama";
  const url = runtime === "lmstudio"
    ? config.runtimeBaseUrl ?? "http://127.0.0.1:1234"
    : config.ollamaBaseUrl ?? "http://127.0.0.1:11434";
  const token = runtime === "lmstudio" ? process.env.LMSTUDIO_API_TOKEN?.trim() : undefined;
  return {
    runtime,
    label,
    origin: normalizeLocalRuntimeOrigin(url, label),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
}

interface LMStudioModel {
  type?: string;
  key?: string;
  display_name?: string;
  loaded_instances?: Array<{ id?: string }>;
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
    reasoning?: { allowed_options?: string[] };
  };
}

function usableModelId(value: unknown): value is string {
  return typeof value === "string" && /^[^\s\x00-\x1f]{1,240}$/.test(value);
}

async function lmStudioInventory(connection: ReturnType<typeof runtimeConnection>, fetcher: typeof fetch) {
  const signal = AbortSignal.timeout(10_000);
  const load = async (path: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetcher(`${connection.origin}${path}`, {
        headers: { accept: "application/json", ...connection.headers },
        redirect: "error",
        signal,
      });
    } catch (error) {
      const problem = signal.aborted ? "Timed out reaching" : "Could not reach";
      throw new Error(
        `${problem} LM Studio at ${connection.origin}. Start the server in LM Studio's Developer tab and set --lmstudio-url if it uses a different port.`,
        { cause: error },
      );
    }
    if (response.ok) return response.json();
    await response.body?.cancel();
    if ([401, 403].includes(response.status)) {
      throw new Error("LM Studio denied access. Set LMSTUDIO_API_TOKEN in this terminal and try again.");
    }
    if (response.status === 404 && path === "/api/v1/models") {
      throw new Error("LM Studio's model catalog is unavailable. Use LM Studio 0.4 or newer.");
    }
    throw new Error(`LM Studio ${path} returned HTTP ${response.status}`);
  };
  const [native, compatible] = await Promise.all([load("/api/v1/models"), load("/v1/models")]);
  const models = (native as { models?: LMStudioModel[] } | null)?.models;
  const served = (compatible as { data?: Array<{ id?: string }> } | null)?.data;
  if (!Array.isArray(models) || !Array.isArray(served)) throw new Error("LM Studio returned an invalid model catalog");
  const available = new Set(served.map((model) => model?.id).filter(usableModelId));
  const inventory = new Map<string, LocalNodeModelInventoryItem>();
  for (const model of models) {
    if (model?.type !== "llm" || !usableModelId(model.key)) continue;
    const loadedIds = Array.isArray(model.loaded_instances)
      ? model.loaded_instances.map((instance) => instance?.id).filter(usableModelId)
      : [];
    const capabilities = {
      ...(typeof model.capabilities?.vision === "boolean"
        ? { vision: model.capabilities.vision ? "supported" : "unsupported" } : {}),
      ...(model.capabilities?.trained_for_tool_use === true ? { tools: "supported" } : {}),
      ...(Array.isArray(model.capabilities?.reasoning?.allowed_options) &&
        model.capabilities.reasoning.allowed_options.some((option) => ["on", "low", "medium", "high"].includes(option))
        ? { reasoning: "supported" } : {}),
    };
    for (const id of new Set([model.key, ...loadedIds])) {
      inventory.set(id, {
        id,
        installed: true,
        loaded: loadedIds.includes(id),
        available: available.has(id),
        ...(typeof model.display_name === "string" ? { displayName: model.display_name } : {}),
        capabilities,
      });
    }
  }
  return [...inventory.values()];
}

export async function discoverRuntimeModels(
  config: RuntimeConfig,
  knownIds: string[] = [],
  fetcher: typeof fetch = fetch,
): Promise<{ models: LocalNodeModelInventoryItem[]; ollamaVersion?: string }> {
  const connection = runtimeConnection(config);
  if (connection.runtime === "lmstudio") return { models: await lmStudioInventory(connection, fetcher) };
  const [models, version] = await Promise.all([
    discoverOllamaModels(connection.origin, fetcher),
    ollamaVersion(connection.origin, fetcher),
  ]);
  return {
    models: await inspectOllamaModelInventory(connection.origin, models, knownIds, fetcher),
    ollamaVersion: version,
  };
}
