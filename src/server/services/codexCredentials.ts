import "server-only";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { serverConfig } from "@/src/server/config/env";
import { HttpError, logServerError } from "@/src/server/http/errors";
import { proxiedFetch } from "@/src/server/net/proxy";
import {
  deleteCodexCredential,
  getCodexCredentialWithTokens,
  listCodexCredentials,
  listCodexCredentialsWithTokens,
  updateCodexCredential,
  upsertCodexCredential,
} from "@/src/server/repositories/codexCredentials";
import { credentialUsageHealth } from "@/src/server/repositories/logs";
import { detachCredentialFromChannels } from "@/src/server/repositories/channels";
import { getProxyPoolItemById } from "@/src/server/repositories/proxyPool";
import {
  saveOAuthPendingState,
  takeOAuthPendingState,
} from "@/src/server/repositories/oauthPendingStates";
import { randomId, sha256 } from "@/src/server/services/crypto";
import { getGlobalProxySetting } from "@/src/server/services/settings";
import { getProxyPoolCredentialProxy } from "@/src/server/services/proxyPool";
import type {
  CodexCredentialRecord,
  CodexCredentialWithTokens,
  CodexTokenBundle,
  CodexUpstreamTransport,
  CredentialProxyConfig,
  CredentialProxyType,
} from "@/src/shared/types/entities";

const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_SCOPE = "openid email profile offline_access";

interface PendingOAuthState {
  codeVerifier: string;
  codeChallenge: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}

const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
const pendingStates = new Map<string, PendingOAuthState>();
let legacyImportAttempted = false;

