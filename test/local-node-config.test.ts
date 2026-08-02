import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  localAgentConfigPath,
  migrateLegacyLocalAgentConfig,
} from "../src/local-nodes/agent/local-node-config.js";

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
