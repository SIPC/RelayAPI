import "server-only";

import { randomUUID } from "node:crypto";
import { serverConfig } from "@/src/server/config/env";
import { HttpError } from "@/src/server/http/errors";
import { proxiedFetch } from "@/src/server/net/proxy";
import { listClaudeCredentials } from "@/src/server/repositories/claudeCredentials";
import { credentialUsageWindows, latestCredentialUpstreamHeaders } from "@/src/server/repositories/logs";
import {
  acquireClaudeQuotaRefresh, claudeQuotaAccountKey, finishClaudeQuotaRefresh,
  getClaudeQuotaCache, mergeClaudeQuotaObservations, ownsClaudeQuotaRefresh,
  type ClaudeQuotaObservation,
} from "@/src/server/repositories/claudeQuota";
import { recordQuotaSnapshots } from "@/src/server/repositories/quotaSnapshots";
import {
  deriveClaudeQuotaStatus, ensureFreshClaudeCredential, getEffectiveClaudeUserAgent,
  parseClaudeRateLimitWindows, resolveClaudeCredentialProxy,
} from "@/src/server/services/claudeCredentials";
import { stripClaudeModelSuffixes } from "@/src/server/claude/modelSuffix";
import { getCredentialQuotaFloorPercent } from "@/src/server/services/settings";
import { evaluateQuotaFloor } from "@/src/server/services/quotaFloor";
import type { ClaudeCredentialRecord, ClaudeQuotaReport } from "@/src/shared/types/entities";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MINUTE = 60_000;
const FRESH_MS = 15 * MINUTE;
const MAX_AGE_MS = 60 * MINUTE;
const refreshes = new Map<string, Promise<void>>();

function current(window: ClaudeQuotaObservation, now: number) {
  return window.observedAt <= now && (!window.reset_at || Date.parse(window.reset_at) > now);
}

function completeFreshWindows(windows: ClaudeQuotaObservation[], now: number) {
  return ["unified-5h", "unified-7d"].every((id) => windows.some((window) =>
    window.id === id && window.remaining_percent !== null && current(window, now) &&
    now - window.observedAt < FRESH_MS));
}

export function recordClaudeQuotaHeaders(credentialId: string, headers: Headers, observedAt = Date.now()) {
  const windows = parseClaudeRateLimitWindows(headers).map((window): ClaudeQuotaObservation => ({
    ...window, observedAt, source: "anthropic_headers",
    scope: /^unified-7d-(.+)$/.exec(window.id)?.[1] ?? null,
    rejected: headers.get(`anthropic-ratelimit-${window.id}-status`) === "rejected",
  }));
  if (!windows.length) return;
  const key = claudeQuotaAccountKey(credentialId);
  if (key) {
    mergeClaudeQuotaObservations(key, windows);
    recordClaudeQuotaSnapshots(key, windows, observedAt);
  }
}

// Quota is per subscription account; duplicate imports share one history.
function recordClaudeQuotaSnapshots(key: string, windows: ClaudeQuotaObservation[], observedAt: number) {
  recordQuotaSnapshots("claude", key, (["5h", "7d"] as const).flatMap((id) => {
    const window = windows.find((item) => item.id === `unified-${id}`);
    return window ? [{ windowId: id, usedPercent: window.used_percent, resetAt: window.reset_at }] : [];
  }), observedAt);
}

