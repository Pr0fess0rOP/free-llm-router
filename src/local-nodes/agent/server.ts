import { appendFile, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { verifyLocalNodeRequestToken } from "../local-node-request-auth.js";
import type { LocalNodeModel } from "../local-node-types.js";
import { localAgentConfigPath, type LocalAgentConfig } from "./local-node-config.js";

const replayedRequestIds = new Map<string, number>();
const MAX_REPLAY_ENTRIES = 10_000;

export interface LocalAgentHandle {
  close(): Promise<void>;
  activeRequests(): number;
  queuedRequests(): number;
  port: number;
}

class RequestLimiter {
  private active = 0;
  private readonly queued: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
  }> = [];

  constructor(
    private readonly maxConcurrent: () => number,
    private readonly maxQueue: () => number,
  ) {}

  activeCount(): number {
    return this.active;
  }

  queueCount(): number {
    return this.queued.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active < this.maxConcurrent()) {
      this.active += 1;
      return () => this.release();
    }
    if (this.queued.length >= this.maxQueue()) {
      throw new Error("Local node request queue is full");
    }
    await new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject, ...(signal ? { signal } : {}) };
      this.queued.push(entry);
      signal?.addEventListener("abort", () => {
        const index = this.queued.indexOf(entry);
        if (index >= 0) this.queued.splice(index, 1);
        reject(new Error("Queued request was cancelled"));
      }, { once: true });
    });
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queued.shift();
    next?.resolve();
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage, maximum: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) throw new Error("Request body exceeds the local node limit");
    chunks.push(buffer);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function containsImage(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === "string") return false;
  if (Array.isArray(value)) return value.some((item) => containsImage(item, depth + 1));
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (["image_url", "input_image", "image"].includes(String(record.type))) return true;
  if (record.image_url !== undefined || record.images !== undefined) return true;
  return Object.values(record).some((item) => containsImage(item, depth + 1));
}

function validateCapabilities(model: LocalNodeModel | undefined, body: Record<string, unknown>): void {
  if (!model) throw new Error("Requested model is not in the local allowlist");
  if (body.stream === true && model.capabilities.streaming === "unsupported") {
    throw new Error("Local model does not allow streaming");
  }
  if (body.tools && model.capabilities.tools === "unsupported") {
    throw new Error("Local model does not allow tools");
  }
  if (containsImage(body.messages) && model.capabilities.vision === "unsupported") {
    throw new Error("Local model does not allow image input");
  }
  if (body.response_format && model.capabilities.structuredOutputs === "unsupported") {
    throw new Error("Local model does not allow structured output");
  }
  if ((body.reasoning || body.thinking) && model.capabilities.reasoning === "unsupported") {
    throw new Error("Local model does not allow reasoning mode");
  }
}

function pruneReplays(nowSeconds: number): void {
  for (const [requestId, expiresAt] of replayedRequestIds) {
    if (expiresAt <= nowSeconds) replayedRequestIds.delete(requestId);
  }
}

function sanitizedBody(body: Record<string, unknown>, config: LocalAgentConfig): Record<string, unknown> {
  const modelMaximum = config.models.find((model) => model.modelId === body.model)?.maxOutputTokens;
  const maximum = Math.min(config.limits.maxOutputTokens, modelMaximum ?? Number.MAX_SAFE_INTEGER);
  const requestedValue = typeof body.max_tokens === "number"
    ? body.max_tokens
    : typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : maximum;
  const requested = Number.isFinite(requestedValue) ? requestedValue : maximum;
  const maxTokens = Math.max(1, Math.min(Math.floor(requested), maximum));
  return {
    ...body,
    max_tokens: maxTokens,
    ...(body.max_completion_tokens !== undefined
      ? { max_completion_tokens: maxTokens }
      : {}),
  };
}

