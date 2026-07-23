import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Redis } from "@upstash/redis";
import type {
  CapabilityRoutingSettings,
  DeduplicationSettings,
  ModelAlias,
  ModelCapabilityState,
  ProviderCapabilityName,
  ProviderQuotaConfig,
  ProviderModelCatalog,
  ProviderModelStatus,
  ReliabilitySettings,
  RoutingPolicy,
  RoutingStrategy,
} from "./types.js";
import { DEFAULT_MODEL_ALIASES, normalizeModelAliases } from "./model-aliases.js";
import { normalizeProviderModelCatalog, normalizeProviderModelCatalogMap } from "./provider-models.js";
import {
  DEFAULT_CAPABILITY_ROUTING_SETTINGS,
  normalizeCapabilityRoutingSettings,
} from "./provider-capabilities.js";
import { normalizeProviderQuotaConfig, normalizeProviderQuotaMap } from "./provider-quotas.js";
import { DEFAULT_RELIABILITY_SETTINGS, normalizeReliabilitySettings } from "./reliability-settings.js";
import {
  DEFAULT_DEDUPLICATION_SETTINGS,
  normalizeDeduplicationSettings,
} from "./deduplication.js";
import {
  normalizeProviderId,
  normalizeProviderIds,
  normalizeProviderRecord,
} from "./provider-identities.js";

interface StoredAccount {
  id: string;
  name: string;
  ownerUserId?: string;
  encryptedRouterKey?: string;
  routerKeyHash: string;
  routerKeyPrefix: string;
  createdAt: string;
  providerKeys: Record<string, string>;
  routingPolicy?: RoutingPolicy;
  modelAliases?: ModelAlias[];
  providerQuotas?: Record<string, ProviderQuotaConfig>;
  providerModels?: Record<string, ProviderModelCatalog>;
  capabilityRoutingSettings?: CapabilityRoutingSettings;
  reliabilitySettings?: ReliabilitySettings;
  deduplicationSettings?: DeduplicationSettings;
}

interface AccountStore {
  accounts: StoredAccount[];
}

export interface AccountSummary {
  id: string;
  name: string;
  routerKeyPrefix: string;
  createdAt: string;
  configuredProviderIds: string[];
  routingPolicy: RoutingPolicy;
  modelAliases: ModelAlias[];
  providerQuotas: Record<string, ProviderQuotaConfig>;
  providerModels: Record<string, ProviderModelCatalog>;
  capabilityRoutingSettings: CapabilityRoutingSettings;
  reliabilitySettings: ReliabilitySettings;
  deduplicationSettings: DeduplicationSettings;
}

const ACCOUNT_INDEX_KEY = "freellm:accounts";
const ACCOUNT_KEY_PREFIX = "freellm:account:";
const USER_ACCOUNT_PREFIX = "freellm:user-account:";
const CREATE_LIMIT = 50;
const CREATE_WINDOW_SECONDS = 60 * 60;
const localCreateAttempts = new Map<string, { count: number; expiresAt: number }>();

const ROUTING_STRATEGIES = new Set<RoutingStrategy>([
  "priority",
  "fastest",
  "round-robin",
  "least-used",
  "reliability",
  "smart",
]);

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  strategy: "priority",
  providerOrder: [],
};

function normalizeRoutingPolicy(value: unknown): RoutingPolicy {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_ROUTING_POLICY, providerOrder: [] };
  }

  const candidate = value as Partial<RoutingPolicy>;
  const strategy = ROUTING_STRATEGIES.has(candidate.strategy as RoutingStrategy)
    ? (candidate.strategy as RoutingStrategy)
    : DEFAULT_ROUTING_POLICY.strategy;
  const providerOrder = Array.isArray(candidate.providerOrder)
    ? normalizeProviderIds(candidate.providerOrder.filter((id): id is string =>
        typeof id === "string" && id.trim().length > 0,
      ))
    : [];

  return { strategy, providerOrder };
}

function storePath(): string {
  return path.resolve(process.env.ACCOUNTS_PATH ?? ".freellm/accounts.json");
}

function redisClient(): Redis | undefined {
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : undefined;
}

