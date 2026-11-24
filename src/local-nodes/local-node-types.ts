import type { CapabilitySupport } from "../types.js";

export type LocalNodeRuntime = "ollama" | "lmstudio";

export function isLocalNodeRuntime(value: unknown): value is LocalNodeRuntime {
  return value === "ollama" || value === "lmstudio";
}
export type LocalNodeStatus = "online" | "unstable" | "offline" | "revoked";
export type LocalNodeRoutingMode = "normal" | "prefer-local" | "local-only";

export interface LocalNodeLimits {
  maxConcurrentRequests: number;
  maxQueueSize: number;
  maxInputBytes: number;
  maxOutputTokens: number;
  firstTokenTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
}

export const DEFAULT_LOCAL_NODE_LIMITS: LocalNodeLimits = {
  maxConcurrentRequests: 1,
  maxQueueSize: 2,
  maxInputBytes: 2 * 1024 * 1024,
  maxOutputTokens: 2_048,
  firstTokenTimeoutMs: 60_000,
  idleTimeoutMs: 60_000,
  totalTimeoutMs: 10 * 60_000,
};

export interface LocalNodeModelCapabilities {
  streaming: CapabilitySupport;
  tools: CapabilitySupport;
  vision: CapabilitySupport;
  reasoning: CapabilitySupport;
  jsonMode: CapabilitySupport;
  structuredOutputs: CapabilitySupport;
}

export interface LocalNodeModelInventoryItem {
  id: string;
  installed: boolean;
  loaded?: boolean;
  available?: boolean;
  displayName?: string;
  capabilities?: unknown;
}

export function normalizeLocalModelCapabilities(value: unknown): LocalNodeModelCapabilities {
  const reported = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const capability = (name: keyof LocalNodeModelCapabilities) => {
    const status = reported[name];
    return status === "supported" || status === "unsupported" ? status : "unknown";
  };
  return {
    streaming: capability("streaming"),
    tools: capability("tools"),
    vision: capability("vision"),
    reasoning: capability("reasoning"),
    jsonMode: capability("jsonMode"),
    structuredOutputs: capability("structuredOutputs"),
  };
}

export interface LocalNodeModel {
  nodeId: string;
  modelId: string;
  displayName?: string;
  enabled: boolean;
  installed: boolean;
  loaded?: boolean;
  available?: boolean;
  capabilities: LocalNodeModelCapabilities;
  contextWindow?: number;
  maxOutputTokens?: number;
  lastTestedAt?: string;
  lastLatencyMs?: number;
  health: "unknown" | "healthy" | "unavailable" | "error";
  lastError?: string;
}

export interface LocalNode {
  id: string;
  ownerAccountId: string;
  name: string;
  runtime: LocalNodeRuntime;
  status: LocalNodeStatus;
  endpoint?: string;
  endpointUpdatedAt?: string;
  lastHeartbeatAt?: string;
  createdAt: string;
  revokedAt?: string;
  cliVersion?: string;
  cliVersionWarning?: string;
  ollamaVersion?: string;
  runtimeStatus?: "online" | "offline";
  credentialFailureCount?: number;
  lastCredentialFailureAt?: string;
  lastCredentialError?: string;
  activeRequests: number;
  limits: LocalNodeLimits;
  routingEnabled: boolean;
  routingMode: LocalNodeRoutingMode;
  models: LocalNodeModel[];
}

export interface LocalNodePairingCode {
  id: string;
  codeHash: string;
  ownerAccountId: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}

export interface LocalNodeCredential {
  nodeId: string;
  credentialHash: string;
  createdAt: string;
  rotatedAt?: string;
  revokedAt?: string;
}

export interface StoredLocalNode extends LocalNode {
  credential: LocalNodeCredential;
}

export interface LocalNodePairingCodeResult {
  code: string;
  expiresAt: string;
}

export interface PairedLocalNodeResult {
  node: LocalNode;
  deviceCredential: string;
}

export interface LocalNodeHeartbeat {
  agentVersion: string;
  ollamaVersion?: string;
  runtimeStatus?: "online" | "offline";
  activeRequests: number;
  maxConcurrentRequests: number;
  models?: LocalNodeModelInventoryItem[];
}
