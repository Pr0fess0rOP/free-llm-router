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

type ToolCallState = {
  outputIndex: number;
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  emitted: boolean;
};

type ResponseToolDescriptor = {
  kind: "function" | "custom";
  name: string;
  namespace?: string;
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

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function serializeToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isObject(part)) return "";
      if (
        ["input_text", "output_text", "text"].includes(String(part.type))
        && typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function contentToOpenAI(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: JsonObject[] = [];
  for (const rawPart of content) {
    if (typeof rawPart === "string") {
      parts.push({ type: "text", text: rawPart });
      continue;
    }
    if (!isObject(rawPart)) continue;

    if (
      ["input_text", "output_text", "text"].includes(String(rawPart.type))
      && typeof rawPart.text === "string"
    ) {
      parts.push({ type: "text", text: rawPart.text });
      continue;
    }

    if (rawPart.type === "input_image") {
      const imageUrl = stringValue(rawPart.image_url) ?? stringValue(rawPart.url);
      if (imageUrl) {
        parts.push({
          type: "image_url",
          image_url: {
            url: imageUrl,
            ...(typeof rawPart.detail === "string" ? { detail: rawPart.detail } : {}),
          },
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

function appendAssistantToolCall(
  messages: OpenAIMessage[],
  toolCall: NonNullable<OpenAIMessage["tool_calls"]>[number],
): void {
  const previous = messages.at(-1);
  if (
    previous?.role === "assistant"
    && previous.content === null
    && Array.isArray(previous.tool_calls)
  ) {
    previous.tool_calls.push(toolCall);
    return;
  }

  messages.push({
    role: "assistant",
    content: null,
    tool_calls: [toolCall],
  });
}

function flattenToolName(name: string, namespace?: string): string {
  return namespace ? `${namespace}${name}` : name;
}

function customArguments(input: unknown): string {
  return JSON.stringify({ input: serializeToolOutput(input) });
}

function customInputFromArguments(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (isObject(parsed) && typeof parsed.input === "string") return parsed.input;
  } catch {
    // A provider may return raw freeform input instead of the wrapper object.
  }
  return argumentsText;
}

function responseToolDescriptor(
  requestBody: JsonObject,
  upstreamName: string,
): ResponseToolDescriptor {
  const tools = Array.isArray(requestBody.tools) ? requestBody.tools : [];

  for (const rawTool of tools) {
    if (!isObject(rawTool)) continue;
    const type = stringValue(rawTool.type);
    const name = stringValue(rawTool.name);

    if ((type === "function" || type === "custom") && name === upstreamName) {
      return { kind: type, name: upstreamName };
    }

    if (type !== "namespace" || !name || !Array.isArray(rawTool.tools)) continue;
    for (const rawNamespacedTool of rawTool.tools) {
      if (!isObject(rawNamespacedTool)) continue;
      const innerName = stringValue(rawNamespacedTool.name);
      if (!innerName || flattenToolName(innerName, name) !== upstreamName) continue;
      return {
        kind: rawNamespacedTool.type === "custom" ? "custom" : "function",
        name: innerName,
        namespace: name,
      };
    }
  }

  return { kind: "function", name: upstreamName || "unknown_tool" };
}

function responseToolItem(params: {
  requestBody: JsonObject;
  itemId: string;
  callId: string;
  upstreamName: string;
  argumentsText: string;
  status: "in_progress" | "completed";
}): JsonObject {
  const {
    requestBody,
    itemId,
    callId,
    upstreamName,
    argumentsText,
    status,
  } = params;
  const descriptor = responseToolDescriptor(requestBody, upstreamName);

  if (descriptor.kind === "custom") {
    return {
      id: itemId.replace(/^fc_/, "ctc_"),
      type: "custom_tool_call",
      status,
      call_id: callId,
      name: descriptor.name,
      ...(descriptor.namespace ? { namespace: descriptor.namespace } : {}),
      input: customInputFromArguments(argumentsText),
    };
  }

  return {
    id: itemId,
    type: "function_call",
    status,
    call_id: callId,
    name: descriptor.name,
    ...(descriptor.namespace ? { namespace: descriptor.namespace } : {}),
    arguments: argumentsText,
  };
}

function responseInputToMessages(input: unknown): OpenAIMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];

  const messages: OpenAIMessage[] = [];

  for (const rawItem of input) {
    if (typeof rawItem === "string") {
      messages.push({ role: "user", content: rawItem });
      continue;
    }
    if (!isObject(rawItem)) continue;

    const itemType = stringValue(rawItem.type);
    const role = stringValue(rawItem.role);

    if (itemType === "reasoning" || itemType === "item_reference") {
      continue;
    }

    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const callId = stringValue(rawItem.call_id)
        ?? stringValue(rawItem.id)
        ?? `call_${randomUUID().replaceAll("-", "")}`;
      const name = flattenToolName(
        stringValue(rawItem.name) ?? "unknown_tool",
        stringValue(rawItem.namespace),
      );
      const argumentsText = itemType === "custom_tool_call"
        ? customArguments(rawItem.input)
        : typeof rawItem.arguments === "string"
          ? rawItem.arguments
          : serializeToolOutput(rawItem.arguments ?? {});
      appendAssistantToolCall(messages, {
        id: callId,
        type: "function",
        function: { name, arguments: argumentsText || "{}" },
      });
      continue;
    }

    if (
      itemType === "function_call_output"
      || itemType === "custom_tool_call_output"
      || itemType === "computer_call_output"
      || itemType === "local_shell_call_output"
    ) {
      const callId = stringValue(rawItem.call_id)
        ?? stringValue(rawItem.id)
        ?? `call_${randomUUID().replaceAll("-", "")}`;
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: serializeToolOutput(rawItem.output),
      });
      continue;
    }

    if (itemType === "message" || role) {
      const normalizedRole = role === "developer" || role === "system"
        ? "system"
        : role === "assistant"
          ? "assistant"
          : "user";
      messages.push({
        role: normalizedRole,
        content: contentToOpenAI(rawItem.content),
      });
    }
  }

  return messages;
}

function convertTools(tools: unknown): JsonObject[] | undefined {
  if (!Array.isArray(tools)) return undefined;

  const convertSingleTool = (
    rawTool: JsonObject,
    namespace?: string,
  ): JsonObject[] => {
    const type = stringValue(rawTool.type);
    const name = stringValue(rawTool.name);
    if (!name) return [];

    if (type === "function") {
      const parameters = isObject(rawTool.parameters)
        ? rawTool.parameters
        : { type: "object", properties: {} };
      return [{
        type: "function",
        function: {
          name: flattenToolName(name, namespace),
          ...(typeof rawTool.description === "string"
            ? { description: rawTool.description }
            : {}),
          parameters,
          ...(typeof rawTool.strict === "boolean" ? { strict: rawTool.strict } : {}),
        },
      }];
    }

    if (type === "custom") {
      return [{
        type: "function",
        function: {
          name: flattenToolName(name, namespace),
          ...(typeof rawTool.description === "string"
            ? { description: rawTool.description }
            : {}),
          parameters: {
            type: "object",
            properties: {
              input: { type: "string" },
            },
            required: ["input"],
            additionalProperties: false,
          },
        },
      }];
    }

    return [];
  };

  const converted = tools.flatMap((rawTool): JsonObject[] => {
    if (!isObject(rawTool)) return [];
    if (
      rawTool.type === "namespace"
      && typeof rawTool.name === "string"
      && Array.isArray(rawTool.tools)
    ) {
      return rawTool.tools.flatMap((innerTool): JsonObject[] => (
        isObject(innerTool) ? convertSingleTool(innerTool, rawTool.name as string) : []
      ));
    }
    return convertSingleTool(rawTool);
  });

  return converted.length > 0 ? converted : undefined;
}

function convertToolChoice(toolChoice: unknown): unknown {
  if (typeof toolChoice === "string") {
    return ["auto", "none", "required"].includes(toolChoice)
      ? toolChoice
      : undefined;
  }
  if (!isObject(toolChoice)) return undefined;

  if (toolChoice.type === "function" && typeof toolChoice.name === "string") {
    return { type: "function", function: { name: toolChoice.name } };
  }
  if (toolChoice.type === "none") return "none";
  if (toolChoice.type === "required") return "required";
  return "auto";
}

function convertResponseFormat(text: unknown): unknown {
  if (!isObject(text) || !isObject(text.format)) return undefined;
  const format = text.format;

  if (format.type === "json_object") return { type: "json_object" };
  if (format.type === "json_schema" && isObject(format.schema)) {
    return {
      type: "json_schema",
      json_schema: {
        name: stringValue(format.name) ?? "response",
        schema: format.schema,
        strict: format.strict === true,
      },
    };
  }
  return undefined;
}

export function responsesToOpenAI(body: JsonObject): JsonObject {
  const messages: OpenAIMessage[] = [];
  const instructions = textFromContent(body.instructions);
  if (instructions) messages.push({ role: "system", content: instructions });
  messages.push(...responseInputToMessages(body.input));

  if (messages.length === 0) {
    throw new Error("Responses API requires a non-empty input");
  }

  const tools = convertTools(body.tools);
  const toolChoice = convertToolChoice(body.tool_choice);
  const responseFormat = convertResponseFormat(body.text);

  return {
    model: typeof body.model === "string" ? body.model : "codex-free-router",
    messages,
    stream: body.stream === true,
    max_tokens: numberValue(body.max_output_tokens) ?? 4096,
    ...(numberValue(body.temperature) !== undefined
      ? { temperature: numberValue(body.temperature) }
      : {}),
    ...(numberValue(body.top_p) !== undefined ? { top_p: numberValue(body.top_p) } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(booleanValue(body.parallel_tool_calls) !== undefined
      ? { parallel_tool_calls: booleanValue(body.parallel_tool_calls) }
      : {}),
    ...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
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

function responseId(value: unknown): string {
  if (typeof value === "string" && value.startsWith("resp_")) return value;
  return `resp_${randomUUID().replaceAll("-", "")}`;
}

function responseUsage(usage: unknown, fallbackInput = 0, fallbackOutput = 0): JsonObject {
  const source = isObject(usage) ? usage : {};
  const inputTokens = numberValue(source.prompt_tokens)
    ?? numberValue(source.input_tokens)
    ?? fallbackInput;
  const outputTokens = numberValue(source.completion_tokens)
    ?? numberValue(source.output_tokens)
    ?? fallbackOutput;
  const totalTokens = numberValue(source.total_tokens) ?? inputTokens + outputTokens;

  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: totalTokens,
  };
}

function responseSkeleton(params: {
  id: string;
  requestedModel: string;
  body: JsonObject;
  status: "in_progress" | "completed" | "failed" | "incomplete";
  output: JsonObject[];
  usage: JsonObject | null;
  createdAt: number;
}): JsonObject {
  const { id, requestedModel, body, status, output, usage, createdAt } = params;
  const textConfig = isObject(body.text) ? body.text : { format: { type: "text" } };
  const reasoning = isObject(body.reasoning) ? body.reasoning : null;

  return {
    id,
    object: "response",
    created_at: createdAt,
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: body.instructions ?? null,
    max_output_tokens: numberValue(body.max_output_tokens) ?? null,
    max_tool_calls: numberValue(body.max_tool_calls) ?? null,
    model: requestedModel,
    output,
    parallel_tool_calls: booleanValue(body.parallel_tool_calls) ?? true,
    previous_response_id: stringValue(body.previous_response_id) ?? null,
    reasoning,
    store: body.store === true,
    temperature: numberValue(body.temperature) ?? 1,
    text: textConfig,
    tool_choice: body.tool_choice ?? "auto",
    tools: Array.isArray(body.tools) ? body.tools : [],
    top_p: numberValue(body.top_p) ?? 1,
    truncation: body.truncation ?? "disabled",
    usage,
    user: body.user ?? null,
    metadata: isObject(body.metadata) ? body.metadata : {},
  };
}

export function openAIToResponses(
  payload: unknown,
  requestedModel: string,
  requestBody: JsonObject,
): JsonObject {
  if (!isObject(payload) || !Array.isArray(payload.choices)) {
    throw new Error("Upstream provider returned an invalid chat completion response");
  }

  const choice = payload.choices.find(isObject) ?? {};
  const message = isObject(choice.message) ? choice.message : {};
  const output: JsonObject[] = [];
  const text = normalizeOpenAIText(message.content);

  if (text) {
    output.push({
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }

  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const rawCall of rawToolCalls) {
    if (!isObject(rawCall)) continue;
    const fn = isObject(rawCall.function) ? rawCall.function : {};
    output.push(responseToolItem({
      requestBody,
      itemId: `fc_${randomUUID().replaceAll("-", "")}`,
      callId: stringValue(rawCall.id) ?? `call_${randomUUID().replaceAll("-", "")}`,
      upstreamName: stringValue(fn.name) ?? "unknown_tool",
      argumentsText: stringValue(fn.arguments) ?? "{}",
      status: "completed",
    }));
  }

  const createdAt = numberValue(payload.created) ?? Math.floor(Date.now() / 1000);
  return responseSkeleton({
    id: responseId(payload.id),
    requestedModel,
    body: requestBody,
    status: "completed",
    output,
    usage: responseUsage(payload.usage),
    createdAt,
  });
}

export function approximateResponsesInputTokens(body: JsonObject): number {
  const serialized = JSON.stringify({
    instructions: body.instructions,
    input: body.input,
    tools: body.tools,
    tool_choice: body.tool_choice,
  });
  return Math.max(1, Math.ceil(serialized.length / 4));
}

function parseSseFrame(frame: string): string | undefined {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data || undefined;
}

export async function streamOpenAIAsResponses(params: {
  upstream: Response;
  response: ServerResponse;
  requestedModel: string;
  requestBody: JsonObject;
  inputTokens: number;
}): Promise<JsonObject> {
  const { upstream, response, requestedModel, requestBody, inputTokens } = params;
  const id = `resp_${randomUUID().replaceAll("-", "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let sequenceNumber = 0;

  const writeEvent = (type: string, data: JsonObject): void => {
    response.write(`event: ${type}\ndata: ${JSON.stringify({
      ...data,
      type,
      sequence_number: sequenceNumber++,
    })}\n\n`);
  };

  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");

  const initialResponse = responseSkeleton({
    id,
    requestedModel,
    body: requestBody,
    status: "in_progress",
    output: [],
    usage: null,
    createdAt,
  });
  writeEvent("response.created", { response: initialResponse });
  writeEvent("response.in_progress", { response: initialResponse });

  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const text = await upstream.text();
    const payload = JSON.parse(text) as unknown;
    const completed = openAIToResponses(payload, requestedModel, requestBody);
    const output = Array.isArray(completed.output) ? completed.output : [];

    output.forEach((rawItem, outputIndex) => {
      if (!isObject(rawItem)) return;
      writeEvent("response.output_item.added", {
        output_index: outputIndex,
        item: { ...rawItem, status: "in_progress" },
      });
      if (rawItem.type === "message" && Array.isArray(rawItem.content)) {
        const part = rawItem.content.find(isObject);
        if (part && part.type === "output_text") {
          writeEvent("response.content_part.added", {
            item_id: rawItem.id,
            output_index: outputIndex,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
          writeEvent("response.output_text.delta", {
            item_id: rawItem.id,
            output_index: outputIndex,
            content_index: 0,
            delta: stringValue(part.text) ?? "",
          });
          writeEvent("response.output_text.done", {
            item_id: rawItem.id,
            output_index: outputIndex,
            content_index: 0,
            text: stringValue(part.text) ?? "",
          });
          writeEvent("response.content_part.done", {
            item_id: rawItem.id,
            output_index: outputIndex,
            content_index: 0,
            part,
          });
        }
      } else if (rawItem.type === "function_call") {
        const argumentsText = stringValue(rawItem.arguments) ?? "{}";
        writeEvent("response.function_call_arguments.delta", {
          item_id: rawItem.id,
          output_index: outputIndex,
          delta: argumentsText,
        });
        writeEvent("response.function_call_arguments.done", {
          item_id: rawItem.id,
          output_index: outputIndex,
          name: stringValue(rawItem.name) ?? "unknown_tool",
          arguments: argumentsText,
        });
      } else if (rawItem.type === "custom_tool_call") {
        const input = stringValue(rawItem.input) ?? "";
        writeEvent("response.custom_tool_call_input.delta", {
          item_id: rawItem.id,
          output_index: outputIndex,
          delta: input,
        });
        writeEvent("response.custom_tool_call_input.done", {
          item_id: rawItem.id,
          output_index: outputIndex,
          name: stringValue(rawItem.name) ?? "unknown_tool",
          input,
        });
      }
      writeEvent("response.output_item.done", { output_index: outputIndex, item: rawItem });
    });

    writeEvent("response.completed", { response: completed });
    return completed;
  }

  if (!upstream.body) {
    const completed = responseSkeleton({
      id,
      requestedModel,
      body: requestBody,
      status: "completed",
      output: [],
      usage: responseUsage(undefined, inputTokens, 0),
      createdAt,
    });
    writeEvent("response.completed", { response: completed });
    return completed;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nextOutputIndex = 0;
  let textOutputIndex: number | undefined;
  let textItemId: string | undefined;
  let outputText = "";
  let finishReason: unknown;
  let upstreamInputTokens: number | undefined;
  let upstreamOutputTokens: number | undefined;
  const toolCalls = new Map<number, ToolCallState>();

  const ensureTextItem = (): void => {
    if (textOutputIndex !== undefined && textItemId) return;
    textOutputIndex = nextOutputIndex++;
    textItemId = `msg_${randomUUID().replaceAll("-", "")}`;
    writeEvent("response.output_item.added", {
      output_index: textOutputIndex,
      item: {
        id: textItemId,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    });
    writeEvent("response.content_part.added", {
      item_id: textItemId,
      output_index: textOutputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  };

  const ensureToolItem = (state: ToolCallState): void => {
    if (state.emitted || !state.name) return;
    state.emitted = true;
    writeEvent("response.output_item.added", {
      output_index: state.outputIndex,
      item: responseToolItem({
        requestBody,
        itemId: state.itemId,
        callId: state.callId,
        upstreamName: state.name,
        argumentsText: "",
        status: "in_progress",
      }),
    });
  };

  const processChunk = (payload: unknown): void => {
    if (!isObject(payload)) return;
    const usage = isObject(payload.usage) ? payload.usage : undefined;
    upstreamInputTokens = numberValue(usage?.prompt_tokens) ?? upstreamInputTokens;
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
        ensureTextItem();
        outputText += text;
        writeEvent("response.output_text.delta", {
          item_id: textItemId,
          output_index: textOutputIndex,
          content_index: 0,
          delta: text,
        });
      }

      if (!Array.isArray(delta.tool_calls)) continue;
      for (const rawCall of delta.tool_calls) {
        if (!isObject(rawCall)) continue;
        const index = numberValue(rawCall.index) ?? 0;
        const existing = toolCalls.get(index) ?? {
          outputIndex: nextOutputIndex++,
          itemId: `fc_${randomUUID().replaceAll("-", "")}`,
          callId: `call_${randomUUID().replaceAll("-", "")}`,
          name: "",
          arguments: "",
          emitted: false,
        };
        if (typeof rawCall.id === "string" && rawCall.id) existing.callId = rawCall.id;
        const fn = isObject(rawCall.function) ? rawCall.function : {};
        if (typeof fn.name === "string") existing.name += fn.name;
        toolCalls.set(index, existing);
        ensureToolItem(existing);
        if (typeof fn.arguments === "string" && fn.arguments) {
          existing.arguments += fn.arguments;
          const descriptor = responseToolDescriptor(requestBody, existing.name);
          if (descriptor.kind === "function") {
            writeEvent("response.function_call_arguments.delta", {
              item_id: existing.itemId,
              output_index: existing.outputIndex,
              delta: fn.arguments,
            });
          }
        }
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
          // Ignore malformed provider chunks and continue processing valid frames.
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

  const output: JsonObject[] = [];
  if (textOutputIndex !== undefined && textItemId) {
    writeEvent("response.output_text.done", {
      item_id: textItemId,
      output_index: textOutputIndex,
      content_index: 0,
      text: outputText,
    });
    const textPart = { type: "output_text", text: outputText, annotations: [] };
    writeEvent("response.content_part.done", {
      item_id: textItemId,
      output_index: textOutputIndex,
      content_index: 0,
      part: textPart,
    });
    const messageItem = {
      id: textItemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [textPart],
    };
    writeEvent("response.output_item.done", {
      output_index: textOutputIndex,
      item: messageItem,
    });
    output[textOutputIndex] = messageItem;
  }

  for (const [, state] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
    ensureToolItem(state);
    const argumentsText = state.arguments || "{}";
    const descriptor = responseToolDescriptor(requestBody, state.name);
    const toolItem = responseToolItem({
      requestBody,
      itemId: state.itemId,
      callId: state.callId,
      upstreamName: state.name || "unknown_tool",
      argumentsText,
      status: "completed",
    });
    const emittedItemId = stringValue(toolItem.id) ?? state.itemId;
    if (descriptor.kind === "custom") {
      writeEvent("response.custom_tool_call_input.done", {
        item_id: emittedItemId,
        output_index: state.outputIndex,
        name: descriptor.name,
        input: customInputFromArguments(argumentsText),
      });
    } else {
      writeEvent("response.function_call_arguments.done", {
        item_id: emittedItemId,
        output_index: state.outputIndex,
        name: descriptor.name,
        arguments: argumentsText,
      });
    }
    writeEvent("response.output_item.done", {
      output_index: state.outputIndex,
      item: toolItem,
    });
    output[state.outputIndex] = toolItem;
  }

  const compactOutput = output.filter(isObject);
  const fallbackOutputTokens = Math.max(
    1,
    Math.ceil((outputText.length
      + [...toolCalls.values()].reduce((total, call) => total + call.arguments.length, 0)) / 4),
  );
  const completed = responseSkeleton({
    id,
    requestedModel,
    body: requestBody,
    status: "completed",
    output: compactOutput,
    usage: responseUsage(
      {
        prompt_tokens: upstreamInputTokens,
        completion_tokens: upstreamOutputTokens,
      },
      inputTokens,
      fallbackOutputTokens,
    ),
    createdAt,
  });

  if (finishReason === "length") {
    completed.incomplete_details = { reason: "max_output_tokens" };
  }
  writeEvent("response.completed", { response: completed });
  return completed;
}

export function responsesError(
  message: string,
  type = "invalid_request_error",
  code: string | null = null,
  param: string | null = null,
): JsonObject {
  return {
    error: {
      message,
      type,
      param,
      code,
    },
  };
}
