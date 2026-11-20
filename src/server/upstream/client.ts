import "server-only";

import { serverConfig } from "@/src/server/config/env";
import { HttpError } from "@/src/server/http/errors";
import type { StageTimer } from "@/src/server/http/stageTimer";
import { proxiedFetch } from "@/src/server/net/proxy";
import { getProxyPoolCredentialProxy } from "@/src/server/services/proxyPool";
import { getGlobalProxySetting } from "@/src/server/services/settings";
import { redactText } from "@/src/server/upstream/redact";
export { redactText, redactValue } from "@/src/server/upstream/redact";
import type {
  ApiUpstreamProvider,
  UpstreamCredentialWithSecret,
  UpstreamOperation,
} from "@/src/shared/types/entities";

const PATHS: Record<ApiUpstreamProvider, Partial<Record<UpstreamOperation, string>>> = {
  openai: {
    chat: "/chat/completions",
    responses: "/responses",
    images_generations: "/images/generations",
    images_edits: "/images/edits",
  },
  anthropic: {
    chat: "/messages",
    responses: "/messages",
    messages: "/messages",
    count_tokens: "/messages/count_tokens",
  },
};

export function apiUpstreamUrl(provider: ApiUpstreamProvider, baseUrl: string, operation: UpstreamOperation) {
  const path = PATHS[provider]?.[operation];
  if (!path) throw new HttpError(400, "unsupported_upstream_operation", "Unsupported API upstream operation");
  let url: URL;
  try {
    url = new URL(baseUrl || (provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com/v1"));
  } catch {
    throw new HttpError(400, "invalid_upstream_url", "API upstream URL must be an absolute HTTP(S) URL");
  }
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash) {
    throw new HttpError(400, "invalid_upstream_url", "API upstream URL must use HTTP(S), without credentials, query or fragment");
  }
  const prefix = url.pathname.replace(/\/+$/, "") || "/v1";
  url.pathname = prefix + path;
  return url.toString();
}

export async function fetchApiUpstream(input: {
  request: Request;
  baseUrl: string;
  credential: UpstreamCredentialWithSecret;
  operation: UpstreamOperation;
  payload: Record<string, unknown> | FormData;
  stream: boolean;
  streamTimeout?: boolean;
  timing?: StageTimer;
}) {
  const { credential } = input;
  const url = apiUpstreamUrl(credential.provider, input.baseUrl, input.operation);
  if (!credential.apiKey?.trim()) throw new HttpError(400, "missing_upstream_key", "API upstream credential has no key");
  const headers = new Headers({ Accept: input.stream ? "text/event-stream" : "application/json" });
  if (credential.provider === "openai") {
    headers.set("Authorization", `Bearer ${credential.apiKey}`);
  } else {
    headers.set("x-api-key", credential.apiKey);
    headers.set("anthropic-version", input.request.headers.get("anthropic-version") || "2023-06-01");
    const beta = input.request.headers.get("anthropic-beta");
    if (beta) headers.set("anthropic-beta", beta);
  }
  let body: string | Uint8Array<ArrayBuffer>;
  if (input.payload instanceof FormData) {
    // node-fetch's SOCKS path cannot encode the platform's Web FormData reliably.
    // Encode once with the platform, keeping repeated fields, files and its boundary together.
    const encoded = new Response(input.payload);
    headers.set("Content-Type", encoded.headers.get("content-type")!);
    body = new Uint8Array(await encoded.arrayBuffer());
  } else {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(input.payload);
  }
  const proxy = credential.proxy?.enabled
    ? credential.proxy
    : getProxyPoolCredentialProxy(credential.proxyPoolId) ||
      (credential.useGlobalProxy ? getGlobalProxySetting() : null);
  const cancellation = new AbortController();
  const signal = AbortSignal.any([
    input.request.signal,
    cancellation.signal,
    AbortSignal.timeout((input.streamTimeout ?? input.stream) ? serverConfig.streamRequestTimeoutMs : serverConfig.requestTimeoutMs),
  ]);
  const send = () => proxiedFetch(url, { method: "POST", headers, body, signal, redirect: "manual" }, proxy);
  let response: Response;
  try {
    response = input.timing
      ? await input.timing.timeAsync("upstream_fetch", "API Key 上游 Fetch", send)
      : await send();
  } catch (error) {
    // Transport errors can embed a URL, headers or the key in their cause chain.
    throw new HttpError(502, "upstream_connection_error", redactText(error instanceof Error ? error.message : "API upstream connection failed", credential.apiKey));
  }
  return { response, headers, signal, abort: () => cancellation.abort() };
}

const BLOCKED_HEADERS = new Set([
  "connection", "keep-alive", "proxy-connection", "http2-settings", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "content-length", "content-encoding", "authorization",
  "cookie", "set-cookie", "set-cookie2", "x-api-key", "www-authenticate", "location",
  "openai-organization", "openai-project", "anthropic-organization-id", "chatgpt-account-id",
]);

export function copyApiUpstreamHeaders(headers: Headers) {
  const output = new Headers();
  const connectionHeaders = new Set((headers.get("connection") || "").toLowerCase().split(",").map((name) => name.trim()));
  for (const [name, value] of headers) {
    if (BLOCKED_HEADERS.has(name) || connectionHeaders.has(name) ||
      /(?:^|[-_])(?:account|organization|project|user|email|session|device|identity)(?:[-_]|$)/i.test(name) ||
      /(?:^|[-_])(?:authorization|auth|secret|api-key|token)(?:[-_]|$)/i.test(name) ||
      /^(?:x-codex-|x-stainless-|x-claude-code-|x-relay-quota-)/i.test(name)) continue;
    output.set(name, value);
  }
  return output;
}


export function forwardedPayloadSnapshot(payload: Record<string, unknown> | FormData) {
  if (!(payload instanceof FormData)) return payload;
  // Do not put binary uploads in request logs, and do not collapse repeated multipart fields.
  return Array.from(payload, ([name, value]) => [name, typeof value === "string" ? value : {
    filename: value.name, type: value.type, size: value.size,
  }]);
}
