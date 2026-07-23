import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

type JsonObject = Record<string, unknown>;

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function contentAsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!isObject(block)) return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "tool_result") return contentAsText(block.content);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toOpenAIUserContent(blocks: JsonObject[]): unknown {
  const parts: Array<JsonObject> = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
      continue;
    }

    if (block.type === "image" && isObject(block.source)) {
      const mediaType = stringValue(block.source.media_type);
      const data = stringValue(block.source.data);
      if (block.source.type === "base64" && mediaType && data) {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${mediaType};base64,${data}` },
        });
      }
    }
  }

  if (parts.length === 0) return "";
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => String(part.text ?? "")).join("\n");
  }
  return parts;
}

function convertUserMessage(content: unknown): OpenAIMessage[] {
  if (typeof content === "string") return [{ role: "user", content }];
  if (!Array.isArray(content)) return [{ role: "user", content: "" }];

  const output: OpenAIMessage[] = [];
  let pendingBlocks: JsonObject[] = [];

  const flushUserBlocks = (): void => {
    if (pendingBlocks.length === 0) return;
    output.push({ role: "user", content: toOpenAIUserContent(pendingBlocks) });
    pendingBlocks = [];
  };

  for (const rawBlock of content) {
    if (!isObject(rawBlock)) continue;
    if (rawBlock.type !== "tool_result") {
      pendingBlocks.push(rawBlock);
      continue;
    }

    flushUserBlocks();
    const toolCallId = stringValue(rawBlock.tool_use_id) ?? `toolu_${randomUUID()}`;
    const toolText = contentAsText(rawBlock.content);
    output.push({
      role: "tool",
      tool_call_id: toolCallId,
      content: rawBlock.is_error === true ? `Tool error: ${toolText}` : toolText,
    });
  }

  flushUserBlocks();
  return output.length > 0 ? output : [{ role: "user", content: "" }];
}

function convertAssistantMessage(content: unknown): OpenAIMessage {
  if (typeof content === "string") return { role: "assistant", content };
  if (!Array.isArray(content)) return { role: "assistant", content: "" };

  const text: string[] = [];
  const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];

  for (const rawBlock of content) {
    if (!isObject(rawBlock)) continue;
    if (rawBlock.type === "text" && typeof rawBlock.text === "string") {
      text.push(rawBlock.text);
      continue;
    }
    if (rawBlock.type === "tool_use") {
      const id = stringValue(rawBlock.id) ?? `toolu_${randomUUID()}`;
      const name = stringValue(rawBlock.name) ?? "unknown_tool";
      const input = isObject(rawBlock.input) ? rawBlock.input : {};
      toolCalls.push({
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(input) },
      });
    }
  }

  return {
    role: "assistant",
    content: text.join("\n") || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function convertMessages(messages: unknown): OpenAIMessage[] {
  if (!Array.isArray(messages)) return [];
  const output: OpenAIMessage[] = [];

  for (const rawMessage of messages) {
    if (!isObject(rawMessage)) continue;
    if (rawMessage.role === "user") {
      output.push(...convertUserMessage(rawMessage.content));
    } else if (rawMessage.role === "assistant") {
      output.push(convertAssistantMessage(rawMessage.content));
    }
  }

  return output;
}

function convertTools(tools: unknown): JsonObject[] | undefined {
  if (!Array.isArray(tools)) return undefined;

  const converted = tools.flatMap((rawTool): JsonObject[] => {
    if (!isObject(rawTool) || typeof rawTool.name !== "string") return [];
    const parameters = isObject(rawTool.input_schema)
      ? rawTool.input_schema
      : { type: "object", properties: {} };
    return [{
      type: "function",
      function: {
        name: rawTool.name,
        ...(typeof rawTool.description === "string"
          ? { description: rawTool.description }
          : {}),
        parameters,
      },
    }];
  });

  return converted.length > 0 ? converted : undefined;
}

function convertToolChoice(toolChoice: unknown): unknown {
  if (!isObject(toolChoice)) return undefined;
  switch (toolChoice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return typeof toolChoice.name === "string"
        ? { type: "function", function: { name: toolChoice.name } }
        : "required";
    default:
      return undefined;
  }
}

export function anthropicToOpenAI(body: JsonObject): JsonObject {
  const messages: OpenAIMessage[] = [];
  const system = contentAsText(body.system);
  if (system) messages.push({ role: "system", content: system });
  messages.push(...convertMessages(body.messages));

  const tools = convertTools(body.tools);
  const toolChoice = convertToolChoice(body.tool_choice);
  const outputConfig = isObject(body.output_config) ? body.output_config : undefined;
  const responseFormat = outputConfig && isObject(outputConfig.format)
    ? outputConfig.format
    : undefined;

  return {
    model: typeof body.model === "string" ? body.model : "claude-free-router",
    messages,
    max_tokens: numberValue(body.max_tokens) ?? 4096,
    stream: body.stream === true,
    ...(numberValue(body.temperature) !== undefined
      ? { temperature: numberValue(body.temperature) }
      : {}),
    ...(numberValue(body.top_p) !== undefined ? { top_p: numberValue(body.top_p) } : {}),
    ...(Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0
      ? { stop: body.stop_sequences }
      : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(isObject(body.tool_choice) && body.tool_choice.disable_parallel_tool_use === true
      ? { parallel_tool_calls: false }
      : {}),
    ...(responseFormat?.type === "json_schema" && isObject(responseFormat.schema)
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: stringValue(responseFormat.name) ?? "response",
              schema: responseFormat.schema,
              strict: responseFormat.strict === true,
            },
          },
        }
      : {}),
    ...(isObject(body.thinking) && body.thinking.type === "enabled"
      ? { reasoning_effort: "medium" }
      : {}),
  };
}

function normalizeOpenAIText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isObject(part)) return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .join("");
}

function mapStopReason(finishReason: unknown, hasTools: boolean): string | null {
  if (hasTools || finishReason === "tool_calls" || finishReason === "function_call") {
    return "tool_use";
  }
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "stop" || finishReason === "content_filter") return "end_turn";
  return finishReason === null || finishReason === undefined ? null : "end_turn";
}

function anthropicMessageId(value: unknown): string {
  if (typeof value === "string" && value.startsWith("msg_")) return value;
  const normalized = typeof value === "string"
    ? value.replace(/[^A-Za-z0-9_-]/g, "").slice(-48)
    : "";
  return `msg_${normalized || randomUUID().replaceAll("-", "")}`;
}

export function openAIToAnthropic(
  payload: unknown,
  requestedModel: string,
): JsonObject {
  if (!isObject(payload) || !Array.isArray(payload.choices)) {
    throw new Error("Upstream provider returned an invalid chat completion response");
  }

  const choice = payload.choices.find(isObject) ?? {};
  const message = isObject(choice.message) ? choice.message : {};
  const text = normalizeOpenAIText(message.content);
  const content: JsonObject[] = [];
  if (text) content.push({ type: "text", text });

  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const rawCall of rawToolCalls) {
    if (!isObject(rawCall)) continue;
    const fn = isObject(rawCall.function) ? rawCall.function : {};
    const rawArguments = stringValue(fn.arguments) ?? "{}";
    let input: unknown = {};
    try {
      input = JSON.parse(rawArguments) as unknown;
    } catch {
      input = { _raw: rawArguments };
    }
    content.push({
      type: "tool_use",
      id: stringValue(rawCall.id) ?? `toolu_${randomUUID()}`,
      name: stringValue(fn.name) ?? "unknown_tool",
      input: isObject(input) ? input : { value: input },
    });
  }

  const usage = isObject(payload.usage) ? payload.usage : {};
  return {
    id: anthropicMessageId(payload.id),
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: mapStopReason(choice.finish_reason, rawToolCalls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: numberValue(usage.prompt_tokens) ?? 0,
      output_tokens: numberValue(usage.completion_tokens) ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

export function approximateAnthropicInputTokens(body: JsonObject): number {
  const serialized = JSON.stringify({
    system: body.system,
    messages: body.messages,
    tools: body.tools,
    tool_choice: body.tool_choice,
  });
  return Math.max(1, Math.ceil(serialized.length / 4));
}

function writeSse(response: ServerResponse, event: string, data: JsonObject): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function emitAnthropicMessageAsStream(
  response: ServerResponse,
  message: JsonObject,
): void {
  const content = Array.isArray(message.content) ? message.content : [];
  content.forEach((rawBlock, index) => {
    if (!isObject(rawBlock)) return;
    if (rawBlock.type === "text") {
      writeSse(response, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      writeSse(response, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: stringValue(rawBlock.text) ?? "" },
      });
      writeSse(response, "content_block_stop", { type: "content_block_stop", index });
      return;
    }
    if (rawBlock.type === "tool_use") {
      writeSse(response, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: stringValue(rawBlock.id) ?? `toolu_${randomUUID()}`,
          name: stringValue(rawBlock.name) ?? "unknown_tool",
          input: {},
        },
      });
      writeSse(response, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(isObject(rawBlock.input) ? rawBlock.input : {}),
        },
      });
      writeSse(response, "content_block_stop", { type: "content_block_stop", index });
    }
  });
}

function parseSseFrame(frame: string): string | undefined {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data || undefined;
}

export async function streamOpenAIAsAnthropic(params: {
  upstream: Response;
  response: ServerResponse;
  requestedModel: string;
  inputTokens: number;
}): Promise<JsonObject> {
  const { upstream, response, requestedModel, inputTokens } = params;
  const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");

  writeSse(response, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: requestedModel,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });

  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const text = await upstream.text();
    const payload = JSON.parse(text) as unknown;
    const message = openAIToAnthropic(payload, requestedModel);
    emitAnthropicMessageAsStream(response, message);
    const usage = isObject(message.usage) ? message.usage : {};
    writeSse(response, "message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: stringValue(message.stop_reason) ?? "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: numberValue(usage.output_tokens) ?? 0 },
    });
    writeSse(response, "message_stop", { type: "message_stop" });
    const content = Array.isArray(message.content) ? message.content : [];
    return {
      ...message,
      id: messageId,
      model: requestedModel,
      content,
      usage: {
        input_tokens: inputTokens,
        output_tokens: numberValue(usage.output_tokens) ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
  }

  if (!upstream.body) {
    writeSse(response, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    });
    writeSse(response, "message_stop", { type: "message_stop" });
    return {
      id: messageId,
      type: "message",
      role: "assistant",
      model: requestedModel,
      content: [],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let textBlockIndex: number | undefined;
  let nextBlockIndex = 0;
  let outputText = "";
  let finishReason: unknown;
  let upstreamOutputTokens: number | undefined;
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  const closeTextBlock = (): void => {
    if (textBlockIndex === undefined) return;
    writeSse(response, "content_block_stop", {
      type: "content_block_stop",
      index: textBlockIndex,
    });
    textBlockIndex = undefined;
  };

  const processChunk = (payload: unknown): void => {
    if (!isObject(payload)) return;
    const usage = isObject(payload.usage) ? payload.usage : undefined;
    upstreamOutputTokens = numberValue(usage?.completion_tokens) ?? upstreamOutputTokens;
    if (!Array.isArray(payload.choices)) return;

    for (const rawChoice of payload.choices) {
      if (!isObject(rawChoice)) continue;
      if (rawChoice.finish_reason !== null && rawChoice.finish_reason !== undefined) {
        finishReason = rawChoice.finish_reason;
      }
      const delta = isObject(rawChoice.delta) ? rawChoice.delta : {};
      const text = normalizeOpenAIText(delta.content);
      if (text) {
        if (textBlockIndex === undefined) {
          textBlockIndex = nextBlockIndex++;
          writeSse(response, "content_block_start", {
            type: "content_block_start",
            index: textBlockIndex,
            content_block: { type: "text", text: "" },
          });
        }
        outputText += text;
        writeSse(response, "content_block_delta", {
          type: "content_block_delta",
          index: textBlockIndex,
          delta: { type: "text_delta", text },
        });
      }

      if (!Array.isArray(delta.tool_calls)) continue;
      for (const rawCall of delta.tool_calls) {
        if (!isObject(rawCall)) continue;
        const index = numberValue(rawCall.index) ?? 0;
        const existing = toolCalls.get(index) ?? {
          id: `toolu_${randomUUID()}`,
          name: "",
          arguments: "",
        };
        if (typeof rawCall.id === "string" && rawCall.id) existing.id = rawCall.id;
        const fn = isObject(rawCall.function) ? rawCall.function : {};
        if (typeof fn.name === "string") existing.name += fn.name;
        if (typeof fn.arguments === "string") existing.arguments += fn.arguments;
        toolCalls.set(index, existing);
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer = `${buffer}${decoder.decode(value, { stream: true })}`
      .replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = parseSseFrame(frame);
      if (data && data !== "[DONE]") {
        try {
          processChunk(JSON.parse(data) as unknown);
        } catch {
          // Ignore malformed provider chunks and continue streaming valid chunks.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  const trailing = parseSseFrame(buffer);
  if (trailing && trailing !== "[DONE]") {
    try {
      processChunk(JSON.parse(trailing) as unknown);
    } catch {
      // Ignore an incomplete trailing event.
    }
  }

  closeTextBlock();

  for (const [, toolCall] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
    const index = nextBlockIndex++;
    writeSse(response, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.name || "unknown_tool",
        input: {},
      },
    });
    writeSse(response, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: toolCall.arguments || "{}",
      },
    });
    writeSse(response, "content_block_stop", { type: "content_block_stop", index });
  }

  const outputTokens = upstreamOutputTokens
    ?? Math.max(1, Math.ceil((outputText.length
      + [...toolCalls.values()].reduce((total, call) => total + call.arguments.length, 0)) / 4));
  const stopReason = mapStopReason(finishReason, toolCalls.size > 0) ?? "end_turn";
  writeSse(response, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
    usage: { output_tokens: outputTokens },
  });
  writeSse(response, "message_stop", { type: "message_stop" });

  const content: JsonObject[] = [];
  if (outputText) content.push({ type: "text", text: outputText });
  for (const [, toolCall] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
    let input: unknown = {};
    try {
      input = JSON.parse(toolCall.arguments || "{}") as unknown;
    } catch {
      input = { _raw: toolCall.arguments };
    }
    content.push({
      type: "tool_use",
      id: toolCall.id,
      name: toolCall.name || "unknown_tool",
      input: isObject(input) ? input : { value: input },
    });
  }

  return {
    id: messageId,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

export function anthropicError(
  type: string,
  message: string,
  extra?: JsonObject,
): JsonObject {
  return {
    type: "error",
    error: { type, message, ...(extra ?? {}) },
  };
}
