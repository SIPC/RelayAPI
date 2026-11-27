import "server-only";

import { randomUUID } from "node:crypto";
import { serverConfig } from "@/src/server/config/env";
import { HttpError, logServerError } from "@/src/server/http/errors";
import { liveAccountQuotaSnapshot } from "@/src/server/http/accountQuota";
import { proxiedFetch } from "@/src/server/net/proxy";
import { getCodexCredentialById } from "@/src/server/repositories/codexCredentials";
import {
  acquireCodexQuotaRefresh,
  finishCodexQuotaRefresh,
  getCodexQuotaCacheByCredentialId,
  upsertCodexQuotaCache,
} from "@/src/server/repositories/quota";
import { recordQuotaSnapshots } from "@/src/server/repositories/quotaSnapshots";
import { ensureFreshCredential } from "@/src/server/services/codexCredentials";
import { evaluateQuotaFloor, type QuotaFloorWindow } from "@/src/server/services/quotaFloor";
import {
  getCredentialQuotaFloorPercent,
  getEffectiveCodexUserAgent,
  getGlobalProxySetting,
} from "@/src/server/services/settings";
import type {
  CodexCredentialRecord,
  CodexCredentialWithTokens,
  CredentialQuotaFloorState,
} from "@/src/shared/types/entities";

export const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const WINDOW_5H_SECONDS = 5 * 60 * 60;
const WINDOW_7D_SECONDS = 7 * 24 * 60 * 60;
export const CODEX_QUOTA_FRESH_MS = 2 * 60 * 1000;
// A credential skipped at the floor gets no traffic and so no response headers;
// routing re-reads WHAM at most this often so recovery is noticed.
const FLOOR_RECHECK_MS = 15 * 60 * 1000;
const QUOTA_TIMEOUT_MS = Math.min(serverConfig.requestTimeoutMs, 8_000);
const refreshes = new Map<string, Promise<PublicCodexQuotaReport>>();

type CodexQuotaStatus =
  | "unknown"
  | "exhausted"
  | "low"
  | "medium"
  | "high"
  | "full";

type CacheState = "cached" | "fresh" | "missing";

type RawObject = Record<string, unknown>;

interface QuotaWindow {
  id: string;
  label: string;
  window_seconds: number | null;
  used_percent: number | null;
  remaining_percent: number | null;
  reset_label: string;
  reset_at: string | null;
  exhausted: boolean;
}

interface CodexQuotaReport {
  provider: "codex";
  credential_id: string;
  account_id: string;
  email: string;
  plan_type: string;
  status: CodexQuotaStatus;
  windows: QuotaWindow[];
  additional_windows: QuotaWindow[];
  retrieved_at: string;
  raw?: unknown;
}

interface PublicCodexQuotaReport extends CodexQuotaReport {
  cached: boolean;
  cache_state: CacheState;
  quota_floor: CredentialQuotaFloorState;
}

interface MissingCodexQuotaReport {
  provider: "codex";
  credential_id: string;
  account_id: string;
  email: string;
  plan_type: string;
  status: "not_cached";
  windows: [];
  additional_windows: [];
  retrieved_at: string;
  cached: false;
  cache_state: "missing";
  message: string;
  quota_floor: CredentialQuotaFloorState;
}

export async function getCodexQuota({
  credentialId,
  forceRefresh = false,
  includeRaw = false,
  refreshIfStale = false,
}: {
  credentialId: string;
  forceRefresh?: boolean;
  includeRaw?: boolean;
  refreshIfStale?: boolean;
}): Promise<PublicCodexQuotaReport | MissingCodexQuotaReport> {
  if (!credentialId) {
    throw new HttpError(
      400,
      "missing_codex_credential_id",
      "Codex credential id is required",
    );
  }

  const credential = getCodexCredentialById(credentialId);
  if (!credential) {
    throw new HttpError(404, "codex_credential_not_found", "Codex credential not found");
  }
  const cached = getCodexQuotaCacheByCredentialId(credentialId);
  const snapshot = cached ? markQuotaCacheState(cached.cache, "cached") : missingQuotaResponse(credential);
  const age = cached ? Date.now() - Date.parse(cached.retrievedAt) : Infinity;
  const needsRefresh = !cached || !Number.isFinite(age) || age < 0 || age >= CODEX_QUOTA_FRESH_MS ||
    snapshot.windows.some((window) =>
      !window.window_seconds || (window.reset_at && Date.parse(window.reset_at) <= Date.now()),
    );
  if (!forceRefresh && !(refreshIfStale && needsRefresh)) return snapshot;

  // Only the initiating admin caller may receive raw; joiners get a clean report.
  const running = refreshes.get(credentialId);
  if (running) return running.then((report) => markQuotaCacheState(reportToRecord(report), "fresh"));
  const owner = randomUUID();
  const lease = acquireCodexQuotaRefresh(credentialId, owner, QUOTA_TIMEOUT_MS + 30_000);
  if (!lease) return snapshot;
  const refresh = refreshCodexQuota(credentialId, includeRaw).then((report) => {
    finishCodexQuotaRefresh(credentialId, owner, 0, CODEX_QUOTA_FRESH_MS);
    return report;
  }).catch((error: unknown) => {
    const failures = Math.min(lease.failures + 1, 10);
    const retryAfter = error instanceof HttpError
      ? Number((error.details as { retryAfterMs?: number } | undefined)?.retryAfterMs) || 0 : 0;
    finishCodexQuotaRefresh(credentialId, owner, failures,
      Math.max(Math.min(30_000 * 2 ** (failures - 1), 15 * 60_000), retryAfter));
    throw error;
  }).finally(() => refreshes.delete(credentialId));
  refreshes.set(credentialId, refresh);
  return refresh;
}

