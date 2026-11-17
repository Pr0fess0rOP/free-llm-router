import type { LocalNode } from "../local-node-types.js";
import { discoverRuntimeModels } from "./runtime.js";
import {
  saveLocalAgentConfig,
  type LocalAgentConfig,
} from "./local-node-config.js";
import { localNodeDeviceRequest } from "./node-api.js";
import type { LocalAgentHandle } from "./server.js";

export async function sendLocalNodeHeartbeat(
  config: LocalAgentConfig,
  agent: LocalAgentHandle,
): Promise<LocalNode> {
  const inventory = await discoverRuntimeModels(config, config.models.map(({ modelId }) => modelId)).catch(() => undefined);
  const node = await localNodeDeviceRequest<LocalNode>(config, "/heartbeat", {
    agentVersion: config.cliVersion,
    ...(inventory?.ollamaVersion ? { ollamaVersion: inventory.ollamaVersion } : {}),
    runtimeStatus: inventory ? "online" : "offline",
    activeRequests: agent.activeRequests(),
    maxConcurrentRequests: config.limits.maxConcurrentRequests,
    ...(inventory ? { models: inventory.models } : {}),
  });
  config.limits = node.limits;
  config.models = node.models;
  config.allowedModels = node.models
    .filter((model) => model.enabled && model.installed)
    .map((model) => model.modelId);
  if (node.lastHeartbeatAt) config.lastHeartbeatAt = node.lastHeartbeatAt;
  else delete config.lastHeartbeatAt;
  config.lastKnownActiveRequests = node.activeRequests;
  await saveLocalAgentConfig(config);
  return node;
}
