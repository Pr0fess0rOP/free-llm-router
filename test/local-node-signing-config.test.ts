import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  localNodeVerificationKey,
  resetLocalNodeSigningKeyCache,
} from "../src/local-nodes/local-node-request-auth.js";

const ENVIRONMENT_NAMES = [
  "KV_REST_API_URL",
  "UPSTASH_REDIS_REST_URL",
  "LOCAL_NODE_SIGNING_PRIVATE_KEY",
  "LOCAL_NODE_SIGNING_PUBLIC_KEY",
  "LOCAL_NODE_SIGNING_KEY_PATH",
  "VERCEL",
  "NODE_ENV",
] as const;

test("local development persists a signing key when using remote storage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-signing-config-"));
  const keyPath = path.join(directory, "signing.json");
  const previous = Object.fromEntries(
    ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]),
  );

  try {
    delete process.env.KV_REST_API_URL;
    process.env.UPSTASH_REDIS_REST_URL = "https://example.invalid";
    delete process.env.LOCAL_NODE_SIGNING_PRIVATE_KEY;
    delete process.env.LOCAL_NODE_SIGNING_PUBLIC_KEY;
    delete process.env.VERCEL;
    process.env.NODE_ENV = "development";
    process.env.LOCAL_NODE_SIGNING_KEY_PATH = keyPath;
    resetLocalNodeSigningKeyCache();

    const first = await localNodeVerificationKey();
    assert.match(first.publicKey, /BEGIN PUBLIC KEY/);
    assert.match(await readFile(keyPath, "utf8"), /BEGIN PRIVATE KEY/);

    resetLocalNodeSigningKeyCache();
    const second = await localNodeVerificationKey();
    assert.deepEqual(second, first);
  } finally {
    resetLocalNodeSigningKeyCache();
    for (const name of ENVIRONMENT_NAMES) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("serverless production still requires an environment signing key", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-signing-production-"));
  const previous = Object.fromEntries(
    ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]),
  );

  try {
    delete process.env.KV_REST_API_URL;
    process.env.UPSTASH_REDIS_REST_URL = "https://example.invalid";
    delete process.env.LOCAL_NODE_SIGNING_PRIVATE_KEY;
    delete process.env.LOCAL_NODE_SIGNING_PUBLIC_KEY;
    process.env.VERCEL = "1";
    process.env.LOCAL_NODE_SIGNING_KEY_PATH = path.join(directory, "missing.json");
    resetLocalNodeSigningKeyCache();

    await assert.rejects(
      localNodeVerificationKey(),
      /LOCAL_NODE_SIGNING_PRIVATE_KEY is required/,
    );
  } finally {
    resetLocalNodeSigningKeyCache();
    for (const name of ENVIRONMENT_NAMES) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