function encryptionKey(): Buffer | undefined {
  const encoded = process.env.ACCOUNT_ENCRYPTION_KEY;
  if (!encoded) return undefined;
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) {
    throw new Error("ACCOUNT_ENCRYPTION_KEY must be a 32-byte base64url value");
  }
  return key;
}

function encryptCredential(value: string): string {
  const key = encryptionKey();
  if (!key) {
    if (redisClient()) {
      throw new Error("ACCOUNT_ENCRYPTION_KEY is required for hosted storage");
    }
    return value;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${Buffer.concat([iv, tag, encrypted]).toString("base64url")}`;
}

function decryptCredential(value: string): string {
  if (!value.startsWith("v1.")) return value;
  const key = encryptionKey();
  if (!key) throw new Error("ACCOUNT_ENCRYPTION_KEY is required to read credentials");

  const payload = Buffer.from(value.slice(3), "base64url");
  if (payload.length < 29) throw new Error("Invalid encrypted credential");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8",
  );
}

export function hashRouterKey(routerKey: string): string {
  return createHash("sha256").update(routerKey).digest("hex");
}

function safeHashEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function accountKey(routerKeyHash: string): string {
  return `${ACCOUNT_KEY_PREFIX}${routerKeyHash}`;
}

function normalizeStoredAccount(account: StoredAccount): StoredAccount {
  return {
    ...account,
    providerKeys: normalizeProviderRecord(account.providerKeys),
    routingPolicy: normalizeRoutingPolicy(account.routingPolicy),
    modelAliases: normalizeModelAliases(account.modelAliases),
    providerQuotas: normalizeProviderQuotaMap(account.providerQuotas),
    providerModels: normalizeProviderModelCatalogMap(account.providerModels),
    capabilityRoutingSettings: normalizeCapabilityRoutingSettings(
      account.capabilityRoutingSettings,
    ),
    reliabilitySettings: normalizeReliabilitySettings(account.reliabilitySettings),
    deduplicationSettings: normalizeDeduplicationSettings(account.deduplicationSettings),
  };
}

async function loadLocalStore(): Promise<AccountStore> {
  try {
    const parsed = JSON.parse(await readFile(storePath(), "utf8")) as AccountStore;
    if (!Array.isArray(parsed.accounts)) throw new Error("Invalid account store");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { accounts: [] };
    }
    throw error;
  }
}

async function saveLocalStore(store: AccountStore): Promise<void> {
  const target = storePath();
  const directory = path.dirname(target);
  const temporary = `${target}.${process.pid}.tmp`;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

async function readStoredAccount(
  routerKeyHash: string,
): Promise<StoredAccount | undefined> {
  const redis = redisClient();
  if (redis) {
    const account = await redis.get<StoredAccount>(accountKey(routerKeyHash));
    return account ? normalizeStoredAccount(account) : undefined;
  }

  const store = await loadLocalStore();
  const account = store.accounts.find((candidate) =>
    safeHashEquals(candidate.routerKeyHash, routerKeyHash),
  );
  return account ? normalizeStoredAccount(account) : undefined;
}

async function writeStoredAccount(account: StoredAccount): Promise<void> {
  account = normalizeStoredAccount(account);
  const redis = redisClient();
  if (redis) {
    const writes: Array<Promise<unknown>> = [
      redis.set(accountKey(account.routerKeyHash), account),
      redis.sadd(ACCOUNT_INDEX_KEY, account.routerKeyHash),
    ];
    if (account.ownerUserId) {
      writes.push(
        redis.set(`${USER_ACCOUNT_PREFIX}${account.ownerUserId}`, account.routerKeyHash),
      );
    }
    await Promise.all(writes);
    return;
  }

  const store = await loadLocalStore();
  const index = store.accounts.findIndex((candidate) =>
    safeHashEquals(candidate.routerKeyHash, account.routerKeyHash),
  );
  if (index >= 0) store.accounts[index] = account;
  else store.accounts.push(account);
  await saveLocalStore(store);
}

function summarize(account: StoredAccount): AccountSummary {
  return {
    id: account.id,
    name: account.name,
    routerKeyPrefix: account.routerKeyPrefix,
    createdAt: account.createdAt,
    configuredProviderIds: Object.keys(normalizeProviderRecord(account.providerKeys)),
    routingPolicy: normalizeRoutingPolicy(account.routingPolicy),
    modelAliases: normalizeModelAliases(account.modelAliases),
    providerQuotas: normalizeProviderQuotaMap(account.providerQuotas),
    providerModels: normalizeProviderModelCatalogMap(account.providerModels),
    capabilityRoutingSettings: normalizeCapabilityRoutingSettings(account.capabilityRoutingSettings),
    reliabilitySettings: normalizeReliabilitySettings(account.reliabilitySettings),
    deduplicationSettings: normalizeDeduplicationSettings(account.deduplicationSettings),
  };
}

export async function allowAccountCreation(clientId: string): Promise<boolean> {
  const fingerprint = createHash("sha256").update(clientId).digest("hex");
  const redis = redisClient();
  if (redis) {
    const key = `freellm:create-limit:${fingerprint}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, CREATE_WINDOW_SECONDS);
    return count <= CREATE_LIMIT;
  }

  const now = Date.now();
  const attempt = localCreateAttempts.get(fingerprint);
  if (!attempt || attempt.expiresAt <= now) {
    localCreateAttempts.set(fingerprint, {
      count: 1,
      expiresAt: now + CREATE_WINDOW_SECONDS * 1000,
    });
    return true;
  }
  attempt.count += 1;
  return attempt.count <= CREATE_LIMIT;
}

