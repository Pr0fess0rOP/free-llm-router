import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  clerkAuthorizedParties,
  clerkConfigurationError,
} from "../src/auth.js";

function requestWithHeaders(
  headers: IncomingMessage["headers"],
): IncomingMessage {
  return { headers } as IncomingMessage;
}

test("Clerk authorized parties include configured and proxy-facing origins", () => {
  const original = process.env.CLERK_AUTHORIZED_PARTIES;
  process.env.CLERK_AUTHORIZED_PARTIES =
    "https://router.example.com/, http://localhost:8787, https://router.example.com";

  try {
    assert.deepEqual(
      clerkAuthorizedParties(requestWithHeaders({
        host: "internal-deployment.vercel.app",
        "x-forwarded-host": "preview.example.net, ignored.example.net",
        "x-forwarded-proto": "https, http",
      })),
      [
        "https://router.example.com",
        "http://localhost:8787",
        "https://preview.example.net",
        "https://internal-deployment.vercel.app",
      ],
    );
  } finally {
    if (original === undefined) delete process.env.CLERK_AUTHORIZED_PARTIES;
    else process.env.CLERK_AUTHORIZED_PARTIES = original;
  }
});

test("Clerk authorized parties default local requests to HTTP", () => {
  const original = process.env.CLERK_AUTHORIZED_PARTIES;
  delete process.env.CLERK_AUTHORIZED_PARTIES;

  try {
    assert.deepEqual(
      clerkAuthorizedParties(requestWithHeaders({ host: "localhost:8787" })),
      ["http://localhost:8787"],
    );
  } finally {
    if (original !== undefined) process.env.CLERK_AUTHORIZED_PARTIES = original;
  }
});

test("Clerk configuration rejects incomplete and mixed-environment keys", () => {
  const originalPublishable = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const originalFallbackPublishable = process.env.CLERK_PUBLISHABLE_KEY;
  const originalSecret = process.env.CLERK_SECRET_KEY;

  try {
    delete process.env.CLERK_PUBLISHABLE_KEY;
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.CLERK_SECRET_KEY;
    assert.equal(clerkConfigurationError(), "Clerk publishable key is missing");

    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_example";
    assert.equal(clerkConfigurationError(), "Clerk secret key is missing");

    process.env.CLERK_SECRET_KEY = "sk_test_example";
    assert.equal(
      clerkConfigurationError(),
      "Clerk publishable and secret keys use different environments",
    );

    process.env.CLERK_SECRET_KEY = "sk_live_example";
    assert.equal(clerkConfigurationError(), undefined);
  } finally {
    if (originalPublishable === undefined) {
      delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    } else {
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = originalPublishable;
    }
    if (originalFallbackPublishable === undefined) {
      delete process.env.CLERK_PUBLISHABLE_KEY;
    } else {
      process.env.CLERK_PUBLISHABLE_KEY = originalFallbackPublishable;
    }
    if (originalSecret === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = originalSecret;
  }
});

test("dashboard auth retries a rejected Clerk session with a fresh token", () => {
  const source = readFileSync("public/app.js", "utf8");
  assert.match(source, /credentials:\s*"same-origin"/);
  assert.match(source, /response\.status === 401/);
  assert.match(source, /getToken\(\{ skipCache: true \}\)/);
});
