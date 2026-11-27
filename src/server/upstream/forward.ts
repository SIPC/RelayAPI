import "server-only";

import {
  chatCompletionsToClaude,
  responsesToClaude,
  claudeSseTextToOpenAIChatCompletion,
  claudeSseTextToOpenAIResponse,
  createOpenAIChatStreamFromClaude,
  createOpenAIResponsesStreamFromClaude,
} from "@/src/server/claude/chat";
import { HttpError } from "@/src/server/http/errors";
import { isNativeClaudeCodeRequest } from "@/src/server/claude/wire";
import { redactResponseText } from "@/src/server/upstream/redact";
import { prepareAnthropicApiCacheControl } from "@/src/server/claude/cacheControl";
import { prepareAnthropicApiPayload } from "@/src/server/upstream/anthropicBetas";
import type { StageTimer } from "@/src/server/http/stageTimer";
import type {
  ChannelRecord,
  UpstreamCredentialWithSecret,
  UpstreamOperation,
  UsageSnapshot,
} from "@/src/shared/types/entities";
import {
  copyApiUpstreamHeaders,
  fetchApiUpstream,
  forwardedPayloadSnapshot,
  redactText,
  redactValue,
} from "@/src/server/upstream/client";
import {
  BodyCapture,
  SseTracker,
  UpstreamFailure,
  UsageTracker,
  relaySseStream,
  readBodyBytes,
  responseFailure,
  validatedClaudeStream,
  type SseProtocol,
} from "@/src/server/upstream/stream";

export interface ApiKeyRelayResult {
  statusCode: number;
  usage: UsageSnapshot;
  errorCode?: string;
  errorMessage?: string;
  upstreamBody?: unknown;
  forwardedBody?: unknown;
  forwardedHeaders?: Record<string, string>;
  upstreamHeaders: Headers;
  error?: unknown;
}

