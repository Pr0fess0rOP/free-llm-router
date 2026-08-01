import type { CapabilitySupport } from "../types.js";

export type LocalNodeRuntime = "ollama";
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
  structuredOutputs: CapabilitySupport;
}

export interface LocalNodeModel {
  nodeId: string;
  modelId: string;
  displayName?: string;
  enabled: boolean;
  installed: boolean;
  loaded?: boolean;
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
  credentialFailureCount?: number;
  lastCredentialFailureAt?: string;
  lastCredentialError?: string;
  activeRequests: number;
  limits: LocalNodeLimits;
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
  activeRequests: number;
  maxConcurrentRequests: number;
  models?: Array<{
    id: string;
    installed: boolean;
    loaded?: boolean;
  }>;
}
