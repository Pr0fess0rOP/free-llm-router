import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocalNodeLimits, LocalNodeModel } from "../local-node-types.js";
import {
  deleteProtectedCredential,
  protectDeviceCredential,
  revealDeviceCredential,
  type ProtectedCredential,
} from "./credential-store.js";
import { normalizeOllamaBaseUrl } from "./ollama-client.js";

export interface LocalAgentConfig {
  nodeId: string;
  ownerAccountId: string;
  name: string;
  routerBaseUrl: string;
  verificationPublicKey: string;
  verificationKeyId: string;
  credential: ProtectedCredential;
  allowedModels: string[];
  models: LocalNodeModel[];
  limits: LocalNodeLimits;
  agentPort: number;
  ollamaBaseUrl: string;
  agentPid?: number;
  tunnelEndpoint?: string;
  ngrokPath?: string;
  cliVersion: string;
  lastHeartbeatAt?: string;
  lastKnownActiveRequests?: number;
}

export function localAgentConfigPath(): string {
  return path.resolve(
    process.env.FREE_LLM_LOCAL_NODE_CONFIG ?? ".freellm/local-node.json",
  );
}

export function normalizeRouterBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Router URL must be a valid HTTPS URL or a loopback development URL");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error("Router URL must be an HTTPS origin (HTTP is allowed only on loopback)");
  }
  return parsed.origin;
}

export async function saveLocalAgentConfig(
  config: LocalAgentConfig,
): Promise<void> {
  const target = localAgentConfigPath();
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function createLocalAgentConfig(params: {
  nodeId: string;
  ownerAccountId: string;
  name: string;
  routerBaseUrl: string;
  verificationPublicKey: string;
  verificationKeyId: string;
  deviceCredential: string;
  allowedModels: string[];
  models: LocalNodeModel[];
  limits: LocalNodeLimits;
  agentPort?: number;
  ollamaBaseUrl?: string;
  cliVersion: string;
  ngrokPath?: string;
}): Promise<LocalAgentConfig> {
  const config: LocalAgentConfig = {
    nodeId: params.nodeId,
    ownerAccountId: params.ownerAccountId,
    name: params.name,
    routerBaseUrl: normalizeRouterBaseUrl(params.routerBaseUrl),
    verificationPublicKey: params.verificationPublicKey,
    verificationKeyId: params.verificationKeyId,
    credential: await protectDeviceCredential(params.nodeId, params.deviceCredential),
    allowedModels: [...new Set(params.allowedModels)],
    models: params.models,
    limits: params.limits,
    agentPort: params.agentPort ?? 11_500,
    ollamaBaseUrl: normalizeOllamaBaseUrl(params.ollamaBaseUrl ?? "http://127.0.0.1:11434"),
    cliVersion: params.cliVersion,
    ...(params.ngrokPath ? { ngrokPath: params.ngrokPath } : {}),
  };
  await saveLocalAgentConfig(config);
  return config;
}

export async function loadLocalAgentConfig(): Promise<LocalAgentConfig | undefined> {
  try {
    const config = JSON.parse(await readFile(localAgentConfigPath(), "utf8")) as LocalAgentConfig;
    if (!config.nodeId || !config.ownerAccountId || !config.routerBaseUrl) {
      throw new Error("Invalid local node configuration");
    }
    config.routerBaseUrl = normalizeRouterBaseUrl(config.routerBaseUrl);
    config.ollamaBaseUrl = normalizeOllamaBaseUrl(config.ollamaBaseUrl);
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function localAgentCredential(config: LocalAgentConfig): Promise<string> {
  return revealDeviceCredential(config.credential);
}

export async function replaceLocalAgentCredential(
  config: LocalAgentConfig,
  credential: string,
): Promise<void> {
  await deleteProtectedCredential(config.credential);
  config.credential = await protectDeviceCredential(config.nodeId, credential);
  await saveLocalAgentConfig(config);
}

export async function deleteLocalAgentConfig(): Promise<void> {
  const config = await loadLocalAgentConfig();
  if (config) await deleteProtectedCredential(config.credential);
  await unlink(localAgentConfigPath()).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
