import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAccount, deleteProviderKey, findAccount, getProviderKeys, hashRouterKey, listAccounts,
  setProviderKey, setProviderModelCatalog, setProviderQuota, updateAccountSettings,
  updateProviderModelCapabilitiesByHash, updateProviderModelHealthByHash,
} from "../src/accounts.js";
import {
  claimProviderHalfOpenProbe, getRoutingStats, prepareProviderCircuitRetry,
  recordProviderTokenUsage, recordRoutingAttempt,
} from "../src/routing-state.js";

test("concurrent storage mutations preserve account data, usage, and exclusive recovery probes", async (t) => {
  for (const backend of ["file", "redis"] as const) {
    await t.test(backend, async (t) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "flr-concurrent-storage-"));
      const names = [
        "ACCOUNTS_PATH", "ROUTING_STATE_PATH", "ACCOUNT_ENCRYPTION_KEY",
        "KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
      ];
      const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
      for (const name of names) delete process.env[name];
      process.env.ACCOUNTS_PATH = path.join(directory, "accounts.json");
      process.env.ROUTING_STATE_PATH = path.join(directory, "routing.json");
      process.env.ACCOUNT_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
      let conflicts = 0;
      if (backend === "redis") {
        process.env.KV_REST_API_URL = "https://mock-redis.invalid";
        process.env.KV_REST_API_TOKEN = "test-token";
        const values = new Map<string, string>();
        const sets = new Map<string, Set<string>>();
        const version = (value: string | undefined) =>
          value === undefined ? "" : createHash("sha1").update(value).digest("hex");
        t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          assert.ok(String(input).startsWith("https://mock-redis.invalid"));
          const payload = JSON.parse(String(init?.body));
          const run = (command: string[]) => {
            const [operation, key, ...args] = command as [string, string, ...string[]];
            switch (operation.toLowerCase()) {
              case "get": return { result: values.get(key) ?? null };
              case "set":
                values.set(key, args[0]!);
                return { result: "OK" };
              case "sadd": {
                const members = sets.get(key) ?? new Set<string>();
                members.add(args[0]!);
                sets.set(key, members);
                return { result: 1 };
              }
              case "smembers": return { result: [...(sets.get(key) ?? [])] };
              case "eval": {
                const script = key;
                const storedKey = args[1]!;
                if (script.includes("return {redis.sha1hex(value), value}")) {
                  const raw = values.get(storedKey);
                  return { result: [version(raw), raw ?? null] };
                }
                assert.ok(script.includes("version ~= ARGV[1]"), "Unexpected Redis script");
                if (version(values.get(storedKey)) !== args[2]) {
                  conflicts += 1;
                  return { result: 0 };
                }
                values.set(storedKey, args[3]!);
                return { result: 1 };
              }
              default: throw new Error(`Unexpected Redis command: ${operation}`);
            }
          };
          const encode = (value: unknown): unknown => {
            if (typeof value === "string") return Buffer.from(value).toString("base64");
            if (Array.isArray(value)) return value.map(encode);
            return value;
          };
          const respond = (command: string[]) => ({ result: encode(run(command).result) });
          return Response.json(Array.isArray(payload[0]) ? payload.map(respond) : respond(payload));
        });
      }
      try {
        const owners = await Promise.all(Array.from({ length: 6 }, (_, index) => createAccount(`Owner ${index}`)));
        assert.equal((await listAccounts()).length, 6);
        const owner = owners[0]!;
        const hash = hashRouterKey(owner.routerKey);
        await Promise.all([
          ...Array.from({ length: 12 }, (_, index) => setProviderKey(owner.routerKey, `provider-${index}`, `key-${index}`)),
          updateAccountSettings(owner.routerKey, { name: "Renamed" }),
          updateAccountSettings(owner.routerKey, { routingPolicy: { strategy: "least-used", providerOrder: [] } }),
          setProviderQuota(owner.routerKey, "provider-0", { dailyRequestLimit: 100 }),
        ]);
        assert.equal(Object.keys((await getProviderKeys(owner.routerKey))!).length, 12);
        const account = await findAccount(owner.routerKey);
        assert.equal(account?.name, "Renamed");
        assert.equal(account?.routingPolicy.strategy, "least-used");
        assert.equal(account?.providerQuotas["provider-0"]?.dailyRequestLimit, 100);

        await setProviderModelCatalog(owner.routerKey, "provider-0", {
          activeModelId: "model", models: [{ id: "model", status: "unknown" }],
        });
        await Promise.all([
          deleteProviderKey(owner.routerKey, "provider-0"),
          updateProviderModelHealthByHash(hash, "provider-0", "model", { status: "healthy" }),
          updateProviderModelCapabilitiesByHash(hash, "provider-0", "model", { tools: {
            value: "supported", source: "runtime",
            evidence: { observedAt: new Date().toISOString(), validated: true },
          } }),
        ]);
        const model = (await findAccount(owner.routerKey))?.providerModels["provider-0"]?.models[0];
        assert.equal(model?.status, "healthy");
        assert.equal(model?.capabilities?.tools?.value, "supported");
        assert.equal((await getProviderKeys(owner.routerKey))?.["provider-0"], undefined);
        await assert.rejects(setProviderModelCatalog(owner.routerKey, "provider-0", { activeModelId: "", models: [] }));
        await setProviderKey(owner.routerKey, "after-failure", "key");
        assert.equal((await getProviderKeys(owner.routerKey))?.["after-failure"], "key");

        await Promise.all(Array.from({ length: 24 }, async (_, index) => {
          await Promise.all([
            recordRoutingAttempt(hash, { providerId: "provider", success: true, latencyMs: index, status: 200 }),
            recordProviderTokenUsage(hash, "provider", { inputTokens: 2, outputTokens: 3, totalTokens: 5, source: "reported" }),
            getRoutingStats(hash),
          ]);
        }));
        const stats = (await getRoutingStats(hash)).provider!;
        assert.equal(stats.attempts, 24);
        assert.equal(stats.successes, 24);
        assert.equal(stats.quotaUsage?.daily.requests, 24);
        assert.equal(stats.quotaUsage?.daily.totalTokens, 120);
        await prepareProviderCircuitRetry(hash, "provider");
        const claims = await Promise.all(Array.from({ length: 12 }, () => claimProviderHalfOpenProbe(hash, "provider")));
        assert.equal(claims.filter(Boolean).length, 1);
        if (backend === "redis") assert.ok(conflicts > 0, "The test must exercise competing Redis writes");
      } finally {
        for (const name of names) {
          if (previous[name] === undefined) delete process.env[name];
          else process.env[name] = previous[name];
        }
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
