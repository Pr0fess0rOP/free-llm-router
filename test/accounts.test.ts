import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAccount,
  findAccount,
  findAccountForUser,
  getAccountForUser,
  getProviderKeys,
  setProviderKey,
  setProviderQuota,
  updateAccountSettings,
} from "../src/accounts.js";

test("persists provider credentials encrypted at rest", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-"));
  const storePath = path.join(directory, "accounts.json");
  const previousPath = process.env.ACCOUNTS_PATH;
  const previousKey = process.env.ACCOUNT_ENCRYPTION_KEY;
  process.env.ACCOUNTS_PATH = storePath;
  process.env.ACCOUNT_ENCRYPTION_KEY = randomBytes(32).toString("base64url");

  try {
    const { account, routerKey } = await createAccount("Encrypted router");
    assert.deepEqual(account.modelAliases.map((alias) => alias.id), [
      "free-router",
      "codex-free-router",
      "claude-free-router",
    ]);
    assert.equal(account.deduplicationSettings.enabled, true);
    assert.equal(account.deduplicationSettings.windowMs, 30_000);
    await setProviderKey(routerKey, "example", "provider-secret-value");
    await setProviderQuota(routerKey, "example", {
      dailyRequestLimit: 100,
      monthlyTokenLimit: 50_000,
      warningThresholdPercent: 75,
    });

    const stored = await readFile(storePath, "utf8");
    assert.doesNotMatch(stored, /provider-secret-value/);
    assert.match(stored, /v1\./);
    assert.equal((await findAccount(routerKey))?.name, "Encrypted router");
    assert.deepEqual((await findAccount(routerKey))?.providerQuotas.example, {
      dailyRequestLimit: 100,
      monthlyTokenLimit: 50_000,
      warningThresholdPercent: 75,
    });
    assert.deepEqual(await getProviderKeys(routerKey), {
      example: "provider-secret-value",
    });
  } finally {
    if (previousPath === undefined) delete process.env.ACCOUNTS_PATH;
    else process.env.ACCOUNTS_PATH = previousPath;
    if (previousKey === undefined) delete process.env.ACCOUNT_ENCRYPTION_KEY;
    else process.env.ACCOUNT_ENCRYPTION_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers a user's router key after sign-in and enforces ownership", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-user-"));
  const storePath = path.join(directory, "accounts.json");
  const previousPath = process.env.ACCOUNTS_PATH;
  const previousKey = process.env.ACCOUNT_ENCRYPTION_KEY;
  process.env.ACCOUNTS_PATH = storePath;
  process.env.ACCOUNT_ENCRYPTION_KEY = randomBytes(32).toString("base64url");

  try {
    const created = await createAccount("Signed-in router", "user_123");
    const recovered = await getAccountForUser("user_123");
    assert.equal(recovered?.routerKey, created.routerKey);
    assert.equal(recovered?.account.id, created.account.id);
    assert.equal(
      (await findAccountForUser(created.routerKey, "user_123"))?.id,
      created.account.id,
    );
    assert.equal(
      await findAccountForUser(created.routerKey, "different_user"),
      undefined,
    );
  } finally {
    if (previousPath === undefined) delete process.env.ACCOUNTS_PATH;
    else process.env.ACCOUNTS_PATH = previousPath;
    if (previousKey === undefined) delete process.env.ACCOUNT_ENCRYPTION_KEY;
    else process.env.ACCOUNT_ENCRYPTION_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
});


test("persists router name and routing policy settings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-settings-"));
  const storePath = path.join(directory, "accounts.json");
  const previousPath = process.env.ACCOUNTS_PATH;
  const previousKey = process.env.ACCOUNT_ENCRYPTION_KEY;
  process.env.ACCOUNTS_PATH = storePath;
  process.env.ACCOUNT_ENCRYPTION_KEY = randomBytes(32).toString("base64url");

  try {
    const created = await createAccount("Original router");
    const updated = await updateAccountSettings(created.routerKey, {
      name: "Production router",
      routingPolicy: {
        strategy: "smart",
        providerOrder: ["groq", "mistral"],
      },
      capabilityRoutingSettings: { unknownMode: "strict" },
      deduplicationSettings: {
        enabled: true,
        windowMs: 45_000,
        automaticFingerprinting: false,
        requireIdempotencyKey: true,
        bypassToolRequests: true,
        bypassMultimodalRequests: true,
        bypassNonDeterministicRequests: true,
      },
      reliabilitySettings: {
        providerTimeoutMs: 8_000,
        totalRequestTimeoutMs: 30_000,
        maxProviderAttempts: 2,
        initialBackoffMs: 100,
        maxBackoffMs: 1_000,
        backoffMultiplier: 2,
        useJitter: false,
        retryStatusCodes: [429, 503],
        retryNetworkErrors: true,
        retryMalformedResponses: false,
        streamingConnectionTimeoutMs: 10_000,
        halfOpenProbeTimeoutMs: 4_000,
        providerTimeoutOverrides: { mistral: 12_000 },
      },
      modelAliases: [
        ...created.account.modelAliases,
        {
          id: "custom-router",
          name: "Custom Router",
          enabled: true,
          routingStrategy: "fastest",
          requiredCapabilities: ["vision"],
          eligibleProviderIds: ["mistral"],
          providerOrder: ["mistral"],
          reliabilityOverrides: {
            providerTimeoutMs: 4_000,
            totalRequestTimeoutMs: 12_000,
            maxProviderAttempts: 1,
          },
        },
      ],
    });

    assert.equal(updated?.name, "Production router");
    assert.deepEqual(updated?.routingPolicy, {
      strategy: "smart",
      providerOrder: ["groq", "mistral"],
    });
    assert.deepEqual((await findAccount(created.routerKey))?.routingPolicy, {
      strategy: "smart",
      providerOrder: ["groq", "mistral"],
    });
    assert.equal(updated?.capabilityRoutingSettings.unknownMode, "strict");
    assert.equal((await findAccount(created.routerKey))?.capabilityRoutingSettings.unknownMode, "strict");
    assert.equal(updated?.deduplicationSettings.windowMs, 45_000);
    assert.equal(updated?.deduplicationSettings.requireIdempotencyKey, true);
    assert.equal(updated?.deduplicationSettings.automaticFingerprinting, false);
    assert.equal((await findAccount(created.routerKey))?.deduplicationSettings.windowMs, 45_000);
    assert.equal(updated?.reliabilitySettings.maxProviderAttempts, 2);
    assert.deepEqual(updated?.reliabilitySettings.retryStatusCodes, [429, 503]);
    assert.equal(updated?.reliabilitySettings.providerTimeoutOverrides.mistral, 12_000);
    assert.equal(
      updated?.modelAliases.find((alias) => alias.id === "custom-router")?.routingStrategy,
      "fastest",
    );
    assert.deepEqual(
      (await findAccount(created.routerKey))?.modelAliases
        .find((alias) => alias.id === "custom-router")?.requiredCapabilities,
      ["vision"],
    );
    assert.equal(
      (await findAccount(created.routerKey))?.modelAliases
        .find((alias) => alias.id === "custom-router")?.reliabilityOverrides?.providerTimeoutMs,
      4_000,
    );
  } finally {
    if (previousPath === undefined) delete process.env.ACCOUNTS_PATH;
    else process.env.ACCOUNTS_PATH = previousPath;
    if (previousKey === undefined) delete process.env.ACCOUNT_ENCRYPTION_KEY;
    else process.env.ACCOUNT_ENCRYPTION_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test("filters legacy starter aliases from stored account data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-legacy-aliases-"));
  const storePath = path.join(directory, "accounts.json");
  const previousPath = process.env.ACCOUNTS_PATH;
  const previousKey = process.env.ACCOUNT_ENCRYPTION_KEY;
  process.env.ACCOUNTS_PATH = storePath;
  process.env.ACCOUNT_ENCRYPTION_KEY = randomBytes(32).toString("base64url");

  try {
    const created = await createAccount("Legacy router", "legacy_user");
    const stored = JSON.parse(await readFile(storePath, "utf8"));
    stored.accounts[0].modelAliases.push(
      {
        id: "fast-router",
        name: "Fast Router",
        description: "Prefer the provider with the lowest observed latency.",
        enabled: true,
        routingStrategy: "fastest",
        requiredCapabilities: [],
        eligibleProviderIds: [],
        providerOrder: [],
      },
      {
        id: "coding-router",
        name: "Coding Router",
        description: "Require streaming and tool support, then use smart routing.",
        enabled: true,
        routingStrategy: "smart",
        requiredCapabilities: ["streaming", "tools"],
        eligibleProviderIds: [],
        providerOrder: [],
      },
    );
    await writeFile(storePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    assert.deepEqual(
      (await findAccount(created.routerKey))?.modelAliases.map((alias) => alias.id),
      ["free-router", "codex-free-router", "claude-free-router"],
    );
    assert.deepEqual(
      (await getAccountForUser("legacy_user"))?.account.modelAliases.map((alias) => alias.id),
      ["free-router", "codex-free-router", "claude-free-router"],
    );
  } finally {
    if (previousPath === undefined) delete process.env.ACCOUNTS_PATH;
    else process.env.ACCOUNTS_PATH = previousPath;
    if (previousKey === undefined) delete process.env.ACCOUNT_ENCRYPTION_KEY;
    else process.env.ACCOUNT_ENCRYPTION_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrates legacy model-coupled provider IDs to canonical provider identities", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-provider-id-migration-"));
  const storePath = path.join(directory, "accounts.json");
  const previousPath = process.env.ACCOUNTS_PATH;
  const previousKey = process.env.ACCOUNT_ENCRYPTION_KEY;
  process.env.ACCOUNTS_PATH = storePath;
  process.env.ACCOUNT_ENCRYPTION_KEY = randomBytes(32).toString("base64url");

  try {
    const created = await createAccount("Legacy provider identities");
    await setProviderKey(created.routerKey, "openrouter", "openrouter-secret");
    await updateAccountSettings(created.routerKey, {
      routingPolicy: { strategy: "priority", providerOrder: ["openrouter"] },
      modelAliases: [
        ...created.account.modelAliases,
        {
          id: "legacy-route",
          name: "Legacy route",
          enabled: true,
          routingStrategy: "priority",
          requiredCapabilities: [],
          eligibleProviderIds: ["openrouter"],
          providerOrder: ["openrouter"],
        },
      ],
      providerQuotas: {
        openrouter: { dailyRequestLimit: 10, warningThresholdPercent: 80 },
      },
      providerModels: {
        openrouter: {
          activeModelId: "qwen/qwen3-coder:free",
          models: [{ id: "qwen/qwen3-coder:free", status: "unknown" }],
        },
      },
      reliabilitySettings: {
        ...created.account.reliabilitySettings,
        providerTimeoutOverrides: { openrouter: 12_000 },
      },
    });

    const stored = JSON.parse(await readFile(storePath, "utf8"));
    const account = stored.accounts[0];
    account.providerKeys["openrouter-qwen"] = account.providerKeys.openrouter;
    delete account.providerKeys.openrouter;
    account.routingPolicy.providerOrder = ["openrouter-qwen", "groq-llama"];
    account.providerQuotas["openrouter-qwen"] = account.providerQuotas.openrouter;
    delete account.providerQuotas.openrouter;
    account.providerModels["openrouter-qwen"] = account.providerModels.openrouter;
    delete account.providerModels.openrouter;
    account.reliabilitySettings.providerTimeoutOverrides = {
      "openrouter-qwen": 12_000,
    };
    const alias = account.modelAliases.find((item: { id: string }) => item.id === "legacy-route");
    alias.eligibleProviderIds = ["openrouter-qwen"];
    alias.providerOrder = ["openrouter-qwen"];
    await writeFile(storePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    const migrated = await findAccount(created.routerKey);
    assert.deepEqual(migrated?.configuredProviderIds, ["openrouter"]);
    assert.deepEqual(migrated?.routingPolicy.providerOrder, ["openrouter", "groq"]);
    assert.ok(migrated?.providerQuotas.openrouter);
    assert.ok(migrated?.providerModels.openrouter);
    assert.equal(migrated?.reliabilitySettings.providerTimeoutOverrides.openrouter, 12_000);
    assert.deepEqual(
      migrated?.modelAliases.find((item) => item.id === "legacy-route")?.eligibleProviderIds,
      ["openrouter"],
    );
    assert.deepEqual(await getProviderKeys(created.routerKey), {
      openrouter: "openrouter-secret",
    });

    await setProviderKey(created.routerKey, "openrouter-qwen", "updated-secret");
    const rewritten = JSON.parse(await readFile(storePath, "utf8")).accounts[0];
    assert.ok(rewritten.providerKeys.openrouter);
    assert.equal(rewritten.providerKeys["openrouter-qwen"], undefined);
  } finally {
    if (previousPath === undefined) delete process.env.ACCOUNTS_PATH;
    else process.env.ACCOUNTS_PATH = previousPath;
    if (previousKey === undefined) delete process.env.ACCOUNT_ENCRYPTION_KEY;
    else process.env.ACCOUNT_ENCRYPTION_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
});
