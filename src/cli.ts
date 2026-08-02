#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  createAccount,
  deleteProviderKey,
  findAccount,
  setProviderKey,
} from "./accounts.js";
import { loadProviderConfigs } from "./config.js";
import {
  isLocalNodeCliCommand,
  prompt,
  runLocalNodeCliCommand,
} from "./local-nodes/agent/cli-commands.js";
import { PROVIDER_CATALOG } from "./provider-catalog.js";
import { normalizeProviderId } from "./provider-identities.js";

const LOCAL_KEY_ENV = "FREE_LLM_ROUTER_KEY";

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
  --port <number>                  Port used by "serve" (default: 8787)
  --router-url <url>               Free LLM Router URL used by local-node commands
  --ollama-url <url>               Ollama URL (default: http://127.0.0.1:11434)
  --agent-port <number>            Loopback agent port (default: 11500)
  --models <id,id>                 Non-interactive model allowlist
  --no-start                       Pair and save configuration without starting
`.trim());
}

async function packageVersion(): Promise<string> {
  for (const candidate of [
    new URL("../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ]) {
    try {
      const payload = JSON.parse(await readFile(candidate, "utf8")) as { version?: unknown };
      if (typeof payload.version === "string" && /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(payload.version)) {
        return payload.version;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("Could not determine the CLI package version");
}

async function readLocalRouterKey(): Promise<string | undefined> {
  if (process.env[LOCAL_KEY_ENV]) return process.env[LOCAL_KEY_ENV];
  try {
    return (await readFile(".freellm/router-key", "utf8")).trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveLocalRouterKey(routerKey: string): Promise<void> {
  const { chmod, mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(".freellm", { recursive: true, mode: 0o700 });
  await writeFile(".freellm/router-key", `${routerKey}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(".freellm/router-key", 0o600);
}

async function requireRouterKey(): Promise<string> {
  const routerKey = await readLocalRouterKey();
  if (!routerKey || !(await findAccount(routerKey))) {
    throw new Error('No local router found. Run "free-llm init" first.');
  }
  return routerKey;
}

function openUrl(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(command, args, (error) => {
    if (error) console.warn(`Could not open a browser. Visit: ${url}`);
  });
}

async function providerById(providerId: string) {
  providerId = normalizeProviderId(providerId);
  return (await loadProviderConfigs()).find((provider) => provider.id === providerId);
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
  console.log("────────────────────────────────────────────────────────────────────────");
  for (const provider of configs) {
    const metadata = PROVIDER_CATALOG[provider.id];
    const status = account?.configuredProviderIds.includes(provider.id) ? "connected" : "available";
    console.log(`${(metadata?.name ?? provider.id).padEnd(23)} ${status.padEnd(12)} ${provider.model}`);
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

async function main(): Promise<void> {
  const [, , command = "help", ...args] = process.argv;
  if (isLocalNodeCliCommand(command)) {
    const handled = await runLocalNodeCliCommand(command, args, {
      cliVersion: await packageVersion(),
    });
    if (handled) return;
  }
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
    case "serve":
      await serve(args);
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