export async function getClaudeQuota(
  credentialId: string, { refreshIfStale = true }: { refreshIfStale?: boolean } = {},
): Promise<ClaudeQuotaReport> {
  const credential = listClaudeCredentials().find((item) => item.id === credentialId);
  const key = claudeQuotaAccountKey(credentialId);
  if (!credential || !key) throw new HttpError(404, "claude_credential_not_found", "Claude credential not found");
  let cache = getClaudeQuotaCache(key);
  // Seed the new persistent store from existing logs without making old data fresh.
  if (!cache.windows.length && !cache.lastUsageAt) {
    const historical = latestCredentialUpstreamHeaders(credentialId);
    if (historical) recordClaudeQuotaHeaders(credentialId, new Headers(historical.headers), historical.observedAt);
    cache = getClaudeQuotaCache(key);
  }
  if (credential.enabled && refreshIfStale && !completeFreshWindows(cache.windows, Date.now())) {
    await refreshClaudeQuota(credential, key);
    cache = getClaudeQuotaCache(key);
  }
  const now = Date.now();
  const windows = cache.windows.filter((window) => current(window, now));
  const latest = windows.reduce<ClaudeQuotaObservation | undefined>((a, b) =>
    !a || a.observedAt < b.observedAt ? b : a, undefined);
  const observedAt = latest?.observedAt || cache.lastUsageAt;
  const state = completeFreshWindows(windows, now) && !cache.lastError ? "fresh"
    : observedAt ? "stale" : "missing";
  return {
    provider: "claude", source: latest?.source || (cache.lastUsageAt ? "oauth_usage" : "unavailable"),
    cache_state: state, next_attempt_at: cache.nextAttemptAt ? new Date(cache.nextAttemptAt).toISOString() : null,
    credential_id: credential.id, account_id: credential.accountId, email: credential.email,
    status: deriveClaudeQuotaStatus(credential, windows.filter((window) => !window.scope), new Date(now)),
    windows, local_windows: credentialUsageWindows(credential.id, new Date(now)),
    retrieved_at: observedAt ? new Date(observedAt).toISOString() : "",
    cooldown_until: credential.cooldownUntil, last_error: cache.lastError,
    quota_floor: claudeQuotaFloorState(credential.id, null, now),
    message: cache.lastError || (state === "fresh" ? "OAuth 只读用量 / 正常推理响应头；未发送额度探测推理。"
      : "额度数据不完整或已过期；保留最后有效观测，后台按退避周期补查。"),
  };
}

async function refreshClaudeQuota(credential: ClaudeCredentialRecord, key: string) {
  const running = refreshes.get(key);
  if (running) return running;
  const owner = randomUUID();
  const lease = acquireClaudeQuotaRefresh(key, owner, Date.now());
  if (!lease) return;
  const refresh = (async () => {
    try {
      const fresh = await ensureFreshClaudeCredential(credential.id);
      if (claudeQuotaAccountKey(credential.id) !== key) return;
      if (!fresh.tokens.access_token) throw new Error("missing access token");
      const observedAt = Date.now();
      const response = await proxiedFetch(USAGE_URL, {
        method: "GET", redirect: "error",
        headers: { Authorization: `Bearer ${fresh.tokens.access_token}`, Accept: "application/json",
          "anthropic-beta": "oauth-2025-04-20", "User-Agent": getEffectiveClaudeUserAgent(fresh) },
        signal: AbortSignal.timeout(Math.min(serverConfig.requestTimeoutMs, 8_000)),
      }, resolveClaudeCredentialProxy(fresh));
      if (!response.ok) {
        await response.body?.cancel();
        const raw = response.headers.get("retry-after");
        const seconds = raw?.trim() ? Number(raw) : NaN;
        const retryAt = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000
          : Date.parse(raw || "");
        throw new HttpError(response.status, "claude_usage_failed", `Claude usage HTTP ${response.status}`,
          { retryAt: Number.isFinite(retryAt) ? retryAt : 0 });
      }
      const payload: unknown = await response.json();
      const { windows, extraUsageEnabled } = parseUsage(payload, observedAt);
      if (!ownsClaudeQuotaRefresh(key, owner) || claudeQuotaAccountKey(credential.id) !== key) return;
      mergeClaudeQuotaObservations(key, windows, { observedAt, extraUsageEnabled });
      recordClaudeQuotaSnapshots(key, windows, observedAt);
      finishClaudeQuotaRefresh(key, owner, 0, Date.now() + FRESH_MS, null);
    } catch (error) {
      const failures = Math.min(lease.failures + 1, 10);
      const status = error instanceof HttpError ? error.status : null;
      const delay = status === 429 ? Math.min(15 * 2 ** (failures - 1), 60) * MINUTE
        : Math.min(2 ** (failures - 1), 30) * MINUTE;
      const retryAt = error instanceof HttpError ? Number((error.details as { retryAt?: number })?.retryAt) || 0 : 0;
      // Never persist provider bodies or tokens, and never change inference health/cooldowns here.
      finishClaudeQuotaRefresh(key, owner, failures, Math.max(Date.now() + delay, retryAt),
        status ? `Claude usage HTTP ${status}；稍后重试，非推理额度耗尽。` : "Claude usage 查询失败；稍后重试。");
    } finally {
      refreshes.delete(key);
    }
  })();
  refreshes.set(key, refresh);
  return refresh;
}

