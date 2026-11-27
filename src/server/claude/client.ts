import "server-only";

import { withAccountQuotaHeaders } from "@/src/server/http/accountQuota";
import { recordClaudeQuotaHeaders } from "@/src/server/services/claudeQuota";

import crypto from "node:crypto";
import { claudeBetas, claudeCacheTtlMs } from "@/src/server/claude/wire";
import { claudeChannelSession } from "@/src/server/services/channels";
import { prepareClaudeOAuthUpstreamPayload } from "@/src/server/claude/compat";
import { serverConfig } from "@/src/server/config/env";
import { logServerError } from "@/src/server/http/errors";
import { proxiedFetch } from "@/src/server/net/proxy";
import {
  ensureFreshClaudeCredential,
  ensureClaudeRequestIdentity,
  getEffectiveClaudeUserAgent,
  resolveClaudeCredentialProxy,
} from "@/src/server/services/claudeCredentials";
import type { StageTimer } from "@/src/server/http/stageTimer";
import type { ChannelRecord, ClaudeCredentialWithTokens } from "@/src/shared/types/entities";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const SENSITIVE_UPSTREAM_RESPONSE_HEADERS = new Set([
  "anthropic-organization-id",
  "authorization",
  "cookie",
  "set-cookie",
  "set-cookie2",
  "x-api-key",
]);

export async function claudeFetch(
  payload: Record<string, unknown>,
  input: {
    stream: boolean;
    sourceHeaders: Headers;
    credentialId: string;
    channel?: ChannelRecord;
    baseUrl?: string;
    upstreamPath?: "/v1/messages" | "/v1/messages/count_tokens";
    timing?: StageTimer;
  },
) {
  const credential =
    (await input.timing?.timeAsync(
      "ensure_claude_credential",
      "获取/刷新 Claude 凭据",
      () => ensureFreshClaudeCredential(input.credentialId),
    )) ?? (await ensureFreshClaudeCredential(input.credentialId));
  if (!credential.tokens.access_token) {
    throw new Error("Saved Claude credential does not contain access_token");
  }
  const claudeUserAgent = getEffectiveClaudeUserAgent(credential);
  const prepared = prepareClaudeOAuthUpstreamPayload(cloneJsonObject(payload), {
    accessToken: credential.tokens.access_token,
    sourceHeaders: input.sourceHeaders,
    claudeUserAgent,
    ...ensureClaudeRequestIdentity(credential),
    sessionId: input.channel && claudeChannelSession(input.channel)?.sessionId,
    countTokens: input.upstreamPath === "/v1/messages/count_tokens",
  });
  const upstreamPayload = prepared.payload;
  const proxy = resolveClaudeCredentialProxy({
    proxy: credential.proxy,
    proxyPoolId: credential.proxyPoolId,
    useGlobalProxy: credential.useGlobalProxy,
  });
  const url = `${normalizeClaudeBaseUrl(input.baseUrl)}${input.upstreamPath || "/v1/messages"}?beta=true`;
  const headers = buildClaudeHeaders(credential, {
    stream: input.stream,
    sourceHeaders: input.sourceHeaders,
    claudeUserAgent,
    extraBetas: prepared.extraBetas,
    sessionId: prepared.sessionId,
    payload: upstreamPayload,
    countTokens: input.upstreamPath === "/v1/messages/count_tokens",
  });
  const session = input.channel && claudeChannelSession(input.channel);
  if (session) {
    session.ttlMs = claudeCacheTtlMs(upstreamPayload);
    session.startedAt = Date.now();
    session.upstreamStarted = true;
  }
  const response =
    (await input.timing?.timeAsync("upstream_fetch", "Claude 上游 Fetch", () =>
      proxiedFetch(
        url,
        {
          method: "POST",
          headers,
          body: prepared.body,
          signal: AbortSignal.timeout(
            input.stream
              ? serverConfig.streamRequestTimeoutMs
              : serverConfig.requestTimeoutMs,
          ),
        },
        proxy,
      ),
    )) ??
    (await proxiedFetch(
      url,
      {
        method: "POST",
        headers,
        body: prepared.body,
        signal: AbortSignal.timeout(
          input.stream
            ? serverConfig.streamRequestTimeoutMs
            : serverConfig.requestTimeoutMs,
        ),
      },
      proxy,
    ));
  try {
    recordClaudeQuotaHeaders(credential.id, response.headers);
  } catch (error) {
    // A cache write failure must not discard an already successful upstream response.
    logServerError(error, { operation: "claude.quota.record", metadata: { credentialId: credential.id } });
  }
  return {
    response: withAccountQuotaHeaders(response, "claude", credential.id),
    credential,
    upstreamPayload,
    upstreamRequestHeaders: headers,
  };
}