export async function createAccount(
  name: string,
  ownerUserId?: string,
): Promise<{ account: AccountSummary; routerKey: string }> {
  const routerKey = `flm_${randomBytes(32).toString("base64url")}`;
  const account: StoredAccount = {
    id: randomUUID(),
    name,
    ...(ownerUserId
      ? {
          ownerUserId,
          encryptedRouterKey: encryptCredential(routerKey),
        }
      : {}),
    routerKeyHash: hashRouterKey(routerKey),
    routerKeyPrefix: routerKey.slice(0, 12),
    createdAt: new Date().toISOString(),
    providerKeys: {},
    routingPolicy: { ...DEFAULT_ROUTING_POLICY, providerOrder: [] },
    providerQuotas: {},
    providerModels: {},
    capabilityRoutingSettings: { ...DEFAULT_CAPABILITY_ROUTING_SETTINGS },
    deduplicationSettings: { ...DEFAULT_DEDUPLICATION_SETTINGS },
    reliabilitySettings: {
      ...DEFAULT_RELIABILITY_SETTINGS,
      retryStatusCodes: [...DEFAULT_RELIABILITY_SETTINGS.retryStatusCodes],
      providerTimeoutOverrides: {},
    },
    modelAliases: DEFAULT_MODEL_ALIASES.map((alias) => ({
      ...alias,
      requiredCapabilities: [...alias.requiredCapabilities],
      eligibleProviderIds: [...alias.eligibleProviderIds],
      providerOrder: [...alias.providerOrder],
    })),
  };

  await writeStoredAccount(account);
  return { account: summarize(account), routerKey };
}

export async function getAccountForUser(
  userId: string,
): Promise<{ account: AccountSummary; routerKey: string } | undefined> {
  const redis = redisClient();
  let account: StoredAccount | undefined;
  if (redis) {
    const routerKeyHash = await redis.get<string>(`${USER_ACCOUNT_PREFIX}${userId}`);
    if (routerKeyHash) account = await readStoredAccount(routerKeyHash);
  } else {
    account = (await loadLocalStore()).accounts.find(
      (candidate) => candidate.ownerUserId === userId,
    );
  }
  if (!account?.encryptedRouterKey) return undefined;
  return {
    account: summarize(account),
    routerKey: decryptCredential(account.encryptedRouterKey),
  };
}

export async function findAccountForUser(
  routerKey: string,
  userId: string,
): Promise<AccountSummary | undefined> {
  const account = await readStoredAccount(hashRouterKey(routerKey));
  return account?.ownerUserId === userId ? summarize(account) : undefined;
}

export async function listAccounts(): Promise<AccountSummary[]> {
  const redis = redisClient();
  if (!redis) {
    return (await loadLocalStore()).accounts.map(summarize);
  }

  const hashes = await redis.smembers<string[]>(ACCOUNT_INDEX_KEY);
  if (hashes.length === 0) return [];
  const accounts = await Promise.all(
    hashes.map((hash) => redis.get<StoredAccount>(accountKey(hash))),
  );
  return accounts.filter((account): account is StoredAccount => Boolean(account)).map(summarize);
}

