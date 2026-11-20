import "server-only";

import { serverConfig } from "@/src/server/config/env";
import { ANTIGRAVITY_DEFAULT_CLIENT_ID, ANTIGRAVITY_DEFAULT_CLIENT_SECRET } from "@/src/server/antigravity/oauthClient";
import {
  ANTIGRAVITY_BASE_URL,
  ANTIGRAVITY_GOOG_API_CLIENT,
  ANTIGRAVITY_ONBOARD_USER_AGENT,
  ANTIGRAVITY_TOKEN_USER_AGENT,
  ANTIGRAVITY_USER_AGENT,
  ANTIGRAVITY_VERSION,
  antigravityObject as object,
  antigravityString as string,
} from "@/src/server/antigravity/protocol";
import { HttpError } from "@/src/server/http/errors";
import { detachCredentialFromChannels } from "@/src/server/repositories/channels";
import { credentialUsageHealth } from "@/src/server/repositories/logs";
import {
  deleteAntigravityCredential,
  getAntigravityCredential,
  getAntigravityCredentialWithTokens,
  listAntigravityCredentials,
  updateAntigravityCredentialSettings,
  replaceAntigravityModels,
  replaceAntigravityTokens,
  saveAntigravityCredential,
  suspendAntigravityCredential,
} from "@/src/server/repositories/antigravityCredentials";
import { saveOAuthPendingState, takeOAuthPendingState } from "@/src/server/repositories/oauthPendingStates";
import { base64Url } from "@/src/server/services/crypto";
import type {
  AntigravityCredentialRecord,
  AntigravityCredentialWithTokens,
  AntigravityQuotaBucket,
  AntigravityQuotaGroup,
  AntigravityQuotaReport,
  AntigravityTokenBundle,
} from "@/src/shared/types/entities";

const REFRESH_LEAD_MS = 5 * 60 * 1000;
const CREDITS_HINT_TTL_MS = 10 * 60 * 1000;
const ONBOARD_ATTEMPTS = 5;
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo?alt=json";
const DEFAULT_REDIRECT_URI = "http://localhost:51121/oauth-callback";
const DEFAULT_SCOPE = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ");

type Step = "token" | "identity" | "project" | "onboard" | "models" | "quota";
type CreditsHint = { available: boolean; updatedAt: number };

const refreshes = new Map<string, Promise<AntigravityCredentialWithTokens>>();
const creditsHints = new Map<string, CreditsHint>();

function oauthClient() {
  return {
    clientId: process.env.RELAY_ANTIGRAVITY_OAUTH_CLIENT_ID?.trim() || ANTIGRAVITY_DEFAULT_CLIENT_ID,
    clientSecret: process.env.RELAY_ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() || ANTIGRAVITY_DEFAULT_CLIENT_SECRET,
  };
}

export function startAntigravityOAuthLoginSession() {
  const { clientId } = oauthClient();
  const redirectUri = process.env.RELAY_ANTIGRAVITY_OAUTH_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI;
  const state = base64Url();
  const now = Date.now();
  // The Antigravity desktop client does not use PKCE; the verifier columns stay empty.
  saveOAuthPendingState({
    state,
    provider: "antigravity",
    codeVerifier: "",
    codeChallenge: "",
    redirectUri,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
  });
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: clientId,
    prompt: "consent",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: process.env.RELAY_ANTIGRAVITY_OAUTH_SCOPE?.trim() || DEFAULT_SCOPE,
    state,
  });
  return { state, redirectUri, authUrl: AUTH_URL + "?" + params };
}

export async function finishAntigravityOAuthCallback(input: unknown) {
  const raw = string(input).trim();
  let params: URLSearchParams;
  try {
    params = raw.includes("://") ? new URL(raw).searchParams : new URLSearchParams(raw);
  } catch {
    throw new HttpError(400, "invalid_antigravity_callback", "Invalid Antigravity callback URL");
  }
  const state = params.get("state") || "";
  const code = params.get("code") || "";
  if (!state || params.get("error") || !code) {
    throw new HttpError(400, "invalid_antigravity_callback", "Google did not return an authorization code and state");
  }
  const pending = takeOAuthPendingState(state, "antigravity");
  if (!pending) throw new HttpError(400, "invalid_oauth_state", "Antigravity authorization has expired or was already used");
  const tokens = await exchangeToken({
    code,
    grant_type: "authorization_code",
    redirect_uri: pending.redirectUri,
  });
  const token = tokens.access_token;
  const [user, loaded] = await Promise.all([
    googleJson(USERINFO_URL, { headers: { Authorization: "Bearer " + token, "User-Agent": ANTIGRAVITY_USER_AGENT } }, "identity"),
    loadCodeAssist(token),
  ]);
  const email = string(user.email).trim();
  const accountId = string(user.id).trim();
  if (!accountId || !email) throw new HttpError(502, "antigravity_identity_missing", "Google did not return an account identity");
  // Accounts without a project are provisioned with onboardUser, as in CPA.
  const projectId = companionProject(loaded) || await onboardUser(token, defaultTierId(loaded));
  if (!projectId) throw new HttpError(403, "antigravity_project_missing", "No Antigravity project is associated with this account");
  const saved = saveAntigravityCredential({ accountId, email, projectId, tokens });
  observeCredits(saved.id, loaded);
  await refreshModelCatalog(saved.id, token, projectId);
  return publicCredential(getAntigravityCredential(saved.id) ?? saved);
}

