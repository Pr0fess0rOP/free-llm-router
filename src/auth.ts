import { verifyToken } from "@clerk/backend";
import type { IncomingMessage } from "node:http";

export function clerkPublishableKey(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??
    process.env.CLERK_PUBLISHABLE_KEY
  );
}

function getRequestOrigin(request: IncomingMessage): string | undefined {
  const host = request.headers.host;
  if (!host) return undefined;

  const forwardedProto = request.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");

  return `${protocol}://${host}`;
}

export async function sessionUserId(
  request: IncomingMessage,
): Promise<string | undefined> {
  const tokenHeader = request.headers["x-clerk-session-token"];
  const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;

  const secretKey = process.env.CLERK_SECRET_KEY;

  if (!token || !secretKey) {
    console.warn("Missing Clerk token or CLERK_SECRET_KEY");
    return undefined;
  }

  try {
    const origin = getRequestOrigin(request);

    const verified = await verifyToken(token, {
      secretKey,
      ...(origin ? { authorizedParties: [origin] } : {}),
    });

    return typeof verified.sub === "string" ? verified.sub : undefined;
  } catch (error) {
    console.error("Clerk token verification failed:", error);
    return undefined;
  }
}