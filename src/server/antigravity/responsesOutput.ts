import "server-only";

import { randomUUID } from "node:crypto";
import { antigravityObject as object, antigravityString as string } from "@/src/server/antigravity/protocol";
import { ANTIGRAVITY_CALL_ID_PREFIX, ANTIGRAVITY_SIGNATURE_PREFIX } from "@/src/server/antigravity/responsesRequest";
import { HttpError } from "@/src/server/http/errors";
import { emptyUsage } from "@/src/server/upstream/stream";

type Item = Record<string, unknown> & { id: string; type: string };
type Emit = (type: string, fields: Record<string, unknown>) => void;

export class AntigravityResponsesOutput {
  readonly usage = emptyUsage();
  private readonly id = "resp_" + randomUUID().replaceAll("-", "");
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private readonly output: Item[] = [];
  private readonly customTools: Set<string>;
  private readonly model: string;
  private readonly emit?: Emit;
  private reason: string | null = null;
  private reasoning: { item: Item; text: string; signature: string; index: number } | null = null;
  private text: { item: Item; value: string; index: number } | null = null;
  private reasoningTokens = 0;

  constructor(model: string, input: Record<string, unknown>, emit?: Emit) {
    this.model = model;
    this.emit = emit;
    this.customTools = new Set((Array.isArray(input.tools) ? input.tools : [])
      .map(object).filter(tool => tool.type === "custom").map(tool => string(tool.name)));
  }

  start() {
    const response = this.response("in_progress");
    this.emit?.("response.created", { response });
    this.emit?.("response.in_progress", { response });
  }

  observe(value: Record<string, unknown>) {
    const result = value.response === undefined ? value : object(value.response);
    if (value.error || result.error) throw antigravityResponseError(value.error || result.error);
    this.observeUsage(object(result.usageMetadata));
    const candidate = object(Array.isArray(result.candidates) ? result.candidates[0] : null);
    const content = object(candidate.content);
    for (const raw of Array.isArray(content.parts) ? content.parts : []) this.observePart(object(raw));
    const finishReason = string(candidate.finishReason);
    if (finishReason && finishReason !== "FINISH_REASON_UNSPECIFIED") this.reason = finishReason;
    const blocked = string(object(result.promptFeedback).blockReason);
    if (blocked && blocked !== "BLOCK_REASON_UNSPECIFIED" && !this.reason) this.reason = "SAFETY";
    return this.reason !== null;
  }

