import { createHash } from "node:crypto";
import { generateRequestId } from "./request-ids.js";

import type { DeduplicationMetadata, DeduplicationSettings } from "./types.js";

export interface CapturedHttpResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

interface DeduplicationEntry {
  originalRequestId: string;
  promise: Promise<CapturedHttpResponse>;
  completed: boolean;
  expiresAt: number;
  duplicateCount: number;
}

export const DEFAULT_DEDUPLICATION_SETTINGS: DeduplicationSettings = {
  enabled: true,
  windowMs: 30_000,
  automaticFingerprinting: true,
  requireIdempotencyKey: false,
  bypassToolRequests: true,
  bypassMultimodalRequests: true,
  bypassNonDeterministicRequests: true,
};

const MIN_WINDOW_MS = 1_000;
const MAX_WINDOW_MS = 5 * 60_000;
const MAX_CACHED_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DEDUPLICATION_ENTRIES = 500;
const entries = new Map<string, DeduplicationEntry>();

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function normalizeDeduplicationSettings(
  value: unknown,
): DeduplicationSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_DEDUPLICATION_SETTINGS };
  }
  const candidate = value as Partial<DeduplicationSettings>;
  return {
    enabled: candidate.enabled !== false,
    windowMs: boundedInteger(
      candidate.windowMs,
      DEFAULT_DEDUPLICATION_SETTINGS.windowMs,
      MIN_WINDOW_MS,
      MAX_WINDOW_MS,
    ),
    automaticFingerprinting: candidate.automaticFingerprinting !== false,
    requireIdempotencyKey: candidate.requireIdempotencyKey === true,
    bypassToolRequests: candidate.bypassToolRequests !== false,
    bypassMultimodalRequests: candidate.bypassMultimodalRequests !== false,
    bypassNonDeterministicRequests:
      candidate.bypassNonDeterministicRequests !== false,
  };
}

export function parseDeduplicationSettings(value: unknown): DeduplicationSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Deduplication settings must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.windowMs !== undefined &&
    (!Number.isFinite(Number(candidate.windowMs)) ||
      Number(candidate.windowMs) < MIN_WINDOW_MS ||
      Number(candidate.windowMs) > MAX_WINDOW_MS)
  ) {
    throw new Error("Deduplication window must be between 1 and 300 seconds");
  }
  return normalizeDeduplicationSettings(candidate);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function defaultModelForEndpoint(endpoint: string): string {
  if (endpoint === "/v1/responses") return "codex-free-router";
  if (endpoint === "/v1/messages") return "claude-free-router";
  return "free-router";
}

function canonicalRequestBody(
  endpoint: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...body,
    model: typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : defaultModelForEndpoint(endpoint),
    stream: body.stream === true,
  };
}

export function createRequestFingerprint(params: {
  routerKeyHash: string;
  endpoint: string;
  body: Record<string, unknown>;
  idempotencyKey?: string;
}): string {
  const identity = params.idempotencyKey
    ? { idempotencyKey: params.idempotencyKey }
    : { body: stableValue(canonicalRequestBody(params.endpoint, params.body)) };
  return createHash("sha256")
    .update(JSON.stringify({
      routerKeyHash: params.routerKeyHash,
      endpoint: params.endpoint,
      ...identity,
    }))
    .digest("hex");
}

function hasToolRequest(body: Record<string, unknown>): boolean {
  return (
    (Array.isArray(body.tools) && body.tools.length > 0) ||
    (Array.isArray(body.functions) && body.functions.length > 0) ||
    body.tool_choice !== undefined ||
    body.toolChoice !== undefined
  );
}