export function startOAuthLoginSession() {
  const state = generateRandomState();
  const { codeVerifier, codeChallenge } = generatePkce();
  const redirectUri = serverConfig.codexRedirectUri;
  const createdAt = Date.now();
  const expiresAt = createdAt + OAUTH_STATE_TTL_MS;
  pendingStates.set(state, {
    codeVerifier,
    codeChallenge,
    redirectUri,
    createdAt,
    expiresAt,
  });
  // Persist pending PKCE state because Next route handlers may run in a
  // different worker/module instance between URL generation and callback paste.
  saveOAuthPendingState({
    state,
    provider: "codex",
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
  redirectUri?: string;
}) {
  // Keep this parameter set and encoding aligned with CLIProxyAPI's
  // internal/auth/codex/openai_auth.go GenerateAuthURL implementation.
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: input.redirectUri || serverConfig.codexRedirectUri,
    scope: OAUTH_SCOPE,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    prompt: "login",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function finishOAuthCallback(searchParams: URLSearchParams) {
  const error =
    searchParams.get("error") || searchParams.get("error_description");
  if (error) {
    throw new HttpError(400, "codex_oauth_error", error);
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  if (!code || !state) {
    throw new HttpError(
      400,
      "invalid_oauth_callback",
      "OAuth callback must include code and state",
    );
  }
  const pending = takePendingOAuthState(state);
  if (!pending) {
    throw new HttpError(
      400,
      "expired_oauth_state",
      "Unknown or expired OAuth state. Start OAuth again.",
    );
  }
  return exchangeCodeForTokens({
    code,
    codeVerifier: pending.codeVerifier,
    redirectUri: pending.redirectUri,
  });
}

export function parseOAuthCallbackInput(input: unknown) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) {
    throw new HttpError(
      400,
      "missing_callback_url",
      "Paste the localhost callback URL or query string returned by Codex OAuth",
    );
  }

  // Match CLIProxyAPI's misc.ParseOAuthCallback tolerance: accept full URLs,
  // ?query strings, host/path snippets, and raw code=...&state=... pairs.
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

export async function listPublicCodexCredentials() {
  await importLegacyCredentialsOnce();
  const credentials = listCodexCredentials();
  const healthByCredentialId = credentialUsageHealth(
    credentials.map((credential) => credential.id),
  );
  return credentials.map((credential) => ({
    ...credential,
    usageHealth: healthByCredentialId[credential.id],
  }));
}

export function patchCodexCredentialRouting(
  id: string,
  input: {
    enabled?: boolean;
    priority?: number;
    weight?: number;
    fastEnabled?: boolean;
    upstreamTransport?: CodexUpstreamTransport;
    useGlobalProxy?: boolean;
    proxyPoolId?: string | null;
    proxy?: unknown;
  },
) {
  const existing = getCodexCredentialWithTokens(id);
  if (!existing) {
    throw new HttpError(
      404,
      "codex_credential_not_found",
      "Codex credential not found",
    );
  }
  const fastEnabled =
    input.fastEnabled !== undefined ? Boolean(input.fastEnabled) : undefined;
  if (fastEnabled && !isFastServiceTierPlan(existing.planType)) {
    throw new HttpError(
      400,
      "fast_service_tier_not_available",
      "Fast service tier is only available for Pro / Pro 20x credentials",
    );
  }
  const upstreamTransport = Object.hasOwn(input, "upstreamTransport")
    ? normalizeCodexUpstreamTransport(input.upstreamTransport)
    : undefined;
  const proxyPatch = Object.hasOwn(input, "proxy")
    ? { proxy: normalizeCredentialProxyPatch(input.proxy, existing.proxy) }
    : {};
  const proxyPoolPatch = Object.hasOwn(input, "proxyPoolId")
    ? { proxyPoolId: normalizeProxyPoolId(input.proxyPoolId) }
    : {};
  const updated = updateCodexCredential(id, {
    ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
    ...(input.priority !== undefined
      ? { priority: normalizeInteger(input.priority, 100) }
      : {}),
    ...(input.weight !== undefined
      ? { weight: Math.max(1, normalizeInteger(input.weight, 1)) }
      : {}),
    ...(fastEnabled !== undefined ? { fastEnabled } : {}),
    ...(upstreamTransport !== undefined ? { upstreamTransport } : {}),
    ...(input.useGlobalProxy !== undefined
      ? { useGlobalProxy: Boolean(input.useGlobalProxy) }
      : {}),
    ...proxyPoolPatch,
    ...proxyPatch,
  });
  if (!updated) {
    throw new HttpError(
      404,
      "codex_credential_not_found",
      "Codex credential not found",
    );
  }
  return publicCredential(updated);
}

export function resolveCredentialProxy(input: {
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

export async function removeCodexCredential(id: string) {
  detachCredentialFromChannels(id);
  if (!deleteCodexCredential(id)) {
    throw new HttpError(
      404,
      "codex_credential_not_found",
      "Codex credential not found",
    );
  }
}

export async function refreshCodexCredential(id: string) {
  // Admin callers receive only public credential metadata; token plaintext stays server-side.
  return publicCredential(await refreshCodexCredentialWithTokens(id));
}

export async function exportCodexCredentials() {
  await importLegacyCredentialsOnce();
  return {
    type: "relayapi_codex_credentials_export",
    version: 1,
    exported_at: new Date().toISOString(),
    credentials: listCodexCredentialsWithTokens().map(
      exportCodexCredentialJson,
    ),
  };
}

export async function exportCodexCredential(id: string) {
  await importLegacyCredentialsOnce();
  const credential = getCodexCredentialWithTokens(id);
  if (!credential) {
    throw new HttpError(
      404,
      "codex_credential_not_found",
      "Codex credential not found",
    );
  }
  return exportCodexCredentialJson(credential);
}

export function importCodexCredentialFromJson(
  input: unknown,
  options: { filename?: string } = {},
) {
  const raw = objectValue(input);
  if (!raw) {
    throw new HttpError(
      400,
      "invalid_codex_credential_json",
      "Uploaded Codex credential must be a JSON object",
    );
  }

  const { parsed, sourceFormat } = normalizeImportedCodexCredential(raw);
  const type = stringValue(parsed.type);

  const tokens: CodexTokenBundle = {
    access_token: stringValue(parsed.access_token),
    refresh_token: stringValue(parsed.refresh_token),
    id_token: stringValue(parsed.id_token),
    expired: stringValue(parsed.expired || parsed.expire),
    last_refresh: stringValue(parsed.last_refresh),
  };
  if (!tokens.refresh_token && !tokens.access_token) {
    throw new HttpError(
      400,
      "missing_codex_tokens",
      "Uploaded Codex credential must include access_token or refresh_token",
    );
  }

  const accessClaims = decodeJwtPayload(tokens.access_token);
  const idClaims = decodeJwtPayload(tokens.id_token);
  const accessAuth = objectValue(accessClaims?.["https://api.openai.com/auth"]);
  const idAuth = objectValue(idClaims?.["https://api.openai.com/auth"]);
  const profile = objectValue(accessClaims?.["https://api.openai.com/profile"]);
  const auth = idAuth || accessAuth;
  const email =
    stringValue(parsed.email) ||
    stringValue(idClaims?.email) ||
    stringValue(profile?.email);
  const accountId =
    stringValue(parsed.account_id) ||
    stringValue(parsed.accountId) ||
    stringValue(auth?.chatgpt_account_id) ||
    stringValue(auth?.chatgpt_user_id);
  const planType =
    stringValue(parsed.plan_type) ||
    stringValue(parsed.planType) ||
    stringValue(auth?.chatgpt_plan_type) ||
    planTypeFromImportedType(type) ||
    planTypeFromCredentialName(stringValue(parsed.name));
  const id =
    stringValue(parsed.id) || createCredentialId({ email, accountId, tokens });

  const proxy = Object.hasOwn(parsed, "proxy")
    ? normalizeCredentialProxyPatch(parsed.proxy, null)
    : undefined;
  const enabled = booleanValue(parsed.enabled);
  const disabled = booleanValue(parsed.disabled);
  const fastEnabled = booleanValue(parsed.fast_enabled ?? parsed.fastEnabled);
  const upstreamTransport =
    parsed.upstream_transport ?? parsed.upstreamTransport;
  const useGlobalProxy = booleanValue(
    parsed.use_global_proxy ?? parsed.useGlobalProxy,
  );
  const metadata = objectValue(parsed.metadata);

  const saved = upsertCodexCredential({
    id,
    email,
    accountId,
    planType,
    tokens,
    proxy,
    ...(enabled !== undefined
      ? { enabled }
      : disabled !== undefined
        ? { enabled: !disabled }
        : {}),
    ...(parsed.priority !== undefined
      ? { priority: normalizeInteger(parsed.priority, 100) }
      : {}),
    ...(parsed.weight !== undefined
      ? { weight: Math.max(1, normalizeInteger(parsed.weight, 1)) }
      : {}),
    metadata: {
      ...(metadata || {}),
      imported_from: "web_upload",
      import_format: sourceFormat,
      import_filename: options.filename,
      imported_at: new Date().toISOString(),
      source_disabled: parsed.disabled,
      ...(fastEnabled !== undefined ? { fast_service_tier: fastEnabled } : {}),
      ...(upstreamTransport !== undefined
        ? {
            upstream_transport:
              normalizeCodexUpstreamTransport(upstreamTransport),
          }
        : {}),
      ...(useGlobalProxy !== undefined
        ? { use_global_proxy: useGlobalProxy }
        : {}),
    },
  });
  if (!saved) {
    throw new Error("Failed to import Codex credential");
  }
  return publicCredential(saved);
}

async function refreshCodexCredentialWithTokens(id: string) {
  const credential = getCodexCredentialWithTokens(id);
  if (!credential) {
    throw new HttpError(
      404,
      "codex_credential_not_found",
      "Codex credential not found",
    );
  }
  if (!credential.tokens.refresh_token) {
    throw new HttpError(
      400,
      "missing_refresh_token",
      "Saved Codex credential does not contain a refresh token",
    );
  }
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: credential.tokens.refresh_token,
    scope: "openid profile email",
  });
  try {
    const tokenResponse = await tokenRequest(
      body,
      credential.proxy,
      credential.proxyPoolId,
      credential.useGlobalProxy,
    );
    return await saveTokenResponse(tokenResponse, credential);
  } catch (error) {
    logServerError(error, {
      operation: "codex.refresh_token",
      metadata: codexCredentialLogMetadata(credential),
    });
    throw error;
  }
}

export async function ensureFreshCredential(id: string) {
  if (!id) {
    throw new HttpError(
      503,
      "missing_channel_credential",
      "Selected channel has no bound Codex credential",
    );
  }
  const credential = getCodexCredentialWithTokens(id);
  if (!credential) {
    throw new HttpError(
      503,
      "codex_credential_not_found",
      "Selected channel credential was not found",
    );
  }
  const expiresAt = Date.parse(
    credential.expiresAt || credential.tokens.expired || "",
  );
  if (!Number.isFinite(expiresAt)) {
    return credential;
  }
  const refreshLeadMs = 5 * 60 * 1000;
  if (expiresAt - Date.now() > refreshLeadMs) {
    return credential;
  }
  return refreshCodexCredentialWithTokens(id);
}

async function exchangeCodeForTokens(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  try {
    // OAuth route responses also get public metadata only.
    return publicCredential(
      await saveTokenResponse(await tokenRequest(body, null, null, true), null),
    );
  } catch (error) {
    logServerError(error, {
      operation: "codex.oauth.exchange_token",
      metadata: {
        redirectUri: input.redirectUri,
        useGlobalProxyFallback: true,
      },
    });
    throw error;
  }
}

async function tokenRequest(
  body: URLSearchParams,
  proxy: CredentialProxyConfig | null,
  proxyPoolId: string | null,
  useGlobalProxyFallback: boolean,
) {
  const response = await proxiedFetch(
    TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(serverConfig.requestTimeoutMs),
    },
    resolveCredentialProxy({
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
      "codex_token_request_failed",
      `Token request failed with HTTP ${response.status}`,
      {
        upstreamStatus: response.status,
        upstreamStatusText: response.statusText,
        upstreamBody: parsed,
      },
    );
  }
  return parsed;
}

async function saveTokenResponse(
  tokenResponse: Record<string, unknown>,
  previous: CodexCredentialWithTokens | null,
) {
  const claims = decodeJwtPayload(
    stringValue(tokenResponse.id_token) || previous?.tokens.id_token || "",
  );
  const codexAuth = objectValue(claims?.["https://api.openai.com/auth"]);
  const now = new Date();
  const expiresIn = numberValue(tokenResponse.expires_in) || 3600;
  const tokens: CodexTokenBundle = {
    access_token:
      stringValue(tokenResponse.access_token) ||
      previous?.tokens.access_token ||
      "",
    refresh_token:
      stringValue(tokenResponse.refresh_token) ||
      previous?.tokens.refresh_token ||
      "",
    id_token:
      stringValue(tokenResponse.id_token) || previous?.tokens.id_token || "",
    expired: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    last_refresh: now.toISOString(),
  };
  const email = stringValue(claims?.email) || previous?.email || "";
  const accountId =
    stringValue(codexAuth?.chatgpt_account_id) || previous?.accountId || "";
  const planType =
    stringValue(codexAuth?.chatgpt_plan_type) || previous?.planType || "";
  const id = previous?.id || createCredentialId({ email, accountId, tokens });
  const saved = upsertCodexCredential({
    id,
    email,
    accountId,
    planType,
    tokens,
    metadata: { imported_from: previous?.metadata?.imported_from || undefined },
  });
  if (!saved) {
    throw new Error("Failed to save Codex credential");
  }
  return saved;
}

async function importLegacyCredentialsOnce() {
  if (legacyImportAttempted || !serverConfig.autoImportLegacyCredentials) {
    return;
  }
  legacyImportAttempted = true;
  for (const dir of serverConfig.legacyCredentialDirs) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
        continue;
      }
      const filePath = path.join(dir, entry.name);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
          string,
          unknown
        >;
        if (parsed.type !== "codex") {
          continue;
        }
        const tokens: CodexTokenBundle = {
          access_token: stringValue(parsed.access_token),
          refresh_token: stringValue(parsed.refresh_token),
          id_token: stringValue(parsed.id_token),
          expired: stringValue(parsed.expired || parsed.expire),
          last_refresh: stringValue(parsed.last_refresh),
        };
        if (!tokens.refresh_token && !tokens.access_token) {
          continue;
        }
        const id =
          stringValue(parsed.id) ||
          createCredentialId({
            email: stringValue(parsed.email),
            accountId: stringValue(parsed.account_id),
            tokens,
          });
        if (getCodexCredentialWithTokens(id)) {
          continue;
        }
        const saved = upsertCodexCredential({
          id,
          email: stringValue(parsed.email),
          accountId: stringValue(parsed.account_id),
          planType: stringValue(parsed.plan_type),
          tokens,
          metadata: { imported_from: filePath },
        });
        void saved;
      } catch {
        // Ignore malformed legacy credential files. They are never returned to UI.
      }
    }
  }
}

