import "server-only";

import crypto from "node:crypto";
import { prepareClaudeOAuthUpstreamPayload } from "@/src/server/claude/compat";
import {
  claudeModelAllowlistCandidates,
  stripClaudeModelSuffixes,
} from "@/src/server/claude/modelSuffix";
import { serverConfig } from "@/src/server/config/env";
import { HttpError, logServerError } from "@/src/server/http/errors";
import { proxiedFetch } from "@/src/server/net/proxy";
import {
  deleteClaudeCredential,
  getClaudeCredentialWithTokens,
  listClaudeCredentials,
  listClaudeCredentialsWithTokens,
  markClaudeCredentialUsed,
  updateClaudeCredential,
  upsertClaudeCredential,
} from "@/src/server/repositories/claudeCredentials";
import { detachCredentialFromChannels } from "@/src/server/repositories/channels";
import {
  credentialUsageHealth,
  credentialUsageWindows,
  latestCredentialUpstreamHeaders,
} from "@/src/server/repositories/logs";
import {
  saveOAuthPendingState,
  takeOAuthPendingState,
} from "@/src/server/repositories/oauthPendingStates";
import { getProxyPoolCredentialProxy } from "@/src/server/services/proxyPool";
import {
  getGlobalProxySetting,
  normalizeCodexUserAgentInput,
} from "@/src/server/services/settings";
import { randomId, sha256 } from "@/src/server/services/crypto";
import type {
  ClaudeCredentialRecord,
  ClaudeCredentialWithTokens,
  ClaudeQuotaReport,
  ClaudeQuotaStatus,
  ClaudeQuotaWindow,
  ClaudeTokenBundle,
  CredentialProxyConfig,
  CredentialProxyType,
  RelayApiKeyContext,
} from "@/src/shared/types/entities";

const AUTH_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_SCOPE =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CLAUDE_USER_AGENT = "claude-cli/2.1.77 (external, cli)";
const TOKEN_REFRESH_ERROR_PREFIX = "Claude token 自动刷新失败";
const TOKEN_REFRESH_METADATA_KEYS = [
  "token_refresh_attempt_count",
  "token_refresh_next_attempt_at",
  "token_refresh_last_attempt_at",
  "token_refresh_last_failed_at",
  "token_refresh_last_error",
  "token_refresh_exhausted",
  "token_refresh_exhausted_at",
  "token_refresh_auto_disabled",
] as const;
const USAGE_HEALTH_RESET_METADATA_KEY = "usage_health_reset_at";
const CLAUDE_MESSAGES_PATH = "/v1/messages?beta=true";
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

interface PendingOAuthState {
  codeVerifier: string;
  codeChallenge: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}

const pendingStates = new Map<string, PendingOAuthState>();

export function startClaudeOAuthLoginSession() {
  const state = generateRandomState();
  const { codeVerifier, codeChallenge } = generatePkce();
  const redirectUri = serverConfig.claudeRedirectUri;
  const createdAt = Date.now();
  const expiresAt = createdAt + OAUTH_STATE_TTL_MS;
  pendingStates.set(state, {
    codeVerifier,
    codeChallenge,
    redirectUri,
    createdAt,
    expiresAt,
  });
  saveOAuthPendingState({
    state,
    provider: "claude",
    codeVerifier,
    codeChallenge,
    redirectUri,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  });
  prunePendingStates();
  return {
    state,
    redirectUri,
    authUrl: createAuthUrl({ state, codeChallenge, redirectUri }),
  };
}

