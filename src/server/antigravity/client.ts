import "server-only";

import {
  ANTIGRAVITY_BASE_URL,
  ANTIGRAVITY_USER_AGENT,
  antigravityObject as object,
  antigravityRequestId,
  antigravityStandardModel,
  antigravityRequiresStreaming,
  antigravityString as string,
  isAntigravityClaudeModel,
  resolveAntigravityModel,
} from "@/src/server/antigravity/protocol";
import { AntigravityResponsesOutput, antigravityResponseError } from "@/src/server/antigravity/responsesOutput";
import { antigravityResponsesPayload } from "@/src/server/antigravity/responsesRequest";
import { responsesSseDataPayload } from "@/src/server/codex/sse";
import { serverConfig } from "@/src/server/config/env";
import { HttpError } from "@/src/server/http/errors";
import {
  clearAntigravityModelCooldown,
  markAntigravityModelCooldown,
  suspendAntigravityCredential,
} from "@/src/server/repositories/antigravityCredentials";
import {
  antigravityCreditsHint,
  ensureFreshAntigravityCredential,
  markAntigravityCreditsExhausted,
} from "@/src/server/services/antigravityCredentials";
import { redactValue } from "@/src/server/upstream/redact";
import { emptyUsage } from "@/src/server/upstream/stream";
import type { AntigravityCredentialWithTokens, SelectedChannel, UsageSnapshot } from "@/src/shared/types/entities";

const INSTANT_RETRY_MS = 3000;
const SHORT_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_FAILOVER_ATTEMPTS = 10;
// Credential failures that CPA answers by moving to the next credential.
const SWITCH_STATUSES = new Set([401, 403, 429, 503]);

export type AntigravityResult = {
  status: number;
  usage: UsageSnapshot;
  error?: HttpError;
  selected: SelectedChannel;
};

export type AntigravityOutcome =
  | { type: "json"; value: Record<string, unknown> }
  | { type: "stream"; body: ReadableStream<Uint8Array> }
  | { type: "error"; error: HttpError; retryAfter?: string };

type Decision = "instant" | "switch" | "exhausted" | "soft";
type Failure = { error: HttpError; retryAfterMs?: number; creditsExhausted?: boolean; decision?: Decision };

