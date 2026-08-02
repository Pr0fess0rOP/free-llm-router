import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleRequest } from "../src/server.js";
import { authenticateLocalNode } from "../src/local-nodes/local-node-auth.js";
import { resetLocalNodeSigningKeyCache } from "../src/local-nodes/local-node-request-auth.js";
import {
  createLocalNodePairingCode,
  LOCAL_NODE_PAIRING_TTL_MS,
  LocalNodePairingError,
  pairLocalNode,
} from "../src/local-nodes/pairing-service.js";
import {
  deleteLocalNode,
  getLocalNode,
  listLocalNodes,
  revokeLocalNode,
  recordLocalNodeHeartbeat,
  recordLocalProviderAttempt,
  registerLocalNodeEndpoint,
  rotateLocalNodeCredential,
  syncLocalNodeModels,
  updateLocalNodeModel,
  validateLocalNodeEndpoint,
} from "../src/local-nodes/local-node-service.js";

const REDIS_ENVIRONMENT_VARIABLES = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;

async function withLocalNodeStore(
  operation: (storePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "freellm-local-nodes-"));
  const storePath = path.join(directory, "local-nodes.json");
  const previousPath = process.env.LOCAL_NODES_PATH;
  const previousSigningPath = process.env.LOCAL_NODE_SIGNING_KEY_PATH;
  const previousRedis = Object.fromEntries(
    REDIS_ENVIRONMENT_VARIABLES.map((name) => [name, process.env[name]]),
  );
  process.env.LOCAL_NODES_PATH = storePath;
  process.env.LOCAL_NODE_SIGNING_KEY_PATH = path.join(directory, "signing.json");
  resetLocalNodeSigningKeyCache();
  for (const name of REDIS_ENVIRONMENT_VARIABLES) delete process.env[name];

  try {
    await operation(storePath);
  } finally {
    if (previousPath === undefined) delete process.env.LOCAL_NODES_PATH;
    else process.env.LOCAL_NODES_PATH = previousPath;
    resetLocalNodeSigningKeyCache();
    if (previousSigningPath === undefined) delete process.env.LOCAL_NODE_SIGNING_KEY_PATH;
    else process.env.LOCAL_NODE_SIGNING_KEY_PATH = previousSigningPath;
    for (const name of REDIS_ENVIRONMENT_VARIABLES) {
      const previous = previousRedis[name];
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return address.port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("pairing codes are hashed, expire, and can be used only once", async () => {
  await withLocalNodeStore(async (storePath) => {
    const pairing = await createLocalNodePairingCode("account_1");
    assert.match(pairing.code, /^FLR-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const beforePairing = await readFile(storePath, "utf8");
    assert.doesNotMatch(beforePairing, new RegExp(pairing.code));

    const paired = await pairLocalNode({
      code: pairing.code.toLowerCase(),
      name: "Development PC",
      runtime: "ollama",
      cliVersion: "0.1.0",
    });
    assert.equal(paired.node.ownerAccountId, "account_1");
    assert.equal(paired.node.status, "offline");
    assert.equal(paired.node.runtime, "ollama");
    assert.equal(paired.node.limits.maxConcurrentRequests, 1);
    assert.match(paired.deviceCredential, /^fln_/);

    const stored = await readFile(storePath, "utf8");
    assert.doesNotMatch(stored, new RegExp(paired.deviceCredential));

    await assert.rejects(
      pairLocalNode({
        code: pairing.code,
        name: "Replay PC",
        runtime: "ollama",
      }),
      (error: unknown) =>
        error instanceof LocalNodePairingError &&
        error.code === "invalid_pairing_code",
    );

    const expired = await createLocalNodePairingCode(
      "account_1",
      Date.now() - LOCAL_NODE_PAIRING_TTL_MS - 1,
    );
    await assert.rejects(
      pairLocalNode({
        code: expired.code,
        name: "Expired PC",
        runtime: "ollama",
      }),
      (error: unknown) =>
        error instanceof LocalNodePairingError &&
      error.code === "expired_pairing_code",
    );

    const validationCode = await createLocalNodePairingCode("account_1");
    await assert.rejects(
      pairLocalNode({
        code: validationCode.code,
        name: "Validation PC",
        runtime: "ollama",
        models: [{ id: "invalid model", enabled: true }],
      }),
      (error: unknown) => error instanceof LocalNodePairingError && error.code === "invalid_model_id",
    );
    const afterValidation = await pairLocalNode({
      code: validationCode.code,
      name: "Validation PC",
      runtime: "ollama",
      models: [{ id: "qwen:latest", enabled: true }],
    });
    assert.equal(afterValidation.node.models[0]?.modelId, "qwen:latest");
  });
});

test("node ownership, device authentication, and revocation are enforced", async () => {
  await withLocalNodeStore(async () => {
    const pairing = await createLocalNodePairingCode("owner_account");
    const paired = await pairLocalNode({
      code: pairing.code,
      name: "Private Ollama",
      runtime: "ollama",
    });

    assert.equal(
      (await authenticateLocalNode(paired.node.id, paired.deviceCredential))?.id,
      paired.node.id,
    );
    assert.equal(await authenticateLocalNode(paired.node.id, "fln_wrong"), undefined);
    assert.equal((await getLocalNode("owner_account", paired.node.id))?.credentialFailureCount, 1);
    assert.equal((await listLocalNodes("owner_account")).length, 1);
    assert.equal((await listLocalNodes("other_account")).length, 0);
    assert.equal(
      await getLocalNode("other_account", paired.node.id),
      undefined,
    );
    assert.equal(
      await revokeLocalNode("other_account", paired.node.id),
      undefined,
    );
    assert.equal(
      await updateLocalNodeModel("other_account", paired.node.id, "missing", { enabled: true }),
      undefined,
    );

    const revoked = await revokeLocalNode("owner_account", paired.node.id);
    assert.equal(revoked?.status, "revoked");
    assert.ok(revoked?.revokedAt);
    assert.equal(
      await authenticateLocalNode(paired.node.id, paired.deviceCredential),
      undefined,
    );
    assert.equal((await recordLocalNodeHeartbeat(paired.node.id, {
      agentVersion: "0.7.0",
      activeRequests: 0,
      maxConcurrentRequests: 1,
    }))?.status, "revoked");
    assert.equal(await deleteLocalNode("other_account", paired.node.id), false);
    assert.equal(await deleteLocalNode("owner_account", paired.node.id), true);
    assert.equal(await getLocalNode("owner_account", paired.node.id), undefined);
    assert.equal((await listLocalNodes("owner_account")).length, 0);
    assert.equal(await deleteLocalNode("owner_account", paired.node.id), false);
  });
});

test("the device pairing API exchanges a valid code without exposing its hash", async () => {
  await withLocalNodeStore(async () => {
    const pairing = await createLocalNodePairingCode("api_account");
    const server = createServer((request, response) => {
      void handleRequest(request, response);
    });
    const port = await listen(server);

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/local-nodes/pair`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code: pairing.code,
            name: "API Node",
            runtime: "ollama",
            cliVersion: "0.1.0",
          }),
        },
      );
      assert.equal(response.status, 201);
      const payload = (await response.json()) as {
        node: { id: string; ownerAccountId: string };
        deviceCredential: string;
        credentialHash?: string;
      };
      assert.equal(payload.node.ownerAccountId, "api_account");
      assert.match(payload.deviceCredential, /^fln_/);
      assert.equal(payload.credentialHash, undefined);

      const replay = await fetch(
        `http://127.0.0.1:${port}/api/local-nodes/pair`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code: pairing.code,
            name: "Replay Node",
            runtime: "ollama",
          }),
        },
      );
      assert.equal(replay.status, 400);
      assert.equal(
        ((await replay.json()) as { code: string }).code,
        "invalid_pairing_code",
      );
    } finally {
      await close(server);
    }
  });
});