function createAuthUrl(input: {
  state: string;
  codeChallenge: string;
  redirectUri: string;
}) {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: input.redirectUri,
    scope: OAUTH_SCOPE,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    state: input.state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function finishClaudeOAuthCallback(searchParams: URLSearchParams) {
  const error =
    searchParams.get("error") || searchParams.get("error_description");
  if (error) {
    throw new HttpError(400, "claude_oauth_error", error);
  }
  const rawCode = searchParams.get("code") || "";
  const state = searchParams.get("state") || stateFromCode(rawCode);
  const code = rawCode.split("#", 1)[0];
  if (!code || !state) {
    throw new HttpError(
      400,
      "invalid_claude_oauth_callback",
      "OAuth callback must include code and state",
    );
  }
  const pending = takePendingClaudeOAuthState(state);
  if (!pending) {
    throw new HttpError(
      400,
      "expired_claude_oauth_state",
      "Unknown or expired OAuth state. Start Claude OAuth again.",
    );
  }
  return exchangeCodeForTokens({
    code,
    state,
    codeVerifier: pending.codeVerifier,
    redirectUri: pending.redirectUri,
  });
}

export function parseClaudeOAuthCallbackInput(input: unknown) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) {
    throw new HttpError(
      400,
      "missing_callback_url",
      "Paste the localhost callback URL or query string returned by Claude OAuth",
    );
  }

  let candidate = raw;
  if (!candidate.includes("://")) {
    if (candidate.startsWith("?")) {
      candidate = `http://localhost${candidate}`;
    } else if (
      /[/?#]/.test(candidate) ||
      (candidate.includes(":") && !candidate.includes("="))
    ) {
      candidate = `http://${candidate}`;
    } else if (candidate.includes("=")) {
      candidate = `http://localhost/?${candidate.replace(/^&+/, "")}`;
    } else {
      throw new HttpError(400, "invalid_callback_url", "Invalid callback URL");
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new HttpError(400, "invalid_callback_url", "Invalid callback URL");
  }

  const params = new URLSearchParams(parsed.searchParams);
  if (parsed.hash) {
    const fragment = parsed.hash.replace(/^#/, "");
    const fragmentParams = new URLSearchParams(fragment);
    for (const key of ["code", "state", "error", "error_description"]) {
      if (!params.get(key) && fragmentParams.get(key)) {
        params.set(key, fragmentParams.get(key) || "");
      }
    }
  }

  const code = params.get("code") || "";
  if (code.includes("#") && !params.get("state")) {
    const [cleanCode, state] = code.split("#", 2);
    params.set("code", cleanCode);
    params.set("state", state || "");
  }

  if (
    !params.get("code") &&
    !params.get("error") &&
    !params.get("error_description")
  ) {
    throw new HttpError(
      400,
      "callback_missing_code",
      "Callback URL missing code",
    );
  }

  return params;
}

export function listPublicClaudeCredentials() {
  const credentials = listClaudeCredentials();
  const healthByCredentialId = credentialUsageHealth(
    credentials.map((credential) => credential.id),
    { resetSinceById: credentialUsageHealthResetMap(credentials) },
  );
  return credentials.map((credential) => ({
    ...credential,
    usageHealth: healthByCredentialId[credential.id],
  }));
}

export async function getClaudeQuota(
  credentialId: string,
  options: { sourceHeaders?: Headers } = {},
): Promise<ClaudeQuotaReport> {
  const id = cleanString(credentialId);
  if (!id) {
    throw new HttpError(
      400,
      "missing_claude_credential_id",
      "Claude credential id is required",
    );
  }
  const existing = getClaudeCredentialWithTokens(id);
  if (!existing) {
    throw new HttpError(
      404,
      "claude_credential_not_found",
      "Claude credential not found",
    );
  }

  let credential = existing;
  try {
    credential = await ensureFreshClaudeCredential(id);
    if (!credential.tokens.access_token) {
      throw new HttpError(
        400,
        "missing_claude_access_token",
        "Saved Claude credential does not contain an access token",
      );
    }

    const now = new Date();
    const localWindows = credentialUsageWindows(id, now);
    const probe =
      cachedClaudeQuotaProbe(id) ||
      (await requestClaudeQuotaProbe(
        credential,
        options.sourceHeaders || new Headers(),
      ));
    const windows = withClaudeRetryAfterWindow(
      parseClaudeRateLimitWindows(probe.headers),
      probe,
      now,
    );

    return {
      provider: "claude",
      source: "anthropic_headers",
      credential_id: credential.id,
      account_id: credential.accountId,
      email: credential.email,
      status: deriveClaudeQuotaStatus(credential, windows, now, probe.status),
      windows,
      local_windows: localWindows,
      retrieved_at: now.toISOString(),
      cooldown_until: credential.cooldownUntil,
      last_error: credential.lastError,
      message: claudeQuotaMessage(probe, windows),
    };
  } catch (error) {
    logServerError(error, {
      operation: "claude.quota.refresh",
      metadata: claudeCredentialLogMetadata(credential),
    });
    throw error;
  }
}

export function patchClaudeCredentialRouting(
  id: string,
  input: {
    enabled?: boolean;
    priority?: number;
    weight?: number;
    userAgent?: string | null;
    useGlobalProxy?: boolean;
    proxyPoolId?: string | null;
    proxy?: unknown;
  },
) {
  const existing = getClaudeCredentialWithTokens(id);
  if (!existing) {
    throw new HttpError(
      404,
      "claude_credential_not_found",
      "Claude credential not found",
    );
  }
  const updated = updateClaudeCredential(id, {
    ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
    ...(input.priority !== undefined
      ? { priority: normalizeInteger(input.priority, 100) }
      : {}),
    ...(input.weight !== undefined
      ? { weight: Math.max(1, normalizeInteger(input.weight, 1)) }
      : {}),
    ...(Object.hasOwn(input, "userAgent")
      ? { userAgent: normalizeCodexUserAgentInput(input.userAgent) }
      : {}),
    ...(input.useGlobalProxy !== undefined
      ? { useGlobalProxy: Boolean(input.useGlobalProxy) }
      : {}),
    ...(Object.hasOwn(input, "proxyPoolId")
      ? { proxyPoolId: normalizeProxyPoolId(input.proxyPoolId) }
      : {}),
    ...(Object.hasOwn(input, "proxy")
      ? { proxy: normalizeCredentialProxyPatch(input.proxy, existing.proxy) }
      : {}),
  });
  if (!updated) {
    throw new HttpError(
      404,
      "claude_credential_not_found",
      "Claude credential not found",
    );
  }
  return publicClaudeCredential(updated);
}

export function removeClaudeCredential(id: string) {
  detachCredentialFromChannels(id, "claude");
  if (!deleteClaudeCredential(id)) {
    throw new HttpError(
      404,
      "claude_credential_not_found",
      "Claude credential not found",
    );
  }
}

export async function refreshClaudeCredential(id: string) {
  return publicClaudeCredential(await refreshClaudeCredentialWithTokens(id));
}

export function resetClaudeCredentialHealth(id: string) {
  const credential = getClaudeCredentialWithTokens(id);
  if (!credential) {
    throw new HttpError(
      404,
      "claude_credential_not_found",
      "Claude credential not found",
    );
  }
  const updated = updateClaudeCredential(id, {
    cooldownUntil: null,
    lastError: isClaudeTokenRefreshError(credential)
      ? credential.lastError
      : null,
    metadata: {
      ...credential.metadata,
      [USAGE_HEALTH_RESET_METADATA_KEY]: new Date().toISOString(),
    },
  });
  if (!updated) {
    throw new HttpError(
      404,
      "claude_credential_not_found",
      "Claude credential not found",
    );
  }
  return publicClaudeCredential(updated);
}

export async function refreshClaudeCredentialForScheduler(id: string) {
  return refreshClaudeCredentialWithTokens(id);
}

export async function ensureFreshClaudeCredential(id: string) {
  if (!id) {
    throw new HttpError(
      503,
      "missing_claude_credential",
      "Selected route has no Claude credential",
    );
  }
  const credential = getClaudeCredentialWithTokens(id);
  if (!credential) {
    throw new HttpError(
      503,
      "claude_credential_not_found",
      "Selected Claude credential was not found",
    );
  }
  const expiresAt = Date.parse(
    credential.expiresAt || credential.tokens.expired || "",
  );
  if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) {
    return credential;
  }
  throw new HttpError(
    503,
    credential.metadata.token_refresh_exhausted === true
      ? "claude_token_refresh_exhausted"
      : "claude_token_expired",
    credential.metadata.token_refresh_exhausted === true
      ? "Claude credential token refresh has exhausted its retry budget"
      : "Claude credential token is expired and waiting for scheduled refresh",
  );
}

export function selectClaudeCredential(input: {
  model: string;
  apiKey: RelayApiKeyContext;
}) {
  const model = cleanString(input.model);
  const baseModel = stripClaudeModelSuffixes(model);
  if (
    input.apiKey.modelAllowlist.length > 0 &&
    model &&
    !modelMatchesAllowlist(model, baseModel, input.apiKey.modelAllowlist)
  ) {
    throw new HttpError(
      403,
      "model_not_allowed",
      `API key is not allowed to use model: ${model}`,
    );
  }
  if (input.apiKey.channelAllowlist.length > 0) {
    throw new HttpError(
      503,
      "no_available_claude_route",
      "Claude routing does not use Codex channel IDs, and this API key is channel-restricted",
    );
  }

  const now = Date.now();
  const credentials = listClaudeCredentials();
  const healthByCredentialId = credentialUsageHealth(
    credentials.map((credential) => credential.id),
    { resetSinceById: credentialUsageHealthResetMap(credentials) },
  );
  const candidates = credentials
    .map((credential) => ({
      ...credential,
      usageHealth: healthByCredentialId[credential.id] || unusedUsageHealth(50),
    }))
    .filter(
      (credential) =>
        credential.enabled &&
        (!credential.cooldownUntil ||
          Date.parse(credential.cooldownUntil) <= now),
    );
  if (candidates.length === 0) {
    throw new HttpError(
      503,
      "no_available_claude_credential",
      "No usable Claude credential is available for this request",
    );
  }
  const selected = selectRoutingItem(
    candidates,
    (credential) => credential.priority,
    (credential) => credential.weight,
    (credential) => clamp(credential.usageHealth?.score ?? 100, 0, 100),
  );
  const credential = getClaudeCredentialWithTokens(selected.id);
  if (!credential) {
    throw new HttpError(
      503,
      "claude_credential_not_found",
      "Selected Claude credential was not found",
    );
  }
  markClaudeCredentialUsed(credential.id);
  return credential;
}

export function recordClaudeCredentialSuccess(
  credential: ClaudeCredentialWithTokens,
) {
  updateClaudeCredential(credential.id, {
    cooldownUntil: null,
    lastError: null,
  });
}

export function recordClaudeCredentialFailure(
  credential: Pick<ClaudeCredentialWithTokens, "id">,
  input: { statusCode?: number | null; message?: string | null },
) {
  const statusCode = input.statusCode ?? null;
  const cooldownUntil = isCredentialScopedFailure(statusCode)
    ? new Date(
        Date.now() + (statusCode === 429 ? 5 : 15) * 60 * 1000,
      ).toISOString()
    : null;
  updateClaudeCredential(credential.id, {
    ...(cooldownUntil ? { cooldownUntil } : {}),
    lastError: input.message || null,
  });
}

export function resolveClaudeCredentialProxy(input: {
  proxy: CredentialProxyConfig | null;
  proxyPoolId: string | null;
  useGlobalProxy: boolean;
}) {
  if (input.proxy?.enabled) {
    return input.proxy;
  }
  const pooledProxy = getProxyPoolCredentialProxy(input.proxyPoolId);
  if (pooledProxy?.enabled) {
    return pooledProxy;
  }
  return input.useGlobalProxy ? getGlobalProxySetting() : null;
}

export function getEffectiveClaudeUserAgent(input?: {
  userAgent?: string | null;
}) {
  const fallback = serverConfig.claudeUserAgent || DEFAULT_CLAUDE_USER_AGENT;
  const configured = cleanString(input?.userAgent);
  if (!configured) {
    return fallback;
  }
  return shouldUpgradeClaudeUserAgent(configured, fallback)
    ? fallback
    : configured;
}

export async function exportClaudeCredentials() {
  return {
    type: "relayapi_claude_credentials_export",
    version: 1,
    exported_at: new Date().toISOString(),
    credentials: listClaudeCredentialsWithTokens().map(
      exportClaudeCredentialJson,
    ),
  };
}

export async function exportClaudeCredential(id: string) {
  const credential = getClaudeCredentialWithTokens(id);
  if (!credential) {
    throw new HttpError(
      404,
      "claude_credential_not_found",
      "Claude credential not found",
    );
  }
  return exportClaudeCredentialJson(credential);
}

export function importClaudeCredentialFromJson(
  input: unknown,
  options: { filename?: string } = {},
) {
  const raw = objectValue(input);
  if (!raw) {
    throw new HttpError(
      400,
      "invalid_claude_credential_json",
      "Uploaded Claude credential must be a JSON object",
    );
  }
  const tokens: ClaudeTokenBundle = {
    access_token: stringValue(raw.access_token),
    refresh_token: stringValue(raw.refresh_token),
    expired: stringValue(raw.expired || raw.expire),
    last_refresh: stringValue(raw.last_refresh),
  };
  if (!tokens.refresh_token && !tokens.access_token) {
    throw new HttpError(
      400,
      "missing_claude_tokens",
      "Uploaded Claude credential must include access_token or refresh_token",
    );
  }
  const id =
    stringValue(raw.id) ||
    createCredentialId({
      email: stringValue(raw.email),
      accountId: stringValue(raw.account_id || raw.accountId),
      tokens,
    });
  const metadata = objectValue(raw.metadata);
  const saved = upsertClaudeCredential({
    id,
    email: stringValue(raw.email),
    accountId: stringValue(raw.account_id || raw.accountId),
    tokens,
    proxy: Object.hasOwn(raw, "proxy")
      ? normalizeCredentialProxyPatch(raw.proxy, null)
      : undefined,
    ...(raw.enabled !== undefined ? { enabled: Boolean(raw.enabled) } : {}),
    ...(raw.priority !== undefined
      ? { priority: normalizeInteger(raw.priority, 100) }
      : {}),
    ...(raw.weight !== undefined
      ? { weight: Math.max(1, normalizeInteger(raw.weight, 1)) }
      : {}),
    metadata: {
      ...(metadata || {}),
      imported_from: "web_upload",
      import_filename: options.filename,
      imported_at: new Date().toISOString(),
      ...(Object.hasOwn(raw, "user_agent")
        ? { user_agent: stringValue(raw.user_agent) }
        : {}),
      ...(Object.hasOwn(raw, "userAgent")
        ? { user_agent: stringValue(raw.userAgent) }
        : {}),
      ...(Object.hasOwn(raw, "use_global_proxy")
        ? { use_global_proxy: Boolean(raw.use_global_proxy) }
        : {}),
      ...(Object.hasOwn(raw, "useGlobalProxy")
        ? { use_global_proxy: Boolean(raw.useGlobalProxy) }
        : {}),
    },
  });
  if (!saved) {
    throw new Error("Failed to import Claude credential");
  }
  return publicClaudeCredential(saved);
}

async function exchangeCodeForTokens(input: {
  code: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}) {
  try {
    return publicClaudeCredential(
      await saveClaudeTokenResponse(
        await tokenRequest(
          {
            code: input.code,
            state: input.state,
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            redirect_uri: input.redirectUri,
            code_verifier: input.codeVerifier,
          },
          null,
          null,
          true,
        ),
        null,
      ),
    );
  } catch (error) {
    logServerError(error, {
      operation: "claude.oauth.exchange_token",
      metadata: {
        redirectUri: input.redirectUri,
        useGlobalProxyFallback: true,
      },
    });
    throw error;
  }
}

async function refreshClaudeCredentialWithTokens(id: string) {
  const credential = getClaudeCredentialWithTokens(id);
  if (!credential) {
    throw new HttpError(
      404,
      "claude_credential_not_found",
      "Claude credential not found",
    );
  }
  if (!credential.tokens.refresh_token) {
    throw new HttpError(
      400,
      "missing_refresh_token",
      "Saved Claude credential does not contain a refresh token",
    );
  }
  try {
    const tokenResponse = await tokenRequest(
      {
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: credential.tokens.refresh_token,
      },
      credential.proxy,
      credential.proxyPoolId,
      credential.useGlobalProxy,
    );
    return clearClaudeTokenRefreshState(
      await saveClaudeTokenResponse(tokenResponse, credential),
    );
  } catch (error) {
    logServerError(error, {
      operation: "claude.refresh_token",
      metadata: claudeCredentialLogMetadata(credential),
    });
    throw error;
  }
}

async function tokenRequest(
  body: Record<string, unknown>,
  proxy: CredentialProxyConfig | null,
  proxyPoolId: string | null,
  useGlobalProxyFallback: boolean,
) {
  const response = await proxiedFetch(
    TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": getEffectiveClaudeUserAgent(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(serverConfig.requestTimeoutMs),
    },
    resolveClaudeCredentialProxy({
      proxy,
      proxyPoolId,
      useGlobalProxy: useGlobalProxyFallback,
    }),
  );
  const text = await response.text();
  const parsed = parseMaybeJson<Record<string, unknown>>(text) || { raw: text };
  if (!response.ok) {
    throw new HttpError(
      response.status,
      "claude_token_request_failed",
      `Claude token request failed with HTTP ${response.status}`,
      {
        upstreamStatus: response.status,
        upstreamStatusText: response.statusText,
        upstreamBody: parsed,
      },
    );
  }
  return parsed;
}

