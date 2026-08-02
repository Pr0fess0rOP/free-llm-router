#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import {
  isLocalNodeCliCommand,
  localNodeCliUsage,
  runLocalNodeCliCommand,
} from "../../../src/local-nodes/agent/cli-commands.js";

async function packageVersion(): Promise<string> {
  for (const packageJson of [
    new URL("../package.json", import.meta.url),
    new URL("../../../../package.json", import.meta.url),
  ]) {
    try {
      const payload = JSON.parse(await readFile(packageJson, "utf8")) as { version?: unknown };
      if (typeof payload.version === "string") return payload.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("CLI package version is missing");
}

async function main(): Promise<void> {
  const [, , command = "help", ...args] = process.argv;
  const version = await packageVersion();
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(localNodeCliUsage(version));
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(version);
    return;
  }
  if (!isLocalNodeCliCommand(command)) {
    console.log(localNodeCliUsage(version));
    throw new Error(`Unknown Local LLM command: ${command}`);
  }
  await runLocalNodeCliCommand(command, args, {
    cliVersion: version,
    requirePairedStart: true,
  });
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
