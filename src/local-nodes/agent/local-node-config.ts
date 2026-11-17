import { constants } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isLocalNodeRuntime, type LocalNodeLimits, type LocalNodeModel, type LocalNodeRuntime } from "../local-node-types.js";
import {
  deleteProtectedCredential,
  protectDeviceCredential,
  revealDeviceCredential,
  type ProtectedCredential,
} from "./credential-store.js";
import { normalizeLocalRuntimeOrigin, normalizeOllamaBaseUrl } from "./ollama-client.js";

export interface LocalAgentConfig {
  configFile?: string;
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
  runtime?: LocalNodeRuntime;
  runtimeBaseUrl?: string;
  ollamaBaseUrl?: string;
  agentPid?: number;
  tunnelEndpoint?: string;
  ngrokPath?: string;
  cliVersion: string;
  lastHeartbeatAt?: string;
  lastKnownActiveRequests?: number;
}

export function localAgentConfigPath(): string {
  if (process.env.FREE_LLM_LOCAL_NODE_CONFIG) {
    return path.resolve(process.env.FREE_LLM_LOCAL_NODE_CONFIG);
  }
  return path.join(os.homedir(), ".freellm", "local-node.json");
}

export function runtimeAgentConfigPath(runtime: LocalNodeRuntime): string {
  return path.join(path.dirname(localAgentConfigPath()), runtime, "local-node.json");
}

export function legacyLocalAgentConfigPath(): string {
  return path.resolve(".freellm", "local-node.json");
}

export async function migrateLegacyLocalAgentConfig(
  legacy = legacyLocalAgentConfigPath(),
  target = localAgentConfigPath(),
): Promise<boolean> {
  if (process.env.FREE_LLM_LOCAL_NODE_CONFIG || path.resolve(legacy) === path.resolve(target)) {
    return false;
  }
  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(legacy, target, constants.COPYFILE_EXCL);
    await chmod(target, 0o600);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST") return false;
    throw error;
  }
}

export function normalizeRouterBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Pass the router site URL to --router-url, for example https://your-router.example");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("--router-url requires HTTPS. For a router on this computer, use http://127.0.0.1:8787");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Use the router site URL without credentials, a query string, or a fragment");
  }
  if (!/^\/(?:dashboard\/?|v1\/?)?$/.test(parsed.pathname)) {
    throw new Error("Use the router site URL, such as https://your-router.example, or copy the pairing command from the dashboard");
  }
  return parsed.origin;
}

export async function saveLocalAgentConfig(
  config: LocalAgentConfig,
): Promise<void> {
  const { configFile = localAgentConfigPath(), ...storedConfig } = config;
  const target = configFile;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(storedConfig, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function createLocalAgentConfig(params: {
  configFile?: string;
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
  runtime?: LocalNodeRuntime;
  runtimeBaseUrl?: string;
  cliVersion: string;
  ngrokPath?: string;
}): Promise<LocalAgentConfig> {
  const config: LocalAgentConfig = {
    configFile: params.configFile ?? localAgentConfigPath(),
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
    ...(params.runtime === "lmstudio"
      ? { runtime: "lmstudio", runtimeBaseUrl: normalizeLocalRuntimeOrigin(params.runtimeBaseUrl ?? "http://127.0.0.1:1234") }
      : { ollamaBaseUrl: normalizeOllamaBaseUrl(params.runtimeBaseUrl ?? params.ollamaBaseUrl ?? "http://127.0.0.1:11434") }),
    cliVersion: params.cliVersion,
    ...(params.ngrokPath ? { ngrokPath: params.ngrokPath } : {}),
  };
  await saveLocalAgentConfig(config);
  return config;
}

export async function loadLocalAgentConfig(
  configFile = localAgentConfigPath(),
): Promise<LocalAgentConfig | undefined> {
  if (configFile === localAgentConfigPath()) await migrateLegacyLocalAgentConfig();
  try {
    const config = JSON.parse(await readFile(configFile, "utf8")) as LocalAgentConfig;
    config.configFile = configFile;
    if (!config.nodeId || !config.ownerAccountId || !config.routerBaseUrl) {
      throw new Error("Invalid local node configuration");
    }
    config.routerBaseUrl = normalizeRouterBaseUrl(config.routerBaseUrl);
    if (config.runtime !== undefined && !isLocalNodeRuntime(config.runtime)) {
      throw new Error("Invalid local node runtime");
    }
    if (config.runtime === "lmstudio") {
      if (!config.runtimeBaseUrl) throw new Error("LM Studio URL is missing");
      config.runtimeBaseUrl = normalizeLocalRuntimeOrigin(config.runtimeBaseUrl);
    } else {
      if (!config.ollamaBaseUrl) throw new Error("Ollama URL is missing");
      config.ollamaBaseUrl = normalizeOllamaBaseUrl(config.ollamaBaseUrl);
    }
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

export async function deleteLocalAgentConfig(config: LocalAgentConfig): Promise<void> {
  await deleteProtectedCredential(config.credential);
  await unlink(config.configFile ?? localAgentConfigPath()).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
