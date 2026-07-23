import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type RequestIdSource = "client" | "generated";

export interface RequestCorrelation {
  requestId: string;
  source: RequestIdSource;
  startedAt: number;
  clientRequestId?: string;
}

const REQUEST_CONTEXT = Symbol("free-llm-request-correlation");
const MAX_CLIENT_REQUEST_ID_LENGTH = 128;
const SAFE_CLIENT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

type RequestWithCorrelation = IncomingMessage & {
  [REQUEST_CONTEXT]?: RequestCorrelation;
};

export function generateRequestId(): string {
  return `req_${randomUUID().replaceAll("-", "")}`;
}

export function validClientRequestId(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_CLIENT_REQUEST_ID_LENGTH ||
    !SAFE_CLIENT_REQUEST_ID.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

export function requestCorrelation(request: IncomingMessage): RequestCorrelation {
  const contextualRequest = request as RequestWithCorrelation;
  if (contextualRequest[REQUEST_CONTEXT]) return contextualRequest[REQUEST_CONTEXT]!;

  const clientRequestId = validClientRequestId(request.headers["x-request-id"]);
  const correlation: RequestCorrelation = clientRequestId
    ? {
        requestId: clientRequestId,
        clientRequestId,
        source: "client",
        startedAt: Date.now(),
      }
    : {
        requestId: generateRequestId(),
        source: "generated",
        startedAt: Date.now(),
      };
  contextualRequest[REQUEST_CONTEXT] = correlation;
  return correlation;
}

export function setRequestCorrelationHeaders(
  response: ServerResponse,
  correlation: RequestCorrelation,
): void {
  response.setHeader("x-free-llm-request-id", correlation.requestId);
  response.setHeader("x-free-llm-request-id-source", correlation.source);
  if (correlation.clientRequestId) {
    response.setHeader("x-free-llm-client-request-id", correlation.clientRequestId);
  }
}

export function addRequestIdToErrorPayload(
  body: unknown,
  requestId: string | undefined,
): unknown {
  if (!requestId || !body || typeof body !== "object" || Array.isArray(body)) return body;
  const payload = body as Record<string, unknown>;
  if (payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)) {
    return {
      ...payload,
      error: {
        ...(payload.error as Record<string, unknown>),
        request_id: requestId,
      },
    };
  }
  return { ...payload, request_id: requestId };
}
