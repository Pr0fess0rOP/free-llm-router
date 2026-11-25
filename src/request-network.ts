import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

function normalizedAddress(value: string | undefined): string | undefined {
  if (!value || !isIP(value)) return undefined;
  return value.toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, "$1");
}

export function requestClientAddress(request: IncomingMessage): string {
  const peer = normalizedAddress(request.socket.remoteAddress);
  if (process.env.VERCEL === "1") {
    const platformAddress = request.headers["x-vercel-forwarded-for"];
    if (typeof platformAddress === "string") {
      const address = normalizedAddress(platformAddress.trim());
      if (address) return address;
    }
  }
  const trustedPeers = (process.env.TRUSTED_PROXY_IPS ?? "")
    .split(",").map((value) => normalizedAddress(value.trim())).filter(Boolean);
  if (peer && trustedPeers.includes(peer)) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const address = normalizedAddress(forwarded.split(",").at(-1)?.trim());
      if (address) return address;
    }
  }
  return peer ?? "unknown";
}