async function refreshCodexQuota(credentialId: string, includeRaw: boolean): Promise<PublicCodexQuotaReport> {
  let credential: CodexCredentialWithTokens | null = null;
  try {
    credential = await ensureFreshCredential(credentialId);
    if (!credential.tokens.access_token) {
      throw new HttpError(
        400,
        "missing_access_token",
        "Saved Codex credential does not contain an access token",
      );
    }
    if (!credential.accountId) {
      throw new HttpError(
        400,
        "missing_account_id",
        "Saved Codex credential does not contain an account id",
      );
    }

    const response = await proxiedFetch(
      WHAM_USAGE_URL,
      {
        method: "GET",
        headers: buildQuotaHeaders({
          accessToken: credential.tokens.access_token,
          accountId: credential.accountId,
          userAgent: getEffectiveCodexUserAgent(credential),
        }),
        signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
        redirect: "error",
      },
      credential.proxy?.enabled
        ? credential.proxy
        : credential.useGlobalProxy
          ? getGlobalProxySetting()
          : null,
    );

    const text = await response.text();
    const body = parseMaybeJson<unknown>(text) || { raw: text };
    if (!response.ok) {
      throw new HttpError(
        response.status,
        "codex_quota_request_failed",
        `Quota request failed with HTTP ${response.status}`,
        {
          upstreamStatus: response.status,
          upstreamStatusText: response.statusText,
          upstreamBody: body,
          retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
        },
      );
    }

    const root = objectFrom(body);
    if (!root || !objectFrom(firstValue(root.rate_limit, root.rateLimit))) {
      throw new HttpError(502, "invalid_codex_quota_response", "Invalid quota response");
    }
    const report = normalizeQuotaResponse(body, credential);
    // Quota cache belongs to the main DB because automatic channel routing may
    // use current quota state in a later routing slice.
    upsertCodexQuotaCache({
      credentialId: credential.id,
      status: report.status,
      cache: reportToRecord(report),
      retrievedAt: report.retrieved_at,
    });
    recordQuotaSnapshots("codex", credential.id, (["5h", "7d"] as const).flatMap((id) => {
      const window = report.windows.find((item) => item.id === `code-${id}`);
      return window ? [{ windowId: id, usedPercent: window.used_percent, resetAt: window.reset_at }] : [];
    }), Date.parse(report.retrieved_at));

    const publicReport = markQuotaCacheState(reportToRecord(report), "fresh");
    if (includeRaw) {
      return { ...publicReport, raw: body };
    }
    return publicReport;
  } catch (error) {
    logServerError(error, {
      operation: "codex.quota.refresh",
      metadata: {
        ...(credential
          ? codexQuotaCredentialLogMetadata(credential)
          : { credentialId }),
        includeRaw,
        forceRefresh: true,
      },
    });
    throw error;
  }
}

