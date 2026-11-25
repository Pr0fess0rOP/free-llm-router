import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import handler from "../api/handler.js";
import { handleRequest } from "../src/server.js";

async function withGateway(
  listener: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => void listener(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
}

function send(port: number, target: string, host = "localhost", method = "GET") {
  return new Promise<{ status: number; body: string; requestId: string | string[] | undefined }>((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1", port, path: target, method,
      headers: { host, connection: "close", "x-request-id": "malformed-input-check" },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({
        status: response.statusCode!,
        body: Buffer.concat(chunks).toString("utf8"),
        requestId: response.headers["x-free-llm-request-id"],
      }));
    });
    request.on("error", reject);
    request.setTimeout(2_000, () => request.destroy(new Error("Request did not complete")));
    request.end();
  });
}

test("malformed URLs and Host headers return 400 without taking down either HTTP entry point", async (t) => {
  for (const [name, listener] of [["standalone", handleRequest], ["serverless adapter", handler]] as const) {
    await t.test(name, async () => {
      await withGateway(listener, async (port) => {
        for (const host of ["[", "localhost:invalid", "bad host"]) {
          for (const target of ["/health", "/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
            const result = await send(port, target, host, target === "/health" ? "GET" : "POST");
            assert.equal(result.status, 400, `${host} ${target}`);
            assert.equal(JSON.parse(result.body).error.type, "invalid_request_error");
            assert.equal(result.requestId, "malformed-input-check");
            assert.equal(JSON.parse(result.body).error.request_id, result.requestId);
          }
        }
        for (const target of ["http://[", "//["]) {
          assert.equal((await send(port, target)).status, 400);
        }
        for (const host of ["localhost:8787", "[::1]:8787"]) {
          const healthy = await send(port, "/health", host);
          assert.equal(healthy.status, 200);
          assert.equal(JSON.parse(healthy.body).status, "ok");
        }
        if (listener === handler) {
          assert.equal((await send(port, "/api/handler?__route=%2Fhealth&extra=1")).status, 200);
        }
      });
    });
  }
});

test("failures before normal routing are contained and return a generic 500", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "flr-error-boundary-"));
  const names = [
    "ACCOUNTS_PATH", "KV_REST_API_URL", "KV_REST_API_TOKEN",
    "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.ACCOUNTS_PATH = path.join(directory, "accounts.json");
  await writeFile(process.env.ACCOUNTS_PATH, "invalid-account-store");
  const errors = t.mock.method(console, "error", () => {});
  try {
    await withGateway(handleRequest, async (port) => {
      const result = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer test-router-key", "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
      });
      assert.equal(result.status, 500);
      assert.equal((await result.json()).error.message, "Internal server error");
      assert.ok(result.headers.get("x-free-llm-request-id"));
      assert.equal(errors.mock.callCount(), 1);
      assert.equal((await send(port, "/health")).status, 200);
    });
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
