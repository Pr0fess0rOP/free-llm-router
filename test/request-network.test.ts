import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";
import { requestClientAddress } from "../src/request-network.js";
import { handleRequest } from "../src/server.js";

test("forwarded client addresses require a trusted transport", () => {
  const previousVercel = process.env.VERCEL;
  const previousProxies = process.env.TRUSTED_PROXY_IPS;
  delete process.env.VERCEL;
  delete process.env.TRUSTED_PROXY_IPS;
  const request = {
    socket: { remoteAddress: "::ffff:127.0.0.1" },
    headers: { "x-forwarded-for": "192.0.2.1, 198.51.100.2", "x-vercel-forwarded-for": "203.0.113.3" },
  } as unknown as IncomingMessage;
  try {
    assert.equal(requestClientAddress(request), "127.0.0.1");
    process.env.TRUSTED_PROXY_IPS = "127.0.0.1";
    assert.equal(requestClientAddress(request), "198.51.100.2");
    request.headers["x-forwarded-for"] = "not-an-ip";
    assert.equal(requestClientAddress(request), "127.0.0.1");
    process.env.VERCEL = "1";
    assert.equal(requestClientAddress(request), "203.0.113.3");
    request.headers["x-vercel-forwarded-for"] = "203.0.113.3, 192.0.2.4";
    assert.equal(requestClientAddress(request), "127.0.0.1");
    request.headers["x-forwarded-for"] = ["192.0.2.1", "192.0.2.2"];
    assert.equal(requestClientAddress(request), "127.0.0.1");
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    if (previousProxies === undefined) delete process.env.TRUSTED_PROXY_IPS;
    else process.env.TRUSTED_PROXY_IPS = previousProxies;
  }
});

test("rotating spoofed forwarding headers cannot bypass pairing limits", async () => {
  const names = [
    "VERCEL", "TRUSTED_PROXY_IPS", "KV_REST_API_URL", "KV_REST_API_TOKEN",
    "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  const server = createServer((request, response) => void handleRequest(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (let index = 0; index < 35; index += 1) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}/api/local-nodes/pair`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `192.0.2.${index}`,
          "x-vercel-forwarded-for": `198.51.100.${index}`,
          "x-real-ip": `203.0.113.${index}`,
        },
        body: "{}",
      });
      assert.equal(response.status, index < 30 ? 400 : 429);
      await response.text();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