export async function findAccount(
  routerKey: string,
): Promise<AccountSummary | undefined> {
  const account = await readStoredAccount(hashRouterKey(routerKey));
  return account ? summarize(account) : undefined;
}

export async function getProviderKeys(
  routerKey: string,
): Promise<Record<string, string> | undefined> {
  return getProviderKeysByHash(hashRouterKey(routerKey));
}

export async function getProviderKeysByHash(
  routerKeyHash: string,
): Promise<Record<string, string> | undefined> {
  const account = await readStoredAccount(routerKeyHash);
  if (!account) return undefined;
  return Object.fromEntries(
    Object.entries(account.providerKeys).map(([providerId, apiKey]) => [
      providerId,
      decryptCredential(apiKey),
    ]),
  );
}

export async function setProviderKey(
  routerKey: string,
  providerId: string,
  apiKey: string,
): Promise<AccountSummary | undefined> {
  providerId = normalizeProviderId(providerId);
  const account = await readStoredAccount(hashRouterKey(routerKey));
  if (!account) return undefined;

  account.providerKeys[providerId] = encryptCredential(apiKey);
  await writeStoredAccount(account);
  return summarize(account);
}

export async function deleteProviderKey(
  routerKey: string,
  providerId: string,
): Promise<AccountSummary | undefined> {
  providerId = normalizeProviderId(providerId);
  const account = await readStoredAccount(hashRouterKey(routerKey));
  if (!account) return undefined;

  delete account.providerKeys[providerId];
  await writeStoredAccount(account);
  return summarize(account);
}

export async function updateAccountSettings(
  routerKey: string,
  updates: {
    name?: string;
    routingPolicy?: RoutingPolicy;
    modelAliases?: ModelAlias[];
    providerQuotas?: Record<string, ProviderQuotaConfig>;
  providerModels?: Record<string, ProviderModelCatalog>;
    capabilityRoutingSettings?: CapabilityRoutingSettings;
    reliabilitySettings?: ReliabilitySettings;
    deduplicationSettings?: DeduplicationSettings;
  },
): Promise<AccountSummary | undefined> {
  const account = await readStoredAccount(hashRouterKey(routerKey));
  if (!account) return undefined;

  if (typeof updates.name === "string" && updates.name.trim()) {
    account.name = updates.name.trim().slice(0, 80);
  }

  if (updates.routingPolicy) {
    account.routingPolicy = normalizeRoutingPolicy(updates.routingPolicy);
  }

  if (updates.modelAliases !== undefined) {
    account.modelAliases = normalizeModelAliases(updates.modelAliases);
  }

  if (updates.providerQuotas !== undefined) {
    account.providerQuotas = normalizeProviderQuotaMap(updates.providerQuotas);
  }

  if (updates.providerModels !== undefined) {
    account.providerModels = normalizeProviderModelCatalogMap(updates.providerModels);
  }

  if (updates.capabilityRoutingSettings !== undefined) {
    account.capabilityRoutingSettings = normalizeCapabilityRoutingSettings(
      updates.capabilityRoutingSettings,
    );
  }

  if (updates.reliabilitySettings !== undefined) {
    account.reliabilitySettings = normalizeReliabilitySettings(updates.reliabilitySettings);
  }

  if (updates.deduplicationSettings !== undefined) {
    account.deduplicationSettings = normalizeDeduplicationSettings(
      updates.deduplicationSettings,
    );
  }

  await writeStoredAccount(account);
  return summarize(account);
}

export async function setProviderQuota(
  routerKey: string,
  providerId: string,
  quota: unknown,
): Promise<AccountSummary | undefined> {
  providerId = normalizeProviderId(providerId);
  const account = await readStoredAccount(hashRouterKey(routerKey));
  if (!account) return undefined;

  const normalized = normalizeProviderQuotaConfig(quota);
  account.providerQuotas = normalizeProviderQuotaMap(account.providerQuotas);
  if (normalized) account.providerQuotas[providerId] = normalized;
  else delete account.providerQuotas[providerId];
  await writeStoredAccount(account);
  return summarize(account);
}

