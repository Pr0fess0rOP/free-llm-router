import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLocalNodeCliCommand } from "../src/local-nodes/agent/cli-commands.js";
import {
  loadLocalAgentConfig,
  localAgentConfigPath,
  migrateLegacyLocalAgentConfig,
  normalizeRouterBaseUrl,
  runtimeAgentConfigPath,
} from "../src/local-nodes/agent/local-node-config.js";

test("accepts copied dashboard and API URLs while requiring HTTPS for remote routers", () => {
  for (const url of ["https://router.example/dashboard", "https://router.example/v1/"]) {
    assert.equal(normalizeRouterBaseUrl(url), "https://router.example");
  }
  assert.equal(normalizeRouterBaseUrl("http://127.0.0.1:8787/dashboard"), "http://127.0.0.1:8787");
  assert.throws(() => normalizeRouterBaseUrl("http://192.168.1.10:8787/dashboard"), /requires HTTPS/);
  assert.throws(() => normalizeRouterBaseUrl("https://router.example/v1/models"), /router site URL/);
  assert.throws(() => normalizeRouterBaseUrl("https://user:password@router.example/v1"), /without credentials/);
});

test("local-node configuration defaults to stable user-level storage", () => {
  const previous = process.env.FREE_LLM_LOCAL_NODE_CONFIG;
  delete process.env.FREE_LLM_LOCAL_NODE_CONFIG;
  try {
    assert.equal(
      localAgentConfigPath(),
      path.join(os.homedir(), ".freellm", "local-node.json"),
    );
  } finally {
    if (previous === undefined) delete process.env.FREE_LLM_LOCAL_NODE_CONFIG;
    else process.env.FREE_LLM_LOCAL_NODE_CONFIG = previous;
  }
});

test("legacy working-directory configuration is copied forward without overwriting", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-config-migration-"));
  const legacy = path.join(directory, "legacy", "local-node.json");
  const target = path.join(directory, "home", ".freellm", "local-node.json");
  const previous = process.env.FREE_LLM_LOCAL_NODE_CONFIG;
  delete process.env.FREE_LLM_LOCAL_NODE_CONFIG;
  try {
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(legacy, "legacy-config", "utf8");
    assert.equal(await migrateLegacyLocalAgentConfig(legacy, target), true);
    assert.equal(await readFile(target, "utf8"), "legacy-config");

    await writeFile(legacy, "new-legacy-value", "utf8");
    assert.equal(await migrateLegacyLocalAgentConfig(legacy, target), false);
    assert.equal(await readFile(target, "utf8"), "legacy-config");
  } finally {
    if (previous === undefined) delete process.env.FREE_LLM_LOCAL_NODE_CONFIG;
    else process.env.FREE_LLM_LOCAL_NODE_CONFIG = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit configuration path overrides user-level storage", () => {
  const previous = process.env.FREE_LLM_LOCAL_NODE_CONFIG;
  process.env.FREE_LLM_LOCAL_NODE_CONFIG = path.join("relative", "agent.json");
  try {
    assert.equal(localAgentConfigPath(), path.resolve("relative", "agent.json"));
  } finally {
    if (previous === undefined) delete process.env.FREE_LLM_LOCAL_NODE_CONFIG;
    else process.env.FREE_LLM_LOCAL_NODE_CONFIG = previous;
  }
});

test("pairs Ollama alongside an existing LM Studio node and targets management commands by runtime", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-two-runtimes-"));
  const previous = process.env.FREE_LLM_LOCAL_NODE_CONFIG;
  delete process.env.FREE_LLM_LOCAL_NODE_CONFIG;
  t.mock.method(os, "homedir", () => directory);
  t.after(async () => {
    if (previous !== undefined) process.env.FREE_LLM_LOCAL_NODE_CONFIG = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const legacyFile = localAgentConfigPath();
  const studioConfig = JSON.stringify({
    nodeId: "studio-node",
    ownerAccountId: "owner",
    name: "Existing Studio",
    routerBaseUrl: "http://localhost:8787",
    runtime: "lmstudio",
    runtimeBaseUrl: "http://localhost:1235",
    agentPort: 11500,
    models: [],
    allowedModels: [],
    limits: { maxConcurrentRequests: 1, maxOutputTokens: 128 },
  });
  await mkdir(path.dirname(legacyFile), { recursive: true });
  await writeFile(legacyFile, studioConfig);

  const fetch = t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    switch (new URL(url).pathname) {
      case "/api/tags": return Response.json({ models: [{ name: "llama-test" }] });
      case "/api/version": return Response.json({ version: "1.0" });
      case "/api/show": return Response.json({ capabilities: ["completion"] });
      case "/api/v1/models": return Response.json({ models: [] });
      case "/v1/models": return Response.json({ data: [] });
      case "/api/tunnels": return Response.json({ tunnels: [] });
      case "/api/local-nodes/pair":
        assert.equal(JSON.parse(String(options?.body)).runtime, "ollama");
        return Response.json({
          node: { id: "ollama-node", name: "New Ollama", ownerAccountId: "owner", models: [], limits: { maxConcurrentRequests: 1, maxOutputTokens: 128 } },
          deviceCredential: "test-device-credential",
          verificationKey: { publicKey: "test-public-key", keyId: "test-key" },
        });
      default: throw new Error(`Unexpected request: ${url}`);
    }
  });
  const log = t.mock.method(console, "log", () => {});
  const run = (command: string, args: string[]) => runLocalNodeCliCommand(command, args, { cliVersion: "0.8.0" });
  await run("connect", ["ollama", "--code", "test-code", "--models", "llama-test", "--no-start"]);
  const ollamaFile = runtimeAgentConfigPath("ollama");
  assert.equal((await loadLocalAgentConfig(ollamaFile))?.agentPort, 11501);
  assert.equal(await readFile(legacyFile, "utf8"), studioConfig);

  const requestsAfterPairing = fetch.mock.callCount();
  await assert.rejects(run("connect", ["ollama"]), /already paired/);
  await assert.rejects(run("revoke", []), /Both runtimes are paired/);
  assert.equal(fetch.mock.callCount(), requestsAfterPairing);

  await run("status", []);
  const status = log.mock.calls.flatMap(({ arguments: args }) => args).join("\n");
  assert.match(status, /Existing Studio/);
  assert.match(status, /New Ollama/);
  await run("disconnect", ["--runtime", "ollama"]);
  assert.equal((await loadLocalAgentConfig(ollamaFile))?.nodeId, "ollama-node");
  assert.equal(await readFile(legacyFile, "utf8"), studioConfig);
});
