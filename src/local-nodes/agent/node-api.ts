import type { LocalNode } from "../local-node-types.js";
import {
  localAgentCredential,
  type LocalAgentConfig,
} from "./local-node-config.js";

export async function localNodeDeviceRequest<T>(
  config: LocalAgentConfig,
  path: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const credential = await localAgentCredential(config);
  const response = await fetcher(
    `${config.routerBaseUrl}/api/local-nodes/${encodeURIComponent(config.nodeId)}${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  const payload = await response.json().catch(() => ({})) as T & { error?: unknown };
  if (!response.ok) {
    const message = typeof payload.error === "string"
      ? payload.error
      : payload.error && typeof payload.error === "object" && "message" in payload.error
        ? String((payload.error as { message: unknown }).message)
        : `Router returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

export async function registerAgentEndpoint(
  config: LocalAgentConfig,
  endpoint: string,
): Promise<LocalNode> {
  return localNodeDeviceRequest<LocalNode>(config, "/endpoint", { endpoint });
}
