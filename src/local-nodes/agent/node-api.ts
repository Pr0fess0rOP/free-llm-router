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
  const signal = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await fetcher(
      `${config.routerBaseUrl}/api/local-nodes/${encodeURIComponent(config.nodeId)}${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal,
      },
    );
  } catch (error) {
    const problem = signal.aborted ? "Timed out reaching" : "Could not reach";
    throw new Error(
      `${problem} the paired router at ${config.routerBaseUrl}. Make sure the router is running at that address and try again.`,
      { cause: error },
    );
  }
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
