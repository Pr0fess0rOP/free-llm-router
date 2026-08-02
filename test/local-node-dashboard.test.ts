import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Providers dashboard exposes complete local-node pairing and management controls", async () => {
  const [html, app, css, vercel] = await Promise.all([
    readFile("public/dashboard.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("vercel.json", "utf8"),
  ]);
  for (const id of [
    "connect-local-node", "local-node-pairing", "local-node-pairing-code",
    "local-node-pairing-command", "local-node-list", "cloud-providers-tab",
    "local-providers-tab", "cloud-providers-workspace", "local-providers-workspace",
    "local-node-properties", "local-routing-gate-count",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  for (const behavior of [
    "/api/local-nodes/pairing-code", "data-local-routing-mode", "data-local-limit",
    "data-local-model-toggle", "data-local-capability", "data-local-model-test", "data-local-test-all",
    "data-local-revoke", "data-local-delete", "/permanent", "prefer-local", "local-only",
    "local-node:", "routableProviders", "data-local-open-settings", "data-local-open-playground",
    "renderLocalNodeProperties", "data-local-routing-enabled", "/api/playground/local", "localNodeInitials",
  ]) {
    assert.match(app, new RegExp(behavior.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(app, /npx --yes @free-llm-router\/cli@latest/);
  assert.match(app, /npm run cli --/);
  assert.match(app, /connect ollama --code/);
  assert.match(app, /location\.hostname/);
  assert.match(html, /data-snippet="local"/);
  assert.match(html, /id="feature-local-llm"/);
  assert.doesNotMatch(app, /npx free-llm-router connect ollama/);
  assert.match(css, /\.local-node-card/);
  assert.match(css, /\.local-node-status\.online/);
  assert.match(css, /\.provider-workspace-tab\.active/);
  assert.match(css, /\.provider-workspace-tabs\s*\{[\s\S]*display:\s*inline-flex/);
  assert.match(css, /\.provider-workspace-tab\s*\{[\s\S]*min-height:\s*40px/);
  assert.match(css, /\.local-node-action\.delete-action/);
  assert.match(css, /\.local-node-letter-icon/);
  assert.match(css, /\.local-node-model-row > \.local-model-letter-icon/);
  assert.doesNotMatch(css, /\.local-node-model-row span, \.local-node-model-row strong/);
  assert.match(css, /\.local-node-properties/);
  assert.match(css, /\.local-node-routing-gate/);
  assert.match(vercel, /\/api\/local-nodes\/:path\*/);
});

test("CLI and documentation expose the complete local Ollama lifecycle", async () => {
  const [cli, cliCommands, cliEntry, cliPackageJson, service, packageJson, guide, security, troubleshooting, releaseChecklist] = await Promise.all([
    readFile("src/cli.ts", "utf8"),
    readFile("src/local-nodes/agent/cli-commands.ts", "utf8"),
    readFile("packages/cli/src/cli.ts", "utf8"),
    readFile("packages/cli/package.json", "utf8"),
    readFile("src/local-nodes/local-node-service.ts", "utf8"),
    readFile("package.json", "utf8"),
    readFile("docs/CONNECT_LOCAL_LLM.md", "utf8"),
    readFile("docs/LOCAL_NODE_SECURITY.md", "utf8"),
    readFile("docs/LOCAL_NODE_TROUBLESHOOTING.md", "utf8"),
    readFile("docs/LOCAL_NODE_RELEASE_CHECKLIST.md", "utf8"),
  ]);
  for (const command of [
    "connect", "start", "status", "models", "logs", "disconnect", "revoke", "credential",
  ]) {
    assert.match(cliCommands, new RegExp(`case ["']${command}["']`));
  }
  assert.match(cli, /runLocalNodeCliCommand/);
  assert.match(cliEntry, /packageVersion/);
  const cliPackage = JSON.parse(cliPackageJson) as { name: string; version: string; bin?: Record<string, string> };
  assert.equal(cliPackage.name, "@free-llm-router/cli");
  assert.equal(cliPackage.bin?.["free-llm"], "dist/packages/cli/src/cli.js");
  assert.match(guide, /Cloud fallback is possible only before output begins/);
  assert.match(guide, /Playground → Local LLM/);
  assert.match(guide, /Settings → Router & Policies → Local LLM Properties/);
  assert.match(security, /Raw Ollama is never exposed|Do not point ngrok directly/);
  assert.match(troubleshooting, /local-only/i);
  const version = (JSON.parse(packageJson) as { version: string }).version;
  assert.equal(cliPackage.version, version);
  assert.match(cliCommands, /"message" in payload\.error/);
  assert.match(service, new RegExp(`LOCAL_NODE_PROTOCOL_VERSION = ["']${version.split(".").slice(0, 2).join("\\.")}["']`));
  assert.match(releaseChecklist, /End-to-end behavior/);
});
