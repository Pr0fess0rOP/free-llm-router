import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("dedicated npm CLI package is public, focused, and version-aligned", async () => {
  const [rootPackageText, cliPackageText, tsconfigText, entry] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("packages/cli/package.json", "utf8"),
    readFile("packages/cli/tsconfig.json", "utf8"),
    readFile("packages/cli/src/cli.ts", "utf8"),
  ]);
  const rootPackage = JSON.parse(rootPackageText) as {
    version: string;
    private?: boolean;
    bin?: unknown;
  };
  const cliPackage = JSON.parse(cliPackageText) as {
    name: string;
    version: string;
    private?: boolean;
    bin?: Record<string, string>;
    dependencies?: Record<string, string>;
    publishConfig?: { access?: string; registry?: string };
  };
  const tsconfig = JSON.parse(tsconfigText) as { include?: string[] };

  assert.equal(rootPackage.private, true);
  assert.equal(rootPackage.bin, undefined);
  assert.equal(cliPackage.name, "@free-llm-router/cli");
  assert.equal(cliPackage.version, rootPackage.version);
  assert.equal(cliPackage.private, false);
  assert.equal(cliPackage.bin?.["free-llm"], "dist/packages/cli/src/cli.js");
  assert.deepEqual(cliPackage.dependencies, undefined);
  assert.equal(cliPackage.publishConfig?.access, "public");
  assert.equal(cliPackage.publishConfig?.registry, "https://registry.npmjs.org/");
  assert.deepEqual(tsconfig.include, ["./src/**/*.ts"]);
  assert.match(entry, /local-nodes\/agent\/cli-commands\.js/);
  assert.doesNotMatch(entry, /src\/cli\.js/);
});

test("package source entry reports its package version and focused help", async () => {
  const packageJson = JSON.parse(await readFile("packages/cli/package.json", "utf8")) as {
    version: string;
  };
  const run = async (argument: string) => execFileAsync(
    process.execPath,
    ["--import", "tsx", "packages/cli/src/cli.ts", argument],
    { cwd: process.cwd(), env: process.env },
  );

  const version = await run("--version");
  assert.equal(version.stderr, "");
  assert.equal(version.stdout.trim(), packageJson.version);

  const help = await run("help");
  assert.match(help.stdout, /Local LLM CLI/);
  assert.match(help.stdout, /free-llm connect ollama/);
  assert.doesNotMatch(help.stdout, /free-llm serve/);
  assert.doesNotMatch(help.stdout, /free-llm add/);
});
