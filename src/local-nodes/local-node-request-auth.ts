import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LocalNodeRequestClaims {
  iss: "free-llm-router";
  aud: string;
  sub: string;
  requestId: string;
  model: string;
  iat: number;
  exp: number;
}

interface StoredSigningKey {
  privateKey: string;
  publicKey: string;
}

let cachedKeys: StoredSigningKey | undefined;

function signingKeyPath(): string {
  return path.resolve(
    process.env.LOCAL_NODE_SIGNING_KEY_PATH ??
      ".freellm/local-node-signing-key.json",
  );
}

function environmentPrivateKey(): string | undefined {
  const value = process.env.LOCAL_NODE_SIGNING_PRIVATE_KEY;
  return value?.replaceAll("\\n", "\n");
}

function environmentPublicKey(): string | undefined {
  return process.env.LOCAL_NODE_SIGNING_PUBLIC_KEY?.replaceAll("\\n", "\n");
}

async function loadSigningKeys(): Promise<StoredSigningKey> {
  const privateKey = environmentPrivateKey();
  if (privateKey) {
    const publicKey = environmentPublicKey() ?? createPublicKey(privateKey).export({
      type: "spki",
      format: "pem",
    }).toString();
    return { privateKey, publicKey };
  }
  if (cachedKeys) return cachedKeys;

  try {
    cachedKeys = JSON.parse(
      await readFile(signingKeyPath(), "utf8"),
    ) as StoredSigningKey;
    createPrivateKey(cachedKeys.privateKey);
    createPublicKey(cachedKeys.publicKey);
    return cachedKeys;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (
    (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
    (process.env.VERCEL || process.env.NODE_ENV === "production")
  ) {
    throw new Error(
      "LOCAL_NODE_SIGNING_PRIVATE_KEY is required when local nodes use hosted Redis storage in production",
    );
  }

  const generated = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  cachedKeys = {
    privateKey: generated.privateKey,
    publicKey: generated.publicKey,
  };
  const target = signingKeyPath();
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(cachedKeys, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
  await chmod(target, 0o600);
  return cachedKeys;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export async function localNodeVerificationKey(): Promise<{
  publicKey: string;
  keyId: string;
}> {
  const { publicKey } = await loadSigningKeys();
  return {
    publicKey,
    keyId: createHash("sha256").update(publicKey).digest("base64url").slice(0, 16),
  };
}

export async function signLocalNodeRequest(params: {
  nodeId: string;
  ownerAccountId: string;
  requestId: string;
  model: string;
  now?: number;
  ttlSeconds?: number;
}): Promise<string> {
  const { privateKey, publicKey } = await loadSigningKeys();
  const nowSeconds = Math.floor((params.now ?? Date.now()) / 1_000);
  const ttlSeconds = Math.max(1, Math.min(params.ttlSeconds ?? 60, 120));
  const keyId = createHash("sha256")
    .update(publicKey)
    .digest("base64url")
    .slice(0, 16);
  const header = encodeJson({ alg: "EdDSA", typ: "JWT", kid: keyId });
  const claims: LocalNodeRequestClaims = {
    iss: "free-llm-router",
    aud: params.nodeId,
    sub: params.ownerAccountId,
    requestId: params.requestId,
    model: params.model,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  };
  const payload = encodeJson(claims);
  const signed = `${header}.${payload}`;
  const signature = sign(null, Buffer.from(signed), createPrivateKey(privateKey));
  return `${signed}.${signature.toString("base64url")}`;
}

export function verifyLocalNodeRequestToken(params: {
  token: string;
  publicKey: string;
  expectedNodeId: string;
  expectedOwnerAccountId: string;
  expectedModel: string;
  now?: number;
}): LocalNodeRequestClaims {
  const segments = params.token.split(".");
  if (segments.length !== 3 || !segments[0] || !segments[1] || !segments[2]) {
    throw new Error("Invalid router authorization token");
  }
  let header: { alg?: string; typ?: string };
  let claims: LocalNodeRequestClaims;
  try {
    header = JSON.parse(Buffer.from(segments[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid router authorization token");
  }
  if (header.alg !== "EdDSA" || header.typ !== "JWT") {
    throw new Error("Unsupported router authorization token");
  }
  const valid = verify(
    null,
    Buffer.from(`${segments[0]}.${segments[1]}`),
    createPublicKey(params.publicKey),
    Buffer.from(segments[2], "base64url"),
  );
  if (!valid) throw new Error("Invalid router authorization signature");

  const nowSeconds = Math.floor((params.now ?? Date.now()) / 1_000);
  if (claims.iss !== "free-llm-router") throw new Error("Invalid token issuer");
  if (claims.aud !== params.expectedNodeId) throw new Error("Invalid token audience");
  if (claims.sub !== params.expectedOwnerAccountId) throw new Error("Invalid token owner");
  if (claims.model !== params.expectedModel) throw new Error("Invalid token model");
  if (!claims.requestId || typeof claims.requestId !== "string") {
    throw new Error("Invalid token request ID");
  }
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) {
    throw new Error("Invalid token timestamps");
  }
  if (claims.iat > nowSeconds + 30) throw new Error("Token is not active yet");
  if (claims.exp <= nowSeconds) throw new Error("Router authorization token expired");
  if (claims.exp - claims.iat > 120) throw new Error("Router authorization token is too long-lived");
  return claims;
}

export function resetLocalNodeSigningKeyCache(): void {
  cachedKeys = undefined;
}