function loadCodeAssist(token: string) {
  return googleJson(ANTIGRAVITY_BASE_URL + "/v1internal:loadCodeAssist", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "User-Agent": ANTIGRAVITY_USER_AGENT },
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
  }, "project");
}

async function onboardUser(token: string, tierId: string) {
  const body = JSON.stringify({
    tier_id: tierId,
    metadata: { ide_type: "ANTIGRAVITY", ide_version: ANTIGRAVITY_VERSION, ide_name: "antigravity" },
  });
  for (let attempt = 1; attempt <= ONBOARD_ATTEMPTS; attempt++) {
    const result = await googleJson(ANTIGRAVITY_BASE_URL + "/v1internal:onboardUser", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "*/*",
        "Content-Type": "application/json",
        "User-Agent": ANTIGRAVITY_ONBOARD_USER_AGENT,
        "X-Goog-Api-Client": ANTIGRAVITY_GOOG_API_CLIENT,
      },
      body,
    }, "onboard");
    if (result.done === true) return companionProject(object(result.response));
    if (attempt < ONBOARD_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, onboardPollDelayMs()));
  }
  return "";
}

function onboardPollDelayMs() {
  const value = Number(process.env.RELAY_ANTIGRAVITY_ONBOARD_POLL_MS);
  return Number.isFinite(value) && value >= 0 ? value : 2000;
}

function companionProject(value: Record<string, unknown>) {
  return [value.cloudaicompanionProject, value.projectId, value.project]
    .map(item => (string(item) || string(object(item).id)).trim())
    .find(Boolean) || "";
}

function defaultTierId(loaded: Record<string, unknown>) {
  const tiers = Array.isArray(loaded.allowedTiers) ? loaded.allowedTiers.map(object) : [];
  const tier = tiers.find(item => item.isDefault === true && string(item.id).trim());
  return string(tier?.id).trim() || string(object(loaded.currentTier).id).trim() || "free-tier";
}

// Credits hints mirror CPA: GOOGLE_ONE_AI balance from loadCodeAssist, kept in memory for 10 minutes.
function observeCredits(id: string, loaded: Record<string, unknown>) {
  const paidTier = object(loaded.paidTier);
  const credits = Array.isArray(paidTier.availableCredits) ? paidTier.availableCredits.map(object) : [];
  const credit = credits.find(item => string(item.creditType).toUpperCase() === "GOOGLE_ONE_AI");
  const amount = Number(credit?.creditAmount);
  const minimum = Number(credit?.minimumCreditAmountForUsage);
  creditsHints.set(id, {
    available: Number.isFinite(amount) && Number.isFinite(minimum) && amount >= minimum,
    updatedAt: Date.now(),
  });
}

export function antigravityCreditsHint(id: string): boolean | undefined {
  const hint = creditsHints.get(id);
  if (!hint || Date.now() - hint.updatedAt >= CREDITS_HINT_TTL_MS) return undefined;
  return hint.available;
}

export function markAntigravityCreditsExhausted(id: string) {
  creditsHints.set(id, { available: false, updatedAt: Date.now() });
}

export async function refreshAntigravityCreditsHint(credential: AntigravityCredentialWithTokens) {
  try {
    observeCredits(credential.id, await loadCodeAssist(credential.tokens.access_token));
  } catch {
    // A failed balance probe leaves the hint unknown; the credits attempt itself decides.
  }
}

async function refreshModelCatalog(id: string, token: string, projectId: string) {
  try {
    const result = await googleJson(ANTIGRAVITY_BASE_URL + "/v1internal:fetchAvailableModels", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "User-Agent": ANTIGRAVITY_USER_AGENT },
      body: JSON.stringify({ project: projectId }),
    }, "models");
    const models = object(result.models);
    replaceAntigravityModels(id, Object.keys(models).map(model => model.trim().toLowerCase()).filter(Boolean));
  } catch {
    // An unknown catalog is not persisted as an empty one; routing then relies on the channel allowlist.
  }
}

