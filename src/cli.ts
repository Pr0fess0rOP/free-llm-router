#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  createAccount,
  deleteProviderKey,
  findAccount,
  listAccounts,
  setProviderKey,
} from "./accounts.js";
import { loadProviderConfigs } from "./config.js";
import { PROVIDER_CATALOG } from "./provider-catalog.js";
import { normalizeProviderId } from "./provider-identities.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createLocalAgentConfig,
  deleteLocalAgentConfig,
  loadLocalAgentConfig,
  localAgentConfigPath,
  normalizeRouterBaseUrl,
  replaceLocalAgentCredential,
  saveLocalAgentConfig,
} from "./local-nodes/agent/local-node-config.js";
import { discoverOllamaModels, ollamaVersion } from "./local-nodes/agent/ollama-client.js";
import { localNodeDeviceRequest } from "./local-nodes/agent/node-api.js";
import { runLocalNode } from "./local-nodes/agent/run.js";
import { currentNgrokEndpoint } from "./local-nodes/agent/tunnel.js";
import type { LocalNode } from "./local-nodes/local-node-types.js";

const LOCAL_KEY_ENV = "FREE_LLM_ROUTER_KEY";
const LOCAL_NODE_CLI_VERSION = "0.7.0";

function usage(): void {
  console.log(`
Free LLM Router

Usage:
  free-llm init [name]             Create a local router and save its router key
  free-llm providers               List providers and connection status
  free-llm add <provider>          Open the provider website and save its API key
  free-llm remove <provider>       Remove a saved provider key
  free-llm key                     Print the local router key
  free-llm connect ollama --code <code>  Pair Ollama and start the private node
  free-llm start                   Start a paired local node (or router if none)
  free-llm serve                   Start the dashboard and routing server
  free-llm status                  Show local node, Ollama, and tunnel status
  free-llm models [sync]           List or synchronize installed Ollama models
  free-llm logs                    Show redacted local node logs
  free-llm disconnect              Stop the running local node without revoking it
  free-llm revoke                  Revoke and remove the paired local node
  free-llm credential rotate       Rotate the local node device credential
  free-llm help                    Show this help

Options:
  --no-open                        Do not open the provider website
  --port <number>                  Port used by "start" (default: 8787)
  --router-url <url>               Free LLM Router URL used by local-node commands
  --ollama-url <url>               Ollama URL (default: http://127.0.0.1:11434)
  --agent-port <number>            Loopback agent port (default: 11500)
  --models <id,id>                 Non-interactive model allowlist
  --no-start                       Pair and save configuration without starting

Local data is stored under .freellm/ by default.
`.trim());
}