export async function claudeJson(
  payload: Record<string, unknown>,
  input: {
    stream: boolean;
    sourceHeaders: Headers;
    credentialId: string;
    channel?: ChannelRecord;
    baseUrl?: string;
    upstreamPath?: "/v1/messages" | "/v1/messages/count_tokens";
    timing?: StageTimer;
  },
) {
  const { response, credential, upstreamPayload, upstreamRequestHeaders } =
    await claudeFetch(payload, input);
  const text =
    (await input.timing?.timeAsync(
      "read_upstream_body",
      "读取 Claude 上游响应 Body",
      () => response.text(),
    )) ?? (await response.text());
  return {
    response,
    credential,
    upstreamPayload,
    upstreamRequestHeaders,
    text,
    json: parseMaybeJson<unknown>(text),
  };
}

export function copyClaudeUpstreamHeaders(headers: Headers) {
  const output = new Headers();
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) {
      continue;
    }
    if (SENSITIVE_UPSTREAM_RESPONSE_HEADERS.has(lower)) {
      continue;
    }
    if (lower === "content-length" || lower === "content-encoding") {
      continue;
    }
    output.set(name, value);
  }
  return output;
}

// Relay owns the Claude Code client profile on OAuth: the selected credential's
// User-Agent and the configured stainless profile, for native and converted
// callers alike. No caller version, environment or agent header is copied; the
// session ID is Relay's routing key (it also keys account stickiness and
// metadata.user_id), and caller betas only opt into features the body uses.
function buildClaudeHeaders(
  credential: ClaudeCredentialWithTokens,
  input: {
    stream: boolean;
    sourceHeaders: Headers;
    claudeUserAgent: string;
    extraBetas: string[];
    sessionId: string;
    payload: Record<string, unknown>;
    countTokens: boolean;
  },
) {
  const beta = input.countTokens
    ? "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,token-counting-2024-11-01"
    : claudeBetas(input.payload, input.sourceHeaders.get("anthropic-beta"), input.extraBetas);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.tokens.access_token}`,
    "Content-Type": "application/json",
    Connection: "keep-alive",
    Accept: input.stream ? "text/event-stream" : "application/json",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Anthropic-Dangerous-Direct-Browser-Access": "true",
    "Anthropic-Version": "2023-06-01",
    "Anthropic-Beta": beta,
    "X-App": "cli",
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Lang": "js",
    "X-Stainless-Timeout": "600",
    "X-Claude-Code-Session-Id": input.sessionId,
    "x-client-request-id": crypto.randomUUID(),
    "User-Agent": input.claudeUserAgent,
    "X-Stainless-Package-Version": serverConfig.claudeStainlessPackageVersion,
    "X-Stainless-Runtime-Version": serverConfig.claudeStainlessRuntimeVersion,
    "X-Stainless-Os": serverConfig.claudeStainlessOs,
    "X-Stainless-Arch": serverConfig.claudeStainlessArch,
  };
  if (input.countTokens) delete headers["X-Stainless-Timeout"];
  return headers;
}

function normalizeClaudeBaseUrl(value: string | undefined) {
  return (value || serverConfig.claudeBaseUrl).replace(/\/+$/, "");
}

function cloneJsonObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {} as Record<string, unknown>;
  }
  return structuredClone(value) as Record<string, unknown>;
}

function parseMaybeJson<T>(text: string) {
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}
