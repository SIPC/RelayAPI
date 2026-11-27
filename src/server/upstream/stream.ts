import "server-only";

import type { UsageSnapshot } from "@/src/shared/types/entities";
import { ImageStreamState } from "@/src/server/upstream/imageStream";
import { SecretByteRedactor } from "@/src/server/upstream/redact";

export type SseProtocol = "chat" | "responses" | "images" | "messages";

export class UpstreamFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function emptyUsage(): UsageSnapshot {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class UsageTracker {
  readonly usage = emptyUsage();
  private claude: Record<string, unknown> = {};

  private anthropic: boolean;
  constructor(anthropic: boolean) { this.anthropic = anthropic; }

  consume(value: unknown) {
    const root = record(value);
    const response = record(root.response);
    const message = record(root.message);
    const raw = record(root.usage ?? response.usage ?? message.usage);

    if (Object.keys(raw).length === 0) return;
    if (this.anthropic) {
      Object.assign(this.claude, raw);
      this.usage.promptTokens = (count(this.claude.input_tokens) ?? 0) +
        (count(this.claude.cache_creation_input_tokens) ?? 0) + (count(this.claude.cache_read_input_tokens) ?? 0);
      this.usage.completionTokens = count(this.claude.output_tokens) ?? 0;
      this.usage.cachedTokens = count(this.claude.cache_read_input_tokens) ?? 0;
      this.usage.cacheWriteTokens = count(this.claude.cache_creation_input_tokens) ?? 0;
    } else {
      this.usage.promptTokens = count(raw.prompt_tokens ?? raw.input_tokens) ?? this.usage.promptTokens;
      this.usage.completionTokens = count(raw.completion_tokens ?? raw.output_tokens) ?? this.usage.completionTokens;
      this.usage.cachedTokens = count(record(raw.prompt_tokens_details ?? raw.input_tokens_details).cached_tokens) ??
        count(raw.cached_tokens) ?? this.usage.cachedTokens;
    }
    this.usage.totalTokens = count(raw.total_tokens) ?? this.usage.promptTokens + this.usage.completionTokens;
  }
}

export function responseFailure(value: unknown): UpstreamFailure | undefined {
  const root = record(value);
  const response = record(root.response);
  const type = String(root.type || "");
  const status = String(response.status || root.status || "");
  if (root.error || response.error || type === "error" || /(?:^|\.)(?:failed|incomplete|cancelled)$/.test(type) ||
    ["failed", "incomplete", "cancelled"].includes(status)) {
    const error = record(root.error || response.error || (type === "error" ? root : undefined));
    return new UpstreamFailure(
      String(error.code || error.type || (status === "incomplete" || type.endsWith(".incomplete") ? "upstream_incomplete" : "upstream_error")),
      String(error.message || record(root.incomplete_details ?? response.incomplete_details).reason || "API upstream reported a failed or incomplete response"),
    );
  }
}

export class BodyCapture {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private enabled: boolean;
  private limit: number;
  constructor(enabled: boolean, limit = 512 * 1024) { this.enabled = enabled; this.limit = limit; }

  add(chunk: Uint8Array) {
    if (!this.enabled || this.size >= this.limit) return;
    const part = chunk.slice(0, this.limit - this.size);
    this.chunks.push(part);
    this.size += part.byteLength;
  }

  get text(): string | undefined {
    if (!this.enabled) return undefined;
    const bytes = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    // stream:true omits an incomplete UTF-8 suffix at the capture boundary.
    return new TextDecoder().decode(bytes, { stream: true });
  }
}

export async function readBodyBytes(body: ReadableStream<Uint8Array> | null, signal: AbortSignal, capture?: BodyCapture) {
  const reader = body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const aborted = () => new UpstreamFailure("upstream_response_aborted", "API upstream response was aborted or timed out");
  const onAbort = () => { void reader?.cancel(aborted()).catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    while (reader) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw aborted();
      if (done) break;
      capture?.add(value);
      chunks.push(value);
      size += value.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes.buffer;
  } catch (error) {
    void reader?.cancel().catch(() => {});
    throw signal.aborted ? aborted() : error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader?.releaseLock();
  }
}

export class SseTracker {
  readonly tokens: UsageTracker;
  completed = false;
  failure?: UpstreamFailure;
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private lineParts: string[] = [];
  private afterCr = false;
  private lines: string[] = [];
  private images?: ImageStreamState;

  readonly protocol: SseProtocol;
  constructor(protocol: SseProtocol, requestedImages?: unknown) {
    this.protocol = protocol;
    this.tokens = new UsageTracker(protocol === "messages");
    if (protocol === "images") this.images = new ImageStreamState(requestedImages);
  }

  push(chunk: Uint8Array, normalize = false) {
    return this.consume(this.decoder.decode(chunk, { stream: true }), normalize);
  }

  finish() {
    this.consume(this.decoder.decode());
    if (this.failure) throw this.failure;
    if (this.images && (!this.images.isComplete || this.lineParts.length || this.lines.some((line) => !line.startsWith(":")))) {
      throw new UpstreamFailure("upstream_images_incomplete", "API upstream image stream ended before all requested images completed");
    }
    if (!this.completed) throw new UpstreamFailure("upstream_stream_truncated", "API upstream stream ended before its completion event");
  }