function exportCodexCredentialJson(credential: CodexCredentialWithTokens) {
  return {
    type: "codex",
    id: credential.id,
    email: credential.email,
    account_id: credential.accountId,
    accountId: credential.accountId,
    plan_type: credential.planType,
    planType: credential.planType,
    access_token: credential.tokens.access_token,
    refresh_token: credential.tokens.refresh_token,
    id_token: credential.tokens.id_token,
    expired: credential.tokens.expired,
    last_refresh: credential.tokens.last_refresh,
    enabled: credential.enabled,
    disabled: !credential.enabled,
    priority: credential.priority,
    weight: credential.weight,
    fast_enabled: credential.fastEnabled,
    fastEnabled: credential.fastEnabled,
    upstream_transport: credential.upstreamTransport,
    upstreamTransport: credential.upstreamTransport,
    use_global_proxy: credential.useGlobalProxy,
    useGlobalProxy: credential.useGlobalProxy,
    proxy: credential.proxy,
    metadata: credential.metadata,
    created_at: credential.createdAt,
    updated_at: credential.updatedAt,
  };
}

function publicCredential(
  credential: CodexCredentialWithTokens,
): CodexCredentialRecord {
  return {
    id: credential.id,
    provider: credential.provider,
    email: credential.email,
    accountId: credential.accountId,
    planType: credential.planType,
    enabled: credential.enabled,
    priority: credential.priority,
    weight: credential.weight,
    fastEnabled: credential.fastEnabled,
    upstreamTransport: credential.upstreamTransport,
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
    usageHealth: credentialUsageHealth([credential.id])[credential.id],
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

function codexCredentialLogMetadata(credential: CodexCredentialWithTokens) {
  return {
    credentialId: credential.id,
    email: credential.email,
    accountId: credential.accountId,
    planType: credential.planType,
    upstreamTransport: credential.upstreamTransport,
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
  // CLIProxyAPI uses 16 random bytes encoded as hex for OAuth state.
  return crypto.randomBytes(16).toString("hex");
}

function takePendingOAuthState(state: string) {
  prunePendingStates();
  const memoryPending = pendingStates.get(state);
  if (memoryPending) {
    pendingStates.delete(state);
    // Also consume the persisted row so a pasted callback cannot be replayed.
    takeOAuthPendingState(state, "codex");
    if (memoryPending.expiresAt > Date.now()) {
      return memoryPending;
    }
  }
  return takeOAuthPendingState(state, "codex");
}

function prunePendingStates() {
  const now = Date.now();
  for (const [state, pending] of pendingStates) {
    if (pending.expiresAt <= now) {
      pendingStates.delete(state);
    }
  }
}

function createCredentialId(input: {
  email: string;
  accountId: string;
  tokens: CodexTokenBundle;
}) {
  const basis =
    input.email ||
    input.accountId ||
    input.tokens.refresh_token ||
    randomId("seed");
  return `codex_${sha256(basis).slice(0, 24)}`;
}

function decodeJwtPayload(token: string) {
  if (!token) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    return JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown> | null;
  } catch {
    return null;
  }
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

function booleanValue(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on", "enabled"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off", "disabled"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
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

function normalizeImportedCodexCredential(input: Record<string, unknown>) {
  const sub2apiCredentials = objectValue(input.credentials);
  if (sub2apiCredentials) {
    return {
      sourceFormat: "sub2api",
      parsed: {
        ...input,
        ...sub2apiCredentials,
        type:
          planTypeFromCredentialName(stringValue(input.name)) ||
          stringValue(sub2apiCredentials.plan_type) ||
          stringValue(input.plan_type) ||
          "codex",
        account_id:
          sub2apiCredentials.chatgpt_account_id ||
          sub2apiCredentials.account_id ||
          sub2apiCredentials.chatgpt_user_id,
        accountId:
          sub2apiCredentials.chatgpt_account_id ||
          sub2apiCredentials.accountId ||
          sub2apiCredentials.chatgpt_user_id,
        expired:
          isoStringFromUnixSeconds(sub2apiCredentials.expires_at) ||
          stringValue(sub2apiCredentials.expired),
        last_refresh:
          stringValue(sub2apiCredentials.last_refresh) ||
          stringValue(input.updated_at),
        disabled:
          input.enabled !== undefined
            ? !Boolean(input.enabled)
            : input.disabled,
        metadata: {
          ...(objectValue(input.metadata) || {}),
          sub2api_name: stringValue(input.name),
          sub2api_platform: stringValue(input.platform),
          sub2api_organization_id: stringValue(
            sub2apiCredentials.organization_id,
          ),
        },
      },
    };
  }

  const type = stringValue(input.type);
  return {
    sourceFormat: type === "codex" ? "relayapi" : "cpa",
    parsed: input,
  };
}

function isoStringFromUnixSeconds(value: unknown) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  return new Date(seconds * 1000).toISOString();
}

function planTypeFromImportedType(type: string) {
  const normalized = type.trim().toLowerCase();
  if (
    ["free", "plus", "pro", "team", "enterprise", "codex"].includes(normalized)
  ) {
    return normalized;
  }
  return "";
}

function planTypeFromCredentialName(name: string) {
  const firstPart = name.split("-", 1)[0]?.trim().toLowerCase() || "";
  return planTypeFromImportedType(firstPart);
}

function normalizeCodexUpstreamTransport(
  value: unknown,
): CodexUpstreamTransport {
  const normalized = stringValue(value)
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (normalized === "websocket" || normalized === "ws") {
    return "websocket";
  }
  if (normalized === "http" || normalized === "https") {
    return "http";
  }
  throw new HttpError(
    400,
    "unsupported_codex_upstream_transport",
    "Codex upstream transport must be http or websocket",
  );
}

function normalizeProxyPoolId(input: unknown) {
  const id = stringValue(input).trim();
  if (!id) {
    return null;
  }
  if (!getProxyPoolItemById(id)) {
    throw new HttpError(
      400,
      "proxy_pool_not_found",
      "Selected proxy pool item does not exist",
    );
  }
  return id;
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
  return {
    enabled,
    type,
    host,
    port,
    username,
    password,
  };
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
  return {
    enabled,
    type,
    host,
    port,
    username,
    password,
  };
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
    "Only socks5 and socks5h credential proxies are supported",
  );
}

function normalizePort(value: unknown) {
  const port =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value || ""), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(
      400,
      "invalid_credential_proxy_port",
      "Credential proxy port must be between 1 and 65535",
    );
  }
  return port;
}

function assertProxyEndpoint(input: {
  type: CredentialProxyType;
  host: string;
  port: number;
}) {
  if (!input.host.trim()) {
    throw new HttpError(
      400,
      "missing_credential_proxy_host",
      "Credential proxy host is required",
    );
  }
}

function isFastServiceTierPlan(planType: string) {
  const normalized = planType
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  return (
    normalized === "pro" || normalized === "pro20" || normalized === "pro20x"
  );
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