test("authenticated heartbeat, inventory, endpoint registration, rotation, and status aging work", async () => {
  await withLocalNodeStore(async () => {
    const pairing = await createLocalNodePairingCode("lifecycle_account");
    const paired = await pairLocalNode({
      code: pairing.code,
      name: "Lifecycle node",
      runtime: "ollama",
      models: [{ id: "qwen:latest", enabled: true }],
    });
    const now = Date.now();
    const heartbeat = await recordLocalNodeHeartbeat(paired.node.id, {
      agentVersion: "0.6.0",
      ollamaVersion: "0.12.0",
      activeRequests: 0,
      maxConcurrentRequests: 1,
      models: [{ id: "qwen:latest", installed: true, loaded: true }],
    }, now);
    assert.equal(heartbeat?.status, "online");
    assert.match(heartbeat?.cliVersionWarning ?? "", /may be incompatible/);
    assert.equal((await getLocalNode("lifecycle_account", paired.node.id, now + 46_000))?.status, "unstable");
    assert.equal((await getLocalNode("lifecycle_account", paired.node.id, now + 91_000))?.status, "offline");

    const synced = await syncLocalNodeModels(paired.node.id, [
      { id: "qwen:latest", installed: true },
      { id: "llama:latest", installed: true },
    ]);
    assert.deepEqual(synced?.models.map((model) => model.modelId).sort(), ["llama:latest", "qwen:latest"]);
    assert.equal(synced?.models.find((model) => model.modelId === "llama:latest")?.enabled, false);
    await recordLocalProviderAttempt(paired.node.id, "qwen:latest", {
      success: false,
      latencyMs: 42,
      message: "qwen failed",
    });
    const isolatedHealth = await getLocalNode("lifecycle_account", paired.node.id);
    assert.equal(isolatedHealth?.models.find((model) => model.modelId === "qwen:latest")?.health, "error");
    assert.equal(isolatedHealth?.models.find((model) => model.modelId === "llama:latest")?.health, "unknown");

    assert.throws(() => validateLocalNodeEndpoint("http://example.com"), /HTTPS/);
    assert.throws(() => validateLocalNodeEndpoint("https://example.com"), /ngrok/);
    assert.throws(() => validateLocalNodeEndpoint("https://example.ngrok.app/path"), /path/);

    const previousLoopback = process.env.LOCAL_NODE_ALLOW_HTTP_LOOPBACK;
    process.env.LOCAL_NODE_ALLOW_HTTP_LOOPBACK = "true";
    let healthMode: "correct" | "wrong" | "redirect" = "correct";
    const healthServer = createServer((_request, response) => {
      if (healthMode === "redirect") {
        response.writeHead(302, { location: "https://different.ngrok.app/health" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ nodeId: healthMode === "correct" ? paired.node.id : "node_wrong", runtime: "ollama" }));
    });
    const port = await listen(healthServer);
    try {
      const registered = await registerLocalNodeEndpoint(
        paired.node.id,
        `http://127.0.0.1:${port}`,
      );
      assert.equal(registered?.endpoint, `http://127.0.0.1:${port}`);
      healthMode = "wrong";
      await assert.rejects(
        registerLocalNodeEndpoint(paired.node.id, `http://127.0.0.1:${port}`),
        /does not belong/,
      );
      healthMode = "redirect";
      await assert.rejects(
        registerLocalNodeEndpoint(paired.node.id, `http://127.0.0.1:${port}`),
        /must not redirect/,
      );
    } finally {
      await close(healthServer);
      if (previousLoopback === undefined) delete process.env.LOCAL_NODE_ALLOW_HTTP_LOOPBACK;
      else process.env.LOCAL_NODE_ALLOW_HTTP_LOOPBACK = previousLoopback;
    }

    const rotated = await rotateLocalNodeCredential(paired.node.id);
    assert.ok(rotated?.deviceCredential.startsWith("fln_"));
    assert.equal(await authenticateLocalNode(paired.node.id, paired.deviceCredential), undefined);
    assert.equal(
      (await authenticateLocalNode(paired.node.id, rotated!.deviceCredential))?.id,
      paired.node.id,
    );
  });
});
