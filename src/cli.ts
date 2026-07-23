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
  free-llm start                   Start the dashboard and routing server
  free-llm help                    Show this help

Options:
  --no-open                        Do not open the provider website
  --port <number>                  Port used by "start" (default: 8787)

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
