import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import type {
  LocalNodePairingCode,
  StoredLocalNode,
} from "./local-node-types.js";

interface LocalNodeStoreData {
  pairingCodes: LocalNodePairingCode[];
  nodes: StoredLocalNode[];
}

const NODE_KEY_PREFIX = "freellm:local-node:";
const OWNER_NODE_PREFIX = "freellm:local-nodes:owner:";
const PAIRING_KEY_PREFIX = "freellm:local-node-pairing:";
let localMutationQueue: Promise<void> = Promise.resolve();
const localPairAttempts = new Map<string, { count: number; expiresAt: number }>();
const PAIR_ATTEMPT_LIMIT = 30;
const PAIR_ATTEMPT_WINDOW_SECONDS = 10 * 60;
const REDIS_NODE_LOCK_MS = 5_000;

function storePath(): string {
  return path.resolve(
    process.env.LOCAL_NODES_PATH ?? ".freellm/local-nodes.json",
  );
}

function redisClient(): Redis | undefined {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : undefined;
}

function pairingKey(codeHash: string): string {
  return `${PAIRING_KEY_PREFIX}${codeHash}`;
}

function nodeKey(nodeId: string): string {
  return `${NODE_KEY_PREFIX}${nodeId}`;
}

function nodeLockKey(nodeId: string): string {
  return `freellm:local-node-lock:${nodeId}`;
}

