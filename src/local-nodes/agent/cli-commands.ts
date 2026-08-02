import { readFile } from "node:fs/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { LocalNode } from "../local-node-types.js";
import {
  createLocalAgentConfig,
  deleteLocalAgentConfig,
  loadLocalAgentConfig,
  localAgentConfigPath,
  normalizeRouterBaseUrl,
  replaceLocalAgentCredential,
  saveLocalAgentConfig,
} from "./local-node-config.js";
import { discoverOllamaModels, ollamaVersion } from "./ollama-client.js";
import { localNodeDeviceRequest } from "./node-api.js";
import { runLocalNode } from "./run.js";
import { currentNgrokEndpoint } from "./tunnel.js";

const LOCAL_NODE_COMMANDS = new Set([
  "connect",
  "start",
  "status",
  "models",
  "logs",
  "disconnect",
  "revoke",
  "credential",
]);

export interface LocalNodeCliOptions {
  cliVersion: string;
  requirePairedStart?: boolean;
}

export function isLocalNodeCliCommand(command: string): boolean {
  return LOCAL_NODE_COMMANDS.has(command);
}

export function localNodeCliUsage(version: string): string {
  return `
Free LLM Router — Local LLM CLI ${version}

Usage:
  free-llm connect ollama --code <code>  Pair Ollama and start the private node
  free-llm start                   Start the paired local node
  free-llm status                  Show local node, Ollama, and tunnel status
  free-llm models [sync]           List or synchronize installed Ollama models
  free-llm logs                    Show redacted local node logs
  free-llm disconnect              Stop the node without revoking it
  free-llm revoke                  Revoke and remove the paired local node
  free-llm credential rotate       Rotate the device credential
  free-llm help                    Show this help

Options:
  --router-url <url>               Deployed Free LLM Router URL
  --ollama-url <url>               Ollama URL (default: http://127.0.0.1:11434)
  --agent-port <number>            Loopback agent port (default: 11500)
  --models <id,id>                 Non-interactive model allowlist
  --name <name>                    Non-interactive node name
  --no-start                       Pair without starting the agent

Local data: ${path.dirname(localAgentConfigPath())}
`.trim();
}

export async function prompt(question: string, secret = false): Promise<string> {
  const terminal = createInterface({ input: stdin, output: stdout });
  if (secret && stdin.isTTY) {
    stdout.write(question);
    stdin.setRawMode?.(true);
    let value = "";
    for await (const chunk of stdin) {
      const text = String(chunk);
      if (text === "\r" || text === "\n") break;
      if (text === "\u0003") {
        stdin.setRawMode?.(false);
        terminal.close();
        throw new Error("Cancelled");
      }
      if (text === "\u007f") {
        value = value.slice(0, -1);
        continue;
      }
      value += text;
    }
    stdin.setRawMode?.(false);
    stdout.write("\n");
    terminal.close();
    return value.trim();
  }

  const value = await terminal.question(question);
  terminal.close();
  return value.trim();
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positivePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("Port must be an integer from 1 to 65535");
  }
  return parsed;
}

async function selectedModels(
  models: Awaited<ReturnType<typeof discoverOllamaModels>>,
  args: string[],
): Promise<string[]> {
  const explicit = option(args, "--models");
  if (explicit) {
    const selected = [...new Set(explicit.split(",").map((item) => item.trim()).filter(Boolean))];
    const installed = new Set(models.map((model) => model.id));
    const missing = selected.filter((model) => !installed.has(model));
    if (missing.length) throw new Error(`Models are not installed: ${missing.join(", ")}`);
    return selected;
  }
  if (!stdin.isTTY) {
    return models
      .map((model) => model.id)
      .filter((id) => !/(?:^|[-_:])(embed|embedding)(?:[-_:]|$)/i.test(id));
  }
  console.log("\nInstalled Ollama models:");
  models.forEach((model, index) => console.log(`  ${index + 1}. ${model.id}`));
  const answer = await prompt("Select models by number or ID, comma-separated [all]: ");
  if (!answer) return models.map((model) => model.id);
  const selected = answer.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    const index = Number(item);
    return Number.isInteger(index) && index >= 1 && index <= models.length
      ? models[index - 1]!.id
      : item;
  });
  const installed = new Set(models.map((model) => model.id));
  const missing = selected.filter((model) => !installed.has(model));
  if (missing.length) throw new Error(`Models are not installed: ${missing.join(", ")}`);
  return [...new Set(selected)];
}

