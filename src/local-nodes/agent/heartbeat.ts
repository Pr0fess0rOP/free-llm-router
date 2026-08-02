import type { LocalNode } from "../local-node-types.js";
import { discoverOllamaModels, ollamaVersion } from "./ollama-client.js";
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
  const [version, discovered] = await Promise.all([
    ollamaVersion(config.ollamaBaseUrl).catch(() => "unavailable"),
    discoverOllamaModels(config.ollamaBaseUrl).catch(() => []),
  ]);
  const installed = new Set(discovered.map((model) => model.id));
  const node = await localNodeDeviceRequest<LocalNode>(config, "/heartbeat", {
    agentVersion: config.cliVersion,
    ollamaVersion: version,
    activeRequests: agent.activeRequests(),
    maxConcurrentRequests: config.limits.maxConcurrentRequests,
    models: [
      ...discovered.map((model) => ({ id: model.id, installed: true })),
      ...config.models
        .filter((model) => !installed.has(model.modelId))
        .map((model) => ({ id: model.modelId, installed: false })),
    ],
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