async function saveClaudeTokenResponse(
  tokenResponse: Record<string, unknown>,
  previous: ClaudeCredentialWithTokens | null,
) {
  const now = new Date();
  const expiresIn = numberValue(tokenResponse.expires_in) || 3600;
  const account = objectValue(tokenResponse.account);
  const organization = objectValue(tokenResponse.organization);
  const tokens: ClaudeTokenBundle = {
    access_token:
      stringValue(tokenResponse.access_token) ||
      previous?.tokens.access_token ||
      "",
    refresh_token:
      stringValue(tokenResponse.refresh_token) ||
      previous?.tokens.refresh_token ||
      "",
    expired: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    last_refresh: now.toISOString(),
  };
  const email =
    stringValue(account?.email_address) ||
    stringValue(tokenResponse.email) ||
    previous?.email ||
    "";
  const accountId =
    stringValue(account?.uuid) ||
    stringValue(organization?.uuid) ||
    previous?.accountId ||
    "";
  const id = previous?.id || createCredentialId({ email, accountId, tokens });
  const saved = upsertClaudeCredential({
    id,
    email,
    accountId,
    tokens,
    metadata: {
      organization_name: stringValue(organization?.name),
      imported_from: previous?.metadata?.imported_from || undefined,
    },
  });
  if (!saved) {
    throw new Error("Failed to save Claude credential");
  }
  return saved;
}

interface ClaudeQuotaProbeResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  body: unknown;
  source: "request_log" | "probe";
}

function cachedClaudeQuotaProbe(
  credentialId: string,
): ClaudeQuotaProbeResult | null {
  const headers = latestCredentialUpstreamHeaders(credentialId);
  if (!headers) {
    return null;
  }
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(headers),
    body: null,
    source: "request_log",
  };
}

async function requestClaudeQuotaProbe(
  credential: ClaudeCredentialWithTokens,
  sourceHeaders: Headers,
): Promise<ClaudeQuotaProbeResult> {
  const claudeUserAgent = sourceClaudeCliUserAgent(
    sourceHeaders,
    getEffectiveClaudeUserAgent(credential),
  );
  const prepared = prepareClaudeOAuthUpstreamPayload(
    {
      model: stripClaudeModelSuffixes(serverConfig.claudeDefaultModel),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "quota probe" }],
        },
      ],
      max_tokens: 1,
      stream: true,
    },
    {
      accessToken: credential.tokens.access_token,
      sourceHeaders,
      claudeUserAgent,
    },
  );

  const response = await proxiedFetch(
    `${serverConfig.claudeBaseUrl}${CLAUDE_MESSAGES_PATH}`,
    {
      method: "POST",
      headers: buildClaudeQuotaProbeHeaders(credential, {
        stream: true,
        sourceHeaders,
        claudeUserAgent,
        extraBetas: prepared.extraBetas,
      }),
      body: prepared.body,
      signal: AbortSignal.timeout(serverConfig.requestTimeoutMs),
    },
    resolveClaudeCredentialProxy({
      proxy: credential.proxy,
      proxyPoolId: credential.proxyPoolId,
      useGlobalProxy: credential.useGlobalProxy,
    }),
  );

  let responseBody: unknown = null;
  if (response.ok) {
    await response.body?.cancel();
  } else {
    const text = await response.text();
    responseBody = parseMaybeJson<unknown>(text) || { raw: text };
    if (response.status !== 429) {
      throw new HttpError(
        response.status,
        "claude_quota_request_failed",
        `Claude quota probe failed with HTTP ${response.status}`,
        {
          upstreamStatus: response.status,
          upstreamStatusText: response.statusText,
          upstreamBody: responseBody,
        },
      );
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: responseBody,
    source: "probe",
  };
}