export async function sendAntigravity(input: {
  request: Request;
  model: string;
  payload: Record<string, unknown>;
  stream: boolean;
  includeThoughtsByDefault?: boolean;
  selected: SelectedChannel;
  reselect: (exclude: string[]) => SelectedChannel | null;
  onFailover?: (selected: SelectedChannel, error: HttpError) => void;
  onResult: (result: AntigravityResult) => void;
}): Promise<AntigravityOutcome> {
  let selected = input.selected;
  let reported = false;
  const report = (usage: UsageSnapshot, error?: HttpError) => {
    if (reported) return;
    reported = true;
    input.onResult({ status: error?.status ?? 200, usage, error, selected });
  };
  const stopped = new AbortController();
  const timeout = AbortSignal.timeout(input.stream ? serverConfig.streamRequestTimeoutMs : serverConfig.requestTimeoutMs);
  const signal = AbortSignal.any([input.request.signal, timeout, stopped.signal]);
  const abortError = () => input.request.signal.aborted
    ? new HttpError(499, "request_cancelled", "The client cancelled the request")
    : new HttpError(504, "antigravity_timeout", "Antigravity request timed out");
  const upstreamStream = input.stream || antigravityRequiresStreaming(input.model);

  try {
    const build = (model: string) => antigravityResponsesPayload(input.payload, model, {
      includeThoughtsByDefault: input.includeThoughtsByDefault,
    });
    // Validate input before doing any token exchange or inference request.
    build(input.model);
    const effort = string(object(input.payload.reasoning).effort);
    const tried: AntigravityCredentialWithTokens[] = [];
    let last: Failure | null = null;

    const attempt = async (credits: boolean): Promise<{ upstream: Response; credential: AntigravityCredentialWithTokens } | Failure> => {
      let credential: AntigravityCredentialWithTokens;
      try {
        credential = await ensureFreshAntigravityCredential(selected.credential.id);
      } catch (cause) {
        return { error: responseError(cause) };
      }
      if (!tried.some(item => item.id === credential.id)) tried.push(credential);
      // Each account may publish a different tier ID for the requested standard name.
      const upstreamModel = resolveAntigravityModel(credential.models, input.model, effort) ?? input.model;
      const body = {
        ...build(upstreamModel),
        project: credential.projectId,
        requestId: antigravityRequestId(upstreamModel),
        ...(credits && { enabledCreditTypes: ["GOOGLE_ONE_AI"] }),
      };
      const path = upstreamStream ? "/v1internal:streamGenerateContent?alt=sse" : "/v1internal:generateContent";
      let upstream: Response;
      try {
        upstream = await fetch(ANTIGRAVITY_BASE_URL + path, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + credential.tokens.access_token,
            "Content-Type": "application/json",
            "User-Agent": ANTIGRAVITY_USER_AGENT,
            Accept: upstreamStream ? "text/event-stream" : "application/json",
          },
          body: JSON.stringify(body),
          signal,
          redirect: "error",
        });
      } catch {
        throw signal.aborted ? abortError()
          : new HttpError(502, "antigravity_transport_error", "Could not connect to Antigravity");
      }
      if (upstream.ok) return { upstream, credential };
      const value = object(await upstream.json().catch(() => null));
      const error = antigravityResponseError(value.error ?? value, upstream.status);
      if (error.code === "antigravity_tos_violation") suspendAntigravityCredential(credential, error.message);
      const header = upstream.headers.get("retry-after");
      const retryAfterMs = retryDelayMs(value) ?? (header && /^\d+$/.test(header) ? Number(header) * 1000 : undefined);
      return { error, retryAfterMs, creditsExhausted: credits && hasReason(value, "INSUFFICIENT_G1_CREDITS_BALANCE"), ...decisionOf(value, upstream.status) };
    };

    // Per CPA: classify each 429, cool the model on that credential, and move to the next credential.
    for (let round = 0; round < MAX_FAILOVER_ATTEMPTS; round++) {
      let result = await attempt(false);
      if ("decision" in result && result.decision === "instant" && result.retryAfterMs !== undefined) {
        await sleep(result.retryAfterMs, signal);
        result = await attempt(false);
      }
      if ("upstream" in result) return await respond(result.upstream, result.credential);
      last = result;
      if (result.error.status === 429) {
        markAntigravityModelCooldown(selected.credential.id, antigravityStandardModel(input.model), {
          retryAfterMs: "decision" in result && result.decision !== "soft" ? result.retryAfterMs : undefined,
          message: result.error.message,
        });
      }
      // Switch only when another attempt follows, so the logged account is the one that actually failed.
      if (!SWITCH_STATUSES.has(result.error.status) || round === MAX_FAILOVER_ATTEMPTS - 1) break;
      const next = input.reselect(tried.map(item => item.id));
      if (!next) break;
      input.onFailover?.(selected, result.error);
      selected = next;
    }

    // Google One AI credits are a last resort for Claude after every credential is rate limited (CPA default off).
    if (last && (last.error.status === 429 || last.error.status === 503) && creditsEnabled() &&
      isAntigravityClaudeModel(input.model)) {
      const candidates = [...tried.filter(item => antigravityCreditsHint(item.id) === true),
        ...tried.filter(item => antigravityCreditsHint(item.id) === undefined)];
      for (const credential of candidates) {
        selected = { ...selected, credential, channel: { ...selected.channel, credentialId: credential.id } };
        const result = await attempt(true);
        if ("upstream" in result) return await respond(result.upstream, result.credential);
        if (result.creditsExhausted) markAntigravityCreditsExhausted(credential.id);
        last = result;
      }
    }

    const error = last?.error ?? new HttpError(503, "no_available_channel", "No usable channel is available for this request");
    report(emptyUsage(), error);
    const seconds = last?.retryAfterMs !== undefined && error.status === 429 ? Math.ceil(last.retryAfterMs / 1000) : undefined;
    return { type: "error", error, retryAfter: seconds !== undefined ? String(seconds) : undefined };
  } catch (cause) {
    const error = signal.aborted ? abortError() : responseError(cause);
    report(emptyUsage(), error);
    return { type: "error", error };
  }

  async function respond(upstream: Response, credential: AntigravityCredentialWithTokens): Promise<AntigravityOutcome> {
    const { access_token: token, refresh_token: refreshToken } = credential.tokens;
    const redact = (value: unknown) => redactValue(redactValue(value, token), refreshToken);
    const onSuccess = () => clearAntigravityModelCooldown(credential.id, antigravityStandardModel(input.model));
    if (!input.stream) {
      const output = new AntigravityResponsesOutput(input.model, input.payload);
      try {
        if (upstreamStream) {
          // CPA aggregates the stream for models that only work on the streaming endpoint.
          const text = await upstream.text();
          if (signal.aborted) throw abortError();
          for (const frame of text.split(/(?:\r\n|\r(?!\n)|\n){2}/)) consumeFrame(output, frame);
        } else {
          const value = await upstream.json().catch(() => null);
          if (signal.aborted) throw abortError();
          if (value === null) throw new HttpError(502, "invalid_antigravity_json", "Antigravity returned invalid JSON");
          output.observe(object(value));
        }
        const result = output.finish();
        onSuccess();
        report(output.usage);
        return { type: "json", value: redact(result) as Record<string, unknown> };
      } catch (cause) {
        const error = signal.aborted ? abortError() : responseError(cause);
        if (error.code === "antigravity_tos_violation") suspendAntigravityCredential(credential, error.message);
        report(output.usage, error);
        return { type: "error", error };
      }
    }
    if (!upstream.body || !upstream.headers.get("content-type")?.includes("text/event-stream")) {
      await upstream.body?.cancel().catch(() => {});
      const error = new HttpError(502, "invalid_antigravity_sse", "Antigravity did not return an SSE stream");
      report(emptyUsage(), error);
      return { type: "error", error };
    }
    return {
      type: "stream",
      body: convertStream(upstream.body, {
        model: input.model, payload: input.payload, redact, signal, abortError,
        abort: () => stopped.abort(),
        onDone(usage, error) {
          if (error?.code === "antigravity_tos_violation") suspendAntigravityCredential(credential, error.message);
          if (!error) onSuccess();
          report(usage, error);
        },
      }),
    };
  }
}