function parseUsage(payload: unknown, observedAt: number) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid Claude usage");
  const root = payload as Record<string, unknown>;
  const windows: ClaudeQuotaObservation[] = [];
  let recognized = false;
  const add = (id: string, label: string, value: unknown, scope: string | null, field = "utilization") => {
    if (value === null || value === undefined) return;
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Claude usage window");
    const raw = value as Record<string, unknown>;
    const used = raw[field];
    const reset = typeof raw.resets_at === "string" && Number.isFinite(Date.parse(raw.resets_at))
      ? new Date(raw.resets_at).toISOString() : null;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0) throw new Error("invalid Claude usage utilization");
    const percent = Math.min(100, used);
    windows.push({ id, label, scope, observedAt, source: "oauth_usage", rejected: false,
      limit: 100, used: percent, remaining: 100 - percent, used_percent: percent,
      remaining_percent: 100 - percent, reset_at: reset, reset_label: reset || "-", exhausted: percent >= 100 });
  };
  for (const [key, id, label, scope] of [
    ["five_hour", "unified-5h", "5h 额度", null], ["seven_day", "unified-7d", "7d 额度", null],
    ["seven_day_opus", "unified-7d-opus", "Opus 周额度", "opus"],
    ["seven_day_sonnet", "unified-7d-sonnet", "Sonnet 周额度", "sonnet"],
  ] as const) {
    if (key in root) recognized = true;
    add(id, label, root[key], scope);
  }
  if (Array.isArray(root.limits)) {
    recognized = true;
    for (const item of root.limits) {
      if (!item || typeof item !== "object") continue;
      const limit = item as { kind?: string; is_active?: boolean; scope?: { model?: { id?: string; display_name?: string } } };
      if (limit.is_active === false) continue;
      const name = limit.scope?.model?.id || limit.scope?.model?.display_name || "";
      const family = /(?:^|[-\s])(opus|sonnet|haiku|fable|mythos)(?:$|[-\s])/i.exec(name)?.[1].toLowerCase();
      if (limit.kind === "session" && !name) add("unified-5h", "5h 额度", item, null, "percent");
      else if (limit.kind === "weekly" && !name) add("unified-7d", "7d 额度", item, null, "percent");
      else if (limit.kind === "weekly_scoped" && family)
        add(`unified-7d-${family}`, `${name} 周额度`, item, family, "percent");
    }
  }
  if (!recognized) throw new Error("invalid Claude usage");
  const extra = root.extra_usage as { is_enabled?: unknown } | null;
  return { windows, extraUsageEnabled: typeof extra?.is_enabled === "boolean" ? extra.is_enabled : null };
}

