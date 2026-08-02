import { randomBytes } from "node:crypto";
import { hashLocalNodeSecret } from "./local-node-auth.js";
import {
  deleteStoredLocalNode,
  listLocalNodesForOwner,
  readLocalNode,
  updateStoredLocalNode,
} from "./local-node-store.js";
import { signLocalNodeRequest } from "./local-node-request-auth.js";
import type {
  LocalNode,
  LocalNodeHeartbeat,
  LocalNodeLimits,
  LocalNodeModel,
  LocalNodeModelCapabilities,
  LocalNodeRoutingMode,
  StoredLocalNode,
} from "./local-node-types.js";

const ONLINE_MAX_AGE_MS = 45_000;
const UNSTABLE_MAX_AGE_MS = 90_000;
const LOCAL_NODE_PROTOCOL_VERSION = "0.7";
const LOCAL_NODE_NAMES = /^[\p{L}\p{N} ._()\-]{1,80}$/u;
const LOCAL_MODEL_ID = /^[^\s\x00-\x1f]{1,240}$/;
const ROUTING_MODES = new Set<LocalNodeRoutingMode>([
  "normal",
  "prefer-local",
  "local-only",
]);

const DEFAULT_MODEL_CAPABILITIES: LocalNodeModelCapabilities = {
  streaming: "supported",
  tools: "unknown",
  vision: "unknown",
  reasoning: "unknown",
  structuredOutputs: "unknown",
};

export class LocalNodeValidationError extends Error {}

async function boundedResponseText(response: Response, maximumBytes = 64 * 1024): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new LocalNodeValidationError("Local node response exceeded the allowed size");
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function publicNode(node: StoredLocalNode | undefined, now = Date.now()): LocalNode | undefined {
  if (!node) return undefined;
  const { credential: _credential, ...safeNode } = node;
  const versionMatch = safeNode.cliVersion?.match(/^(\d+)\.(\d+)/);
  const cliVersionWarning = versionMatch && `${versionMatch[1]}.${versionMatch[2]}` !== LOCAL_NODE_PROTOCOL_VERSION
    ? `CLI ${safeNode.cliVersion} may be incompatible; update to the ${LOCAL_NODE_PROTOCOL_VERSION}.x release`
    : undefined;
  return {
    ...safeNode,
    activeRequests: safeNode.activeRequests ?? 0,
    routingEnabled: safeNode.routingEnabled !== false,
    status: effectiveLocalNodeStatus(safeNode, now),
    ...(cliVersionWarning ? { cliVersionWarning } : {}),
  };
}

export function effectiveLocalNodeStatus(
  node: Pick<LocalNode, "status" | "revokedAt" | "lastHeartbeatAt">,
  now = Date.now(),
): LocalNode["status"] {
  if (node.status === "revoked" || node.revokedAt) return "revoked";
  if (!node.lastHeartbeatAt) return "offline";
  const age = now - Date.parse(node.lastHeartbeatAt);
  if (age <= ONLINE_MAX_AGE_MS) return "online";
  if (age <= UNSTABLE_MAX_AGE_MS) return "unstable";
  return "offline";
}

