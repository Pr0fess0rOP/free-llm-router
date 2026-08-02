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

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() || undefined;
}

function originForHost(host: string | undefined, protocol?: string): string | undefined {
  if (!host || /[\s/?#@]/.test(host)) return undefined;
  const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
  const normalizedProtocol = protocol === "http" || protocol === "https"
    ? protocol
    : local ? "http" : "https";
  try {
    return new URL(`${normalizedProtocol}://${host}`).origin;
  } catch {
    return undefined;
  }
}

export function clerkAuthorizedParties(request: IncomingMessage): string[] {
  const explicit = (process.env.CLERK_AUTHORIZED_PARTIES ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const forwardedProtocol = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]);
  const requestHost = firstHeaderValue(request.headers.host);
  return [...new Set([
    ...explicit,
    originForHost(forwardedHost, forwardedProtocol),
    originForHost(requestHost, forwardedProtocol),
  ].filter((value): value is string => Boolean(value)))];
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

    const verified = await verifyToken(token, {
      secretKey,
      ...(authorizedParties.length ? { authorizedParties } : {}),
    });

    return typeof verified.sub === "string" ? verified.sub : undefined;
  } catch (error) {
    console.error("Clerk token verification failed:", error);
    return undefined;
  }
}