export function claudeQuotaRouting(credentialId: string, model: string, now = Date.now()) {
  const key = claudeQuotaAccountKey(credentialId);
  if (!key) return { multiplier: 1, blocked: false };
  const cache = getClaudeQuotaCache(key);
  const canonical = stripClaudeModelSuffixes(model).toLowerCase();
  const windows = cache.windows.filter((window) => current(window, now) &&
    window.id.startsWith("unified-") && (!window.scope || canonical.includes(`claude-${window.scope}`)));
  const blocked = windows.some((window) => (window.reset_at || now - window.observedAt < FRESH_MS) &&
    (window.rejected || (cache.extraUsageEnabled === false && window.exhausted)));
  const complete = ["unified-5h", "unified-7d"].every((id) => windows.some((w) =>
    w.id === id && w.remaining_percent !== null));
  const scored = windows.filter((window) => window.remaining_percent !== null);
  const age = complete ? Math.max(...scored.map((window) => now - window.observedAt)) : Infinity;
  if ((!complete || age >= FRESH_MS) && cache.nextAttemptAt <= now) {
    // Selection may hold the session SQLite write lock. Start IO only after it returns.
    queueMicrotask(() => { void getClaudeQuota(credentialId).catch(() => {}); });
  }
  if (!complete || age >= MAX_AGE_MS) return { multiplier: 1, blocked };
  const q = Math.min(...scored.map((window) => window.remaining_percent! / 100));
  const confidence = Math.min(1, (MAX_AGE_MS - age) / (MAX_AGE_MS - FRESH_MS));
  return { multiplier: 1 + confidence * (0.25 + 1.5 * q - 1), blocked };
}

// model null reports the account for the dashboard; with a model, routing applies
// the shared 7d window plus the weekly window of that model family. The 5h window
// is free to use up: a 5h 429 goes through the normal cooldown instead.
export function claudeQuotaFloorState(
  credentialId: string, model: string | null, now = Date.now(), floor = getCredentialQuotaFloorPercent(),
) {
  const key = claudeQuotaAccountKey(credentialId);
  const windows = key ? getClaudeQuotaCache(key).windows.filter((window) => window.id.startsWith("unified-7d")) : [];
  const canonical = model === null ? null : stripClaudeModelSuffixes(model).toLowerCase();
  return evaluateQuotaFloor(windows.map((window) => ({
    label: window.label,
    // An upstream "rejected" status is exhausted even when no percentage came with it.
    remainingPercent: window.rejected ? 0 : window.remaining_percent, observedAt: window.observedAt,
    resetAt: window.reset_at, scope: window.scope,
  })), floor, now, canonical === null ? null : (scope) => canonical.includes(`claude-${scope}`));
}

export async function refreshDueClaudeQuotas() {
  const now = Date.now();
  const accounts = new Map<string, { credential: ClaudeCredentialRecord; active: boolean }>();
  for (const credential of listClaudeCredentials()) {
    if (!credential.enabled) continue;
    const key = claudeQuotaAccountKey(credential.id)!;
    // A credential skipped at the quota floor receives no traffic, so no headers;
    // poll it like an active one so recovery is noticed before its data expires.
    const floor = claudeQuotaFloorState(credential.id, null, now);
    const active = now - Date.parse(credential.lastUsedAt || "") < MAX_AGE_MS ||
      floor.skipped || floor.skipped_scopes.length > 0;
    const previous = accounts.get(key);
    if (!previous || active) accounts.set(key, { credential, active: active || !!previous?.active });
  }
  for (const [key, { credential, active }] of accounts) {
    const cache = getClaudeQuotaCache(key);
    const interval = active ? FRESH_MS : MAX_AGE_MS;
    const core = ["unified-5h", "unified-7d"].map((id) =>
      cache.windows.find((w) => w.id === id && w.remaining_percent !== null && current(w, now))?.observedAt ?? 0);
    const latest = Math.max(cache.lastUsageAt, Math.min(...core));
    if (now >= cache.nextAttemptAt && now - latest >= interval) await refreshClaudeQuota(credential, key);
  }
}

export function startClaudeQuotaScheduler() {
  const state = globalThis as typeof globalThis & { __claudeQuotaTimer?: ReturnType<typeof setInterval> };
  if (state.__claudeQuotaTimer) return;
  state.__claudeQuotaTimer = setInterval(() => { void refreshDueClaudeQuotas().catch(() => {}); }, MINUTE);
  state.__claudeQuotaTimer.unref();
  // A delayed first tick spreads startup work and leaves credential import nonblocking.
}
