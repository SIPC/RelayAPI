import "server-only";

import crypto from "node:crypto";
import { prepareClaudeOAuthUpstreamPayload } from "@/src/server/claude/compat";
import { serverConfig } from "@/src/server/config/env";
import { proxiedFetch } from "@/src/server/net/proxy";
import {
  ensureFreshClaudeCredential,
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

const CLAUDE_BETA = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
].join(",");

export async function claudeFetch(
  payload: Record<string, unknown>,
  input: {
    stream: boolean;
    sourceHeaders: Headers;
    credentialId: string;
    baseUrl?: string;
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
  );
  const prepared = prepareClaudeOAuthUpstreamPayload(cloneJsonObject(payload), {
    accessToken: credential.tokens.access_token,
    sourceHeaders: input.sourceHeaders,
    claudeUserAgent,
  });
  const upstreamPayload = prepared.payload;
  const proxy = resolveClaudeCredentialProxy({
    proxy: credential.proxy,
    proxyPoolId: credential.proxyPoolId,
    useGlobalProxy: credential.useGlobalProxy,
  });
  const url = `${normalizeClaudeBaseUrl(input.baseUrl)}/v1/messages?beta=true`;
  const headers = buildClaudeHeaders(credential, {
    stream: input.stream,
    sourceHeaders: input.sourceHeaders,
    claudeUserAgent,
    extraBetas: prepared.extraBetas,
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
    response,
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
  },
) {
  const beta = mergeClaudeBeta(
    input.sourceHeaders.get("anthropic-beta"),
    input.extraBetas,
  );
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.tokens.access_token}`,
    "Content-Type": "application/json",
    Connection: "keep-alive",
    Accept: input.stream ? "text/event-stream" : "application/json",
    "Accept-Encoding": input.stream ? "identity" : "gzip, deflate, br, zstd",
    "Anthropic-Version":
      input.sourceHeaders.get("anthropic-version") || "2023-06-01",
    "Anthropic-Beta": beta,
    "X-App": "cli",
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Lang": "js",
    "X-Stainless-Timeout": sourceOrDefault(
      input.sourceHeaders,
      "x-stainless-timeout",
      "600",
    ),
    "X-Claude-Code-Session-Id": deterministicUuid(
      `relayapi:claude:${credential.id}`,
    ),
    "x-client-request-id": crypto.randomUUID(),
    "User-Agent": sourceClaudeCliUserAgent(
      input.sourceHeaders,
      input.claudeUserAgent,
    ),
    "X-Stainless-Package-Version": sourceOrDefault(
      input.sourceHeaders,
      "x-stainless-package-version",
      serverConfig.claudeStainlessPackageVersion,
    ),
    "X-Stainless-Runtime-Version": sourceOrDefault(
      input.sourceHeaders,
      "x-stainless-runtime-version",
      serverConfig.claudeStainlessRuntimeVersion,
    ),
    "X-Stainless-Os": sourceOrDefault(
      input.sourceHeaders,
      "x-stainless-os",
      serverConfig.claudeStainlessOs,
    ),
    "X-Stainless-Arch": sourceOrDefault(
      input.sourceHeaders,
      "x-stainless-arch",
      serverConfig.claudeStainlessArch,
    ),
  };
  return headers;
}

function resolveClaudeUpstreamUserAgent(
  sourceHeaders: Headers,
  fallback: string,
) {
  const userAgent = sourceHeaders.get("user-agent")?.trim() || "";
  if (userAgent.startsWith("claude-cli/")) {
    return userAgent;
  }
  return fallback;
}

function sourceClaudeCliUserAgent(sourceHeaders: Headers, fallback: string) {
  return resolveClaudeUpstreamUserAgent(sourceHeaders, fallback);
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

function mergeClaudeBeta(sourceValue: string | null, extraBetas: string[]) {
  const values = new Set(
    (sourceValue || CLAUDE_BETA)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  for (const beta of extraBetas) {
    values.add(beta);
  }
  for (const required of [
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
  ]) {
    values.add(required);
  }
  return [...values].join(",");
}

function normalizeClaudeBaseUrl(value: string | undefined) {
  return (value || serverConfig.claudeBaseUrl).replace(/\/+$/, "");
}

function deterministicUuid(seed: string) {
  const hash = crypto.createHash("sha1").update(seed).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
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