function buildClaudeQuotaProbeHeaders(
  credential: ClaudeCredentialWithTokens,
  input: {
    stream: boolean;
    sourceHeaders: Headers;
    claudeUserAgent: string;
    extraBetas: string[];
  },
) {
  return {
    Authorization: `Bearer ${credential.tokens.access_token}`,
    "Content-Type": "application/json",
    Accept: input.stream ? "text/event-stream" : "application/json",
    "Accept-Encoding": input.stream ? "identity" : "gzip, deflate, br, zstd",
    "Anthropic-Version":
      input.sourceHeaders.get("anthropic-version") || "2023-06-01",
    "Anthropic-Beta": mergeClaudeBeta(
      input.sourceHeaders.get("anthropic-beta"),
      input.extraBetas,
    ),
    "X-App": "cli",
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Lang": "js",
    "X-Stainless-Timeout": sourceClaudeHeaderOrDefault(
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
    "X-Stainless-Package-Version": sourceClaudeHeaderOrDefault(
      input.sourceHeaders,
      "x-stainless-package-version",
      serverConfig.claudeStainlessPackageVersion,
    ),
    "X-Stainless-Runtime-Version": sourceClaudeHeaderOrDefault(
      input.sourceHeaders,
      "x-stainless-runtime-version",
      serverConfig.claudeStainlessRuntimeVersion,
    ),
    "X-Stainless-Os": sourceClaudeHeaderOrDefault(
      input.sourceHeaders,
      "x-stainless-os",
      serverConfig.claudeStainlessOs,
    ),
    "X-Stainless-Arch": sourceClaudeHeaderOrDefault(
      input.sourceHeaders,
      "x-stainless-arch",
      serverConfig.claudeStainlessArch,
    ),
  };
}

function parseClaudeRateLimitWindows(headers: Headers): ClaudeQuotaWindow[] {
  const unifiedWindows = parseClaudeUnifiedRateLimitWindows(headers);
  const groups = new Map<
    string,
    { limit?: string; remaining?: string; reset?: string }
  >();
  for (const [rawName, value] of headers.entries()) {
    const parsed = parseClaudeRateLimitHeaderName(rawName);
    if (!parsed) {
      continue;
    }
    const group = groups.get(parsed.metric) || {};
    group[parsed.field] = value;
    groups.set(parsed.metric, group);
  }

  const order = [
    "unified-5h",
    "unified-7d",
    "requests",
    "tokens",
    "input-tokens",
    "output-tokens",
    "cache-read-input-tokens",
    "cache-creation-input-tokens",
  ];
  const standardWindows = [...groups.entries()]
    .sort(([left], [right]) => {
      const leftIndex = order.indexOf(left);
      const rightIndex = order.indexOf(right);
      return (
        (leftIndex < 0 ? order.length : leftIndex) -
          (rightIndex < 0 ? order.length : rightIndex) ||
        left.localeCompare(right)
      );
    })
    .map(([metric, values]) => buildClaudeQuotaWindow(metric, values));
  return [...unifiedWindows, ...standardWindows];
}

function parseClaudeRateLimitHeaderName(rawName: string) {
  const name = rawName.toLowerCase();
  if (name.startsWith("anthropic-ratelimit-unified-")) {
    return null;
  }
  const anthropic = name.match(
    /^anthropic-ratelimit-(.+)-(limit|remaining|reset)$/,
  );
  if (anthropic) {
    return {
      metric: anthropic[1],
      field: anthropic[2] as "limit" | "remaining" | "reset",
    };
  }

  const fieldFirst = name.match(/^x-ratelimit-(limit|remaining|reset)-(.+)$/);
  if (fieldFirst) {
    return {
      metric: normalizeClaudeRateLimitMetric(fieldFirst[2]),
      field: fieldFirst[1] as "limit" | "remaining" | "reset",
    };
  }

  const fieldLast = name.match(/^x-ratelimit-(.+)-(limit|remaining|reset)$/);
  if (fieldLast) {
    return {
      metric: normalizeClaudeRateLimitMetric(fieldLast[1]),
      field: fieldLast[2] as "limit" | "remaining" | "reset",
    };
  }
  return null;
}

function normalizeClaudeRateLimitMetric(metric: string) {
  return metric
    .replace(/^anthropic-/, "")
    .replace(/_/g, "-")
    .replace(/-per-.+$/, "")
    .replace(/-window$/, "")
    .trim();
}

function parseClaudeUnifiedRateLimitWindows(headers: Headers) {
  const groups = new Map<
    string,
    { reset?: string; status?: string; utilization?: string }
  >();
  for (const [rawName, value] of headers.entries()) {
    const match = rawName
      .toLowerCase()
      .match(
        /^anthropic-ratelimit-unified-(5h|7d)-(reset|status|utilization)$/,
      );
    if (!match) {
      continue;
    }
    const windowId = match[1];
    const field = match[2] as "reset" | "status" | "utilization";
    const group = groups.get(windowId) || {};
    group[field] = value;
    groups.set(windowId, group);
  }

  return [...groups.entries()]
    .sort(
      ([left], [right]) => unifiedWindowRank(left) - unifiedWindowRank(right),
    )
    .map(([windowId, values]) =>
      buildClaudeUnifiedQuotaWindow(windowId, values),
    );
}

function unifiedWindowRank(windowId: string) {
  if (windowId === "5h") {
    return 0;
  }
  if (windowId === "7d") {
    return 1;
  }
  return 2;
}

function buildClaudeUnifiedQuotaWindow(
  windowId: string,
  values: { reset?: string; status?: string; utilization?: string },
): ClaudeQuotaWindow {
  const usedPercent = parseClaudeUtilizationPercent(values.utilization);
  const remainingPercent =
    usedPercent === null ? null : clamp(100 - usedPercent, 0, 100);
  const resetAt = parseClaudeResetHeader(values.reset);
  const status = stringValue(values.status).toLowerCase();
  const exhausted =
    status !== "" && status !== "allowed"
      ? true
      : usedPercent !== null && usedPercent >= 100;
  return {
    id: `unified-${windowId}`,
    label: claudeRateLimitLabel(`unified-${windowId}`),
    limit: usedPercent === null ? null : 100,
    remaining: remainingPercent,
    used: usedPercent,
    used_percent: usedPercent,
    remaining_percent: remainingPercent,
    reset_label: formatResetLabel(resetAt),
    reset_at: resetAt?.toISOString() || null,
    exhausted,
  };
}

function parseClaudeUtilizationPercent(value: unknown) {
  const utilization = positiveNumberOrNull(value);
  if (utilization === null) {
    return null;
  }
  return clamp(utilization <= 1 ? utilization * 100 : utilization, 0, 100);
}

function buildClaudeQuotaWindow(
  metric: string,
  values: { limit?: string; remaining?: string; reset?: string },
): ClaudeQuotaWindow {
  const limit = positiveNumberOrNull(values.limit);
  const remaining = positiveNumberOrNull(values.remaining);
  const used =
    limit === null || remaining === null
      ? null
      : clamp(limit - remaining, 0, limit);
  const usedPercent =
    limit && used !== null ? clamp((used / limit) * 100, 0, 100) : null;
  const remainingPercent =
    limit && remaining !== null
      ? clamp((remaining / limit) * 100, 0, 100)
      : null;
  const resetAt = parseClaudeResetHeader(values.reset);
  return {
    id: metric,
    label: claudeRateLimitLabel(metric),
    limit,
    remaining,
    used,
    used_percent: usedPercent,
    remaining_percent: remainingPercent,
    reset_label: formatResetLabel(resetAt),
    reset_at: resetAt?.toISOString() || null,
    exhausted: remaining !== null && remaining <= 0,
  };
}

function withClaudeRetryAfterWindow(
  windows: ClaudeQuotaWindow[],
  probe: ClaudeQuotaProbeResult,
  now: Date,
) {
  if (probe.status !== 429 || windows.some((window) => window.exhausted)) {
    return windows;
  }
  const resetAt = parseClaudeQuotaRetryAt(probe, now);
  return [
    ...windows,
    {
      id: "retry-after",
      label: "上游 429 冷却",
      limit: null,
      remaining: 0,
      used: null,
      used_percent: null,
      remaining_percent: 0,
      reset_label: formatResetLabel(resetAt),
      reset_at: resetAt?.toISOString() || null,
      exhausted: true,
    },
  ];
}

function deriveClaudeQuotaStatus(
  credential: Pick<ClaudeCredentialRecord, "cooldownUntil" | "lastError">,
  windows: ClaudeQuotaReport["windows"],
  now: Date,
  upstreamStatus?: number,
): ClaudeQuotaStatus {
  const cooldownUntil = Date.parse(credential.cooldownUntil || "");
  if (Number.isFinite(cooldownUntil) && cooldownUntil > now.getTime()) {
    return "cooling_down";
  }
  if (upstreamStatus === 429 || windows.some((window) => window.exhausted)) {
    return "exhausted";
  }
  const remainingValues = windows
    .map((window) => window.remaining_percent)
    .filter((value): value is number => typeof value === "number");
  if (remainingValues.length === 0) {
    return credential.lastError ? "error" : "unknown";
  }
  const remaining = Math.min(...remainingValues);
  if (remaining <= 0) {
    return "exhausted";
  }
  if (remaining <= 30) {
    return "low";
  }
  if (remaining <= 70) {
    return "medium";
  }
  if (remaining < 100) {
    return "high";
  }
  return "full";
}

function claudeQuotaMessage(
  probe: ClaudeQuotaProbeResult,
  windows: ClaudeQuotaWindow[],
) {
  const sourceLabel =
    probe.source === "request_log" ? "最近正常对话" : "/v1/messages 探测";
  if (probe.status === 429) {
    return `Claude ${sourceLabel}返回 429，已按真实上游限流/额度耗尽处理；重置时间来自 Retry-After 或 rate-limit 响应头。`;
  }
  if (windows.length > 0) {
    return `Claude 真实额度来自${sourceLabel}的 unified/rate-limit 响应头；本地请求统计仅作为参考。`;
  }
  if (probe.ok) {
    return `Claude ${sourceLabel}成功，但上游未返回可解析的 unified/rate-limit 响应头。`;
  }
  return `Claude ${sourceLabel}返回 HTTP ${probe.status}，且未返回可解析的 unified/rate-limit 响应头。`;
}

function claudeRateLimitLabel(metric: string) {
  const labels: Record<string, string> = {
    "unified-5h": "5h 额度",
    "unified-7d": "7d 额度",
    requests: "请求额度",
    tokens: "总 Token 额度",
    "input-tokens": "输入 Token 额度",
    "output-tokens": "输出 Token 额度",
    "cache-read-input-tokens": "缓存读取额度",
    "cache-creation-input-tokens": "缓存写入额度",
  };
  return labels[metric] || metric.replace(/-/g, " ");
}

function parseClaudeQuotaRetryAt(probe: ClaudeQuotaProbeResult, now: Date) {
  const retryAfter = parseRetryAfterHeader(
    probe.headers.get("retry-after"),
    now,
  );
  if (retryAfter) {
    return retryAfter;
  }
  return parseClaudeQuotaBodyReset(probe.body, now);
}

function parseRetryAfterHeader(value: string | null, now: Date) {
  const raw = stringValue(value);
  if (!raw) {
    return null;
  }
  const numeric = positiveNumberOrNull(raw);
  if (numeric !== null) {
    const date = new Date(now.getTime() + numeric * 1000);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

function parseClaudeQuotaBodyReset(body: unknown, now: Date) {
  const root = objectValue(body);
  const error = objectValue(root?.error);
  const resetAt = positiveNumberOrNull(
    error?.resets_at ?? error?.reset_at ?? root?.resets_at ?? root?.reset_at,
  );
  if (resetAt !== null) {
    const milliseconds = resetAt > 1_000_000_000_000 ? resetAt : resetAt * 1000;
    const date = new Date(milliseconds);
    if (Number.isFinite(date.getTime())) {
      return date;
    }
  }
  const resetAfterSeconds = positiveNumberOrNull(
    error?.resets_in_seconds ??
      error?.reset_after_seconds ??
      root?.resets_in_seconds ??
      root?.reset_after_seconds,
  );
  if (resetAfterSeconds !== null) {
    const date = new Date(now.getTime() + resetAfterSeconds * 1000);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
}

function parseClaudeResetHeader(value: string | undefined) {
  const raw = stringValue(value);
  if (!raw) {
    return null;
  }
  const candidates = [raw, ...raw.split(",").map((item) => item.trim())];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (/^\d+(\.\d+)?$/.test(candidate)) {
      const timestamp = Number(candidate);
      const milliseconds =
        timestamp > 1_000_000_000_000
          ? timestamp
          : timestamp > 1_000_000_000
            ? timestamp * 1000
            : Date.now() + timestamp * 1000;
      const date = new Date(milliseconds);
      if (Number.isFinite(date.getTime())) {
        return date;
      }
      continue;
    }
    const date = new Date(candidate);
    if (Number.isFinite(date.getTime())) {
      return date;
    }
  }
  return null;
}

function formatResetLabel(date: Date | null) {
  if (!date) {
    return "-";
  }
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}`;
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

function sourceClaudeCliUserAgent(sourceHeaders: Headers, fallback: string) {
  const userAgent = sourceHeaders.get("user-agent")?.trim() || "";
  return userAgent.startsWith("claude-cli/") ? userAgent : fallback;
}

function sourceClaudeHeaderOrDefault(
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

function positiveNumberOrNull(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const candidates = [
      trimmed,
      ...trimmed.split(",").map((item) => item.trim()),
    ];
    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      const parsed = Number(candidate);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }
  return null;
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function publicClaudeCredential(
  credential: ClaudeCredentialWithTokens,
): ClaudeCredentialRecord {
  return {
    id: credential.id,
    provider: credential.provider,
    email: credential.email,
    accountId: credential.accountId,
    enabled: credential.enabled,
    priority: credential.priority,
    weight: credential.weight,
    userAgent: credential.userAgent,
    useGlobalProxy: credential.useGlobalProxy,
    proxyPoolId: credential.proxyPoolId,
    proxy: credential.proxy
      ? {
          enabled: credential.proxy.enabled,
          type: credential.proxy.type,
          host: credential.proxy.host,
          port: credential.proxy.port,
          username: credential.proxy.username,
          passwordSet: Boolean(credential.proxy.password),
        }
      : null,
    usageHealth: credentialUsageHealth([credential.id], {
      resetSinceById: credentialUsageHealthResetMap([credential]),
    })[credential.id],
    expiresAt: credential.expiresAt,
    lastRefreshAt: credential.lastRefreshAt,
    lastUsedAt: credential.lastUsedAt,
    cooldownUntil: credential.cooldownUntil,
    lastError: credential.lastError,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
    metadata: credential.metadata,
  };
}

function credentialUsageHealthResetMap(
  credentials: Array<Pick<ClaudeCredentialRecord, "id" | "metadata">>,
) {
  return Object.fromEntries(
    credentials.map((credential) => [
      credential.id,
      stringValue(credential.metadata[USAGE_HEALTH_RESET_METADATA_KEY]) || null,
    ]),
  );
}

function clearClaudeTokenRefreshState(
  credential: ClaudeCredentialWithTokens,
): ClaudeCredentialWithTokens {
  if (
    !hasClaudeTokenRefreshState(credential.metadata) &&
    !isClaudeTokenRefreshError(credential)
  ) {
    return credential;
  }
  const metadata = { ...credential.metadata };
  for (const key of TOKEN_REFRESH_METADATA_KEYS) {
    metadata[key] = undefined;
  }
  const updated = updateClaudeCredential(credential.id, {
    enabled:
      credential.metadata.token_refresh_auto_disabled === true
        ? true
        : credential.enabled,
    lastError: stringValue(credential.lastError).startsWith(
      TOKEN_REFRESH_ERROR_PREFIX,
    )
      ? null
      : credential.lastError,
    metadata,
  });
  return updated || credential;
}

function hasClaudeTokenRefreshState(metadata: Record<string, unknown>) {
  return TOKEN_REFRESH_METADATA_KEYS.some((key) => metadata[key] !== undefined);
}

function isClaudeTokenRefreshError(credential: ClaudeCredentialRecord) {
  return (
    credential.metadata.token_refresh_exhausted === true ||
    stringValue(credential.lastError).startsWith(TOKEN_REFRESH_ERROR_PREFIX)
  );
}

function exportClaudeCredentialJson(credential: ClaudeCredentialWithTokens) {
  return {
    type: "claude",
    id: credential.id,
    email: credential.email,
    account_id: credential.accountId,
    accountId: credential.accountId,
    access_token: credential.tokens.access_token,
    refresh_token: credential.tokens.refresh_token,
    expired: credential.tokens.expired,
    last_refresh: credential.tokens.last_refresh,
    enabled: credential.enabled,
    disabled: !credential.enabled,
    priority: credential.priority,
    weight: credential.weight,
    use_global_proxy: credential.useGlobalProxy,
    useGlobalProxy: credential.useGlobalProxy,
    user_agent: credential.userAgent,
    userAgent: credential.userAgent,
    proxy: credential.proxy,
    metadata: credential.metadata,
    created_at: credential.createdAt,
    updated_at: credential.updatedAt,
  };
}

function takePendingClaudeOAuthState(state: string) {
  prunePendingStates();
  const memoryPending = pendingStates.get(state);
  if (memoryPending) {
    pendingStates.delete(state);
    takeOAuthPendingState(state, "claude");
    if (memoryPending.expiresAt > Date.now()) {
      return memoryPending;
    }
  }
  return takeOAuthPendingState(state, "claude");
}

function prunePendingStates() {
  const now = Date.now();
  for (const [state, pending] of pendingStates) {
    if (pending.expiresAt <= now) {
      pendingStates.delete(state);
    }
  }
}

function generatePkce() {
  const codeVerifier = randomBase64Url(96);
  const codeChallenge = Buffer.from(
    crypto.createHash("sha256").update(codeVerifier).digest(),
  ).toString("base64url");
  return { codeVerifier, codeChallenge };
}

function randomBase64Url(bytes: number) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function generateRandomState() {
  return crypto.randomBytes(16).toString("hex");
}

function stateFromCode(code: string) {
  return code.includes("#") ? code.split("#", 2)[1] || "" : "";
}

function createCredentialId(input: {
  email: string;
  accountId: string;
  tokens: ClaudeTokenBundle;
}) {
  const basis =
    input.email ||
    input.accountId ||
    input.tokens.refresh_token ||
    randomId("seed");
  return `claude_${sha256(basis).slice(0, 24)}`;
}

function selectRoutingItem<T>(
  items: T[],
  getPriority: (item: T) => number,
  getWeight: (item: T) => number,
  getHealthScore: (item: T) => number,
) {
  const candidates = items.map((item) => ({
    item,
    priority: getPriority(item),
    weight: getWeight(item),
    healthScore: getHealthScore(item),
  }));
  const healthTiers = [80, 50, 1];
  for (const tier of healthTiers) {
    const tierCandidates = candidates.filter(
      (candidate) => candidate.healthScore >= tier,
    );
    if (tierCandidates.length > 0) {
      return weightedPickHighestPriority(tierCandidates).item;
    }
  }
  return weightedPickHighestPriority(candidates).item;
}

function weightedPickHighestPriority<T>(
  candidates: Array<{
    item: T;
    priority: number;
    weight: number;
    healthScore: number;
  }>,
) {
  const maxPriority = Math.max(
    ...candidates.map((candidate) => candidate.priority),
  );
  const priorityCandidates = candidates.filter(
    (candidate) => candidate.priority === maxPriority,
  );
  const totalWeight = priorityCandidates.reduce(
    (sum, candidate) =>
      sum + Math.max(1, candidate.weight) * Math.max(1, candidate.healthScore),
    0,
  );
  let cursor = Math.random() * totalWeight;
  for (const candidate of priorityCandidates) {
    cursor -=
      Math.max(1, candidate.weight) * Math.max(1, candidate.healthScore);
    if (cursor <= 0) {
      return candidate;
    }
  }
  return priorityCandidates[0];
}

function isCredentialScopedFailure(statusCode: number | null) {
  return statusCode === 401 || statusCode === 403 || statusCode === 429;
}

function unusedUsageHealth(windowSize: number) {
  return {
    status: "unused" as const,
    score: 100,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    lastUsedAt: null,
    lastStatusCode: null,
    lastErrorCode: null,
    windowSize,
  };
}

function modelMatchesAllowlist(
  model: string,
  baseModel: string,
  allowlist: string[],
) {
  const candidates = claudeModelAllowlistCandidates(model);
  if (baseModel) {
    candidates.push(baseModel);
  }
  const uniqueCandidates = new Set(candidates);
  return allowlist.some((allowed) =>
    uniqueCandidates.has(cleanString(allowed)),
  );
}

function normalizeProxyPoolId(input: unknown) {
  const id = stringValue(input).trim();
  return id || null;
}

function normalizeCredentialProxyPatch(
  input: unknown,
  existingProxy: CredentialProxyConfig | null,
): CredentialProxyConfig | null {
  if (input === null || input === false) {
    return null;
  }
  if (typeof input === "string") {
    return parseProxyUrl(input, existingProxy?.enabled ?? true);
  }
  const object = objectValue(input);
  if (!object) {
    throw new HttpError(
      400,
      "invalid_credential_proxy",
      "Credential proxy must be a SOCKS5 URL, object, or null",
    );
  }
  const url = stringValue(object.url);
  if (url) {
    const parsed = parseProxyUrl(url, existingProxy?.enabled ?? true);
    return {
      ...parsed,
      enabled:
        object.enabled !== undefined ? Boolean(object.enabled) : parsed.enabled,
    };
  }
  const type = normalizeProxyType(
    object.type,
    existingProxy?.type || "socks5h",
  );
  const host = stringValue(object.host) || existingProxy?.host || "";
  const port = normalizePort(object.port ?? existingProxy?.port);
  const username =
    object.username !== undefined
      ? stringValue(object.username)
      : existingProxy?.username || "";
  const password =
    object.password !== undefined
      ? stringValue(object.password)
      : existingProxy?.password || "";
  const enabled =
    object.enabled !== undefined
      ? Boolean(object.enabled)
      : (existingProxy?.enabled ?? true);
  assertProxyEndpoint({ type, host, port });
  return { enabled, type, host, port, username, password };
}

function parseProxyUrl(input: string, enabled: boolean): CredentialProxyConfig {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new HttpError(
      400,
      "invalid_credential_proxy_url",
      "Invalid proxy URL",
    );
  }
  const type = normalizeProxyType(parsed.protocol.replace(/:$/, ""), "socks5h");
  const host = parsed.hostname;
  const port = normalizePort(parsed.port);
  const username = decodeURIComponent(parsed.username || "");
  const password = decodeURIComponent(parsed.password || "");
  assertProxyEndpoint({ type, host, port });
  return { enabled, type, host, port, username, password };
}

function normalizeProxyType(
  value: unknown,
  fallback: CredentialProxyType,
): CredentialProxyType {
  const type = stringValue(value).toLowerCase();
  if (type === "socks5" || type === "socks5h") {
    return type;
  }
  if (!type) {
    return fallback;
  }
  throw new HttpError(
    400,
    "unsupported_credential_proxy_type",
    "Credential proxy type must be socks5 or socks5h",
  );
}

function normalizePort(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new HttpError(
      400,
      "invalid_credential_proxy_port",
      "Credential proxy port must be an integer between 1 and 65535",
    );
  }
  return parsed;
}

function assertProxyEndpoint(input: {
  type: CredentialProxyType;
  host: string;
  port: number;
}) {
  if (!input.host) {
    throw new HttpError(
      400,
      "invalid_credential_proxy_host",
      "Credential proxy host is required",
    );
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new HttpError(
      400,
      "invalid_credential_proxy_port",
      "Credential proxy port must be an integer between 1 and 65535",
    );
  }
}

function claudeCredentialLogMetadata(credential: ClaudeCredentialWithTokens) {
  return {
    credentialId: credential.id,
    email: credential.email,
    accountId: credential.accountId,
    useGlobalProxy: credential.useGlobalProxy,
    proxy: credential.proxy?.enabled
      ? {
          type: credential.proxy.type,
          host: credential.proxy.host,
          port: credential.proxy.port,
        }
      : null,
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseMaybeJson<T>(text: string) {
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function shouldUpgradeClaudeUserAgent(current: string, baseline: string) {
  const currentVersion = parseClaudeCliVersion(current);
  const baselineVersion = parseClaudeCliVersion(baseline);
  if (!currentVersion || !baselineVersion) {
    return false;
  }
  for (let index = 0; index < baselineVersion.length; index += 1) {
    if (currentVersion[index] !== baselineVersion[index]) {
      return currentVersion[index] < baselineVersion[index];
    }
  }
  return false;
}

function parseClaudeCliVersion(userAgent: string) {
  const match = userAgent.trim().match(/^claude-cli\/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
