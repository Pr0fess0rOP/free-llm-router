import { randomBytes, randomUUID } from "node:crypto";
import { hashLocalNodeSecret } from "./local-node-auth.js";
import {
  consumePairingCode,
  storePairingCode,
  writeLocalNode,
} from "./local-node-store.js";
import {
  DEFAULT_LOCAL_NODE_LIMITS,
  type LocalNode,
  type LocalNodePairingCodeResult,
  type LocalNodeRuntime,
  type PairedLocalNodeResult,
  type StoredLocalNode,
} from "./local-node-types.js";

export const LOCAL_NODE_PAIRING_TTL_MS = 10 * 60_000;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_LOCAL_MODELS = 500;

export class LocalNodePairingError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "invalid_pairing_code"
      | "expired_pairing_code"
      | "invalid_node_name"
      | "invalid_model_id"
      | "unsupported_runtime",
  ) {
    super(message);
  }
}

function pairingCode(): string {
  const bytes = randomBytes(8);
  const characters = Array.from(
    bytes,
    (value) => PAIRING_ALPHABET[value % PAIRING_ALPHABET.length]!,
  );
  return `FLR-${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
}

function publicNode(node: StoredLocalNode): LocalNode {
  const { credential: _credential, ...safeNode } = node;
  return safeNode;
}

export async function createLocalNodePairingCode(
  ownerAccountId: string,
  now = Date.now(),
): Promise<LocalNodePairingCodeResult> {
  const code = pairingCode();
  const expiresAt = new Date(now + LOCAL_NODE_PAIRING_TTL_MS).toISOString();
  await storePairingCode({
    id: `pair_${randomUUID().replaceAll("-", "")}`,
    codeHash: hashLocalNodeSecret(code),
    ownerAccountId,
    createdAt: new Date(now).toISOString(),
    expiresAt,
  });
  return { code, expiresAt };
}

export async function pairLocalNode(params: {
  code: string;
  name: string;
  runtime: LocalNodeRuntime;
  cliVersion?: string;
  models?: Array<{ id: string; enabled: boolean }>;
  now?: number;
}): Promise<PairedLocalNodeResult> {
  if (params.runtime !== "ollama") {
    throw new LocalNodePairingError(
      "Only the Ollama runtime is supported",
      "unsupported_runtime",
    );
  }
  const name = params.name.trim();
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new LocalNodePairingError(
      "Node name must contain 1 to 80 characters",
      "invalid_node_name",
    );
  }

  if ((params.models?.length ?? 0) > MAX_LOCAL_MODELS) {
    throw new LocalNodePairingError(
      `A local node may advertise at most ${MAX_LOCAL_MODELS} models`,
      "invalid_model_id",
    );
  }
  const normalizedModels = (params.models ?? []).map((model) => {
    const modelId = model.id.trim();
    if (!modelId || /[\s\x00-\x1f]/.test(modelId) || modelId.length > 240) {
      throw new LocalNodePairingError("Invalid Ollama model ID", "invalid_model_id");
    }
    return { id: modelId, enabled: model.enabled };
  });

  const normalizedCode = params.code.trim().toUpperCase();
  const record = await consumePairingCode(hashLocalNodeSecret(normalizedCode));
  if (!record) {
    throw new LocalNodePairingError(
      "Pairing code is invalid or has already been used",
      "invalid_pairing_code",
    );
  }

  const now = params.now ?? Date.now();
  if (Date.parse(record.expiresAt) <= now) {
    throw new LocalNodePairingError(
      "Pairing code has expired",
      "expired_pairing_code",
    );
  }

  const nodeId = `node_${randomUUID().replaceAll("-", "")}`;
  const deviceCredential = `fln_${randomBytes(32).toString("base64url")}`;
  const createdAt = new Date(now).toISOString();
  const models = normalizedModels.map((model) => {
    const modelId = model.id;
    return {
      nodeId,
      modelId,
      displayName: modelId,
      enabled: model.enabled,
      installed: true,
      capabilities: {
        streaming: "supported" as const,
        tools: "unknown" as const,
        vision: "unknown" as const,
        reasoning: "unknown" as const,
        structuredOutputs: "unknown" as const,
      },
      health: "unknown" as const,
    };
  });
  const node: StoredLocalNode = {
    id: nodeId,
    ownerAccountId: record.ownerAccountId,
    name,
    runtime: "ollama",
    status: "offline",
    createdAt,
    ...(params.cliVersion ? { cliVersion: params.cliVersion.slice(0, 40) } : {}),
    limits: { ...DEFAULT_LOCAL_NODE_LIMITS },
    activeRequests: 0,
    routingMode: "normal",
    models,
    credential: {
      nodeId,
      credentialHash: hashLocalNodeSecret(deviceCredential),
      createdAt,
    },
  };
  await writeLocalNode(node);
  return { node: publicNode(node), deviceCredential };
}