function normalizedModelId(value: string): string {
  const modelId = value.trim();
  if (!LOCAL_MODEL_ID.test(modelId)) {
    throw new LocalNodeValidationError("Invalid Ollama model ID");
  }
  return modelId;
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new LocalNodeValidationError(
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value as number;
}

function normalizeLimits(
  current: LocalNodeLimits,
  updates: Partial<LocalNodeLimits>,
): LocalNodeLimits {
  return {
    maxConcurrentRequests: updates.maxConcurrentRequests === undefined
      ? current.maxConcurrentRequests
      : boundedInteger(updates.maxConcurrentRequests, "Maximum concurrent requests", 1, 32),
    maxQueueSize: updates.maxQueueSize === undefined
      ? current.maxQueueSize
      : boundedInteger(updates.maxQueueSize, "Maximum queue size", 0, 100),
    maxInputBytes: updates.maxInputBytes === undefined
      ? current.maxInputBytes
      : boundedInteger(updates.maxInputBytes, "Maximum input bytes", 1_024, 10 * 1024 * 1024),
    maxOutputTokens: updates.maxOutputTokens === undefined
      ? current.maxOutputTokens
      : boundedInteger(updates.maxOutputTokens, "Maximum output tokens", 1, 131_072),
    firstTokenTimeoutMs: updates.firstTokenTimeoutMs === undefined
      ? current.firstTokenTimeoutMs
      : boundedInteger(updates.firstTokenTimeoutMs, "First-token timeout", 1_000, 10 * 60_000),
    idleTimeoutMs: updates.idleTimeoutMs === undefined
      ? current.idleTimeoutMs
      : boundedInteger(updates.idleTimeoutMs, "Idle timeout", 1_000, 10 * 60_000),
    totalTimeoutMs: updates.totalTimeoutMs === undefined
      ? current.totalTimeoutMs
      : boundedInteger(updates.totalTimeoutMs, "Total timeout", 1_000, 60 * 60_000),
  };
}

function mergeModelInventory(
  current: LocalNodeModel[],
  inventory: Array<{ id: string; installed: boolean; loaded?: boolean }>,
  nodeId: string,
): LocalNodeModel[] {
  const incoming = new Map(
    inventory.map((item) => [normalizedModelId(item.id), item]),
  );
  const result = current.map((model) => {
    const update = incoming.get(model.modelId);
    incoming.delete(model.modelId);
    return {
      ...model,
      installed: update?.installed ?? false,
      ...(update?.loaded !== undefined ? { loaded: update.loaded } : {}),
    };
  });
  for (const [modelId, item] of incoming) {
    result.push({
      nodeId,
      modelId,
      displayName: modelId,
      enabled: false,
      installed: item.installed,
      ...(item.loaded !== undefined ? { loaded: item.loaded } : {}),
      capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
      health: "unknown",
    });
  }
  return result;
}

export async function listLocalNodes(
  ownerAccountId: string,
  now = Date.now(),
): Promise<LocalNode[]> {
  return (await listLocalNodesForOwner(ownerAccountId)).map(
    (node) => publicNode(node, now)!,
  );
}

export async function getLocalNode(
  ownerAccountId: string,
  nodeId: string,
  now = Date.now(),
): Promise<LocalNode | undefined> {
  const node = await readLocalNode(nodeId);
  return node?.ownerAccountId === ownerAccountId ? publicNode(node, now) : undefined;
}

export async function updateLocalNode(
  ownerAccountId: string,
  nodeId: string,
  updates: {
    name?: string;
    routingEnabled?: boolean;
    routingMode?: LocalNodeRoutingMode;
    limits?: Partial<LocalNodeLimits>;
  },
): Promise<LocalNode | undefined> {
  const node = await updateStoredLocalNode(nodeId, (stored) => {
    if (stored.ownerAccountId !== ownerAccountId || stored.revokedAt) return;
    if (updates.name !== undefined) {
      const name = updates.name.trim();
      if (!LOCAL_NODE_NAMES.test(name)) {
        throw new LocalNodeValidationError("Node name contains unsupported characters");
      }
      stored.name = name;
    }
    if (updates.routingMode !== undefined) {
      if (!ROUTING_MODES.has(updates.routingMode)) {
        throw new LocalNodeValidationError("Unknown local routing mode");
      }
      stored.routingMode = updates.routingMode;
    }
    if (updates.routingEnabled !== undefined) {
      stored.routingEnabled = updates.routingEnabled;
    }
    if (updates.limits) stored.limits = normalizeLimits(stored.limits, updates.limits);
  });
  return node?.ownerAccountId === ownerAccountId ? publicNode(node) : undefined;
}

export async function recordLocalNodeHeartbeat(
  nodeId: string,
  heartbeat: LocalNodeHeartbeat,
  now = Date.now(),
): Promise<LocalNode | undefined> {
  if ((heartbeat.models?.length ?? 0) > 500) {
    throw new LocalNodeValidationError("Model inventory cannot exceed 500 models");
  }
  const node = await updateStoredLocalNode(nodeId, (stored) => {
    if (stored.revokedAt || stored.status === "revoked") return;
    stored.lastHeartbeatAt = new Date(now).toISOString();
    stored.status = "online";
    stored.activeRequests = boundedInteger(
      heartbeat.activeRequests,
      "Active requests",
      0,
      10_000,
    );
    stored.cliVersion = heartbeat.agentVersion.trim().slice(0, 40);
    if (heartbeat.ollamaVersion) {
      stored.ollamaVersion = heartbeat.ollamaVersion.trim().slice(0, 40);
    }
    if (heartbeat.models) {
      stored.models = mergeModelInventory(stored.models, heartbeat.models, stored.id);
    }
  });
  return publicNode(node, now);
}

export async function syncLocalNodeModels(
  nodeId: string,
  inventory: Array<{ id: string; installed: boolean; loaded?: boolean }>,
): Promise<LocalNode | undefined> {
  if (inventory.length > 500) {
    throw new LocalNodeValidationError("Model inventory cannot exceed 500 models");
  }
  const node = await updateStoredLocalNode(nodeId, (stored) => {
    if (stored.revokedAt) return;
    stored.models = mergeModelInventory(stored.models, inventory, stored.id);
  });
  return publicNode(node);
}

export async function updateLocalNodeModel(
  ownerAccountId: string,
  nodeId: string,
  modelIdValue: string,
  updates: {
    enabled?: boolean;
    capabilities?: Partial<LocalNodeModelCapabilities>;
    maxOutputTokens?: number;
  },
): Promise<LocalNode | undefined> {
  const modelId = normalizedModelId(modelIdValue);
  const node = await updateStoredLocalNode(nodeId, (stored) => {
    if (stored.ownerAccountId !== ownerAccountId || stored.revokedAt) return;
    const model = stored.models.find((candidate) => candidate.modelId === modelId);
    if (!model) throw new LocalNodeValidationError("Local model is not installed");
    if (updates.enabled !== undefined) model.enabled = updates.enabled;
    if (updates.maxOutputTokens !== undefined) {
      model.maxOutputTokens = boundedInteger(
        updates.maxOutputTokens,
        "Model maximum output tokens",
        1,
        stored.limits.maxOutputTokens,
      );
    }
    if (updates.capabilities) {
      const allowed = new Set(["supported", "unsupported", "unknown"]);
      for (const [name, value] of Object.entries(updates.capabilities)) {
        if (!allowed.has(value as string)) {
          throw new LocalNodeValidationError(`Invalid ${name} capability value`);
        }
      }
      model.capabilities = { ...model.capabilities, ...updates.capabilities };
    }
  });
  return node?.ownerAccountId === ownerAccountId ? publicNode(node) : undefined;
}

export function validateLocalNodeEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new LocalNodeValidationError("Tunnel endpoint must be a valid URL");
  }
  const allowLoopback = process.env.LOCAL_NODE_ALLOW_HTTP_LOOPBACK === "true";
  const isLoopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost";
  if (endpoint.protocol !== "https:" && !(allowLoopback && endpoint.protocol === "http:" && isLoopback)) {
    throw new LocalNodeValidationError("Tunnel endpoint must use HTTPS");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new LocalNodeValidationError("Tunnel endpoint cannot contain credentials, query, or fragment");
  }
  if (endpoint.pathname !== "/" && endpoint.pathname !== "") {
    throw new LocalNodeValidationError("Tunnel endpoint must not contain a path");
  }
  const ngrokHost = /(?:^|\.)(?:ngrok\.app|ngrok-free\.app|ngrok\.io|ngrok-free\.dev)$/i.test(
    endpoint.hostname,
  );
  if (!ngrokHost && !(allowLoopback && isLoopback)) {
    throw new LocalNodeValidationError("Only ngrok HTTPS endpoints are allowed");
  }
  return endpoint;
}