// countTokens takes the generate request without project, model, toolConfig, or sessionId, as in CPA.
export async function countAntigravityTokens(input: {
  request: Request;
  model: string;
  payload: Record<string, unknown>;
  credentialId: string;
}) {
  antigravityResponsesPayload(input.payload, input.model, { countTokens: true });
  const credential = await ensureFreshAntigravityCredential(input.credentialId);
  const model = resolveAntigravityModel(credential.models, input.model) ?? input.model;
  const body = antigravityResponsesPayload(input.payload, model, { countTokens: true });
  let upstream: Response;
  try {
    upstream = await fetch(ANTIGRAVITY_BASE_URL + "/v1internal:countTokens", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + credential.tokens.access_token,
        "Content-Type": "application/json",
        "User-Agent": ANTIGRAVITY_USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([input.request.signal, AbortSignal.timeout(serverConfig.requestTimeoutMs)]),
      redirect: "error",
    });
  } catch {
    throw new HttpError(502, "antigravity_transport_error", "Could not connect to Antigravity");
  }
  const value = object(await upstream.json().catch(() => null));
  if (!upstream.ok) {
    const error = antigravityResponseError(value.error ?? value, upstream.status);
    if (error.code === "antigravity_tos_violation") suspendAntigravityCredential(credential, error.message);
    throw error;
  }
  const total = value.totalTokens;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
    throw new HttpError(502, "invalid_antigravity_json", "Antigravity returned an invalid token count");
  }
  return total;
}

function decisionOf(value: Record<string, unknown>, status: number): { decision?: Decision } {
  if (status !== 429) return {};
  const error = object(value.error);
  const delay = retryDelayMs(value);
  if (string(error.status).toUpperCase() === "RESOURCE_EXHAUSTED") {
    if (hasReason(value, "QUOTA_EXHAUSTED") || hasReason(value, "INSUFFICIENT_G1_CREDITS_BALANCE")) return { decision: "exhausted" };
    if (hasReason(value, "RATE_LIMIT_EXCEEDED")) {
      if (delay === undefined) return { decision: "soft" };
      return { decision: delay < INSTANT_RETRY_MS ? "instant" : delay < SHORT_COOLDOWN_MS ? "switch" : "exhausted" };
    }
    if (/quota[_ ]exhausted/i.test(JSON.stringify(value))) return { decision: "exhausted" };
  }
  return { decision: "soft" };
}

function hasReason(value: Record<string, unknown>, reason: string) {
  const details = object(value.error).details;
  return Array.isArray(details) && details.map(object).some(detail =>
    string(detail["@type"]) === "type.googleapis.com/google.rpc.ErrorInfo" && string(detail.reason).toUpperCase() === reason);
}