function containsMultimodalInput(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsMultimodalInput(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  const type = typeof object.type === "string" ? object.type.toLowerCase() : "";
  if (
    type.includes("image") ||
    type.includes("audio") ||
    type === "file" ||
    object.image_url !== undefined ||
    object.imageUrl !== undefined ||
    object.input_image !== undefined ||
    object.input_audio !== undefined ||
    object.file_id !== undefined
  ) {
    return true;
  }
  return Object.values(object).some((item) => containsMultimodalInput(item, depth + 1));
}

function isExplicitlyNonDeterministic(body: Record<string, unknown>): boolean {
  const temperature = Number(body.temperature);
  const topP = Number(body.top_p ?? body.topP);
  const candidates = Number(body.n ?? body.candidate_count);
  return (
    (Number.isFinite(temperature) && temperature > 0) ||
    (Number.isFinite(topP) && topP > 0 && topP < 1) ||
    (Number.isFinite(candidates) && candidates > 1)
  );
}

export function deduplicationBypassReason(params: {
  body: Record<string, unknown>;
  settings: DeduplicationSettings;
  idempotencyKey?: string;
}): string | undefined {
  if (!params.settings.enabled) return "disabled";
  if (params.body.stream === true) return "streaming_request";
  if (params.settings.requireIdempotencyKey && !params.idempotencyKey) {
    return "idempotency_key_required";
  }
  if (!params.idempotencyKey && !params.settings.automaticFingerprinting) {
    return "automatic_fingerprinting_disabled";
  }
  // Explicit idempotency keys are an opt-in override for otherwise conservative
  // automatic safety checks. Streaming remains excluded because it cannot be replayed safely.
  if (!params.idempotencyKey) {
    if (params.settings.bypassToolRequests && hasToolRequest(params.body)) {
      return "tool_request";
    }
    if (
      params.settings.bypassMultimodalRequests &&
      containsMultimodalInput(params.body)
    ) {
      return "multimodal_request";
    }
    if (
      params.settings.bypassNonDeterministicRequests &&
      isExplicitlyNonDeterministic(params.body)
    ) {
      return "non_deterministic_request";
    }
  }
  return undefined;
}

function cleanupExpired(now = Date.now()): void {
  for (const [key, entry] of entries) {
    if (entry.completed && entry.expiresAt <= now) entries.delete(key);
  }
}

export async function executeDeduplicated(params: {
  key: string;
  windowMs: number;
  requestId?: string;
  execute: () => Promise<CapturedHttpResponse>;
}): Promise<{ response: CapturedHttpResponse; metadata: DeduplicationMetadata }> {
  cleanupExpired();
  const existing = entries.get(params.key);
  if (existing && (!existing.completed || existing.expiresAt > Date.now())) {
    existing.duplicateCount += 1;
    const source = existing.completed ? "completed" as const : "in-flight" as const;
    const response = await existing.promise;
    return {
      response,
      metadata: {
        deduplicated: true,
        originalRequestId: existing.originalRequestId,
        source,
        duplicateCount: existing.duplicateCount,
        providerCallAvoided: true,
        estimatedRequestsSaved: 1,
      },
    };
  }

  const originalRequestId = params.requestId ?? generateRequestId();
  if (entries.size >= MAX_DEDUPLICATION_ENTRIES) {
    for (const [candidateKey, candidate] of entries) {
      if (candidate.completed) {
        entries.delete(candidateKey);
        break;
      }
    }
    if (entries.size >= MAX_DEDUPLICATION_ENTRIES) {
      return {
        response: await params.execute(),
        metadata: {
          deduplicated: false,
          originalRequestId,
          source: "original",
          duplicateCount: 0,
          providerCallAvoided: false,
          estimatedRequestsSaved: 0,
        },
      };
    }
  }
  const entry: DeduplicationEntry = {
    originalRequestId,
    completed: false,
    expiresAt: Number.POSITIVE_INFINITY,
    duplicateCount: 0,
    promise: Promise.resolve({ status: 500, headers: {}, body: Buffer.alloc(0) }),
  };

  entry.promise = params.execute()
    .then((response) => {
      entry.completed = true;
      const cacheable =
        response.status >= 200 &&
        response.status < 300 &&
        response.body.byteLength <= MAX_CACHED_RESPONSE_BYTES;
      if (cacheable) {
        entry.expiresAt = Date.now() + params.windowMs;
      } else {
        entries.delete(params.key);
      }
      return response;
    })
    .catch((error) => {
      entries.delete(params.key);
      throw error;
    });
  entries.set(params.key, entry);

  const response = await entry.promise;
  return {
    response,
    metadata: {
      deduplicated: false,
      originalRequestId,
      source: "original",
      duplicateCount: entry.duplicateCount,
      providerCallAvoided: false,
      estimatedRequestsSaved: 0,
    },
  };
}

export function clearDeduplicationCache(): void {
  entries.clear();
}
