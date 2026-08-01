import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProtectedCredential {
  storage: "dpapi" | "macos-keychain" | "linux-keyring" | "file";
  value?: string;
  account: string;
}

const SERVICE = "free-llm-router-local-node";

async function runWithInput(command: string, args: string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, 2_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

async function windowsProtect(secret: string): Promise<string> {
  const script = [
    "$bytes=[Text.Encoding]::UTF8.GetBytes($env:FLR_DEVICE_SECRET)",
    "$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($protected)",
  ].join(";");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { env: { ...process.env, FLR_DEVICE_SECRET: secret }, windowsHide: true },
  );
  return stdout.trim();
}

async function windowsUnprotect(value: string): Promise<string> {
  const script = [
    "$bytes=[Convert]::FromBase64String($env:FLR_PROTECTED_SECRET)",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Text.Encoding]::UTF8.GetString($plain)",
  ].join(";");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { env: { ...process.env, FLR_PROTECTED_SECRET: value }, windowsHide: true },
  );
  return stdout.trim();
}

export async function protectDeviceCredential(
  nodeId: string,
  credential: string,
): Promise<ProtectedCredential> {
  if (process.platform === "win32") {
    try {
      return { storage: "dpapi", value: await windowsProtect(credential), account: nodeId };
    } catch {
      // Restrictive file fallback is handled by the config store.
    }
  }
  if (process.platform === "darwin") {
    try {
      await execFileAsync("security", [
        "add-generic-password",
        "-U",
        "-s",
        SERVICE,
        "-a",
        nodeId,
        "-w",
        credential,
      ]);
      return { storage: "macos-keychain", account: nodeId };
    } catch {
      // Restrictive file fallback is handled by the config store.
    }
  }
  if (process.platform === "linux") {
    try {
      await runWithInput("secret-tool", [
        "store",
        "--label=Free LLM Router local node",
        "service",
        SERVICE,
        "account",
        nodeId,
      ], credential);
      return { storage: "linux-keyring", account: nodeId };
    } catch {
      // Restrictive file fallback is handled by the config store.
    }
  }
  return { storage: "file", value: credential, account: nodeId };
}

export async function revealDeviceCredential(
  protectedCredential: ProtectedCredential,
): Promise<string> {
  if (protectedCredential.storage === "dpapi" && protectedCredential.value) {
    return windowsUnprotect(protectedCredential.value);
  }
  if (protectedCredential.storage === "macos-keychain") {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      protectedCredential.account,
      "-w",
    ]);
    return stdout.trim();
  }
  if (protectedCredential.storage === "linux-keyring") {
    const { stdout } = await execFileAsync("secret-tool", [
      "lookup", "service", SERVICE, "account", protectedCredential.account,
    ]);
    return stdout.trim();
  }
  if (protectedCredential.storage === "file" && protectedCredential.value) {
    return protectedCredential.value;
  }
  throw new Error("Local node credential is unavailable");
}

export async function deleteProtectedCredential(
  protectedCredential: ProtectedCredential,
): Promise<void> {
  if (protectedCredential.storage === "macos-keychain") {
    await execFileAsync("security", [
      "delete-generic-password",
      "-s",
      SERVICE,
      "-a",
      protectedCredential.account,
    ]).catch(() => undefined);
  }
  if (protectedCredential.storage === "linux-keyring") {
    await execFileAsync("secret-tool", [
      "clear", "service", SERVICE, "account", protectedCredential.account,
    ]).catch(() => undefined);
  }
}
