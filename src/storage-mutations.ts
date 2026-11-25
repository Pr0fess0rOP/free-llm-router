import type { Redis } from "@upstash/redis";
import { rename } from "node:fs/promises";

export async function replaceStorageFile(temporary: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 10 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(20 * (attempt + 1), 100)));
    }
  }
}

const mutationQueues = new Map<string, Promise<void>>();

export async function serializeMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(() => {}, () => {});
  mutationQueues.set(key, settled);
  try {
    return await result;
  } finally {
    if (mutationQueues.get(key) === settled) mutationQueues.delete(key);
  }
}

const READ_VERSIONED_JSON = `
local value = redis.call('get', KEYS[1])
if not value then return {'', false} end
return {redis.sha1hex(value), value}
`;

const COMPARE_AND_SET_JSON = `
local current = redis.call('get', KEYS[1])
local version = current and redis.sha1hex(current) or ''
if version ~= ARGV[1] then return 0 end
redis.call('set', KEYS[1], ARGV[2])
return 1
`;

// Reapply the mutation to fresh data if another instance commits first.
export async function mutateRedisJson<T, R>(
  redis: Redis,
  key: string,
  mutate: (current: T | undefined) => { value: T | undefined; result: R },
): Promise<R> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [version, current] = await redis.eval<[], [string, T | null]>(READ_VERSIONED_JSON, [key], []);
    const update = mutate(current ?? undefined);
    if (update.value === undefined) return update.result;
    const committed = await redis.eval<[string, string], number>(
      COMPARE_AND_SET_JSON, [key], [version, JSON.stringify(update.value)],
    );
    if (committed === 1) return update.result;
    await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)));
  }
  throw new Error("Storage update could not complete because of concurrent changes");
}