export async function registerLocalNodeEndpoint(
  nodeId: string,
  endpointValue: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<LocalNode | undefined> {
  const stored = await readLocalNode(nodeId);
  if (!stored || stored.revokedAt) return undefined;
  const endpoint = validateLocalNodeEndpoint(endpointValue);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Node health check timed out")), 10_000);
  try {
    const health = await fetcher(new URL("/health", endpoint), {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (health.status >= 300 && health.status < 400) {
      throw new LocalNodeValidationError("Node health endpoint must not redirect");
    }
    if (!health.ok) throw new LocalNodeValidationError("Node health check failed");
    let payload: { nodeId?: unknown; runtime?: unknown };
    try {
      payload = JSON.parse(await boundedResponseText(health, 16 * 1024)) as typeof payload;
    } catch (error) {
      if (error instanceof LocalNodeValidationError) throw error;
      throw new LocalNodeValidationError("Node health endpoint returned invalid JSON");
    }
    if (payload.nodeId !== nodeId || payload.runtime !== "ollama") {
      throw new LocalNodeValidationError("Tunnel does not belong to the expected Ollama node");
    }
  } finally {
    clearTimeout(timeout);
  }
  const node = await updateStoredLocalNode(nodeId, (candidate) => {
    if (candidate.revokedAt) return;
    candidate.endpoint = endpoint.origin;
    candidate.endpointUpdatedAt = new Date(now).toISOString();
  });
  return publicNode(node, now);
}

export async function rotateLocalNodeCredential(
  nodeId: string,
  now = Date.now(),
): Promise<{ node: LocalNode; deviceCredential: string } | undefined> {
  const deviceCredential = `fln_${randomBytes(32).toString("base64url")}`;
  const rotatedAt = new Date(now).toISOString();
  const node = await updateStoredLocalNode(nodeId, (stored) => {
    if (stored.revokedAt) return;
    stored.credential.credentialHash = hashLocalNodeSecret(deviceCredential);
    stored.credential.rotatedAt = rotatedAt;
  });
  const safeNode = publicNode(node, now);
  return safeNode && !safeNode.revokedAt ? { node: safeNode, deviceCredential } : undefined;
}

export async function revokeLocalNode(
  ownerAccountId: string,
  nodeId: string,
  now = Date.now(),
): Promise<LocalNode | undefined> {
  const node = await updateStoredLocalNode(nodeId, (stored) => {
    if (stored.ownerAccountId !== ownerAccountId) return;
    const revokedAt = stored.revokedAt ?? new Date(now).toISOString();
    stored.status = "revoked";
    stored.revokedAt = revokedAt;
    stored.activeRequests = 0;
    delete stored.endpoint;
    delete stored.endpointUpdatedAt;
    stored.credential.revokedAt = stored.credential.revokedAt ?? revokedAt;
  });
  return node?.ownerAccountId === ownerAccountId ? publicNode(node, now) : undefined;
}

export async function deleteLocalNode(
  ownerAccountId: string,
  nodeId: string,
): Promise<boolean> {
  return deleteStoredLocalNode(ownerAccountId, nodeId);
}

export function localProviderId(nodeId: string, modelId: string): string {
  return `local-node:${nodeId}:model:${modelId}`;
}

export async function eligibleLocalNodeProviders(
  ownerAccountId: string,
  requestId: string,
  now = Date.now(),
): Promise<import("../types.js").ProviderRuntime[]> {
  const nodes = await listLocalNodesForOwner(ownerAccountId);
  return nodes.flatMap((stored) => {
    const node = publicNode(stored, now)!;
    if (node.status !== "online" || !node.endpoint || node.revokedAt) return [];
    if (!node.routingEnabled) return [];
    if (node.activeRequests >= node.limits.maxConcurrentRequests) return [];
    const endpoint = node.endpoint;
    return node.models
      .filter((model) => model.enabled && model.installed)
      .map((model) => {
        const id = localProviderId(node.id, model.modelId);
        return {
          id,
          providerType: "local-ollama" as const,
          localNodeId: node.id,
          baseUrl: `${endpoint.replace(/\/+$/, "")}/v1`,
          model: model.modelId,
          priority: node.routingMode === "prefer-local" ? -10_000 : 100,
          routingTier: node.routingMode === "prefer-local" ? -1 : 0,
          timeoutMs: node.limits.totalTimeoutMs,
          streamingTimeoutMs: node.limits.firstTokenTimeoutMs,
          capabilities: {
            streaming: model.capabilities.streaming,
            tools: model.capabilities.tools,
            jsonMode: model.capabilities.structuredOutputs,
            structuredOutputs: model.capabilities.structuredOutputs,
            vision: model.capabilities.vision,
            reasoning: model.capabilities.reasoning,
            embeddings: "unsupported" as const,
          },
          apiKeyValue: undefined,
          redirect: "manual" as const,
          localMaxInputBytes: node.limits.maxInputBytes,
          cooldownUntil: 0,
          failures: 0,
          circuitState: "closed" as const,
          circuitOpenUntil: 0,
          circuitFailureCount: 0,
          circuitOpenCount: 0,
          halfOpenProbeActive: false,
          requestHeaders: async (_body: Record<string, unknown>, routedRequestId: string | undefined) => ({
            authorization: `Bearer ${await signLocalNodeRequest({
              nodeId: node.id,
              ownerAccountId,
              requestId: routedRequestId ?? requestId,
              model: model.modelId,
            })}`,
            "x-free-llm-node-id": node.id,
          }),
        };
      });
  });
}

export async function testLocalNodeModel(params: {
  ownerAccountId: string;
  nodeId: string;
  modelId: string;
  fetcher?: typeof fetch;
}): Promise<{ ok: boolean; status: number; latencyMs: number; message: string }> {
  const stored = await readLocalNode(params.nodeId);
  const node = stored?.ownerAccountId === params.ownerAccountId ? publicNode(stored) : undefined;
  const model = node?.models.find((candidate) => candidate.modelId === params.modelId);
  if (!node || node.status === "revoked") throw new LocalNodeValidationError("Local node not found");
  if (!node.endpoint || node.status === "offline") throw new LocalNodeValidationError("Local node is offline");
  if (!model?.installed || !model.enabled) throw new LocalNodeValidationError("Local model is not enabled");
  const requestId = `test_${randomBytes(12).toString("hex")}`;
  const token = await signLocalNodeRequest({
    nodeId: node.id,
    ownerAccountId: node.ownerAccountId,
    requestId,
    model: model.modelId,
  });
  const startedAt = Date.now();
  const response = await (params.fetcher ?? fetch)(
    `${node.endpoint.replace(/\/+$/, "")}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-request-id": requestId,
      },
      body: JSON.stringify({
        model: model.modelId,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 8,
        stream: false,
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(node.limits.totalTimeoutMs),
    },
  );
  const latencyMs = Date.now() - startedAt;
  if (response.ok) await response.body?.cancel();
  const message = response.ok
    ? "Local model responded successfully"
    : await boundedResponseText(response);
  await updateStoredLocalNode(node.id, (candidate) => {
    const updated = candidate.models.find((item) => item.modelId === model.modelId);
    if (!updated) return;
    updated.lastTestedAt = new Date().toISOString();
    updated.lastLatencyMs = latencyMs;
    updated.health = response.ok ? "healthy" : "error";
    if (response.ok) delete updated.lastError;
    else updated.lastError = message.slice(0, 500);
  });
  return { ok: response.ok, status: response.status, latencyMs, message };
}

export async function recordLocalProviderAttempt(
  nodeId: string,
  modelId: string,
  attempt: { success: boolean; latencyMs: number; message?: string },
): Promise<void> {
  await updateStoredLocalNode(nodeId, (node) => {
    const model = node.models.find((candidate) => candidate.modelId === modelId);
    if (!model) return;
    model.lastTestedAt = new Date().toISOString();
    model.lastLatencyMs = attempt.latencyMs;
    model.health = attempt.success ? "healthy" : "error";
    if (attempt.success) delete model.lastError;
    else if (attempt.message) model.lastError = attempt.message.slice(0, 500);
  });
}
