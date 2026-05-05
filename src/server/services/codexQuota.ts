import "server-only";

import { serverConfig } from "@/src/server/config/env";
import { HttpError } from "@/src/server/http/errors";
import { getCodexCredentialById } from "@/src/server/repositories/codexCredentials";
import {
  getCodexQuotaCacheByCredentialId,
  upsertCodexQuotaCache,
} from "@/src/server/repositories/quota";
import { ensureFreshCredential } from "@/src/server/services/codexCredentials";
import type { CodexCredentialRecord } from "@/src/shared/types/entities";

export const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const WINDOW_5H_SECONDS = 5 * 60 * 60;
const WINDOW_7D_SECONDS = 7 * 24 * 60 * 60;

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
  used_percent: number | null;
  remaining_percent: number | null;
  reset_label: string;
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
}

export async function getCodexQuota({
  credentialId,
  forceRefresh = false,
  includeRaw = false,
}: {
  credentialId: string;
  forceRefresh?: boolean;
  includeRaw?: boolean;
}): Promise<PublicCodexQuotaReport | MissingCodexQuotaReport> {
  if (!credentialId) {
    throw new HttpError(
      400,
      "missing_codex_credential_id",
      "Codex credential id is required",
    );
  }

  if (!forceRefresh) {
    const cached = getCodexQuotaCacheByCredentialId(credentialId);
    if (cached) {
      return markQuotaCacheState(cached.cache, "cached");
    }
    const credential = getCodexCredentialById(credentialId);
    if (!credential) {
      throw new HttpError(
        404,
        "codex_credential_not_found",
        "Codex credential not found",
      );
    }
    return missingQuotaResponse(credential);
  }

  const credential = await ensureFreshCredential(credentialId);
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

  const response = await fetch(WHAM_USAGE_URL, {
    method: "GET",
    headers: buildQuotaHeaders({
      accessToken: credential.tokens.access_token,
      accountId: credential.accountId,
    }),
    signal: AbortSignal.timeout(serverConfig.requestTimeoutMs),
  });

  const text = await response.text();
  const body = parseMaybeJson<unknown>(text) || { raw: text };
  if (!response.ok) {
    throw new HttpError(
      response.status,
      "codex_quota_request_failed",
      `Quota request failed with HTTP ${response.status}`,
      body,
    );
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

  const publicReport = markQuotaCacheState(reportToRecord(report), "fresh");
  if (includeRaw) {
    return { ...publicReport, raw: body };
  }
  return publicReport;
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
  };
}

function buildQuotaHeaders(input: { accessToken: string; accountId: string }) {
  return {
    Authorization: `Bearer ${input.accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": serverConfig.userAgent,
    "Chatgpt-Account-Id": input.accountId,
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
  const limitReached = firstValue(
    rateLimit?.limit_reached,
    rateLimit?.limitReached,
  );
  const allowed = firstValue(rateLimit?.allowed);
  return [
    buildWindow("code-5h", "5h", fiveHour, limitReached, allowed),
    buildWindow("code-7d", "7d", weekly, limitReached, allowed),
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
    const limitReached = firstValue(
      rateLimit.limit_reached,
      rateLimit.limitReached,
    );
    const allowed = firstValue(rateLimit.allowed);
    return [
      buildWindow(
        `${name}-primary`,
        `${name} 5h`,
        objectFrom(
          firstValue(rateLimit.primary_window, rateLimit.primaryWindow),
        ),
        limitReached,
        allowed,
      ),
      buildWindow(
        `${name}-secondary`,
        `${name} 7d`,
        objectFrom(
          firstValue(rateLimit.secondary_window, rateLimit.secondaryWindow),
        ),
        limitReached,
        allowed,
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

  return [fiveHour || primary, weekly || secondary];
}

function buildWindow(
  id: string,
  label: string,
  window: RawObject | null,
  limitReached: unknown,
  allowed: unknown,
): QuotaWindow | null {
  if (!window) {
    return null;
  }
  const usedPercent = deduceUsedPercent(window, limitReached, allowed);
  const remainingPercent =
    usedPercent === null ? null : clamp(100 - usedPercent, 0, 100);
  return {
    id,
    label,
    used_percent: usedPercent,
    remaining_percent: remainingPercent,
    reset_label: formatResetLabel(window),
    exhausted: usedPercent !== null && usedPercent >= 100,
  };
}

function deduceUsedPercent(
  window: RawObject,
  limitReached: unknown,
  allowed: unknown,
) {
  const used = numberPtr(firstValue(window.used_percent, window.usedPercent));
  if (used !== null) {
    return clamp(used, 0, 100);
  }
  if (
    (booleanFromAny(limitReached) || allowed === false) &&
    formatResetLabel(window) !== "-"
  ) {
    return 100;
  }
  return null;
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

function formatResetLabel(window: RawObject) {
  const resetAt = numberFromAny(firstValue(window.reset_at, window.resetAt));
  if (resetAt > 0) {
    return formatLocalMinute(new Date(resetAt * 1000));
  }
  const resetAfterSeconds = numberFromAny(
    firstValue(window.reset_after_seconds, window.resetAfterSeconds),
  );
  if (resetAfterSeconds > 0) {
    return formatLocalMinute(new Date(Date.now() + resetAfterSeconds * 1000));
  }
  return "-";
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

function booleanFromAny(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  return typeof value === "string" && value.trim().toLowerCase() === "true";
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
