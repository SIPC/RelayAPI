import "server-only";

import { randomUUID } from "node:crypto";
import { antigravityObject as object, antigravityString as string } from "@/src/server/antigravity/protocol";
import { responsesSseDataPayload } from "@/src/server/codex/sse";
import { HttpError } from "@/src/server/http/errors";

// Claude Messages <-> Responses conversion for Antigravity. Thinking signatures round-trip as
// Responses reasoning items, so the Antigravity request builder handles every protocol the same way.

function invalid(message: string): never {
  throw new HttpError(400, "unsupported_antigravity_input", message);
}

function blocks(content: unknown) {
  return typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.map(object) : [];
}

export function claudeMessagesToResponses(payload: Record<string, unknown>) {
  const input: Record<string, unknown>[] = [];
  for (const raw of Array.isArray(payload.messages) ? payload.messages : []) {
    const message = object(raw);
    const assistant = message.role === "assistant";
    if (!assistant && message.role !== "user") invalid("Claude messages require user or assistant roles");
    let parts: Record<string, unknown>[] = [];
    const flush = () => {
      if (parts.length) input.push({ type: "message", role: assistant ? "assistant" : "user", content: parts });
      parts = [];
    };
    for (const block of blocks(message.content)) {
      if (block.type === "text") {
        parts.push({ type: assistant ? "output_text" : "input_text", text: string(block.text) });
      } else if (block.type === "image" && !assistant) {
        const source = object(block.source);
        if (source.type !== "base64") invalid("Antigravity input images require base64 data");
        parts.push({ type: "input_image", image_url: `data:${string(source.media_type)};base64,${string(source.data)}` });
      } else if (block.type === "thinking" && assistant) {
        flush();
        input.push({ type: "reasoning", summary: [{ type: "summary_text", text: string(block.thinking) }],
          encrypted_content: string(block.signature) });
      } else if (block.type === "redacted_thinking" && assistant) {
        continue;
      } else if (block.type === "tool_use" && assistant) {
        flush();
        input.push({ type: "function_call", call_id: string(block.id), name: string(block.name),
          arguments: JSON.stringify(object(block.input)) });
      } else if (block.type === "tool_result" && !assistant) {
        flush();
        const content = block.content;
        const output = typeof content === "string" ? content
          : blocks(content).filter(item => item.type === "text").map(item => string(item.text)).join("\n");
        input.push({ type: "function_call_output", call_id: string(block.tool_use_id), output });
      } else {
        invalid("Antigravity does not support Claude content block " + string(block.type));
      }
    }
    flush();
  }

  const system = typeof payload.system === "string" ? payload.system
    : blocks(payload.system).filter(item => item.type === "text").map(item => string(item.text)).join("\n");
  const tools = (Array.isArray(payload.tools) ? payload.tools : []).map(raw => {
    const tool = object(raw);
    if (tool.type && tool.type !== "custom") invalid("Antigravity Messages supports client tools only");
    return { type: "function", name: string(tool.name), description: string(tool.description) || undefined,
      parameters: tool.input_schema };
  });
  const choice = object(payload.tool_choice);
  const toolChoice = choice.type === "any" ? "required" : choice.type === "none" ? "none"
    : choice.type === "tool" ? { type: "function", name: string(choice.name) } : undefined;

  const thinking = object(payload.thinking);
  const effort = string(object(payload.output_config).effort).toLowerCase();
  const reasoning: Record<string, unknown> = {};
  if (thinking.type === "enabled" && typeof thinking.budget_tokens === "number") reasoning.budget_tokens = thinking.budget_tokens;
  else if (thinking.type === "adaptive" || thinking.type === "auto") reasoning.effort = effort || "high";
  else if (thinking.type === "disabled") reasoning.effort = "none";
  // CPA only sends includeThoughts when the client states display intent.
  if (thinking.display === "omitted") reasoning.summary = "none";
  else if (thinking.display === "summarized") reasoning.summary = "auto";

  const format = object(object(payload.output_config).format);
  return {
    instructions: system || undefined,
    input,
    tools: tools.length ? tools : undefined,
    tool_choice: toolChoice,
    max_output_tokens: payload.max_tokens,
    temperature: payload.temperature,
    top_p: payload.top_p,
    top_k: payload.top_k,
    stop_sequences: payload.stop_sequences,
    reasoning: Object.keys(reasoning).length ? reasoning : undefined,
    text: format.type === "json_schema" ? { format: { type: "json_schema", schema: format.schema } } : undefined,
  };
}

function stopReason(response: Record<string, unknown>, toolUse: boolean) {
  const reason = string(object(response.incomplete_details).reason);
  if (reason === "max_output_tokens") return "max_tokens";
  if (reason === "content_filter") return "refusal";
  return toolUse ? "tool_use" : "end_turn";
}

function usageOf(response: Record<string, unknown>) {
  const usage = object(response.usage);
  const cached = Number(object(usage.input_tokens_details).cached_tokens) || 0;
  return {
    input_tokens: Math.max(0, (Number(usage.input_tokens) || 0) - cached),
    cache_read_input_tokens: cached,
    output_tokens: Number(usage.output_tokens) || 0,
  };
}

function argumentsObject(raw: string) {
  try { return object(JSON.parse(raw || "{}")); } catch { return {}; }
}