async function connectLocalNode(
  runtime: string | undefined,
  args: string[],
  cliVersion: string,
): Promise<void> {
  if (runtime !== "ollama") throw new Error('Only "connect ollama" is supported in v1.');
  if (await loadLocalAgentConfig()) {
    throw new Error('A local node is already paired. Run "free-llm status" or "free-llm revoke" first.');
  }
  const routerBaseUrl = normalizeRouterBaseUrl(
    option(args, "--router-url") ??
    process.env.FREE_LLM_ROUTER_URL ??
    "http://127.0.0.1:8787",
  );
  const ollamaBaseUrl = (
    option(args, "--ollama-url") ??
    process.env.OLLAMA_BASE_URL ??
    "http://127.0.0.1:11434"
  ).replace(/\/+$/, "");
  console.log("Free LLM Router — Connect Local LLM\n");
  const version = await ollamaVersion(ollamaBaseUrl);
  console.log(`✓ Ollama ${version} detected at ${ollamaBaseUrl}`);
  const discovered = await discoverOllamaModels(ollamaBaseUrl);
  if (!discovered.length) throw new Error("No installed Ollama models were found");
  console.log(`✓ ${discovered.length} installed model${discovered.length === 1 ? "" : "s"} found`);
  const allowedModels = await selectedModels(discovered, args);
  if (!allowedModels.length) throw new Error("Select at least one Ollama model");
  const code = option(args, "--code") ?? await prompt("Pairing code: ");
  if (!code) throw new Error("Pairing code is required");
  const defaultName = process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "Local Ollama";
  const name = option(args, "--name") ?? (stdin.isTTY
    ? (await prompt(`Node name [${defaultName}]: `)) || defaultName
    : defaultName);
  const response = await fetch(`${routerBaseUrl}/api/local-nodes/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      name,
      runtime: "ollama",
      cliVersion,
      models: discovered.map((model) => ({
        id: model.id,
        enabled: allowedModels.includes(model.id),
      })),
    }),
    redirect: "error",
  });
  const payload = await response.json() as {
    node?: LocalNode;
    deviceCredential?: string;
    verificationKey?: { publicKey?: string; keyId?: string };
    error?: unknown;
    request_id?: string;
  };
  if (!response.ok || !payload.node || !payload.deviceCredential || !payload.verificationKey?.publicKey || !payload.verificationKey.keyId) {
    const errorMessage = typeof payload.error === "string"
      ? payload.error
      : payload.error && typeof payload.error === "object" && "message" in payload.error
        ? String((payload.error as { message?: unknown }).message ?? "")
        : "";
    const requestId = payload.request_id ? ` (request ${payload.request_id})` : "";
    throw new Error(`${errorMessage || `Pairing failed with HTTP ${response.status}`}${requestId}`);
  }
  const config = await createLocalAgentConfig({
    nodeId: payload.node.id,
    ownerAccountId: payload.node.ownerAccountId,
    name: payload.node.name,
    routerBaseUrl,
    verificationPublicKey: payload.verificationKey.publicKey,
    verificationKeyId: payload.verificationKey.keyId,
    deviceCredential: payload.deviceCredential,
    allowedModels,
    models: payload.node.models,
    limits: payload.node.limits,
    agentPort: positivePort(option(args, "--agent-port"), 11_500),
    ollamaBaseUrl,
    cliVersion,
    ...(option(args, "--ngrok-path") ? { ngrokPath: option(args, "--ngrok-path")! } : {}),
  });
  console.log(`✓ Node registered as "${config.name}"`);
  console.log(`✓ ${allowedModels.length} model${allowedModels.length === 1 ? "" : "s"} allowed`);
  console.log(`✓ Device credential stored using ${config.credential.storage}`);
  console.log(`Maximum concurrent requests: ${config.limits.maxConcurrentRequests}`);
  console.log(`Maximum output tokens: ${config.limits.maxOutputTokens}`);
  if (args.includes("--no-start")) {
    console.log('Run "free-llm start" to start the agent and secure tunnel.');
    return;
  }
  await runLocalNode(config, { onStatus: (message) => console.log(`✓ ${message}`) });
}

async function startLocalNode(requirePaired: boolean, args: string[]): Promise<boolean> {
  const config = await loadLocalAgentConfig();
  if (!config || args.includes("--router")) {
    if (requirePaired) {
      throw new Error('No local node is paired. Run "free-llm connect ollama" first.');
    }
    return false;
  }
  if (config.agentPid && config.agentPid !== process.pid) {
    try {
      process.kill(config.agentPid, 0);
      throw new Error(`Local node agent is already running as PID ${config.agentPid}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("already running")) throw error;
      delete config.agentPid;
      await saveLocalAgentConfig(config);
    }
  }
  await runLocalNode(config, { onStatus: (message) => console.log(message) });
  return true;
}