export async function deleteProviderQuota(
  routerKey: string,
  providerId: string,
): Promise<AccountSummary | undefined> {
  providerId = normalizeProviderId(providerId);
  const account = await readStoredAccount(hashRouterKey(routerKey));
  if (!account) return undefined;
  account.providerQuotas = normalizeProviderQuotaMap(account.providerQuotas);
  delete account.providerQuotas[providerId];
  await writeStoredAccount(account);
  return summarize(account);
}

export async function setProviderModelCatalog(
  routerKey: string,
  providerId: string,
  catalog: ProviderModelCatalog,
): Promise<AccountSummary | undefined> {
  providerId = normalizeProviderId(providerId);
  const account = await readStoredAccount(hashRouterKey(routerKey));
  if (!account) return undefined;
  const normalized = normalizeProviderModelCatalog(catalog);
  if (!normalized) throw new Error("A provider must have at least one saved model");
  account.providerModels = normalizeProviderModelCatalogMap(account.providerModels);
  account.providerModels[providerId] = normalized;
  await writeStoredAccount(account);
  return summarize(account);
}

export async function updateProviderModelHealthByHash(
  routerKeyHash: string,
  providerId: string,
  modelId: string,
  update: {
    status: ProviderModelStatus;
    lastStatus?: number;
    lastError?: string;
    checkedAt?: string;
  },
): Promise<void> {
  providerId = normalizeProviderId(providerId);
  const account = await readStoredAccount(routerKeyHash);
  if (!account) return;
  account.providerModels = normalizeProviderModelCatalogMap(account.providerModels);
  const existing = account.providerModels[providerId] ?? {
    activeModelId: modelId,
    models: [{ id: modelId, status: "unknown" as const }],
  };
  const models = existing.models.map((model) => {
    if (model.id !== modelId) return model;
    const next = {
      ...model,
      status: update.status,
      ...(update.lastStatus !== undefined ? { lastStatus: update.lastStatus } : {}),
      ...(update.lastError ? { lastError: update.lastError.slice(0, 500) } : {}),
      lastCheckedAt: update.checkedAt ?? new Date().toISOString(),
    };
    if (!update.lastError) delete next.lastError;
    return next;
  });
  if (!models.some((model) => model.id === modelId)) {
    models.push({
      id: modelId,
      status: update.status,
      ...(update.lastStatus !== undefined ? { lastStatus: update.lastStatus } : {}),
      ...(update.lastError ? { lastError: update.lastError.slice(0, 500) } : {}),
      lastCheckedAt: update.checkedAt ?? new Date().toISOString(),
    });
  }
  account.providerModels[providerId] = { ...existing, models };
  await writeStoredAccount(account);
}


export async function updateProviderModelCapabilitiesByHash(
  routerKeyHash: string,
  providerId: string,
  modelId: string,
  updates: Partial<Record<ProviderCapabilityName, ModelCapabilityState>>,
): Promise<void> {
  providerId = normalizeProviderId(providerId);
  const account = await readStoredAccount(routerKeyHash);
  if (!account) return;
  account.providerModels = normalizeProviderModelCatalogMap(account.providerModels);
  const existing = account.providerModels[providerId] ?? {
    activeModelId: modelId,
    models: [{ id: modelId, status: "unknown" as const }],
  };
  const sourcePriority = { provider: 1, catalog: 2, runtime: 3, probe: 4, user: 5 } as const;
  const models = existing.models.map((model) => {
    if (model.id !== modelId) return model;
    const capabilities = { ...(model.capabilities ?? {}) };
    for (const [name, update] of Object.entries(updates) as Array<[ProviderCapabilityName, ModelCapabilityState]>) {
      const current = capabilities[name];
      if (current && sourcePriority[current.source] > sourcePriority[update.source]) continue;
      if (current && update.value === "unknown" && current.value !== "unknown" && update.source !== "user") continue;
      capabilities[name] = update;
    }
    return { ...model, capabilities };
  });
  if (!models.some((model) => model.id === modelId)) {
    models.push({
      id: modelId,
      status: "unknown",
      capabilities: { ...updates },
    });
  }
  account.providerModels[providerId] = { ...existing, models };
  await writeStoredAccount(account);
}