// The weekly window from the WHAM cache and the newest response headers, whichever
// was observed later. The 5h window is free to use up (a 5h 429 goes through the
// normal cooldown). Additional (feature) limits are not mapped to models.
export function codexQuotaFloorState(
  credentialId: string,
  { now = Date.now(), floor = getCredentialQuotaFloorPercent(), recheck = false } = {},
) {
  let weekly: QuotaFloorWindow | null = null;
  const cached = getCodexQuotaCacheByCredentialId(credentialId);
  const retrievedAt = cached ? Date.parse(cached.retrievedAt) : NaN;
  for (const raw of Array.isArray(cached?.cache.windows) ? cached.cache.windows : []) {
    const window = objectFrom(raw);
    if (window?.id !== "code-7d") continue;
    weekly = {
      label: "7d 额度", remainingPercent: typeof window.remaining_percent === "number" ? window.remaining_percent : null,
      observedAt: retrievedAt, resetAt: typeof window.reset_at === "string" ? window.reset_at : null, scope: null,
    };
  }
  const live = liveAccountQuotaSnapshot("codex", credentialId);
  const liveWeekly = live?.windows.find((window) => window.id === "7d");
  if (liveWeekly && !(weekly && weekly.observedAt > live!.observedAt)) {
    weekly = { label: "7d 额度", remainingPercent: liveWeekly.remainingPercent ?? null, observedAt: live!.observedAt,
      resetAt: liveWeekly.resetAt ?? null, scope: null };
  }
  const state = evaluateQuotaFloor(weekly ? [weekly] : [], floor, now, null);
  if (recheck && state.skipped && !(now - retrievedAt < FLOOR_RECHECK_MS)) {
    // Selection may hold the session SQLite write lock. Start IO only after it returns.
    queueMicrotask(() => {
      void getCodexQuota({ credentialId, refreshIfStale: true }).catch(() => {});
    });
  }
  return state;
}

function retryAfterMs(value: string | null) {
  if (!value) return 0;
  const seconds = Number(value);
  return Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()) || 0;
}

function markQuotaCacheState(
  report: Record<string, unknown>,
  state: Exclude<CacheState, "missing">,
): PublicCodexQuotaReport {
  const cleanReport = removeRaw(report) as unknown as CodexQuotaReport;
  return {
    ...cleanReport,
    cached: state === "cached",
    cache_state: state,
    quota_floor: codexQuotaFloorState(cleanReport.credential_id),
  };
}

function missingQuotaResponse(
  credential: CodexCredentialRecord,
): MissingCodexQuotaReport {
  return {
    provider: "codex",
    credential_id: credential.id,
    account_id: credential.accountId,
    email: credential.email,
    plan_type: credential.planType,
    status: "not_cached",
    windows: [],
    additional_windows: [],
    retrieved_at: "",
    cached: false,
    cache_state: "missing",
    message: "Quota has not been refreshed for this credential yet.",
    quota_floor: codexQuotaFloorState(credential.id),
  };
}

