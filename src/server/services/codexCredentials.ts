import "server-only";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { serverConfig } from "@/src/server/config/env";
import { HttpError } from "@/src/server/http/errors";
import {
  deleteCodexCredential,
  getCodexCredentialWithTokens,
  listCodexCredentials,
  upsertCodexCredential,
} from "@/src/server/repositories/codexCredentials";
import { credentialUsageHealth } from "@/src/server/repositories/logs";
import {
  getChannelByCredentialId,
  insertChannel,
} from "@/src/server/repositories/channels";
import {
  saveOAuthPendingState,
  takeOAuthPendingState,
} from "@/src/server/repositories/oauthPendingStates";
import { randomId, sha256 } from "@/src/server/services/crypto";
import type {
  CodexCredentialRecord,
  CodexCredentialWithTokens,
  CodexTokenBundle,
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

export async function removeCodexCredential(id: string) {
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
  const tokenResponse = await tokenRequest(body);
  return saveTokenResponse(tokenResponse, credential);
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
  // OAuth route responses also get public metadata only.
  return publicCredential(
    await saveTokenResponse(await tokenRequest(body), null),
  );
}

async function tokenRequest(body: URLSearchParams) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(serverConfig.requestTimeoutMs),
  });
  const text = await response.text();
  const parsed = parseMaybeJson<Record<string, unknown>>(text) || { raw: text };
  if (!response.ok) {
    throw new HttpError(
      response.status,
      "codex_token_request_failed",
      `Token request failed with HTTP ${response.status}`,
      parsed,
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
  ensureDefaultChannel(saved);
  return saved;
}

function ensureDefaultChannel(credential: CodexCredentialRecord) {
  if (getChannelByCredentialId(credential.id)) {
    return;
  }
  insertChannel({
    id: randomId("ch"),
    name: credential.email
      ? `Codex · ${credential.email}`
      : `Codex · ${credential.accountId || credential.id}`,
    baseUrl: serverConfig.codexBaseUrl,
    credentialId: credential.id,
    enabled: true,
    priority: 100,
    weight: 1,
    modelAllowlist: [],
    status: "healthy",
  });
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
        if (saved) {
          ensureDefaultChannel(saved);
        }
      } catch {
        // Ignore malformed legacy credential files. They are never returned to UI.
      }
    }
  }
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
    usageHealth: credentialUsageHealth([credential.id])[credential.id],
    expiresAt: credential.expiresAt,
    lastRefreshAt: credential.lastRefreshAt,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
    metadata: credential.metadata,
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

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