async function withRedisNodeLock<T>(
  redis: Redis,
  nodeId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const token = randomUUID();
  const key = nodeLockKey(nodeId);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const acquired = await redis.set(key, token, { nx: true, px: REDIS_NODE_LOCK_MS });
    if (acquired === "OK") {
      try {
        return await operation();
      } finally {
        await redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          [key],
          [token],
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out acquiring local node mutation lock for ${nodeId}`);
}

async function loadLocalStore(): Promise<LocalNodeStoreData> {
  try {
    const parsed = JSON.parse(await readFile(storePath(), "utf8")) as Partial<LocalNodeStoreData>;
    return {
      pairingCodes: Array.isArray(parsed.pairingCodes) ? parsed.pairingCodes : [],
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { pairingCodes: [], nodes: [] };
    }
    throw error;
  }
}

async function saveLocalStore(store: LocalNodeStoreData): Promise<void> {
  const target = storePath();
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

async function mutateLocalStore<T>(
  operation: (store: LocalNodeStoreData) => T | Promise<T>,
): Promise<T> {
  let resolveResult!: (value: T | PromiseLike<T>) => void;
  let rejectResult!: (reason?: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  localMutationQueue = localMutationQueue.then(async () => {
    try {
      const store = await loadLocalStore();
      const value = await operation(store);
      await saveLocalStore(store);
      resolveResult(value);
    } catch (error) {
      rejectResult(error);
    }
  });
  return result;
}

export async function storePairingCode(
  pairingCode: LocalNodePairingCode,
): Promise<void> {
  const redis = redisClient();
  if (redis) {
    const ttlSeconds = Math.max(
      1,
      Math.ceil((Date.parse(pairingCode.expiresAt) - Date.now()) / 1_000),
    );
    await redis.set(pairingKey(pairingCode.codeHash), pairingCode, {
      ex: ttlSeconds,
    });
    return;
  }

  await mutateLocalStore((store) => {
    const now = Date.now();
    store.pairingCodes = store.pairingCodes.filter(
      (candidate) =>
        Date.parse(candidate.expiresAt) > now &&
        candidate.codeHash !== pairingCode.codeHash,
    );
    store.pairingCodes.push(pairingCode);
  });
}

export async function allowLocalNodePairingAttempt(clientId: string): Promise<boolean> {
  const fingerprint = createHash("sha256").update(clientId).digest("hex");
  const redis = redisClient();
  if (redis) {
    const key = `freellm:local-node-pair-limit:${fingerprint}`;
    const count = Number(await redis.eval(
      "local count = redis.call('incr', KEYS[1]); if count == 1 then redis.call('expire', KEYS[1], ARGV[1]); end; return count",
      [key],
      [String(PAIR_ATTEMPT_WINDOW_SECONDS)],
    ));
    return count <= PAIR_ATTEMPT_LIMIT;
  }
  const now = Date.now();
  if (localPairAttempts.size >= 10_000) {
    for (const [key, candidate] of localPairAttempts) {
      if (candidate.expiresAt <= now) localPairAttempts.delete(key);
    }
    if (localPairAttempts.size >= 10_000 && !localPairAttempts.has(fingerprint)) return false;
  }
  const attempt = localPairAttempts.get(fingerprint);
  if (!attempt || attempt.expiresAt <= now) {
    localPairAttempts.set(fingerprint, {
      count: 1,
      expiresAt: now + PAIR_ATTEMPT_WINDOW_SECONDS * 1_000,
    });
    return true;
  }
  attempt.count += 1;
  return attempt.count <= PAIR_ATTEMPT_LIMIT;
}

export async function consumePairingCode(
  codeHash: string,
): Promise<LocalNodePairingCode | undefined> {
  const redis = redisClient();
  if (redis) {
    return (await redis.getdel<LocalNodePairingCode>(pairingKey(codeHash))) ?? undefined;
  }

  return mutateLocalStore((store) => {
    const index = store.pairingCodes.findIndex(
      (candidate) => candidate.codeHash === codeHash,
    );
    if (index < 0) return undefined;
    const [pairingCode] = store.pairingCodes.splice(index, 1);
    return pairingCode;
  });
}

export async function writeLocalNode(node: StoredLocalNode): Promise<void> {
  const redis = redisClient();
  if (redis) {
    await Promise.all([
      redis.set(nodeKey(node.id), node),
      redis.sadd(`${OWNER_NODE_PREFIX}${node.ownerAccountId}`, node.id),
    ]);
    return;
  }

  await mutateLocalStore((store) => {
    const index = store.nodes.findIndex((candidate) => candidate.id === node.id);
    if (index >= 0) store.nodes[index] = node;
    else store.nodes.push(node);
  });
}

export async function deleteStoredLocalNode(
  ownerAccountId: string,
  nodeId: string,
): Promise<boolean> {
  const redis = redisClient();
  if (redis) {
    return withRedisNodeLock(redis, nodeId, async () => {
      const node = await redis.get<StoredLocalNode>(nodeKey(nodeId));
      if (!node || node.ownerAccountId !== ownerAccountId) return false;
      await Promise.all([
        redis.del(nodeKey(nodeId)),
        redis.srem(`${OWNER_NODE_PREFIX}${ownerAccountId}`, nodeId),
      ]);
      return true;
    });
  }

  return mutateLocalStore((store) => {
    const index = store.nodes.findIndex(
      (candidate) =>
        candidate.id === nodeId && candidate.ownerAccountId === ownerAccountId,
    );
    if (index < 0) return false;
    store.nodes.splice(index, 1);
    return true;
  });
}

export async function readLocalNode(
  nodeId: string,
): Promise<StoredLocalNode | undefined> {
  const redis = redisClient();
  if (redis) {
    return (await redis.get<StoredLocalNode>(nodeKey(nodeId))) ?? undefined;
  }
  return (await loadLocalStore()).nodes.find((candidate) => candidate.id === nodeId);
}

export async function updateStoredLocalNode(
  nodeId: string,
  update: (node: StoredLocalNode) => void | Promise<void>,
): Promise<StoredLocalNode | undefined> {
  const redis = redisClient();
  if (redis) {
    return withRedisNodeLock(redis, nodeId, async () => {
      const node = await redis.get<StoredLocalNode>(nodeKey(nodeId));
      if (!node) return undefined;
      await update(node);
      await redis.set(nodeKey(node.id), node);
      return node;
    });
  }

  return mutateLocalStore(async (store) => {
    const node = store.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return undefined;
    await update(node);
    return node;
  });
}

export async function listLocalNodesForOwner(
  ownerAccountId: string,
): Promise<StoredLocalNode[]> {
  const redis = redisClient();
  if (redis) {
    const nodeIds = await redis.smembers<string[]>(
      `${OWNER_NODE_PREFIX}${ownerAccountId}`,
    );
    if (nodeIds.length === 0) return [];
    const nodes = await Promise.all(
      nodeIds.map((nodeId) => redis.get<StoredLocalNode>(nodeKey(nodeId))),
    );
    return nodes.filter(
      (node): node is StoredLocalNode =>
        Boolean(node) && node?.ownerAccountId === ownerAccountId,
    );
  }

  return (await loadLocalStore()).nodes.filter(
    (candidate) => candidate.ownerAccountId === ownerAccountId,
  );
}