function buildQuotaHeaders(input: {
  accessToken: string;
  accountId: string;
  userAgent: string;
}) {
  return {
    Authorization: `Bearer ${input.accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": input.userAgent,
    "Chatgpt-Account-Id": input.accountId,
  };
}

function codexQuotaCredentialLogMetadata(
  credential: CodexCredentialWithTokens,
) {
  return {
    credentialId: credential.id,
    email: credential.email,
    accountId: credential.accountId,
    planType: credential.planType,
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

function normalizeQuotaResponse(
  payload: unknown,
  credential: CodexCredentialRecord,
): CodexQuotaReport {
  const root = objectFrom(payload) || {};
  const planType = cleanString(
    firstValue(root.plan_type, root.planType, credential.planType),
  );
  const windows = parseCodexWindows(root);
  return {
    provider: "codex",
    credential_id: credential.id,
    account_id: credential.accountId,
    email: credential.email,
    plan_type: planType,
    status: deriveCodexStatus(windows),
    windows,
    additional_windows: parseAdditionalWindows(root),
    retrieved_at: new Date().toISOString(),
  };
}

function parseCodexWindows(payload: RawObject) {
  const rateLimit = objectFrom(
    firstValue(payload.rate_limit, payload.rateLimit),
  );
  const [fiveHour, weekly] = findQuotaWindows(rateLimit);
  return [
    buildWindow("code-5h", "5h", fiveHour),
    buildWindow("code-7d", "7d", weekly),
  ].filter((window): window is QuotaWindow => window !== null);
}

function parseAdditionalWindows(payload: RawObject) {
  const raw = firstValue(
    payload.additional_rate_limits,
    payload.additionalRateLimits,
  );
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((item, index) => {
    const entry = objectFrom(item);
    const rateLimit = objectFrom(
      firstValue(entry?.rate_limit, entry?.rateLimit),
    );
    if (!entry || !rateLimit) {
      return [];
    }

    const name =
      cleanString(
        firstValue(
          entry.limit_name,
          entry.limitName,
          entry.metered_feature,
          entry.meteredFeature,
        ),
      ) || `additional-${index + 1}`;
    return [
      buildWindow(
        `${name}-primary`,
        `${name} 5h`,
        objectFrom(
          firstValue(rateLimit.primary_window, rateLimit.primaryWindow),
        ),
      ),
      buildWindow(
        `${name}-secondary`,
        `${name} 7d`,
        objectFrom(
          firstValue(rateLimit.secondary_window, rateLimit.secondaryWindow),
        ),
      ),
    ].filter((window): window is QuotaWindow => window !== null);
  });
}

function findQuotaWindows(
  rateLimit: RawObject | null,
): [RawObject | null, RawObject | null] {
  if (!rateLimit) {
    return [null, null];
  }
  const primary = objectFrom(
    firstValue(rateLimit.primary_window, rateLimit.primaryWindow),
  );
  const secondary = objectFrom(
    firstValue(rateLimit.secondary_window, rateLimit.secondaryWindow),
  );
  let fiveHour: RawObject | null = null;
  let weekly: RawObject | null = null;

  for (const candidate of [primary, secondary]) {
    if (!candidate) {
      continue;
    }
    const duration = numberFromAny(
      firstValue(candidate.limit_window_seconds, candidate.limitWindowSeconds),
    );
    if (duration === WINDOW_5H_SECONDS && !fiveHour) {
      fiveHour = candidate;
    }
    if (duration === WINDOW_7D_SECONDS && !weekly) {
      weekly = candidate;
    }
  }

  const withoutDuration = (window: RawObject | null) => window &&
    !numberPtr(firstValue(window.limit_window_seconds, window.limitWindowSeconds)) ? window : null;
  return [fiveHour || withoutDuration(primary), weekly || withoutDuration(secondary)];
}

function buildWindow(
  id: string,
  label: string,
  window: RawObject | null,
): QuotaWindow | null {
  if (!window) {
    return null;
  }
  const resetAt = resolveResetDate(window);
  // An overall limit_reached/allowed flag cannot identify which window is full.
  const used = numberPtr(firstValue(window.used_percent, window.usedPercent));
  const usedPercent = used === null ? null : clamp(used, 0, 100);
  const remainingPercent =
    usedPercent === null ? null : clamp(100 - usedPercent, 0, 100);
  return {
    id,
    label,
    window_seconds: numberPtr(firstValue(window.limit_window_seconds, window.limitWindowSeconds)),
    used_percent: usedPercent,
    remaining_percent: remainingPercent,
    reset_label: formatResetLabel(resetAt),
    reset_at: resetAt?.toISOString() ?? null,
    exhausted: usedPercent !== null && usedPercent >= 100,
  };
}

function deriveCodexStatus(windows: QuotaWindow[]): CodexQuotaStatus {
  const weekly = windows.find((window) => window.id === "code-7d");
  if (!weekly || weekly.remaining_percent === null) {
    return "unknown";
  }
  const remaining = weekly.remaining_percent;
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

function resolveResetDate(window: RawObject) {
  const resetAt = numberFromAny(firstValue(window.reset_at, window.resetAt));
  if (resetAt > 0) {
    const resetAtMs = resetAt > 1_000_000_000_000 ? resetAt : resetAt * 1000;
    const date = new Date(resetAtMs);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const resetAfterSeconds = numberFromAny(
    firstValue(window.reset_after_seconds, window.resetAfterSeconds),
  );
  if (resetAfterSeconds > 0) {
    const date = new Date(Date.now() + resetAfterSeconds * 1000);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
}

function formatResetLabel(date: Date | null) {
  return date ? formatLocalMinute(date) : "-";
}

function formatLocalMinute(date: Date) {
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  return `${month}-${day} ${hour}:${minute}`;
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function parseMaybeJson<T>(text: string) {
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

function objectFrom(value: unknown): RawObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RawObject)
    : null;
}

function firstValue(...values: unknown[]) {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      continue;
    }
    return value;
  }
  return undefined;
}

function cleanString(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "";
}

function numberPtr(value: unknown) {
  return isNumberish(value) ? numberFromAny(value) : null;
}

function numberFromAny(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim().replace(/%$/, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isNumberish(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }
  return Number.isFinite(Number.parseFloat(value.trim().replace(/%$/, "")));
}

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}

function reportToRecord(report: CodexQuotaReport): Record<string, unknown> {
  return { ...report };
}

function removeRaw(report: Record<string, unknown>) {
  const rest = { ...report };
  delete rest.raw;
  return rest;
}
