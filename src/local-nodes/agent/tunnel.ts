import { spawn, type ChildProcess } from "node:child_process";
import type { LocalAgentConfig } from "./local-node-config.js";

export interface LocalTunnelHandle {
  endpoint: string;
  process?: ChildProcess;
  close(): Promise<void>;
}

export async function currentNgrokEndpoint(
  agentPort: number,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const response = await fetcher("http://127.0.0.1:4040/api/tunnels", {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as {
      tunnels?: Array<{ public_url?: unknown; proto?: unknown; config?: { addr?: unknown } }>;
    };
    return payload.tunnels?.find(
      (tunnel) =>
        tunnel.proto === "https" &&
        typeof tunnel.public_url === "string" &&
        typeof tunnel.config?.addr === "string" &&
        new RegExp(`(?:localhost|127\\.0\\.0\\.1):${agentPort}(?:/|$)`).test(tunnel.config.addr),
    )?.public_url as string | undefined;
  } catch {
    return undefined;
  }
}

async function waitForEndpoint(child: ChildProcess, agentPort: number): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`ngrok exited with code ${child.exitCode}`);
    const endpoint = await currentNgrokEndpoint(agentPort);
    if (endpoint) return endpoint;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for the ngrok HTTPS tunnel");
}

export async function startOrConnectNgrok(
  config: LocalAgentConfig,
  agentPort = config.agentPort,
): Promise<LocalTunnelHandle> {
  const existing = await currentNgrokEndpoint(agentPort);
  if (existing) return { endpoint: existing, close: async () => undefined };

  const executable = config.ngrokPath ?? process.env.NGROK_PATH ?? "ngrok";
  const args = ["http", `http://127.0.0.1:${agentPort}`, "--log=stdout"];
  const child = spawn(executable, args, {
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => { spawnError = error; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (spawnError) throw new Error(`Could not start ngrok: ${spawnError.message}`);
  let endpoint: string;
  try {
    endpoint = await waitForEndpoint(child, agentPort);
  } catch (error) {
    if (child.exitCode === null) child.kill();
    throw error;
  }
  return {
    endpoint,
    process: child,
    close: async () => {
      if (child.exitCode === null) child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once("exit", () => resolve());
        setTimeout(resolve, 2_000);
      });
    },
  };
}