async function localNodeStatus(): Promise<void> {
  const config = await loadLocalAgentConfig();
  if (!config) throw new Error('No local node is paired. Use "free-llm connect ollama".');
  let running = false;
  if (config.agentPid) {
    try {
      process.kill(config.agentPid, 0);
      running = true;
    } catch {
      running = false;
    }
  }
  const version = await ollamaVersion(config.ollamaBaseUrl).catch(() => "offline");
  const liveTunnel = await currentNgrokEndpoint(config.agentPort);
  console.log(`Node:       ${config.name} (${config.nodeId})`);
  console.log(`Account:    ${config.ownerAccountId} (paired)`);
  console.log(`Agent:      ${running ? `running (PID ${config.agentPid})` : "stopped"}`);
  console.log(`Ollama:     ${version}`);
  console.log(`Tunnel:     ${liveTunnel ? `${liveTunnel} (connected)` : config.tunnelEndpoint ? `${config.tunnelEndpoint} (not detected)` : "not registered"}`);
  console.log(`Heartbeat:  ${config.lastHeartbeatAt ?? "not sent"}`);
  console.log(`Active:     ${config.lastKnownActiveRequests ?? 0}/${config.limits.maxConcurrentRequests}`);
  console.log(`Router:     ${config.routerBaseUrl}`);
  console.log(`Models:     ${config.allowedModels.join(", ") || "none"}`);
}

async function localModels(sync: boolean): Promise<void> {
  const config = await loadLocalAgentConfig();
  if (!config) throw new Error("No local node is paired");
  const discovered = await discoverOllamaModels(config.ollamaBaseUrl);
  discovered.forEach((model) => {
    console.log(`${config.allowedModels.includes(model.id) ? "[x]" : "[ ]"} ${model.id}`);
  });
  if (!sync) return;
  const node = await localNodeDeviceRequest<LocalNode>(config, "/models/sync", {
    models: discovered.map((model) => ({ id: model.id, installed: true })),
  });
  config.models = node.models;
  config.allowedModels = node.models.filter((model) => model.enabled && model.installed).map((model) => model.modelId);
  await saveLocalAgentConfig(config);
  console.log("Model inventory synchronized.");
}

async function disconnectLocalNode(): Promise<void> {
  const config = await loadLocalAgentConfig();
  if (!config) throw new Error("No local node is paired");
  if (config.agentPid && config.agentPid !== process.pid) {
    try { process.kill(config.agentPid, "SIGTERM"); } catch { /* already stopped */ }
  }
  delete config.agentPid;
  delete config.tunnelEndpoint;
  await saveLocalAgentConfig(config);
  console.log("Local node stopped. Pairing and Ollama models were preserved.");
}

async function revokeLocalNode(): Promise<void> {
  const config = await loadLocalAgentConfig();
  if (!config) throw new Error("No local node is paired");
  let alreadyInvalidated = false;
  try {
    await localNodeDeviceRequest(config, "/revoke", {});
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid or revoked node credential") {
      alreadyInvalidated = true;
    } else {
      throw error;
    }
  }
  if (config.agentPid && config.agentPid !== process.pid) {
    try { process.kill(config.agentPid, "SIGTERM"); } catch { /* already stopped */ }
  }
  await deleteLocalAgentConfig();
  console.log(alreadyInvalidated
    ? "Local node was already revoked or deleted remotely. Local pairing was removed."
    : "Local node revoked. Ollama models were not changed.");
}

async function rotateLocalCredential(): Promise<void> {
  let config = await loadLocalAgentConfig();
  if (!config) throw new Error("No local node is paired");
  if (config.agentPid && config.agentPid !== process.pid) {
    const pid = config.agentPid;
    try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        break;
      }
    }
    try {
      process.kill(pid, 0);
      throw new Error(`Could not stop local agent PID ${pid}; credential was not rotated`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("credential was not rotated")) throw error;
    }
    config = (await loadLocalAgentConfig()) ?? config;
  }
  const result = await localNodeDeviceRequest<{ deviceCredential: string }>(
    config,
    "/rotate-credential",
    {},
  );
  await replaceLocalAgentCredential(config, result.deviceCredential);
  console.log('Local node credential rotated. Run "free-llm start" to reconnect.');
}

async function localNodeLogs(): Promise<void> {
  const target = path.resolve(path.dirname(localAgentConfigPath()), "local-node.log");
  try {
    const lines = (await readFile(target, "utf8")).trim().split(/\r?\n/).slice(-200);
    console.log(lines.join("\n"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("No local node logs are available yet.");
      return;
    }
    throw error;
  }
}

export async function runLocalNodeCliCommand(
  command: string,
  args: string[],
  options: LocalNodeCliOptions,
): Promise<boolean> {
  switch (command) {
    case "connect":
      await connectLocalNode(args[0], args.slice(1), options.cliVersion);
      return true;
    case "start":
      return startLocalNode(options.requirePairedStart === true, args);
    case "status":
      await localNodeStatus();
      return true;
    case "models":
      await localModels(args[0] === "sync");
      return true;
    case "logs":
      await localNodeLogs();
      return true;
    case "disconnect":
      await disconnectLocalNode();
      return true;
    case "revoke":
      await revokeLocalNode();
      return true;
    case "credential":
      if (args[0] !== "rotate") throw new Error('Use "free-llm credential rotate".');
      await rotateLocalCredential();
      return true;
    default:
      return false;
  }
}