  private consume(text: string, normalize = false) {
    const normalized: string[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (this.afterCr) {
        this.afterCr = false;
        if (char === "\n") { start = i + 1; continue; }
      }
      if (char !== "\r" && char !== "\n") continue;
      this.lineParts.push(text.slice(start, i));
      const line = this.lineParts.join("");
      this.lineParts = [];
      if (line) this.lines.push(line);
      else {
        const event = this.event(this.lines, normalize);
        if (event) normalized.push(event);
        this.lines = [];
      }
      this.afterCr = char === "\r";
      start = i + 1;
    }
    if (start < text.length) this.lineParts.push(text.slice(start));
    return normalized.join("");
  }

  private event(lines: string[], normalize: boolean) {
    const dataLines: string[] = [];
    let event = "";
    for (const line of lines) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const name = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (name === "data") dataLines.push(value);
      if (name === "event") event = value;
    }
    if (!dataLines.length) return "";
    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      if (this.protocol === "chat") this.completed = true;
      return normalize ? "data: [DONE]\n\n" : "";
    }
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Not an object");
      value = parsed as Record<string, unknown>;
    } catch {
      throw new UpstreamFailure("invalid_upstream_sse", "API upstream sent malformed SSE JSON");
    }
    const type = String(value.type || event);
    this.tokens.consume(value);
    this.images?.observe(type, value);
    this.failure ||= responseFailure({ ...value, type });
    if ((this.protocol === "messages" && type === "message_stop") ||
      (this.protocol === "responses" && type === "response.completed") ||
      (this.protocol === "images" && /^image_(?:generation|edit)\.completed$/.test(type))) this.completed = true;
    return normalize ? `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify({ ...value, ...(type && !value.type ? { type } : {}) })}\n\n` : "";
  }
}

// Validation precedes Claude's existing converters, whose aggregation path otherwise
// accepts missing message_stop and whose framer cannot handle CRLF split across reads.
export function validatedClaudeStream(body: ReadableStream<Uint8Array>, tracker: SseTracker, capture: BodyCapture) {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { tracker.finish(); controller.close(); return; }
          capture.add(value);
          const normalized = tracker.push(value, true);
          if (tracker.failure) throw tracker.failure;
          if (normalized) controller.enqueue(new TextEncoder().encode(normalized));
          if (tracker.completed) {
            controller.close();
            void reader.cancel().catch(() => {});
            return;
          }
          if (normalized) return;
        }
      } catch (error) {
        controller.error(error);
        void reader.cancel().catch(() => {});
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });
}

export function streamErrorFrame(protocol: SseProtocol, failure: UpstreamFailure) {
  const error = { type: "upstream_error", code: failure.code, message: failure.message };
  if (protocol === "messages") return `event: error\ndata: ${JSON.stringify({ type: "error", error: { ...error, type: "api_error" } })}\n\n`;
  if (protocol === "responses" || protocol === "images") return `event: error\ndata: ${JSON.stringify({ type: "error", code: failure.code, message: failure.message, param: null })}\n\n`;
  return `data: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n`;
}

export function relaySseStream(body: ReadableStream<Uint8Array>, input: {
  tracker: SseTracker;
  apiKey?: string;
  capture?: BodyCapture;
  signal: AbortSignal;
  abort: () => void;
  safeFailure: (error: unknown) => UpstreamFailure;
  onFirstChunk?: () => void;
  onFinish: (failure?: UpstreamFailure) => void;
}) {
  const reader = body.getReader();
  const redactor = new SecretByteRedactor(input.apiKey || "");
  let settled = false;
  let first = true;
  let controllerRef: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => input.signal.removeEventListener("abort", onAbort);
  function settle(failure?: UpstreamFailure) {
    if (settled) return;
    settled = true;
    cleanup();
    input.onFinish(failure);
  }
  function emit(bytes: Uint8Array) {
    if (!bytes.length) return;
    input.capture?.add(bytes);
    controllerRef.enqueue(bytes);
  }
  function fail(error: unknown) {
    if (settled) return;
    const failure = input.safeFailure(error);
    emit(redactor.finish());
    settle(failure);
    controllerRef.enqueue(new TextEncoder().encode(streamErrorFrame(input.tracker.protocol, failure)));
    controllerRef.close();
    void reader.cancel().catch(() => {});
    input.abort();
  }
  function onAbort() {
    fail(new UpstreamFailure("upstream_stream_aborted", "API upstream stream was aborted or timed out"));
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (input.signal.aborted) onAbort();
    },
    async pull(controller) {
      try {
        while (!settled) {
          const { done, value } = await reader.read();
          if (settled) return;
          if (done) {
            input.tracker.finish();
            emit(redactor.finish());
            settle();
            controller.close();
            return;
          }
          input.tracker.push(value);
          if (first) { first = false; input.onFirstChunk?.(); }
          const output = redactor.push(value);
          emit(output);
          // Images complete per item; subsequent images and final usage still precede EOF.
          const completedRequest = input.tracker.protocol !== "images" && input.tracker.completed;
          if (input.tracker.failure || completedRequest) {
            emit(redactor.finish());
            settle(input.tracker.failure ? input.safeFailure(input.tracker.failure) : undefined);
            controller.close();
            void reader.cancel().catch(() => {});
            return;
          }
          if (output.length) return;
        }
      } catch (error) { fail(error); }
    },
    cancel() {
      settle(new UpstreamFailure("downstream_cancelled", "Downstream canceled the API upstream stream"));
      input.abort();
      return reader.cancel().catch(() => {});
    },
  }, { highWaterMark: 0 });
}
