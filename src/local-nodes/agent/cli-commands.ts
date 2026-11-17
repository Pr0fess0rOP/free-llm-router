import { readFile } from "node:fs/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { isLocalNodeRuntime, type LocalNode, type LocalNodeModelInventoryItem, type LocalNodeRuntime } from "../local-node-types.js";
import {
  createLocalAgentConfig,
  deleteLocalAgentConfig,
  loadLocalAgentConfig,
  localAgentConfigPath,
  normalizeRouterBaseUrl,
  replaceLocalAgentCredential,
  runtimeAgentConfigPath,
  saveLocalAgentConfig,
  type LocalAgentConfig,
} from "./local-node-config.js";
import { discoverRuntimeModels, runtimeConnection } from "./runtime.js";
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
  free-llm connect lmstudio --code <code>  Pair LM Studio and start the private node
  free-llm start                   Start the paired local node
  free-llm status                  Show all paired runtimes and tunnel status
  free-llm models [sync]           List or synchronize installed local models
  free-llm logs                    Show redacted local node logs
  free-llm disconnect              Stop the node without revoking it
  free-llm revoke                  Revoke and remove the paired local node
  free-llm credential rotate       Rotate the device credential
  free-llm help                    Show this help

Options:
  --router-url <url>               Deployed Free LLM Router URL
  --ollama-url <url>               Ollama URL (default: http://127.0.0.1:11434)
  --lmstudio-url <url>             LM Studio URL (default: http://127.0.0.1:1234)
  --agent-port <number>            Override the automatically selected loopback agent port
  --runtime <ollama|lmstudio>       Choose a paired runtime for a local-node command
  --models <id,id>                 Non-interactive model allowlist
  --name <name>                    Non-interactive node name
  --no-start                       Pair without starting the agent

LMSTUDIO_API_TOKEN                 Optional token for an authenticated LM Studio server

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

async function loadPairedNodes(): Promise<LocalAgentConfig[]> {
  const configs = await Promise.all([
    loadLocalAgentConfig(),
    ...(process.env.FREE_LLM_LOCAL_NODE_CONFIG ? [] : [
      loadLocalAgentConfig(runtimeAgentConfigPath("ollama")),
      loadLocalAgentConfig(runtimeAgentConfigPath("lmstudio")),
    ]),
  ]);
  return configs.filter((config): config is LocalAgentConfig => config !== undefined);
}

function pairedRuntime(config: LocalAgentConfig): LocalNodeRuntime {
  return config.runtime ?? "ollama";
}

async function selectedModels(
  models: LocalNodeModelInventoryItem[],
  label: string,
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
  console.log(`\nInstalled ${label} models:`);
  models.forEach((model, index) => console.log(
    `  ${index + 1}. ${model.id}${model.available === false ? " (load in LM Studio to use)" : ""}`,
  ));
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
  if (!isLocalNodeRuntime(runtime)) throw new Error('Use "connect ollama" or "connect lmstudio".');
  const paired = await loadPairedNodes();
  if (paired.some((config) => pairedRuntime(config) === runtime)) {
    throw new Error(`This runtime is already paired. Run "free-llm status --runtime ${runtime}" to check it.`);
  }
  if (process.env.FREE_LLM_LOCAL_NODE_CONFIG && paired.length) {
    throw new Error("FREE_LLM_LOCAL_NODE_CONFIG points to an existing pairing. Clear it to use automatic runtime settings, or choose a different file.");
  }
  const customConfig = process.env.FREE_LLM_LOCAL_NODE_CONFIG;
  const configFile = customConfig ? localAgentConfigPath() : runtimeAgentConfigPath(runtime);
  const usedPorts = new Set(paired.map((config) => config.agentPort));
  let defaultPort = runtime === "lmstudio" && !customConfig ? 11_501 : 11_500;
  while (usedPorts.has(defaultPort)) defaultPort += 1;
  const agentPort = positivePort(option(args, "--agent-port"), defaultPort);
  if (usedPorts.has(agentPort)) throw new Error(`Agent port ${agentPort} is assigned to another pairing. Choose a different --agent-port.`);
  const routerBaseUrl = normalizeRouterBaseUrl(
    option(args, "--router-url") ??
    process.env.FREE_LLM_ROUTER_URL ??
    "http://127.0.0.1:8787",
  );
  const runtimeConfig = runtime === "lmstudio"
    ? { runtime, runtimeBaseUrl: option(args, "--lmstudio-url") ?? process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234" }
    : { runtime, ollamaBaseUrl: option(args, "--ollama-url") ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434" };
  const connection = runtimeConnection(runtimeConfig);
  console.log("Free LLM Router — Connect Local LLM\n");
  const inventory = await discoverRuntimeModels(runtimeConfig);
  const discovered = inventory.models;
  console.log(`✓ ${connection.label}${inventory.ollamaVersion ? ` ${inventory.ollamaVersion}` : ""} detected at ${connection.origin}`);
  if (!discovered.length) throw new Error(`No installed ${connection.label} chat models were found`);
  console.log(`✓ ${discovered.length} installed model${discovered.length === 1 ? "" : "s"} found`);
  const allowedModels = await selectedModels(discovered, connection.label, args);
  if (!allowedModels.length) throw new Error(`Select at least one ${connection.label} model`);
  const code = option(args, "--code") ?? await prompt("Pairing code: ");
  if (!code) throw new Error("Pairing code is required");
  const defaultName = process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? connection.label;
  const name = option(args, "--name") ?? (stdin.isTTY
    ? (await prompt(`Node name [${defaultName}]: `)) || defaultName
    : defaultName);
  const response = await fetch(`${routerBaseUrl}/api/local-nodes/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      name,
      runtime,
      cliVersion,
      models: discovered.map((model) => ({
        ...model,
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
    configFile,
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
    agentPort,
    ...runtimeConfig,
    cliVersion,
    ...(option(args, "--ngrok-path") ? { ngrokPath: option(args, "--ngrok-path")! } : {}),
  });
  console.log(`✓ Node registered as "${config.name}"`);
  console.log(`✓ ${allowedModels.length} model${allowedModels.length === 1 ? "" : "s"} allowed`);
  console.log(`✓ Device credential stored using ${config.credential.storage}`);
  console.log(`Maximum concurrent requests: ${config.limits.maxConcurrentRequests}`);
  console.log(`Maximum output tokens: ${config.limits.maxOutputTokens}`);
  if (args.includes("--no-start")) {
    console.log(`Run "free-llm start --runtime ${runtime}" to start the agent and secure tunnel.`);
    return;
  }
  await runLocalNode(config, { onStatus: (message) => console.log(`✓ ${message}`) });
}

async function startLocalNode(config: LocalAgentConfig, cliVersion: string): Promise<void> {
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
  config.cliVersion = cliVersion;
  await runLocalNode(config, { onStatus: (message) => console.log(message) });
}

async function localNodeStatus(config: LocalAgentConfig): Promise<void> {
  let running = false;
  if (config.agentPid) {
    try {
      process.kill(config.agentPid, 0);
      running = true;
    } catch {
      running = false;
    }
  }
  const runtime = runtimeConnection(config);
  const inventory = await discoverRuntimeModels(config, config.models.map(({ modelId }) => modelId)).catch(() => undefined);
  const liveTunnel = await currentNgrokEndpoint(config.agentPort);
  console.log(`Node:       ${config.name} (${config.nodeId})`);
  console.log(`Account:    ${config.ownerAccountId} (paired)`);
  console.log(`Agent:      ${running ? `running (PID ${config.agentPid})` : "stopped"}`);
  console.log(`Agent port: ${config.agentPort}`);
  console.log(`Runtime:    ${runtime.label} (${inventory?.ollamaVersion ?? (inventory ? "online" : "offline")})`);
  console.log(`Tunnel:     ${liveTunnel ? `${liveTunnel} (connected)` : config.tunnelEndpoint ? `${config.tunnelEndpoint} (not detected)` : "not registered"}`);
  console.log(`Heartbeat:  ${config.lastHeartbeatAt ?? "not sent"}`);
  console.log(`Active:     ${config.lastKnownActiveRequests ?? 0}/${config.limits.maxConcurrentRequests}`);
  console.log(`Router:     ${config.routerBaseUrl}`);
  console.log(`Models:     ${config.allowedModels.join(", ") || "none"}`);
}

async function localModels(config: LocalAgentConfig, sync: boolean): Promise<void> {
  const inventory = await discoverRuntimeModels(config, config.models.map(({ modelId }) => modelId));
  inventory.models.forEach((model) => {
    console.log(`${config.allowedModels.includes(model.id) ? "[x]" : "[ ]"} ${model.id}${model.available === false ? " (load in LM Studio to use)" : ""}`);
  });
  if (!sync) return;
  const node = await localNodeDeviceRequest<LocalNode>(config, "/models/sync", {
    models: inventory.models,
  });
  config.models = node.models;
  config.allowedModels = node.models.filter((model) => model.enabled && model.installed).map((model) => model.modelId);
  await saveLocalAgentConfig(config);
  console.log("Model inventory synchronized.");
}

async function disconnectLocalNode(config: LocalAgentConfig): Promise<void> {
  if (config.agentPid && config.agentPid !== process.pid) {
    try { process.kill(config.agentPid, "SIGTERM"); } catch { /* already stopped */ }
  }
  delete config.agentPid;
  delete config.tunnelEndpoint;
  await saveLocalAgentConfig(config);
  console.log("Local node stopped. Pairing and installed models were preserved.");
}

async function revokeLocalNode(config: LocalAgentConfig): Promise<void> {
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
  await deleteLocalAgentConfig(config);
  console.log(alreadyInvalidated
    ? "Local node was already revoked or deleted remotely. Local pairing was removed."
    : "Local node revoked. Installed models were preserved.");
}

async function rotateLocalCredential(config: LocalAgentConfig): Promise<void> {
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
    config = (await loadLocalAgentConfig(config.configFile)) ?? config;
  }
  const result = await localNodeDeviceRequest<{ deviceCredential: string }>(
    config,
    "/rotate-credential",
    {},
  );
  await replaceLocalAgentCredential(config, result.deviceCredential);
  console.log(`Local node credential rotated. Run "free-llm start --runtime ${pairedRuntime(config)}" to reconnect.`);
}

async function localNodeLogs(configFile = localAgentConfigPath()): Promise<void> {
  const target = path.resolve(path.dirname(configFile), "local-node.log");
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
  if (!isLocalNodeCliCommand(command)) return false;
  if (command === "connect") {
    await connectLocalNode(args[0], args.slice(1), options.cliVersion);
    return true;
  }
  if (command === "start" && args.includes("--router") && !options.requirePairedStart) return false;

  const runtimeIndex = args.indexOf("--runtime");
  let runtime: LocalNodeRuntime | undefined;
  if (runtimeIndex >= 0) {
    const requestedRuntime = args[runtimeIndex + 1];
    if (!isLocalNodeRuntime(requestedRuntime)) throw new Error("--runtime must be ollama or lmstudio");
    runtime = requestedRuntime;
  }
  const commandArgs = args.filter((_, index) => runtimeIndex < 0 || (index !== runtimeIndex && index !== runtimeIndex + 1));
  const paired = await loadPairedNodes();
  const matches = runtime ? paired.filter((config) => pairedRuntime(config) === runtime) : paired;
  if (command === "status" && matches.length) {
    for (const [index, config] of matches.entries()) {
      if (index > 0) console.log("");
      await localNodeStatus(config);
    }
    return true;
  }
  if (matches.length > 1) throw new Error("Both runtimes are paired. Add --runtime ollama or --runtime lmstudio to select one.");
  const config = matches[0];
  if (!config) {
    if (command === "start" && !runtime && !options.requirePairedStart) return false;
    if (command === "logs") {
      await localNodeLogs(runtime && !process.env.FREE_LLM_LOCAL_NODE_CONFIG ? runtimeAgentConfigPath(runtime) : undefined);
      return true;
    }
    throw new Error(runtime ? `No ${runtime} node is paired.` : 'No local node is paired. Use "free-llm help" for connection commands.');
  }
  switch (command) {
    case "start":
      await startLocalNode(config, options.cliVersion);
      return true;
    case "models":
      await localModels(config, commandArgs[0] === "sync");
      return true;
    case "logs":
      await localNodeLogs(config.configFile);
      return true;
    case "disconnect":
      await disconnectLocalNode(config);
      return true;
    case "revoke":
      await revokeLocalNode(config);
      return true;
    case "credential":
      if (commandArgs[0] !== "rotate") throw new Error('Use "free-llm credential rotate".');
      await rotateLocalCredential(config);
      return true;
    default:
      return false;
  }
}
