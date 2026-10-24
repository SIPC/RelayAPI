import "server-only";

import { getCodexQuotaCacheByCredentialId } from "@/src/server/repositories/quota";

type Provider = "codex" | "claude";
type QuotaWindow = {
  id: string;
  usedPercent?: number;
  remainingPercent?: number;
  resetAt?: string;
  limit?: number;
  remaining?: number;
  windowMinutes?: number;
  status?: string;
};
type Snapshot = {
  observedAt: number;
  windows: QuotaWindow[];
  raw: Record<string, string>;
};
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_WINDOWS = 8;
const snapshots = new Map<string, Snapshot>();

export function isAccountQuotaHeader(name: string) {
  return name.toLowerCase().startsWith("x-relay-quota-") || isUpstreamQuotaHeader(name);
}
function isUpstreamQuotaHeader(name: string) {
  return /^x-codex-(?:[a-z0-9-]+-)?(?:used-percent|window-minutes|reset-at|reset-after-seconds|credits-balance|credits-has-credits|credits-unlimited)$/i.test(name)
    || /^anthropic-ratelimit-(?:[a-z0-9-]+)-(?:limit|remaining|reset|status|utilization)$/i.test(name)
    || /^x-ratelimit-(?:limit|remaining|reset)-[a-z0-9-]+$/i.test(name);
}
function number(value: unknown): number | undefined {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") return;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
function percent(value: unknown) {
  const parsed = number(value);
  return parsed === undefined ? undefined : Math.min(100, parsed);
}
function resetAt(value: unknown, now: number, relative?: unknown) {
  if (value !== null && value !== undefined && String(value).trim()) {
    const numeric = number(value);
    const time = numeric === undefined ? Date.parse(String(value)) : numeric > 1e12 ? numeric : numeric * 1000;
    if (Number.isFinite(time) && Number.isFinite(new Date(time).getTime())) return new Date(time).toISOString();
  }
  const seconds = number(relative);
  if (seconds !== undefined && Number.isFinite(new Date(now + seconds * 1000).getTime())) {
    return new Date(now + seconds * 1000).toISOString();
  }
}
function normalizeId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 64);
}
export function parseAccountQuotaHeaders(provider: Provider, headers: Headers, now = Date.now()): Snapshot {
  const raw: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (isUpstreamQuotaHeader(name) && Object.keys(raw).length < 64 && value.length <= 128) raw[name] = value;
  }
  const windows: QuotaWindow[] = [];
  if (provider === "codex") {
    for (const [name, value] of headers) {
      const match = /^x-codex-(.+)-used-percent$/i.exec(name);
      if (!match || windows.length >= MAX_WINDOWS) continue;
      const used = percent(value);
      if (used === undefined) continue;
      const prefix = "x-codex-" + match[1];
      const minutes = number(headers.get(prefix + "-window-minutes"));
      const standardWindow = /^(primary|secondary)$/i.test(match[1]);
      const id = standardWindow && minutes === 300 ? "5h"
        : standardWindow && minutes === 10080 ? "7d" : normalizeId(match[1]);
      windows.push({
        id: windows.some((window) => window.id === id) ? normalizeId(match[1]) : id,
        usedPercent: used, remainingPercent: 100 - used, windowMinutes: minutes,
        resetAt: resetAt(headers.get(prefix + "-reset-at"), now, headers.get(prefix + "-reset-after-seconds")),
      });
    }
  } else {
    for (const id of ["5h", "7d"]) {
      const prefix = "anthropic-ratelimit-unified-" + id;
      const utilization = number(headers.get(prefix + "-utilization"));
      const status = headers.get(prefix + "-status") || undefined;
      const reset = resetAt(headers.get(prefix + "-reset"), now);
      if (utilization === undefined && !status && !reset) continue;
      const used = utilization === undefined ? undefined : Math.min(100, utilization * 100);
      windows.push({ id, usedPercent: used, remainingPercent: used === undefined ? undefined : 100 - used,
        resetAt: reset, status: status && /^[a-z0-9_-]{1,40}$/i.test(status) ? status : undefined });
    }
    for (const metric of ["requests", "tokens", "input-tokens", "output-tokens", "cache-read-input-tokens", "cache-creation-input-tokens"]) {
      if (windows.length >= MAX_WINDOWS) break;
      const prefix = "anthropic-ratelimit-" + metric;
      const limit = number(headers.get(prefix + "-limit") ?? headers.get("x-ratelimit-limit-" + metric));
      const remaining = number(headers.get(prefix + "-remaining") ?? headers.get("x-ratelimit-remaining-" + metric));
      if (limit === undefined && remaining === undefined) continue;
      const used = limit && remaining !== undefined ? Math.min(100, Math.max(0, (1 - remaining / limit) * 100)) : undefined;
      windows.push({ id: metric, limit, remaining, usedPercent: used,
        remainingPercent: used === undefined ? undefined : 100 - used,
        resetAt: resetAt(headers.get(prefix + "-reset") ?? headers.get("x-ratelimit-reset-" + metric), now) });
    }
  }
  return { observedAt: now, windows, raw };
}
function persistedCodexSnapshot(credentialId: string): Snapshot | undefined {
  let cached;
  try { cached = getCodexQuotaCacheByCredentialId(credentialId); } catch { return; }
  if (!cached) return;
  const windows: QuotaWindow[] = [];
  const data = [...(Array.isArray(cached.cache.windows) ? cached.cache.windows : []),
    ...(Array.isArray(cached.cache.additional_windows) ? cached.cache.additional_windows : [])];
  for (const value of data) {
    if (!value || typeof value !== "object" || windows.length >= MAX_WINDOWS) continue;
    const window = value as Record<string, unknown>;
    const used = percent(window.used_percent);
    const remaining = percent(window.remaining_percent);
    if (used === undefined && remaining === undefined) continue;
    const rawId = String(window.id || "");
    const id = rawId === "code-5h" ? "5h" : rawId === "code-7d" ? "7d" : normalizeId(rawId);
    if (!id || windows.some((existing) => existing.id === id)) continue;
    windows.push({ id, usedPercent: used, remainingPercent: remaining,
      resetAt: typeof window.reset_at === "string" ? resetAt(window.reset_at, Date.now()) : undefined });
  }
  return { observedAt: Date.parse(cached.retrievedAt), windows, raw: {} };
}
function currentCache(snapshot: Snapshot | undefined, now: number) {
  if (!snapshot || !Number.isFinite(snapshot.observedAt) || snapshot.observedAt > now
    || now - snapshot.observedAt > CACHE_TTL_MS) return;
  const windows = snapshot.windows.filter((window) => !window.resetAt || Date.parse(window.resetAt) > now);
  // Original upstream headers may describe windows which have already reset.
  return windows.length ? { ...snapshot, windows, raw: {} } : undefined;
}
export function accountQuotaHeaders(
  provider: Provider, credentialId: string, upstreamHeaders: Headers, now = Date.now(),
) {
  const key = provider + ":" + credentialId;
  const live = parseAccountQuotaHeaders(provider, upstreamHeaders, now);
  const hasLive = live.windows.length > 0 || Object.keys(live.raw).length > 0;
  let snapshot: Snapshot | undefined = hasLive ? live : currentCache(snapshots.get(key), now);
  let source = hasLive ? "upstream" : snapshot ? "cache" : "unavailable";
  if (!snapshot && provider === "codex") {
    snapshot = currentCache(persistedCodexSnapshot(credentialId), now);
    if (snapshot) source = "cache";
  }
  if (hasLive) {
    snapshots.delete(key);
    if (snapshots.size >= 4096) snapshots.delete(snapshots.keys().next().value!);
    snapshots.set(key, live);
  }
  const headers = new Headers({
    "X-Relay-Quota-Provider": provider,
    "X-Relay-Quota-Source": source,
  });
  if (!snapshot) return headers;
  headers.set("X-Relay-Quota-Observed-At", new Date(snapshot.observedAt).toISOString());
  headers.set("X-Relay-Quota-Age-Seconds", String(Math.floor((now - snapshot.observedAt) / 1000)));
  for (const [name, value] of Object.entries(snapshot.raw)) headers.set(name, value);
  for (const window of snapshot.windows) {
    const prefix = "X-Relay-Quota-" + window.id + "-";
    for (const [name, value] of Object.entries({
      "Used-Percent": window.usedPercent, "Remaining-Percent": window.remainingPercent,
      "Reset-At": window.resetAt, Limit: window.limit, Remaining: window.remaining,
      "Window-Minutes": window.windowMinutes, Status: window.status,
    })) {
      if (value !== undefined) headers.set(prefix + name, typeof value === "number" ? String(Number(value.toFixed(4))) : value);
    }
  }
  return headers;
}
export function withAccountQuotaHeaders(response: Response, provider: Provider, credentialId: string) {
  const headers = new Headers(response.headers);
  for (const name of [...headers.keys()]) if (name.startsWith("x-relay-quota-")) headers.delete(name);
  for (const [name, value] of accountQuotaHeaders(provider, credentialId, response.headers)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
export function copyAccountQuotaHeaders(upstream: Headers, target = new Headers()) {
  for (const [name, value] of upstream) if (isAccountQuotaHeader(name)) target.set(name, value);
  return target;
}