async function readLocalRouterKey(): Promise<string | undefined> {
  if (process.env[LOCAL_KEY_ENV]) return process.env[LOCAL_KEY_ENV];
  try {
    const { readFile } = await import("node:fs/promises");
    return (await readFile(".freellm/router-key", "utf8")).trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveLocalRouterKey(routerKey: string): Promise<void> {
  const { chmod, mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(".freellm", { recursive: true, mode: 0o700 });
  await writeFile(".freellm/router-key", `${routerKey}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(".freellm/router-key", 0o600);
}

async function requireRouterKey(): Promise<string> {
  const routerKey = await readLocalRouterKey();
  if (!routerKey || !(await findAccount(routerKey))) {
    throw new Error('No local router found. Run "free-llm init" first.');
  }
  return routerKey;
}

async function prompt(question: string, secret = false): Promise<string> {
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

function openUrl(url: string): void {
  const platform = process.platform;
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(command, args, (error) => {
    if (error) console.warn(`Could not open a browser. Visit: ${url}`);
  });
}

async function providerById(providerId: string) {
  providerId = normalizeProviderId(providerId);
  const configs = await loadProviderConfigs();
  return configs.find((provider) => provider.id === providerId);
}

async function init(name?: string): Promise<void> {
  const existingKey = await readLocalRouterKey();
  if (existingKey && (await findAccount(existingKey))) {
    console.log('A local router already exists. Run "free-llm key" to view its key.');
    return;
  }

  const routerName = name?.trim() || (await prompt("Router name [My local router]: ")) || "My local router";
  const { routerKey } = await createAccount(routerName);
  await saveLocalRouterKey(routerKey);
  console.log("\nLocal router created.");
  console.log(`Router key: ${routerKey}`);
  console.log('Next: run "free-llm add groq" or "free-llm providers".');
}

async function providers(): Promise<void> {
  const routerKey = await readLocalRouterKey();
  const account = routerKey ? await findAccount(routerKey) : undefined;
  const configs = await loadProviderConfigs();
  console.log("\nProvider                Status       Model");
  console.log("────────────────────────────────────────────────────────────────────");
  for (const provider of configs) {
    const metadata = PROVIDER_CATALOG[provider.id];
    const status = account?.configuredProviderIds.includes(provider.id)
      ? "connected"
      : "available";
    console.log(
      `${(metadata?.name ?? provider.id).padEnd(23)} ${status.padEnd(12)} ${provider.model}`,
    );
    console.log(`  id: ${provider.id} · ${metadata?.freeTier ?? provider.baseUrl}`);
  }
}

async function add(providerId: string | undefined, shouldOpen: boolean): Promise<void> {
  if (!providerId) throw new Error('Provider id required. Run "free-llm providers".');
  providerId = normalizeProviderId(providerId);
  const routerKey = await requireRouterKey();
  const provider = await providerById(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  const metadata = PROVIDER_CATALOG[providerId];

  if (shouldOpen && metadata?.website) {
    console.log(`Opening ${metadata.name}: ${metadata.website}`);
    openUrl(metadata.website);
  } else if (metadata?.website) {
    console.log(`Create a key at: ${metadata.website}`);
  }

  const apiKey = await prompt(`${metadata?.name ?? providerId} API key: `, true);
  if (apiKey.length < 8) throw new Error("API key is too short.");
  await setProviderKey(routerKey, providerId, apiKey);
  console.log(`${metadata?.name ?? providerId} connected.`);
}

async function remove(providerId: string | undefined): Promise<void> {
  if (!providerId) throw new Error('Provider id required. Run "free-llm providers".');
  providerId = normalizeProviderId(providerId);
  const routerKey = await requireRouterKey();
  const provider = await providerById(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  await deleteProviderKey(routerKey, providerId);
  console.log(`${PROVIDER_CATALOG[providerId]?.name ?? providerId} removed.`);
}

async function start(args: string[]): Promise<void> {
  const localConfig = await loadLocalAgentConfig();
  if (localConfig && !args.includes("--router")) {
    if (localConfig.agentPid && localConfig.agentPid !== process.pid) {
      try {
        process.kill(localConfig.agentPid, 0);
        throw new Error(`Local node agent is already running as PID ${localConfig.agentPid}`);
      } catch (error) {
        if (error instanceof Error && error.message.includes("already running")) throw error;
        delete localConfig.agentPid;
        await saveLocalAgentConfig(localConfig);
      }
    }
    await runLocalNode(localConfig, { onStatus: (message) => console.log(message) });
    return;
  }
  await serve(args);
}

async function serve(args: string[]): Promise<void> {
  const portIndex = args.indexOf("--port");
  if (portIndex >= 0) {
    const port = args[portIndex + 1];
    if (!port || !/^\d+$/.test(port)) throw new Error("--port requires a number.");
    process.env.PORT = port;
  }

  if (!(await readLocalRouterKey())) {
    console.log('No local router exists yet. Running "free-llm init".');
    await init();
  }

  const { startServer } = await import("./server.js");
  await startServer();
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

async function connectLocalNode(runtime: string | undefined, args: string[]): Promise<void> {
  if (runtime !== "ollama") throw new Error('Only "connect ollama" is supported in v1.');
  if (await loadLocalAgentConfig()) {
    throw new Error('A local node is already paired. Run "free-llm status" or "free-llm revoke" first.');
  }
  const routerBaseUrl = normalizeRouterBaseUrl(
    option(args, "--router-url") ??
    process.env.FREE_LLM_ROUTER_URL ??
    "http://127.0.0.1:8787"
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
      cliVersion: LOCAL_NODE_CLI_VERSION,
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
    throw new Error(
      `${errorMessage || `Pairing failed with HTTP ${response.status}`}${requestId}`,
    );
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
    cliVersion: LOCAL_NODE_CLI_VERSION,
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
    try {
      process.kill(config.agentPid, "SIGTERM");
    } catch {
      // The process is already stopped.
    }
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
    if (
      error instanceof Error &&
      error.message === "Invalid or revoked node credential"
    ) {
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

async function main(): Promise<void> {
  const [, , command = "help", ...args] = process.argv;
  switch (command) {
    case "init":
      await init(args.filter((arg) => !arg.startsWith("--")).join(" "));
      break;
    case "providers":
      await providers();
      break;
    case "add":
      await add(args.find((arg) => !arg.startsWith("--")), !args.includes("--no-open"));
      break;
    case "remove":
      await remove(args.find((arg) => !arg.startsWith("--")));
      break;
    case "key":
      console.log(await requireRouterKey());
      break;
    case "start":
      await start(args);
      break;
    case "serve":
      await serve(args);
      break;
    case "connect":
      await connectLocalNode(args[0], args.slice(1));
      break;
    case "status":
      await localNodeStatus();
      break;
    case "models":
      await localModels(args[0] === "sync");
      break;
    case "logs":
      await localNodeLogs();
      break;
    case "disconnect":
      await disconnectLocalNode();
      break;
    case "revoke":
      await revokeLocalNode();
      break;
    case "credential":
      if (args[0] !== "rotate") throw new Error('Use "free-llm credential rotate".');
      await rotateLocalCredential();
      break;
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      usage();
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
