import { verifyToken } from "@clerk/backend";
import type { IncomingMessage } from "node:http";

export function clerkPublishableKey(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??
    process.env.CLERK_PUBLISHABLE_KEY
  );
}

export function clerkConfigurationError(): string | undefined {
  const publishableKey = clerkPublishableKey()?.trim();
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!publishableKey) return "Clerk publishable key is missing";
  if (!secretKey) return "Clerk secret key is missing";

  const publishableEnvironment = /^pk_(test|live)_/.exec(publishableKey)?.[1];
  const secretEnvironment = /^sk_(test|live)_/.exec(secretKey)?.[1];
  if (
    publishableEnvironment &&
    secretEnvironment &&
    publishableEnvironment !== secretEnvironment
  ) {
    return "Clerk publishable and secret keys use different environments";
  }
  return undefined;
}

export function clerkAuthorizedParties(request: IncomingMessage): string[] {
  const explicit = (process.env.CLERK_AUTHORIZED_PARTIES ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (explicit.length) {
    return [...new Set(explicit.map((value) => {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
          url.pathname !== "/" || url.search || url.hash) {
        throw new Error("CLERK_AUTHORIZED_PARTIES must contain HTTP or HTTPS origins");
      }
      return url.origin;
    }))];
  }
  if (process.env.VERCEL === "1") {
    return [...new Set([
      process.env.VERCEL_URL,
      process.env.VERCEL_PROJECT_PRODUCTION_URL,
      process.env.VERCEL_BRANCH_URL,
    ].filter((value): value is string => Boolean(value))
      .map((host) => new URL(`https://${host}`).origin))];
  }
  const host = request.headers.host;
  const peer = request.socket?.remoteAddress;
  const localPeer = peer === "::1" || peer?.startsWith("127.") || peer?.startsWith("::ffff:127.");
  if (process.env.NODE_ENV !== "production" && localPeer && host && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) {
    return [new URL(`http://${host}`).origin];
  }
  return [];
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const cookie = request.headers.cookie;
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sessionToken(request: IncomingMessage): string | undefined {
  const tokenHeader = request.headers["x-clerk-session-token"];
  const customToken = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
  if (customToken) return customToken;
  const authorization = request.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  if (bearer?.split(".").length === 3) return bearer;
  return cookieValue(request, "__session");
}

export async function sessionUserId(
  request: IncomingMessage,
): Promise<string | undefined> {
  const token = sessionToken(request);
  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  const configurationError = clerkConfigurationError();

  if (!token) {
    console.warn("Missing Clerk session token");
    return undefined;
  }
  if (configurationError || !secretKey) {
    console.warn(configurationError ?? "Missing CLERK_SECRET_KEY");
    return undefined;
  }

  try {
    const authorizedParties = clerkAuthorizedParties(request);
    if (!authorizedParties.length) {
      throw new Error("Set CLERK_AUTHORIZED_PARTIES to the public dashboard origin");
    }

    const verified = await verifyToken(token, {
      secretKey,
      authorizedParties,
    });

    return typeof verified.sub === "string" ? verified.sub : undefined;
  } catch (error) {
    console.error("Clerk token verification failed:", error);
    return undefined;
  }
}