async function logAgent(config: LocalAgentConfig, event: string, details: Record<string, unknown>): Promise<void> {
  const target = path.resolve(path.dirname(localAgentConfigPath()), "local-node.log");
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await appendFile(target, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...details,
  })}\n`, { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  controller: AbortController,
  message: string,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort(new Error(message));
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function proxyInference(params: {
  request: IncomingMessage;
  response: ServerResponse;
  config: LocalAgentConfig;
  body: Record<string, unknown>;
  limiter: RequestLimiter;
  shutdownSignal: AbortSignal;
}): Promise<void> {
  const { request, response, config, body, limiter, shutdownSignal } = params;
  const modelId = typeof body.model === "string" ? body.model : "";
  const token = bearerToken(request);
  if (!token) {
    sendJson(response, 401, { error: { message: "Router authorization is required" } });
    return;
  }
  let claims;
  try {
    claims = verifyLocalNodeRequestToken({
      token,
      publicKey: config.verificationPublicKey,
      expectedNodeId: config.nodeId,
      expectedOwnerAccountId: config.ownerAccountId,
      expectedModel: modelId,
    });
  } catch (error) {
    sendJson(response, 401, { error: { message: error instanceof Error ? error.message : "Invalid authorization" } });
    return;
  }
  const headerRequestId = Array.isArray(request.headers["x-request-id"])
    ? request.headers["x-request-id"][0]
    : request.headers["x-request-id"];
  if (headerRequestId && headerRequestId !== claims.requestId) {
    sendJson(response, 401, { error: { message: "Request ID does not match authorization" } });
    return;
  }
  const nowSeconds = Math.floor(Date.now() / 1_000);
  pruneReplays(nowSeconds);
  const replayKey = `${config.nodeId}:${claims.requestId}`;
  if (replayedRequestIds.has(replayKey)) {
    sendJson(response, 409, { error: { message: "Request authorization has already been used" } });
    return;
  }
  while (replayedRequestIds.size >= MAX_REPLAY_ENTRIES) {
    const oldest = replayedRequestIds.keys().next().value as string | undefined;
    if (!oldest) break;
    replayedRequestIds.delete(oldest);
  }
  replayedRequestIds.set(replayKey, claims.exp);

  const model = config.models.find((candidate) => candidate.modelId === modelId);
  if (!config.allowedModels.includes(modelId) || !model?.enabled || !model.installed) {
    sendJson(response, 403, { error: { message: "Requested model is not allowed" } });
    return;
  }
  validateCapabilities(model, body);
  const queueAbort = new AbortController();
  const abortQueue = () => queueAbort.abort();
  const abortShutdownQueue = () => queueAbort.abort(new Error("Local node agent is stopping"));
  request.once("aborted", abortQueue);
  shutdownSignal.addEventListener("abort", abortShutdownQueue, { once: true });
  let release: (() => void) | undefined;
  try {
    release = await limiter.acquire(queueAbort.signal);
  } catch (error) {
    sendJson(response, 429, {
      error: { message: error instanceof Error ? error.message : "Local node is busy" },
    });
    return;
  } finally {
    request.removeListener("aborted", abortQueue);
    shutdownSignal.removeEventListener("abort", abortShutdownQueue);
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Router client disconnected"));
  const cancelForShutdown = () => controller.abort(new Error("Local node agent is stopping"));
  request.once("aborted", cancel);
  shutdownSignal.addEventListener("abort", cancelForShutdown, { once: true });
  if (shutdownSignal.aborted) cancelForShutdown();
  response.once("close", () => {
    if (!response.writableEnded) cancel();
  });
  const totalTimeout = setTimeout(
    () => controller.abort(new Error("Local generation exceeded its total timeout")),
    config.limits.totalTimeoutMs,
  );
  let firstTokenTimeout: ReturnType<typeof setTimeout> | undefined;
  if (body.stream === true) {
    firstTokenTimeout = setTimeout(
      () => controller.abort(new Error("Ollama did not produce a first token in time")),
      config.limits.firstTokenTimeoutMs,
    );
  }
  const startedAt = Date.now();
  let outcome: "success" | "upstream_error" | "agent_error" = "agent_error";
  let upstreamStatus: number | undefined;
  try {
    const upstream = await fetch(`${config.ollamaBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: body.stream === true ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(sanitizedBody(body, config)),
      redirect: "error",
      signal: controller.signal,
    });
    upstreamStatus = upstream.status;
    if (!upstream.ok) {
      outcome = "upstream_error";
      const errorBody = await upstream.text();
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      response.end(errorBody);
      return;
    }
    if (body.stream !== true) {
      const payload = await upstream.arrayBuffer();
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      });
      response.end(Buffer.from(payload));
      outcome = "success";
      return;
    }

    if (!upstream.body) throw new Error("Ollama returned an empty stream");
    const reader = upstream.body.getReader();
    const first = await readWithTimeout(
      reader,
      config.limits.firstTokenTimeoutMs,
      controller,
      "Ollama did not produce a first token in time",
    );
    if (first.done || !first.value?.length) throw new Error("Ollama stream ended before the first token");
    if (firstTokenTimeout) {
      clearTimeout(firstTokenTimeout);
      firstTokenTimeout = undefined;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
    });
    response.write(Buffer.from(first.value));
    while (!controller.signal.aborted) {
      const chunk = await readWithTimeout(
        reader,
        config.limits.idleTimeoutMs,
        controller,
        "Ollama stream became idle",
      );
      if (chunk.done) break;
      if (chunk.value?.length) response.write(Buffer.from(chunk.value));
    }
    response.end();
    outcome = "success";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (response.headersSent) {
      if (!response.writableEnded) {
        response.write(`event: error\ndata: ${JSON.stringify({ error: { message, type: "local_node_stream_error" } })}\n\n`);
        response.end();
      }
    } else {
      sendJson(response, 502, { error: { message, type: "local_node_error" } });
    }
  } finally {
    clearTimeout(totalTimeout);
    if (firstTokenTimeout) clearTimeout(firstTokenTimeout);
    request.removeListener("aborted", cancel);
    shutdownSignal.removeEventListener("abort", cancelForShutdown);
    release?.();
    await logAgent(config, "inference_completed", {
      requestId: claims.requestId,
      model: modelId,
      latencyMs: Date.now() - startedAt,
      streamed: body.stream === true,
      outcome,
      ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
    });
  }
}

