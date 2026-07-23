import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const productionClerkOrigin = "https://clerk.llmrouter.dpdns.org";

function directive(policy: string, name: string): string {
  return (
    policy
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name} `)) ?? ""
  );
}

test("production Clerk Frontend API remains allowed by every CSP path", () => {
  const vercelConfig = JSON.parse(readFileSync("vercel.json", "utf8")) as {
    headers?: Array<{
      headers?: Array<{ key?: string; value?: string }>;
    }>;
  };

  const vercelPolicy = vercelConfig.headers
    ?.flatMap((rule) => rule.headers ?? [])
    .find((header) => header.key?.toLowerCase() === "content-security-policy")
    ?.value;

  assert.ok(vercelPolicy, "vercel.json must define a Content-Security-Policy");
  assert.match(directive(vercelPolicy, "script-src"), new RegExp(productionClerkOrigin.replaceAll(".", "\\.")));
  assert.match(directive(vercelPolicy, "connect-src"), new RegExp(productionClerkOrigin.replaceAll(".", "\\.")));

  const serverSource = readFileSync("src/server.ts", "utf8");
  const serverPolicyMatch = serverSource.match(/"default-src 'self'; script-src[^"\n]+"/);
  assert.ok(serverPolicyMatch, "src/server.ts must define the static response CSP");
  assert.match(directive(serverPolicyMatch[0].slice(1, -1), "script-src"), new RegExp(productionClerkOrigin.replaceAll(".", "\\.")));
  assert.match(directive(serverPolicyMatch[0].slice(1, -1), "connect-src"), new RegExp(productionClerkOrigin.replaceAll(".", "\\.")));
});