export async function ensureFreshAntigravityCredential(id: string, force = false): Promise<AntigravityCredentialWithTokens> {
  const existing = refreshes.get(id);
  if (existing) return existing;
  const credential = getAntigravityCredentialWithTokens(id);
  if (!credential?.enabled) throw new HttpError(403, "antigravity_credential_unavailable", "Antigravity credential is unavailable");
  if (!force && Date.parse(credential.tokens.expired) > Date.now() + REFRESH_LEAD_MS) return credential;
  const refresh = refreshCredential(credential).finally(() => refreshes.delete(id));
  refreshes.set(id, refresh);
  return refresh;
}

async function refreshCredential(credential: AntigravityCredentialWithTokens) {
  const refreshToken = credential.tokens.refresh_token;
  try {
    const tokens = await exchangeToken({ grant_type: "refresh_token", refresh_token: refreshToken }, refreshToken);
    replaceAntigravityTokens(credential, tokens);
  } catch (error) {
    if (error instanceof HttpError && error.code === "antigravity_oauth_revoked") {
      suspendAntigravityCredential(credential, error.message);
    }
    throw error;
  }
  const updated = getAntigravityCredentialWithTokens(credential.id);
  if (!updated?.enabled) throw new HttpError(403, "antigravity_credential_unavailable", "Antigravity credential is unavailable");
  void refreshAntigravityCreditsHint(updated);
  return updated;
}

export async function refreshAntigravityCredential(id: string) {
  const credential = await ensureFreshAntigravityCredential(id, true);
  await refreshModelCatalog(id, credential.tokens.access_token, credential.projectId);
  return publicCredential(getAntigravityCredential(id));
}

async function exchangeToken(values: Record<string, string>, existingRefreshToken = ""): Promise<AntigravityTokenBundle> {
  const { clientId, clientSecret } = oauthClient();
  const params = new URLSearchParams({ ...values, client_id: clientId, client_secret: clientSecret });
  const result = await googleJson(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": ANTIGRAVITY_TOKEN_USER_AGENT },
    body: params,
  }, "token");
  const accessToken = string(result.access_token).trim();
  const refreshToken = string(result.refresh_token).trim() || existingRefreshToken;
  const expires = typeof result.expires_in === "number" ? result.expires_in : 0;
  const now = Date.now();
  if (!accessToken || !refreshToken || !Number.isFinite(expires) || expires <= 0 || expires > 86400) {
    throw new HttpError(502, "antigravity_tokens_invalid", "Google did not return a valid offline token bundle");
  }
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expired: new Date(now + expires * 1000).toISOString(),
    last_refresh: new Date(now).toISOString(),
  };
}

// CPA's management panel reads quota from retrieveUserQuotaSummary. The daily endpoint can answer with only
// the Claude/GPT group, so the panel keeps querying the other endpoints until a Gemini bucket appears and
// merges groups by name, keeping the first value for each bucket.
const QUOTA_SUMMARY_URLS = [
  ANTIGRAVITY_BASE_URL,
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
].map(base => base + "/v1internal:retrieveUserQuotaSummary");

export async function getAntigravityQuota(id: string): Promise<AntigravityQuotaReport> {
  const credential = await ensureFreshAntigravityCredential(id);
  const groups = new Map<string, AntigravityQuotaGroup>();
  let lastError: unknown = null;
  for (const url of QUOTA_SUMMARY_URLS) {
    try {
      const result = await googleJson(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + credential.tokens.access_token,
          "Content-Type": "application/json",
          "User-Agent": ANTIGRAVITY_USER_AGENT,
        },
        body: JSON.stringify({ project: credential.projectId }),
      }, "quota");
      for (const rawGroup of Array.isArray(result.groups) ? result.groups : []) {
        const group = object(rawGroup);
        const label = string(group.displayName).trim() || "Antigravity";
        const merged = groups.get(label) ?? { label, description: string(group.description).trim(), buckets: [] };
        for (const bucket of (Array.isArray(group.buckets) ? group.buckets : []).map(quotaBucket)) {
          if (!merged.buckets.some(existing => existing.id === bucket.id)) merged.buckets.push(bucket);
        }
        groups.set(label, merged);
      }
      if ([...groups.values()].some(group => group.buckets.some(bucket => bucket.id.startsWith("gemini-")))) break;
    } catch (error) {
      lastError = error;
    }
  }
  if (groups.size === 0 && lastError) throw lastError;
  const sorted = [...groups.values()].map(group => ({
    ...group,
    // Weekly first, then the 5-hour window, as in the Antigravity app.
    buckets: group.buckets.sort((left, right) => windowOrder(left.window) - windowOrder(right.window)),
  }));
  return {
    provider: "antigravity",
    credential_id: id,
    status: quotaStatus(credential, sorted),
    groups: sorted,
    retrieved_at: new Date().toISOString(),
    message: sorted.length ? "" : "Antigravity 未返回额度分组",
  };
}