export async function startLocalAgent(
  config: LocalAgentConfig,
): Promise<LocalAgentHandle> {
  const shutdown = new AbortController();
  const limiter = new RequestLimiter(
    () => config.limits.maxConcurrentRequests,
    () => config.limits.maxQueueSize,
  );
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("x-content-type-options", "nosniff");
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          nodeId: config.nodeId,
          runtime: "ollama",
          status: "online",
          agentVersion: config.cliVersion,
          activeRequests: limiter.activeCount(),
          maxConcurrentRequests: config.limits.maxConcurrentRequests,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/models") {
        sendJson(response, 200, {
          nodeId: config.nodeId,
          models: config.models.filter((model) => config.allowedModels.includes(model.modelId)),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = await readBody(request, config.limits.maxInputBytes);
        await proxyInference({ request, response, config, body, limiter, shutdownSignal: shutdown.signal });
        return;
      }
      sendJson(response, 404, { error: { message: "Not found" } });
    } catch (error) {
      sendJson(response, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.agentPort, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : config.agentPort;
  let closed = false;
  await logAgent(config, "agent_started", { port });
  return {
    port,
    activeRequests: () => limiter.activeCount(),
    queuedRequests: () => limiter.queueCount(),
    close: async () => {
      if (closed) return;
      closed = true;
      shutdown.abort(new Error("Local node agent is stopping"));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      await logAgent(config, "agent_stopped", {});
    },
  };
}