// Google reports the delay in RetryInfo, ErrorInfo.metadata.quotaResetDelay, or the message text.
function retryDelayMs(value: Record<string, unknown>) {
  const error = object(value.error);
  const details = Array.isArray(error.details) ? error.details.map(object) : [];
  const candidates = [
    ...details.filter(detail => string(detail["@type"]) === "type.googleapis.com/google.rpc.RetryInfo").map(detail => string(detail.retryDelay)),
    ...details.filter(detail => string(detail["@type"]) === "type.googleapis.com/google.rpc.ErrorInfo")
      .map(detail => string(object(detail.metadata).quotaResetDelay)),
    /\b(?:after|retry\s+in)\s+(\d+(?:\.\d+)?(?:h|ms|m|s)(?:\d+(?:\.\d+)?(?:ms|m|s))*)\b/i.exec(string(error.message))?.[1] ?? "",
  ];
  for (const candidate of candidates) {
    const ms = durationMs(candidate.trim().toLowerCase());
    if (ms !== undefined) return ms;
  }
  return undefined;
}

function durationMs(value: string) {
  if (!value || !/^(\d+(\.\d+)?(h|ms|m|s))+$/.test(value)) return undefined;
  const scale: Record<string, number> = { h: 3600000, m: 60000, s: 1000, ms: 1 };
  let total = 0;
  for (const [, amount, , unit] of value.matchAll(/(\d+(\.\d+)?)(h|ms|m|s)/g)) total += Number(amount) * scale[unit];
  return Math.round(total);
}

function creditsEnabled() {
  return /^(1|true|yes)$/i.test(process.env.RELAY_ANTIGRAVITY_CREDITS?.trim() ?? "");
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function consumeFrame(output: AntigravityResponsesOutput, frame: string) {
  const data = responsesSseDataPayload(frame);
  if (!data || data === "[DONE]") return;
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch {
    throw new HttpError(502, "invalid_antigravity_sse", "Antigravity returned malformed SSE");
  }
  const event = object(parsed);
  if (!Object.keys(event).length) throw new HttpError(502, "invalid_antigravity_sse", "Antigravity returned malformed SSE");
  output.observe(event);
}

function convertStream(body: ReadableStream<Uint8Array>, input: {
  model: string;
  payload: Record<string, unknown>;
  redact: (value: unknown) => unknown;
  signal: AbortSignal;
  abortError: () => HttpError;
  abort: () => void;
  onDone: (usage: UsageSnapshot, error?: HttpError) => void;
}) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  let pending = "";
  let sequence = 0;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let settled = false;
  let started = false;
  function emit(type: string, fields: Record<string, unknown>) {
    const event = input.redact({ type, sequence_number: sequence++, ...fields });
    controller.enqueue(encoder.encode("event: " + type + "\ndata: " + JSON.stringify(event) + "\n\n"));
  }
  const output = new AntigravityResponsesOutput(input.model, input.payload, emit);

  function settle(error?: HttpError) {
    if (settled) return;
    settled = true;
    input.signal.removeEventListener("abort", onAbort);
    input.onDone(output.usage, error);
  }

  function fail(error: HttpError) {
    if (settled) return;
    settle(error);
    emit("error", { code: error.code, message: error.message, param: null });
    controller.close();
    input.abort();
    void reader.cancel().catch(() => {});
  }

  function onAbort() {
    fail(input.abortError());
  }

  function push(text: string) {
    pending += text;
    const frames = pending.split(/(?:\r\n|\r(?!\n)|\n){2}/);
    pending = frames.pop() ?? "";
    for (const frame of frames) consumeFrame(output, frame);
    if (pending.length > 4 * 1024 * 1024) {
      throw new HttpError(502, "invalid_antigravity_sse", "Antigravity SSE frame exceeds the response limit");
    }
  }
  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (input.signal.aborted) onAbort();
    },
    async pull() {
      if (settled) return;
      if (!started) {
        started = true;
        output.start();
        return;
      }
      try {
        const before = sequence;
        while (!settled && sequence === before) {
          const { done, value } = await reader.read();
          if (settled) return;
          if (!done) {
            push(decoder.decode(value, { stream: true }));
            continue;
          }
          push(decoder.decode());
          consumeFrame(output, pending);
          output.finish();
          settle();
          controller.close();
        }
      } catch (cause) {
        fail(input.signal.aborted ? input.abortError() : responseError(cause));
      }
    },
    async cancel(reason) {
      settle(new HttpError(499, "request_cancelled", "The client cancelled the request"));
      input.abort();
      await reader.cancel(reason).catch(() => {});
    },
  });
}

function responseError(error: unknown) {
  return error instanceof HttpError ? error
    : new HttpError(502, "antigravity_response_error", "Could not read Antigravity response");
}