// restoreName maps shortened upstream tool names back to the caller's names (Codex limits them to 64 chars).
type RestoreName = (name: string) => string;
const keepName: RestoreName = name => name;

export function responsesToClaudeMessage(response: Record<string, unknown>, model: string, restoreName = keepName) {
  const content: Record<string, unknown>[] = [];
  for (const raw of Array.isArray(response.output) ? response.output : []) {
    const item = object(raw);
    if (item.type === "reasoning") {
      const text = (Array.isArray(item.summary) ? item.summary : []).map(part => string(object(part).text)).join("");
      content.push({ type: "thinking", thinking: text, signature: string(item.encrypted_content) });
    } else if (item.type === "message") {
      const text = (Array.isArray(item.content) ? item.content : []).map(part => string(object(part).text)).join("");
      if (text) content.push({ type: "text", text });
    } else if (item.type === "function_call") {
      content.push({ type: "tool_use", id: string(item.call_id), name: restoreName(string(item.name)), input: argumentsObject(string(item.arguments)) });
    }
  }
  return {
    id: "msg_" + randomUUID().replaceAll("-", ""),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason(response, content.some(block => block.type === "tool_use")),
    stop_sequence: null,
    usage: usageOf(response),
  };
}

// Re-frames Responses SSE (from AntigravityResponsesOutput or Codex) as Claude Messages SSE.
export function responsesStreamToClaude(body: ReadableStream<Uint8Array>, model: string, restoreName = keepName) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const indexes = new Map<number, number>();
  const kinds = new Map<number, string>();
  let next = 0;
  let pending = "";
  let toolUse = false;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const frames = pending.split("\n\n");
      pending = frames.pop() ?? "";
      for (const frame of frames) {
        const data = responsesSseDataPayload(frame);
        if (data) handle(object(JSON.parse(data)), controller);
      }
    },
  }));

  function send(controller: TransformStreamDefaultController<Uint8Array>, type: string, data: Record<string, unknown>) {
    controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
  }

  // Opens a block for a delta whose output_item.added never arrived (Codex may skip it for text and reasoning).
  function blockFor(outputIndex: number, type: "text" | "thinking", controller: TransformStreamDefaultController<Uint8Array>) {
    const existing = indexes.get(outputIndex);
    if (existing !== undefined) return existing;
    indexes.set(outputIndex, next);
    kinds.set(outputIndex, type);
    send(controller, "content_block_start", { index: next, content_block: type === "text" ? { type, text: "" } : { type, thinking: "" } });
    return next++;
  }

  function handle(event: Record<string, unknown>, controller: TransformStreamDefaultController<Uint8Array>) {
    const outputIndex = Number(event.output_index) || 0;
    const index = indexes.get(outputIndex);
    switch (event.type) {
      case "response.created":
        send(controller, "message_start", { message: {
          id: "msg_" + randomUUID().replaceAll("-", ""), type: "message", role: "assistant", model, content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
        } });
        return;
      case "response.output_item.added": {
        const item = object(event.item);
        const block = item.type === "reasoning" ? { type: "thinking", thinking: "" }
          : item.type === "message" ? { type: "text", text: "" }
            : item.type === "function_call" ? { type: "tool_use", id: string(item.call_id), name: restoreName(string(item.name)), input: {} }
              : null;
        if (!block) return;
        if (block.type === "tool_use") toolUse = true;
        indexes.set(outputIndex, next);
        kinds.set(outputIndex, block.type);
        send(controller, "content_block_start", { index: next++, content_block: block });
        return;
      }
      case "response.reasoning_summary_text.delta":
        send(controller, "content_block_delta", { index: blockFor(outputIndex, "thinking", controller),
          delta: { type: "thinking_delta", thinking: string(event.delta) } });
        return;
      case "response.output_text.delta":
        send(controller, "content_block_delta", { index: blockFor(outputIndex, "text", controller),
          delta: { type: "text_delta", text: string(event.delta) } });
        return;
      case "response.function_call_arguments.delta":
        if (index !== undefined) send(controller, "content_block_delta", { index, delta: { type: "input_json_delta", partial_json: string(event.delta) } });
        return;
      case "response.output_item.done": {
        if (index === undefined) return;
        const signature = string(object(event.item).encrypted_content);
        if (kinds.get(outputIndex) === "thinking" && signature) {
          send(controller, "content_block_delta", { index, delta: { type: "signature_delta", signature } });
        }
        send(controller, "content_block_stop", { index });
        indexes.delete(outputIndex);
        return;
      }
      case "response.completed":
      case "response.incomplete": {
        for (const open of indexes.values()) send(controller, "content_block_stop", { index: open });
        indexes.clear();
        const response = object(event.response);
        const usage = usageOf(response);
        send(controller, "message_delta", { delta: { stop_reason: stopReason(response, toolUse), stop_sequence: null }, usage });
        send(controller, "message_stop", {});
        return;
      }
      case "error":
      case "response.failed":
        send(controller, "error", { error: { type: "api_error",
          message: string(event.message) || string(object(object(event.response).error).message) || "Upstream request failed" } });
        return;
      default:
        // Relay's own truncated-stream frame carries only an error object.
        if (!event.type && event.error) {
          send(controller, "error", { error: { type: "api_error", message: string(object(event.error).message) || "Upstream stream error" } });
        }
    }
  }
}
