import { Ajv } from "ajv";
import type { ProviderCapabilityName } from "./types.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validToolCall(value: unknown): boolean {
  if (!record(value) || !record(value.function)) return false;
  if (typeof value.function.name !== "string" || !value.function.name.length ||
      typeof value.function.arguments !== "string") return false;
  try {
    return record(JSON.parse(value.function.arguments));
  } catch {
    return false;
  }
}

function validMessage(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false;
  if (value.role !== undefined && value.role !== "assistant") return false;
  if (value.tool_calls !== undefined &&
      (!Array.isArray(value.tool_calls) || !value.tool_calls.every(validToolCall))) return false;
  const content = value.content;
  return typeof content === "string"
    || (Array.isArray(content) && content.length > 0 && content.every((part) =>
      record(part) && part.type === "text" && typeof part.text === "string"))
    || (typeof value.refusal === "string" && value.refusal.length > 0)
    || (Array.isArray(value.tool_calls) && value.tool_calls.length > 0)
    || validToolCall({ function: value.function_call });
}

function observedCapabilities(
  messages: Record<string, unknown>[],
  payload: Record<string, unknown>,
  body: Record<string, unknown>,
): ProviderCapabilityName[] {
  const observed: ProviderCapabilityName[] = [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const requestedNames = new Set(tools.flatMap((tool) =>
    record(tool) && record(tool.function) && typeof tool.function.name === "string" ? [tool.function.name] : []));
  if (messages.some((message) => Array.isArray(message.tool_calls) && message.tool_calls.some((call) =>
    record(call) && record(call.function) && requestedNames.has(String(call.function.name))))) {
    observed.push("tools");
  }
  const usage = record(payload.usage) ? payload.usage : {};
  const details = record(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  if (messages.some((message) =>
    (typeof message.reasoning_content === "string" && message.reasoning_content.trim().length > 0)
    || (typeof message.reasoning === "string" && message.reasoning.trim().length > 0)
    || (Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0))
    || (typeof details.reasoning_tokens === "number" && details.reasoning_tokens > 0)) {
    observed.push("reasoning");
  }
  const format = record(body.response_format) ? body.response_format : {};
  if (!["json_object", "json_schema"].includes(String(format.type))) return observed;
  try {
    const outputs = messages.map((message) => {
      if (typeof message.content !== "string" || message.content.length > 64 * 1024) throw new Error("Unobserved JSON output");
      return JSON.parse(message.content) as unknown;
    });
    if (format.type === "json_object" && outputs.every(record)) observed.push("jsonMode");
    if (format.type === "json_schema" && record(format.json_schema)) {
      const schema = format.json_schema.schema;
      if (!record(schema) && typeof schema !== "boolean") return observed;
      const serialized = JSON.stringify(schema);
      // Unsupported or expensive schema features leave evidence unknown.
      if (!serialized || serialized.length > 16 * 1024 ||
          /"(?:pattern|patternProperties|format|\$async)"\s*:/.test(serialized)) return observed;
      const validator = new Ajv({ strict: true, strictTypes: false, strictTuples: false, allowUnionTypes: true, logger: false });
      const validate = validator.compile(schema);
      if (outputs.every((output) => validate(output) === true)) observed.push("structuredOutputs");
    }
  } catch {
    // An inconclusive response cannot establish JSON or schema support.
  }
  return observed;
}

interface ResponseInspection {
  response: Response;
  error?: string;
  observedSupportedCapabilities: ProviderCapabilityName[];
}

async function inspectStream(response: Response): Promise<ResponseInspection> {
  const invalid = (error: string): ResponseInspection => ({ response, error, observedSupportedCapabilities: [] });
  if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    void response.body?.cancel().catch(() => undefined);
    return invalid("Provider did not return a chat completion event stream");
  }
  const reader = response.body.getReader();
  const prefix: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  let bytes = 0;
  while (bytes < 64 * 1024) {
    const { value, done } = await reader.read();
    if (done) break;
    prefix.push(value);
    bytes += value.byteLength;
    if (bytes > 64 * 1024) break;
    const lines = (pending + decoder.decode(value, { stream: true })).split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      try {
        const payload: unknown = JSON.parse(line.slice(5).trim());
        if (!record(payload) || !Array.isArray(payload.choices) || !payload.choices.some((choice) =>
          record(choice) && record(choice.delta) && (
            choice.delta.role === "assistant" || typeof choice.delta.content === "string"
            || typeof choice.delta.refusal === "string" || typeof choice.delta.reasoning_content === "string"
            || (Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length > 0)
            || record(choice.delta.function_call)
          ))) continue;
        let replayPrefix = true;
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (replayPrefix) {
              replayPrefix = false;
              for (const chunk of prefix) controller.enqueue(chunk);
              return;
            }
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
          cancel: (reason) => reader.cancel(reason),
        });
        return {
          response: new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers }),
          observedSupportedCapabilities: ["streaming"],
        };
      } catch {
        // Keep looking past comments, metadata, and terminal markers.
      }
    }
  }
  await reader.cancel().catch(() => undefined);
  return invalid("Provider stream contained no chat completion chunks");
}

export async function inspectProviderResponse(
  response: Response,
  body: Record<string, unknown>,
): Promise<ResponseInspection> {
  if (body.stream === true) return inspectStream(response);
  try {
    const payload: unknown = await response.clone().json();
    if (!record(payload) || payload.error !== undefined || !Array.isArray(payload.choices)
      || payload.choices.length === 0 || !payload.choices.every((choice) => record(choice) && validMessage(choice.message))) {
      void response.body?.cancel().catch(() => undefined);
      return { response, error: "Provider returned a malformed chat completion response", observedSupportedCapabilities: [] };
    }
    const messages = payload.choices.map((choice) => (choice as Record<string, unknown>).message as Record<string, unknown>);
    return { response, observedSupportedCapabilities: observedCapabilities(messages, payload, body) };
  } catch {
    void response.body?.cancel().catch(() => undefined);
    return { response, error: "Provider returned invalid JSON", observedSupportedCapabilities: [] };
  }
}