function quotaBucket(raw: unknown): AntigravityQuotaBucket {
  const bucket = object(raw);
  const window = string(bucket.window).trim();
  const fraction = Number(bucket.remainingFraction);
  const resetAt = string(bucket.resetTime).trim();
  return {
    id: string(bucket.bucketId).trim() || window,
    label: window === "weekly" ? "周额度" : window === "5h" ? "5 小时额度" : string(bucket.displayName).trim() || window,
    window,
    // An omitted fraction is unknown, not exhausted; CPA's panel makes the same distinction.
    remaining_percent: bucket.remainingFraction === undefined || !Number.isFinite(fraction)
      ? null : Math.max(0, Math.min(100, fraction * 100)),
    reset_at: resetAt && Number.isFinite(Date.parse(resetAt)) ? resetAt : null,
  };
}

function windowOrder(window: string) {
  return window === "weekly" ? 0 : window === "5h" ? 1 : 2;
}

// A group is as available as its tightest bucket; the account is as available as its best group.
function quotaStatus(credential: AntigravityCredentialRecord, groups: AntigravityQuotaGroup[]): AntigravityQuotaReport["status"] {
  const until = Date.parse(credential.cooldownUntil || "");
  if (Number.isFinite(until) && until > Date.now()) return "cooling_down";
  const remaining = groups
    .map(group => group.buckets.map(bucket => bucket.remaining_percent).filter((value): value is number => value !== null))
    .filter(values => values.length > 0)
    .map(values => Math.min(...values));
  if (remaining.length === 0) return credential.lastError ? "error" : "unknown";
  const best = Math.max(...remaining);
  if (best <= 0) return "exhausted";
  if (best <= 30) return "low";
  if (best <= 70) return "medium";
  return best < 100 ? "high" : "full";
}

async function googleJson(url: string, init: RequestInit, step: Step) {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(serverConfig.requestTimeoutMs) });
  } catch {
    throw new HttpError(502, "antigravity_oauth_transport", "Could not connect to Google during Antigravity authorization");
  }
  const result = object(await response.json().catch(() => null));
  if (!response.ok) {
    if (step === "token" && result.error === "invalid_grant" && init.body instanceof URLSearchParams &&
      init.body.get("grant_type") === "refresh_token") {
      throw new HttpError(401, "antigravity_oauth_revoked", "Google rejected the refresh grant. Reconnect this Antigravity account.");
    }
    const status = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw new HttpError(status, "antigravity_oauth_" + step, "Google rejected Antigravity " + step + " (HTTP " + response.status + ")");
  }
  return result;
}

const USAGE_HEALTH_RESET_METADATA_KEY = "usage_health_reset_at";

function withUsageHealth(credentials: AntigravityCredentialRecord[]) {
  const health = credentialUsageHealth(credentials.map(credential => credential.id), {
    resetSinceById: Object.fromEntries(credentials.map(credential =>
      [credential.id, string(credential.metadata[USAGE_HEALTH_RESET_METADATA_KEY]) || null])),
  });
  return credentials.map(credential => ({ ...credential, usageHealth: health[credential.id] }));
}

// Admin list and settings mirror the Codex and Claude credential APIs.
export function listPublicAntigravityCredentials() {
  return withUsageHealth(listAntigravityCredentials());
}

function publicCredential(credential: AntigravityCredentialRecord | null) {
  if (!credential) throw new HttpError(404, "antigravity_credential_not_found", "Antigravity credential not found");
  return withUsageHealth([credential])[0];
}

export function patchAntigravityCredential(id: string, input: { enabled?: unknown; priority?: unknown; weight?: unknown }) {
  const integer = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  };
  return publicCredential(updateAntigravityCredentialSettings(id, {
    ...(input.enabled !== undefined && { enabled: Boolean(input.enabled) }),
    ...(input.priority !== undefined && { priority: integer(input.priority, 100) }),
    ...(input.weight !== undefined && { weight: Math.max(1, integer(input.weight, 1)) }),
  }));
}

export function resetAntigravityCredentialHealth(id: string) {
  const credential = getAntigravityCredential(id);
  if (!credential) throw new HttpError(404, "antigravity_credential_not_found", "Antigravity credential not found");
  return publicCredential(updateAntigravityCredentialSettings(id, {
    cooldownUntil: null,
    lastError: null,
    modelCooldowns: {},
    metadata: { ...credential.metadata, [USAGE_HEALTH_RESET_METADATA_KEY]: new Date().toISOString() },
  }));
}

export function removeAntigravityCredential(id: string) {
  detachCredentialFromChannels(id, "antigravity");
  if (!deleteAntigravityCredential(id)) {
    throw new HttpError(404, "antigravity_credential_not_found", "Antigravity credential not found");
  }
}
