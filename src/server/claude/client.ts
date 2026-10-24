import "server-only";

import { withAccountQuotaHeaders } from "@/src/server/http/accountQuota";

import crypto from "node:crypto";
import { claudeBetas, isNativeClaudeCodeRequest } from "@/src/server/claude/wire";
import { prepareClaudeOAuthUpstreamPayload } from "@/src/server/claude/compat";
import { serverConfig } from "@/src/server/config/env";
import { proxiedFetch } from "@/src/server/net/proxy";
import {
  ensureFreshClaudeCredential,
  ensureClaudeRequestIdentity,
  getEffectiveClaudeUserAgent,
  resolveClaudeCredentialProxy,
} from "@/src/server/services/claudeCredentials";
import type { StageTimer } from "@/src/server/http/stageTimer";
import type { ClaudeCredentialWithTokens } from "@/src/shared/types/entities";

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
  const claudeUserAgent = resolveClaudeUpstreamUserAgent(
    input.sourceHeaders,
    getEffectiveClaudeUserAgent(credential),
    isNativeClaudeCodeRequest(input.sourceHeaders, payload, input.upstreamPath === "/v1/messages/count_tokens"),
  );
  const prepared = prepareClaudeOAuthUpstreamPayload(cloneJsonObject(payload), {
    accessToken: credential.tokens.access_token,
    sourceHeaders: input.sourceHeaders,
    claudeUserAgent,
    ...ensureClaudeRequestIdentity(credential),
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
    native: prepared.native,
    sessionId: prepared.sessionId,
    payload: upstreamPayload,
    countTokens: input.upstreamPath === "/v1/messages/count_tokens",
  });
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

function buildClaudeHeaders(
  credential: ClaudeCredentialWithTokens,
  input: {
    stream: boolean;
    sourceHeaders: Headers;
    claudeUserAgent: string;
    extraBetas: string[];
    native: boolean;
    sessionId: string;
    payload: Record<string, unknown>;
    countTokens: boolean;
  },
) {
  const beta = input.countTokens
    ? "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,token-counting-2024-11-01"
    : claudeBetas(input.payload, input.sourceHeaders.get("anthropic-beta"), input.extraBetas, input.native);
  const profileHeaders = input.native ? input.sourceHeaders : new Headers();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.tokens.access_token}`,
    "Content-Type": "application/json",
    Connection: "keep-alive",
    Accept: input.stream ? "text/event-stream" : "application/json",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Anthropic-Dangerous-Direct-Browser-Access": "true",
    "Anthropic-Version":
      input.native ? input.sourceHeaders.get("anthropic-version") || "2023-06-01" : "2023-06-01",
    "Anthropic-Beta": beta,
    "X-App": "cli",
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Lang": "js",
    "X-Stainless-Timeout": sourceOrDefault(
      profileHeaders,
      "x-stainless-timeout",
      "600",
    ),
    "X-Claude-Code-Session-Id": input.sessionId,
    "x-client-request-id": input.native ? input.sourceHeaders.get("x-client-request-id") || crypto.randomUUID() : crypto.randomUUID(),
    "User-Agent": input.claudeUserAgent,
    "X-Stainless-Package-Version": sourceOrDefault(
      profileHeaders,
      "x-stainless-package-version",
      serverConfig.claudeStainlessPackageVersion,
    ),
    "X-Stainless-Runtime-Version": sourceOrDefault(
      profileHeaders,
      "x-stainless-runtime-version",
      serverConfig.claudeStainlessRuntimeVersion,
    ),
    "X-Stainless-Os": sourceOrDefault(
      profileHeaders,
      "x-stainless-os",
      serverConfig.claudeStainlessOs,
    ),
    "X-Stainless-Arch": sourceOrDefault(
      profileHeaders,
      "x-stainless-arch",
      serverConfig.claudeStainlessArch,
    ),
  };
  if (input.countTokens) delete headers["X-Stainless-Timeout"];
  if (input.native) {
    for (const name of ["x-stainless-async", "x-claude-code-agent-id", "x-claude-code-parent-agent-id",
      "x-claude-remote-container-id", "x-claude-remote-session-id", "x-client-app", "x-anthropic-additional-protection",
      "x-claude-code-request-class", "x-claude-code-agent-type", "x-claude-code-compaction", "x-claude-code-context-compacted"]) {
      const value = input.sourceHeaders.get(name);
      if (value) headers[name] = value;
    }
  }
  return headers;
}

function resolveClaudeUpstreamUserAgent(
  sourceHeaders: Headers,
  fallback: string,
  native: boolean,
) {
  const userAgent = sourceHeaders.get("user-agent")?.trim() || "";
  if (native) {
    return userAgent;
  }
  return fallback;
}

function sourceOrDefault(
  sourceHeaders: Headers,
  name: string,
  fallback: string,
) {
  const userAgent = sourceHeaders.get("user-agent")?.trim() || "";
  if (userAgent.startsWith("claude-cli/")) {
    const value = sourceHeaders.get(name)?.trim();
    if (value) {
      return value;
    }
  }
  return fallback;
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