export async function forwardApiKeyRequest(input: {
  request: Request;
  channel: ChannelRecord;
  credential: UpstreamCredentialWithSecret;
  operation: UpstreamOperation;
  payload: Record<string, unknown> | FormData;
  captureBody?: boolean;
  timing?: StageTimer;
  onResult: (result: ApiKeyRelayResult) => void;
}): Promise<Response> {
  const { credential, operation } = input;
  if (input.channel.provider !== credential.provider) {
    throw new HttpError(400, "upstream_provider_mismatch", "Channel and API credential providers do not match");
  }
  if (input.payload instanceof FormData && !(credential.provider === "openai" && operation === "images_edits")) {
    throw new HttpError(400, "unsupported_multipart_operation", "Multipart is only supported for OpenAI image edits");
  }
  const json = input.payload instanceof FormData ? undefined : input.payload;
  const downstreamStream = operation !== "count_tokens" && (input.payload instanceof FormData
    ? input.payload.get("stream") === "true"
    : input.payload.stream === true);
  const converted = credential.provider === "anthropic" && (operation === "chat" || operation === "responses");
  const conversion = converted
    ? (operation === "chat" ? chatCompletionsToClaude : responsesToClaude)(json, { stream: true, oauth: false })
    : undefined;
  let payload = conversion?.payload ?? (operation === "count_tokens" ? { ...json } : input.payload);
  if (operation === "count_tokens" && !(payload instanceof FormData)) delete payload.stream;
  let anthropicBeta: string | undefined;
  if (credential.provider === "anthropic" && !(payload instanceof FormData)) {
    // Default breakpoints come first so the beta derivation below sees the body that is sent.
    if (operation !== "count_tokens") payload = prepareAnthropicApiCacheControl(payload, input.request.headers,
      (body) => isNativeClaudeCodeRequest(input.request.headers, body));
    // Converted requests never carried the caller's header; only betas their body asks for.
    const prepared = prepareAnthropicApiPayload(payload, converted ? null : input.request.headers.get("anthropic-beta"));
    payload = prepared.payload;
    anthropicBeta = prepared.beta;
  }
  const upstream = await fetchApiUpstream({
    ...input,
    baseUrl: input.channel.baseUrl,
    payload,
    anthropicBeta,
    stream: downstreamStream || converted,
    streamTimeout: downstreamStream,
  });
  const { response } = upstream;
  const upstreamHeaders = copyApiUpstreamHeaders(response.headers);
  for (const [name, value] of upstreamHeaders) upstreamHeaders.set(name, redactText(value, credential.apiKey));
  const headers = new Headers(upstreamHeaders);
  const capture = new BodyCapture(Boolean(input.captureBody));
  const usage = new UsageTracker(credential.provider === "anthropic");
  const forwardedHeaders = Object.fromEntries(upstream.headers);
  for (const name of ["authorization", "x-api-key"]) {
    if (name in forwardedHeaders) forwardedHeaders[name] = "[REDACTED]";
  }
  let reported = false;
  function report(statusCode: number, tokens: UsageSnapshot, failure?: UpstreamFailure, body?: unknown) {
    if (reported) return;
    reported = true;
    input.onResult({
      statusCode,
      usage: { ...tokens },
      forwardedBody: input.captureBody ? redactValue(forwardedPayloadSnapshot(payload), credential.apiKey) : undefined,
      forwardedHeaders: input.captureBody ? redactValue(forwardedHeaders, credential.apiKey) as Record<string, string> : undefined,
      upstreamHeaders,
      upstreamBody: input.captureBody ? redactValue(body ?? capture.text, credential.apiKey) : undefined,
      ...(failure ? {
        errorCode: redactText(failure.code, credential.apiKey),
        errorMessage: redactText(failure.message, credential.apiKey),
        error: redactValue(failure, credential.apiKey),
      } : {}),
    });
  }
  function safeFailure(error: unknown) {
    return new UpstreamFailure(
      error instanceof UpstreamFailure ? redactText(error.code, credential.apiKey) : "upstream_stream_error",
      redactText(error instanceof Error ? error.message : "API upstream response failed", credential.apiKey),
    );
  }
  function failedJson(failure: UpstreamFailure, tokens = usage.usage) {
    const safe = safeFailure(failure);
    report(502, tokens, safe);
    const error = { type: "upstream_error", code: safe.code, message: safe.message };
    const body = credential.provider === "anthropic" && !converted
      ? { type: "error", error: { ...error, type: "api_error" } } : { error };
    const errorHeaders = new Headers(headers);
    errorHeaders.set("content-type", "application/json");
    return Response.json(body, { status: 502, headers: errorHeaders });
  }
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => {});
    return failedJson(new UpstreamFailure("upstream_redirect_rejected", "API upstream redirects are not allowed"));
  }
  const isSse = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "text/event-stream";
  if (response.ok && isSse && operation === "count_tokens") {
    void response.body?.cancel().catch(() => {});
    return failedJson(new UpstreamFailure("invalid_upstream_protocol", "Expected a JSON token-count response"));
  }
  if (response.ok && isSse) {
    if (!response.body) return failedJson(new UpstreamFailure("empty_upstream_stream", "API upstream returned an empty stream"));
    const protocol: SseProtocol = credential.provider === "anthropic" ? "messages"
      : operation === "responses" ? "responses"
        : operation.startsWith("images_") ? "images" : "chat";
    const tracker = new SseTracker(protocol, input.payload instanceof FormData ? input.payload.get("n") : json?.n);
    let body: ReadableStream<Uint8Array> = response.body;
    if (conversion) {
      body = validatedClaudeStream(body, tracker, capture);
      const model = String(conversion.payload.model || json?.model || "");
      const options = { model, reverseToolNameMap: conversion.reverseToolNameMap };
      if (!downstreamStream) {
        try {
          const read = () => readBodyBytes(body, upstream.signal);
          const bytes = input.timing
            ? await input.timing.timeAsync("read_upstream_body", "读取 API Key 上游响应", read)
            : await read();
          const text = new TextDecoder().decode(bytes);
          const output = operation === "chat"
            ? claudeSseTextToOpenAIChatCompletion(text, options)
            : claudeSseTextToOpenAIResponse(text, options);
          report(response.status, tracker.tokens.usage);
          headers.set("content-type", "application/json");
          return Response.json(redactValue(output, credential.apiKey), { status: response.status, headers });
        } catch (error) { return failedJson(safeFailure(error), tracker.tokens.usage); }
      }
      body = operation === "chat"
        ? createOpenAIChatStreamFromClaude(body, options)
        : createOpenAIResponsesStreamFromClaude(body, options);
    }
    const outputTracker = conversion ? new SseTracker(operation as "chat" | "responses") : tracker;
    const streamStage = input.timing?.start("stream_upstream_body", "转发 API Key 上游 SSE");
    body = relaySseStream(body, {
      tracker: outputTracker,
      apiKey: credential.apiKey,
      capture: conversion ? undefined : capture,
      signal: upstream.signal,
      abort: upstream.abort,
      safeFailure,
      onFirstChunk: () => input.timing?.mark("stream_first_token", "收到 API Key 流首个分块"),
      onFinish: (failure) => {
        streamStage?.finish();
        report(failure ? 502 : response.status, tracker.tokens.usage, failure);
      },
    });
    headers.set("content-type", "text/event-stream; charset=utf-8");
    return new Response(body, { status: response.status, headers });
  }
  const read = () => readBodyBytes(response.body, upstream.signal, capture);
  let bytes: ArrayBuffer;
  try {
    bytes = input.timing
      ? await input.timing.timeAsync("read_upstream_body", "读取 API Key 上游响应", read)
      : await read();
  } catch (error) { return failedJson(safeFailure(error)); }
  const text = new TextDecoder().decode(bytes);
  let value: unknown;
  try { value = JSON.parse(text); } catch { /* Preserve upstream HTTP error bodies, including plain text. */ }
  if (operation !== "count_tokens") usage.consume(value);
  let failure = responseFailure(value);
  if (!response.ok) failure ||= new UpstreamFailure("upstream_http_error", `API upstream returned HTTP ${response.status}`);
  if (response.ok && converted) {
    capture.add(new Uint8Array(bytes));
    return failedJson(failure || new UpstreamFailure("invalid_upstream_protocol", "Expected an Anthropic SSE response for protocol conversion"));
  }
  if (response.ok && value === undefined) failure ||= new UpstreamFailure("invalid_upstream_json", "API upstream did not return valid JSON");
  const status = response.ok && failure ? 502 : response.status;
  const safeText = redactResponseText(text, value, credential.apiKey);
  report(status, usage.usage, failure, safeText);
  return new Response([204, 205, 304].includes(status) ? null : safeText === text ? bytes : new TextEncoder().encode(safeText), { status, headers });
}