  finish() {
    if (!this.reason) throw new HttpError(502, "antigravity_response_truncated", "Antigravity response ended before a finish reason");
    this.closeReasoning();
    this.closeText();
    let reason: string | undefined;
    if (this.reason !== "STOP") {
      if (this.reason === "MAX_TOKENS") reason = "max_output_tokens";
      else if (["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(this.reason)) reason = "content_filter";
      else throw new HttpError(502, "antigravity_generation_failed", "Antigravity did not complete generation");
    }
    const response = this.response(reason ? "incomplete" : "completed", reason);
    this.emit?.(reason ? "response.incomplete" : "response.completed", { response });
    return response;
  }

  private response(status: "in_progress" | "completed" | "incomplete", reason?: string) {
    return {
      id: this.id,
      object: "response",
      created_at: this.createdAt,
      status,
      model: this.model,
      error: null,
      incomplete_details: reason ? { reason } : null,
      output: status === "in_progress" ? [] : this.output,
      usage: status === "in_progress" ? null : {
        input_tokens: this.usage.promptTokens,
        input_tokens_details: { cached_tokens: this.usage.cachedTokens },
        output_tokens: this.usage.completionTokens,
        output_tokens_details: { reasoning_tokens: this.reasoningTokens },
        total_tokens: this.usage.totalTokens,
      },
    };
  }

  private observeUsage(usage: Record<string, unknown>) {
    const count = (key: string, fallback: number) => {
      const n = usage[key];
      return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : fallback;
    };
    if (!Object.keys(usage).length) return;
    this.usage.promptTokens = count("promptTokenCount", this.usage.promptTokens);
    this.usage.cachedTokens = count("cachedContentTokenCount", this.usage.cachedTokens);
    const candidateTokens = count("candidatesTokenCount", this.usage.completionTokens - this.reasoningTokens);
    this.reasoningTokens = count("thoughtsTokenCount", this.reasoningTokens);
    this.usage.completionTokens = candidateTokens + this.reasoningTokens;
    this.usage.totalTokens = count("totalTokenCount", this.usage.promptTokens + this.usage.completionTokens);
  }

  private observePart(part: Record<string, unknown>) {
    const signature = string(part.thoughtSignature);
    const text = string(part.text);
    if (part.thought === true) {
      this.closeText();
      this.appendReasoning(text, signature);
      return;
    }
    this.closeReasoning();
    if (signature) {
      this.closeText();
      this.appendReasoning("", signature);
      this.closeReasoning(false);
    }
    const inline = object(part.inlineData ?? part.inline_data);
    if (part.functionCall) {
      this.closeText();
      this.functionCall(object(part.functionCall));
    } else if (string(inline.data)) {
      this.closeText();
      // Image models return inlineData parts; Responses carries them as image generation results.
      const item = { id: "ig_" + randomUUID(), type: "image_generation_call", status: "in_progress" };
      const index = this.add(item);
      const mime = string(inline.mimeType ?? inline.mime_type);
      this.done(index, { ...item, status: "completed", result: string(inline.data),
        output_format: mime.startsWith("image/") ? mime.slice("image/".length) : undefined });
    } else if (typeof part.text === "string" || signature) {
      this.appendText(text);
      if (signature) this.closeText();
    } else if (Object.keys(part).length > 0) {
      throw new HttpError(502, "antigravity_unsupported_output", "Antigravity returned an unsupported output part");
    }
  }

  private appendText(text: string) {
    if (!this.text) {
      const item = { id: "msg_" + randomUUID(), type: "message", role: "assistant", status: "in_progress", content: [] };
      this.text = { item, value: "", index: this.add(item) };
      this.emit?.("response.content_part.added", {
        item_id: item.id, output_index: this.text.index, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    this.text.value += text;
    if (text) this.emit?.("response.output_text.delta", {
      item_id: this.text.item.id, output_index: this.text.index, content_index: 0, delta: text, logprobs: [],
    });
  }

  private closeText() {
    if (!this.text) return;
    const { item, value, index } = this.text;
    const coordinates = { item_id: item.id, output_index: index, content_index: 0 };
    const part = { type: "output_text", text: value, annotations: [] };
    this.emit?.("response.output_text.done", { ...coordinates, text: value, logprobs: [] });
    this.emit?.("response.content_part.done", { ...coordinates, part });
    this.done(index, { ...item, content: [part], status: "completed" });
    this.text = null;
  }

  private appendReasoning(text: string, signature: string) {
    if (!text && !signature) return;
    if (!this.reasoning) {
      const item = { id: "rs_" + randomUUID(), type: "reasoning", summary: [] };
      this.reasoning = { item, text: "", signature: "", index: this.add(item) };
    }
    const { item, index } = this.reasoning;
    if (text) {
      const coordinates = { item_id: item.id, output_index: index, summary_index: 0 };
      if (!this.reasoning.text) this.emit?.("response.reasoning_summary_part.added", {
        ...coordinates, part: { type: "summary_text", text: "" },
      });
      this.reasoning.text += text;
      this.emit?.("response.reasoning_summary_text.delta", { ...coordinates, delta: text });
    }
    if (signature) this.reasoning.signature = signature;
  }

  private closeReasoning(thought = true) {
    if (!this.reasoning) return;
    const { item, index, text, signature } = this.reasoning;
    const part = { type: "summary_text", text };
    if (text) {
      const coordinates = { item_id: item.id, output_index: index, summary_index: 0 };
      this.emit?.("response.reasoning_summary_text.done", { ...coordinates, text });
      this.emit?.("response.reasoning_summary_part.done", { ...coordinates, part });
    }
    this.done(index, {
      ...item,
      summary: text ? [part] : [],
      encrypted_content: signature ? ANTIGRAVITY_SIGNATURE_PREFIX + (thought ? "thought:" : "") + signature : undefined,
    });
    this.reasoning = null;
  }

  private functionCall(call: Record<string, unknown>) {
    const name = string(call.name);
    if (!name) throw new HttpError(502, "antigravity_invalid_tool_call", "Antigravity returned a tool call without a name");
    const custom = this.customTools.has(name);
    const type = custom ? "custom_tool_call" : "function_call";
    const field = custom ? "input" : "arguments";
    const event = custom ? "response.custom_tool_call_input" : "response.function_call_arguments";
    const value = custom ? string(object(call.args).input) : JSON.stringify(object(call.args));
    const item = {
      id: "fc_" + randomUUID(), type, name, status: "in_progress",
      call_id: string(call.id) || ANTIGRAVITY_CALL_ID_PREFIX + randomUUID(),
      [field]: "",
    };
    const index = this.add(item);
    const coordinates = { item_id: item.id, output_index: index };
    if (value) this.emit?.(event + ".delta", { ...coordinates, delta: value });
    this.emit?.(event + ".done", { ...coordinates, [field]: value });
    this.done(index, { ...item, [field]: value, status: "completed" });
  }

  private add(item: Item) {
    const index = this.output.push(item) - 1;
    this.emit?.("response.output_item.added", { item, output_index: index });
    return index;
  }

  private done(index: number, item: Item) {
    this.output[index] = item;
    this.emit?.("response.output_item.done", { item, output_index: index });
  }
}

export function antigravityResponseError(raw: unknown, status?: number) {
  const value = object(raw);
  const details = Array.isArray(value.details) ? value.details.map(object) : [];
  if (details.some(detail => detail.reason === "TOS_VIOLATION")) {
    return new HttpError(403, "antigravity_tos_violation", "Google suspended access for this Antigravity credential");
  }
  const code = status ?? value.code;
  const mappedStatus = typeof code === "number" && code >= 400 && code <= 599 ? code : 502;
  return new HttpError(mappedStatus, "antigravity_upstream_error", "Antigravity request failed (HTTP " + mappedStatus + ")");
}
