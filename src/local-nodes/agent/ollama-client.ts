export interface OllamaModelInfo {
  id: string;
  size?: number;
  modifiedAt?: string;
}

export function normalizeOllamaBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Ollama URL must be a valid loopback HTTP URL");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (
    parsed.protocol !== "http:" ||
    !loopback ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error("Ollama URL must use HTTP on localhost with no path or credentials");
  }
  return parsed.origin;
}

export async function ollamaVersion(
  baseUrl = "http://127.0.0.1:11434",
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const response = await fetcher(`${normalizeOllamaBaseUrl(baseUrl)}/api/version`, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  const payload = await response.json() as { version?: unknown };
  if (typeof payload.version !== "string") throw new Error("Ollama returned an invalid version");
  return payload.version;
}

export async function discoverOllamaModels(
  baseUrl = "http://127.0.0.1:11434",
  fetcher: typeof fetch = fetch,
): Promise<OllamaModelInfo[]> {
  const response = await fetcher(`${normalizeOllamaBaseUrl(baseUrl)}/api/tags`, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Ollama model discovery returned HTTP ${response.status}`);
  const payload = await response.json() as {
    models?: Array<{ name?: unknown; model?: unknown; size?: unknown; modified_at?: unknown }>;
  };
  if (!Array.isArray(payload.models)) throw new Error("Ollama returned an invalid model inventory");
  return payload.models.flatMap((model) => {
    const id = typeof model.name === "string"
      ? model.name
      : typeof model.model === "string" ? model.model : undefined;
    if (!id) return [];
    return [{
      id,
      ...(typeof model.size === "number" ? { size: model.size } : {}),
      ...(typeof model.modified_at === "string" ? { modifiedAt: model.modified_at } : {}),
    }];
  });
}
