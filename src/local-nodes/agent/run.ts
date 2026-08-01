import {
  saveLocalAgentConfig,
  type LocalAgentConfig,
} from "./local-node-config.js";
import { sendLocalNodeHeartbeat } from "./heartbeat.js";
import { registerAgentEndpoint } from "./node-api.js";
import { startLocalAgent } from "./server.js";
import { currentNgrokEndpoint, startOrConnectNgrok, type LocalTunnelHandle } from "./tunnel.js";

export async function runLocalNode(
  config: LocalAgentConfig,
  options: { onStatus?: (message: string) => void } = {},
): Promise<void> {
  const status = options.onStatus ?? (() => undefined);
  const credentialWasRevoked = (error: unknown) =>
    error instanceof Error && /invalid or revoked node credential/i.test(error.message);
  const agent = await startLocalAgent(config);
  config.agentPid = process.pid;
  await saveLocalAgentConfig(config);
  status(`Local agent listening on 127.0.0.1:${agent.port}`);
  let tunnel: LocalTunnelHandle | undefined;
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await tunnel?.close().catch(() => undefined);
    await agent.close().catch(() => undefined);
    delete config.agentPid;
    await saveLocalAgentConfig(config).catch(() => undefined);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  try {
    while (!stopped) {
      if (tunnel) {
        const observedEndpoint = await currentNgrokEndpoint(agent.port);
        if (!observedEndpoint) {
          status("Tunnel disconnected; reconnecting...");
          await tunnel.close().catch(() => undefined);
          tunnel = undefined;
        } else if (observedEndpoint !== tunnel.endpoint) {
          tunnel.endpoint = observedEndpoint;
          config.tunnelEndpoint = observedEndpoint;
          await saveLocalAgentConfig(config);
          await registerAgentEndpoint(config, observedEndpoint);
          status(`Tunnel endpoint changed and was registered: ${observedEndpoint}`);
        }
      }
      if (!tunnel || (tunnel.process && tunnel.process.exitCode !== null)) {
        await tunnel?.close().catch(() => undefined);
        try {
          status("Starting secure ngrok tunnel...");
          tunnel = await startOrConnectNgrok(config, agent.port);
          config.tunnelEndpoint = tunnel.endpoint;
          await saveLocalAgentConfig(config);
          await registerAgentEndpoint(config, tunnel.endpoint);
          status(`Node registered at ${tunnel.endpoint}`);
        } catch (error) {
          await tunnel?.close().catch(() => undefined);
          tunnel = undefined;
          if (credentialWasRevoked(error)) {
            status("Node credential was revoked; stopping local agent.");
            await stop();
            break;
          }
          status(`Tunnel connection failed: ${error instanceof Error ? error.message : String(error)}. Retrying...`);
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          continue;
        }
      }
      try {
        const node = await sendLocalNodeHeartbeat(config, agent);
        status(`Heartbeat accepted (${node.status}, ${node.activeRequests} active)`);
      } catch (error) {
        if (credentialWasRevoked(error)) {
          status("Node credential was revoked; stopping local agent.");
          await stop();
          break;
        }
        status(`Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 20_000);
        const check = setInterval(() => {
          if (stopped) {
            clearTimeout(timeout);
            clearInterval(check);
            resolve();
          }
        }, 200);
        setTimeout(() => clearInterval(check), 20_100);
      });
    }
  } finally {
    await stop();
  }
}
