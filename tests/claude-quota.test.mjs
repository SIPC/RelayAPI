import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { Worker } from "node:worker_threads";
import { after, beforeEach, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-quota-"));
process.env.DATA_DIR = dataDir;
process.env.RELAY_MAIN_DB_PATH = path.join(dataDir, "main.sqlite");
process.env.RELAY_LOG_DB_PATH = path.join(dataDir, "logs.sqlite");
process.env.RELAY_ENCRYPTION_KEY = "synthetic-claude-quota";
process.env.RELAY_IMPORT_LEGACY_CREDENTIALS = "0";
for (const name of ["RELAY_GLOBAL_SOCKS_PROXY", "RELAY_GLOBAL_PROXY", "CODEX_PROXY"]) delete process.env[name];
const root = new URL("../", import.meta.url);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  if (specifier.startsWith("@/")) return nextResolve(new URL(specifier.slice(2) + ".ts", root).href, context);
  return nextResolve(specifier, context);
} });
const { getMainDb, getLogDb } = await import("../src/server/db/sqlite.ts");
const { upsertClaudeCredential, updateClaudeCredential, getClaudeCredentialWithTokens } =
  await import("../src/server/repositories/claudeCredentials.ts");
const { getClaudeQuota, recordClaudeQuotaHeaders, claudeQuotaRouting, refreshDueClaudeQuotas, claudeQuotaFloorState } =
  await import("../src/server/services/claudeQuota.ts");
const { claudeQuotaAccountKey, acquireClaudeQuotaRefresh } =
  await import("../src/server/repositories/claudeQuota.ts");
const { appendRequestLog } = await import("../src/server/repositories/logs.ts");
const { createChannel, patchChannel, selectChannelForRequest, recordChannelSuccess } =
  await import("../src/server/services/channels.ts");
const { createApiKey, authenticateRelayRequest } = await import("../src/server/services/apiKeys.ts");
const { patchGlobalSettings, getPublicGlobalSettings } = await import("../src/server/services/settings.ts");
const { upsertCodexCredential } = await import("../src/server/repositories/codexCredentials.ts");
const { upsertCodexQuotaCache } = await import("../src/server/repositories/quota.ts");
const { codexQuotaFloorState } = await import("../src/server/services/codexQuota.ts");
const { accountQuotaHeaders } = await import("../src/server/http/accountQuota.ts");
const { getQuotaBurnReport } = await import("../src/server/services/quotaBurn.ts");
const { UsageTracker } = await import("../src/server/upstream/stream.ts");
const { extractUsageFromClaudeMessage } = await import("../src/server/claude/chat.ts");
const originalFetch = globalThis.fetch;
const minute = 60_000;
let calls;
let response;
let now;

beforeEach((t) => {
  for (const table of ["channels", "claude_credentials", "codex_credentials", "codex_quota_cache",
    "claude_quota_cache", "api_keys", "settings", "session_bindings"]) getMainDb().exec("DELETE FROM " + table);
  for (const table of ["quota_snapshots", "request_logs", "usage_records", "usage_daily_buckets"]) getLogDb().exec("DELETE FROM " + table);
  now = Date.now();
  t.mock.method(Date, "now", () => now);
  calls = [];
  response = () => Response.json(usage(20, 35, 90));
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), init });
    // An accidental probe or paid-usage mutation cannot pass silently.
    assert.equal(String(url), "https://api.anthropic.com/api/oauth/usage");
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    return response(url, init);
  });
});
after(() => {
  globalThis.fetch = originalFetch;
  getMainDb().close(); getLogDb().close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function credential(accountId = randomUUID(), metadata = {}) {
  const id = randomUUID();
  upsertClaudeCredential({ id, accountId, email: "synthetic@example.invalid", metadata,
    tokens: { access_token: "sk-ant-oat01-synthetic", expired: "2099-01-01T00:00:00Z" } });
  return id;
}
function usage(five, week, opus, extra = false) {
  const window = (utilization) => ({ utilization, resets_at: new Date(now + 7 * 86400_000).toISOString() });
  return { five_hour: window(five), seven_day: window(week), seven_day_opus: window(opus),
    extra_usage: { is_enabled: extra } };
}
function headers(id, five, week, at = now, reset = now + 86400_000) {
  recordClaudeQuotaHeaders(id, new Headers({
    "anthropic-ratelimit-unified-5h-utilization": String(five),
    "anthropic-ratelimit-unified-7d-utilization": String(week),
    "anthropic-ratelimit-unified-5h-reset": String(reset / 1000),
    "anthropic-ratelimit-unified-7d-reset": String(reset / 1000),
  }), at);
}
function fixture(quotaWeighted) {
  // Equal creation times are deterministically ordered by credential ID.
  const [a, b] = [credential(), credential()].sort();
  const channel = createChannel({ provider: "claude", credentialIds: [a, b], quotaWeighted });
  const key = createApiKey({ channelAllowlist: [channel.id] });
  const apiKey = authenticateRelayRequest(new Request("http://relay.invalid/v1/messages", {
    headers: { authorization: `Bearer ${key.key}` },
  }));
  const select = (session = randomUUID(), model = "claude-sonnet-4-6") => selectChannelForRequest({
    operation: "messages", model, apiKey,
    request: { payload: { model, session_id: session, messages: [{ role: "user", content: "Hi" }] }, headers: new Headers() },
  });
  return { a, b, channel, select };
}

test("read-only usage single-flight shares an account, preserves sub-1% units, and persists across workers", async () => {
  const account = randomUUID(); const a = credential(account); const b = credential(account);
  response = () => Response.json(usage(0.5, 12, 98));
  const reports = await Promise.all([getClaudeQuota(a), getClaudeQuota(b), getClaudeQuota(a)]);
  assert.equal(calls.length, 1);
  assert.equal(new Headers(calls[0].init.headers).get("anthropic-beta"), "oauth-2025-04-20");
  assert.equal(reports[0].windows[0].remaining_percent, 99.5);
  assert.equal(reports[1].cache_state, "fresh");
  assert.equal(reports[1].source, "oauth_usage");
  assert.ok(Math.abs(claudeQuotaRouting(a, "claude-opus-4-7").multiplier - 0.28) < 1e-10);
  assert.ok(Math.abs(claudeQuotaRouting(a, "claude-sonnet-4-6").multiplier - 1.57) < 1e-10);
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { registerHooks } = require("node:module");
    registerHooks({resolve(s,c,n) {
      if (s === "server-only") return {url:"data:text/javascript,export {};",shortCircuit:true};
      return n(s.startsWith("@/") ? new URL(s.slice(2)+".ts",workerData.root).href : s,c);
    }});
    globalThis.fetch = () => { throw new Error("cache read attempted network"); };
    (async () => {
      const {getClaudeQuota} = await import(new URL("src/server/services/claudeQuota.ts",workerData.root));
      parentPort.postMessage(await getClaudeQuota(workerData.id));
      const {getMainDb,getLogDb} = await import(new URL("src/server/db/sqlite.ts",workerData.root));
      getMainDb().close();getLogDb().close();
    })();
  `, { eval: true, workerData: { root: root.href, id: a } });
  const report = await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
  assert.equal(report.windows[0].remaining_percent, 99.5);
  assert.equal(report.last_error, null);
  assert.notEqual(claudeQuotaAccountKey(credential(account, { organization_uuid: "other-org" })), claudeQuotaAccountKey(a));
});

test("SQLite leases exclude another process and expire after a crashed refresh", async () => {
  const id = credential(); const key = claudeQuotaAccountKey(id);
  assert.ok(acquireClaudeQuotaRefresh(key, "other-worker", now));
  assert.equal((await getClaudeQuota(id)).cache_state, "missing");
  assert.equal(calls.length, 0);
  now += 30_001;
  assert.equal((await getClaudeQuota(id)).cache_state, "fresh");
  assert.equal(calls.length, 1);
});

test("usage 429 backs off 15/30/60 minutes, honors Retry-After, and never exhausts or cools inference", async () => {
  const id = credential();
  await getClaudeQuota(id);
  now += 15 * minute;
  response = () => new Response("private response must not be persisted", { status: 429 });
  for (const delay of [15, 30, 60]) {
    const report = await getClaudeQuota(id);
    assert.equal(Date.parse(report.next_attempt_at), now + delay * minute);
    assert.equal(report.status, "medium");
    assert.equal(report.cache_state, "stale");
    assert.ok(!JSON.stringify(report).includes("private response"));
    assert.equal(getClaudeCredentialWithTokens(id).cooldownUntil, null);
    const count = calls.length;
    now += delay * minute - 1;
    await getClaudeQuota(id);
    assert.equal(calls.length, count);
    now += 1;
  }
  response = () => new Response(null, { status: 429, headers: { "retry-after": "7200" } });
  assert.equal(Date.parse((await getClaudeQuota(id)).next_attempt_at), now + 120 * minute);
  now += 120 * minute;
  const retryAt = Math.floor((now + 180 * minute) / 1000) * 1000;
  response = () => new Response(null, { status: 429, headers: { "retry-after": new Date(retryAt).toUTCString() } });
  assert.equal(Date.parse((await getClaudeQuota(id)).next_attempt_at), retryAt);
});

test("newer inference headers correct usage without refreshing missing fields or losing model scopes", async () => {
  const id = credential();
  await getClaudeQuota(id);
  now += minute;
  headers(id, 0.6, 0.7);
  recordClaudeQuotaHeaders(id, new Headers({ "anthropic-ratelimit-unified-7d-opus-utilization": "0.95" }));
  assert.ok(Math.abs(claudeQuotaRouting(id, "claude-opus-4-7").multiplier - 0.325) < 1e-10);
  assert.ok(Math.abs(claudeQuotaRouting(id, "claude-sonnet-4-6").multiplier - 0.7) < 1e-10);
  now += minute;
  recordClaudeQuotaHeaders(id, new Headers({ "anthropic-ratelimit-unified-5h-status": "allowed" }));
  const report = await getClaudeQuota(id, { refreshIfStale: false });
  assert.equal(report.windows.find(w => w.id === "unified-5h").remaining_percent, 40);
  assert.equal(report.windows.find(w => w.id === "unified-5h").observedAt, now - minute);
  headers(id, 0, 0, now - 10 * minute);
  assert.equal((await getClaudeQuota(id, { refreshIfStale: false })).windows[0].remaining_percent, 40);
});

test("a slow usage response cannot overwrite newer inference observations; malformed responses retain last-good data", async () => {
  const id = credential();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  response = async () => { await gate; return Response.json(usage(0, 0, 0)); };
  const pending = getClaudeQuota(id);
  // ensureFreshClaudeCredential and fetch enter before recording a newer response.
  await new Promise(resolve => setImmediate(resolve));
  now += minute;
  headers(id, 0.4, 0.8);
  release();
  let report = await pending;
  assert.equal(report.windows.find(w => w.id === "unified-5h").remaining_percent, 60);
  assert.equal(report.windows.find(w => w.id === "unified-7d").remaining_percent, 20);
  now += 15 * minute;
  response = () => Response.json({ five_hour: { utilization: "invalid" } });
  report = await getClaudeQuota(id);
  assert.equal(report.windows.find(w => w.id === "unified-5h").remaining_percent, 60);
  assert.ok(report.last_error);
});

test("quota influence fades at 15–60 minutes; reset/unknown are neutral and queue a read-only refresh", async () => {
  const id = credential();
  headers(id, 0.2, 0.8);
  // q = min(0.8, 0.2) = 0.2; full-confidence factor = 0.55.
  assert.ok(Math.abs(claudeQuotaRouting(id, "claude-sonnet-4-6").multiplier - 0.55) < 1e-10);
  now += 15 * minute;
  assert.ok(Math.abs(claudeQuotaRouting(id, "claude-sonnet-4-6").multiplier - 0.55) < 1e-10);
  now += 22.5 * minute;
  assert.ok(Math.abs(claudeQuotaRouting(id, "claude-sonnet-4-6").multiplier - 0.775) < 1e-10);
  now += 22.5 * minute;
  assert.equal(claudeQuotaRouting(id, "claude-sonnet-4-6").multiplier, 1);
  // Let queued reads finish before installing the reset fixture.
  await getClaudeQuota(id);
  const resetId = credential();
  headers(resetId, 0, 0, now, now + minute);
  now += minute;
  assert.equal(claudeQuotaRouting(resetId, "claude-sonnet-4-6").multiplier, 1);
  assert.equal((await getClaudeQuota(resetId, { refreshIfStale: false })).windows.length, 0);
  await getClaudeQuota(resetId);
  assert.equal(calls.length, 2);
});

test("scheduler refreshes active accounts after 15m and idle after 60m, including duplicate imports", async () => {
  const active = credential(); const idle = credential();
  await getClaudeQuota(active); await getClaudeQuota(idle);
  credential(getClaudeCredentialWithTokens(active).accountId);
  now += 15 * minute - 1;
  updateClaudeCredential(active, { lastUsedAt: new Date(now).toISOString() });
  await refreshDueClaudeQuotas(); assert.equal(calls.length, 2);
  now += 1;
  await refreshDueClaudeQuotas(); assert.equal(calls.length, 3);
  updateClaudeCredential(active, { enabled: false });
  // Disable the duplicate too; only the idle account should be due next.
  getMainDb().prepare("UPDATE claude_credentials SET enabled = 0 WHERE account_id = ?")
    .run(getClaudeCredentialWithTokens(active).accountId);
  now += 45 * minute - 1;
  await refreshDueClaudeQuotas(); assert.equal(calls.length, 3);
  now += 1;
  await refreshDueClaudeQuotas(); assert.equal(calls.length, 4);
});

test("opt-in weighting multiplies configured weight, preserves priority and sticky sessions, and never jumps back", (t) => {
  const { a, b, channel, select } = fixture();
  assert.equal(channel.quotaWeighted, false);
  headers(a, 0.9, 0.9); headers(b, 0.1, 0.2);
  t.mock.method(Math, "random", () => 0.4);
  // Off: equal weights select the first account. On: 0.4 vs 1.45 selects the second.
  assert.equal(select().credential.id, a);
  patchChannel(channel.id, { quotaWeighted: true });
  const session = randomUUID();
  const bound = select(session);
  assert.equal(bound.credential.id, b);
  recordChannelSuccess(bound.channel, 1);
  // Above the 5% floor: weighting alone never moves a bound session.
  headers(a, 0, 0); headers(b, 0.9, 0.9);
  assert.equal(select(session).credential.id, b);
  updateClaudeCredential(b, { cooldownUntil: new Date(now + minute).toISOString() });
  const rebound = select(session);
  assert.equal(rebound.credential.id, a);
  recordChannelSuccess(rebound.channel, 1);
  now += minute;
  headers(a, 0.9, 0.9); headers(b, 0, 0);
  assert.equal(select(session).credential.id, a);
  updateClaudeCredential(b, { priority: 999 });
  assert.equal(select().credential.id, b);
});

test("quota weights stay below health tiers and combine with configured credential weights", (t) => {
  const { a, b, select } = fixture(true);
  headers(a, 0.9, 0.9); headers(b, 0, 0);
  updateClaudeCredential(a, { weight: 10 });
  t.mock.method(Math, "random", () => 0.6);
  // 10 × 0.4 = 4 vs 1 × 1.75 = 1.75: configured weight still matters.
  assert.equal(select().credential.id, a);
  // Two successes and one failure give b a measured health of 67 (the next tier).
  for (const statusCode of [200, 500, 200]) appendRequestLog({ credentialId: b,
    startedAt: new Date(now).toISOString(), method: "POST", path: "/v1/messages",
    requestType: "messages", stream: false, statusCode, latencyMs: 1 });
  updateClaudeCredential(b, { priority: 9999 });
  assert.equal(select().credential.id, a);
});

test("confirmed exhaustion filters until reset; usage 429 alone does not, and extra usage is never enabled", async () => {
  const { a, b, select } = fixture(true);
  response = () => Response.json(usage(100, 10, 20));
  await getClaudeQuota(a);
  headers(b, 0.1, 0.2);
  updateClaudeCredential(a, { priority: 9999 });
  assert.equal(select().credential.id, b);
  now += 61 * minute;
  response = () => new Response(null, { status: 429 });
  await getClaudeQuota(a);
  assert.equal(claudeQuotaRouting(a, "claude-sonnet-4-6").blocked, true);
  assert.equal(select().credential.id, b);
  await getClaudeQuota(b);
  now += 7 * 86400_000;
  assert.equal(claudeQuotaRouting(a, "claude-sonnet-4-6").blocked, false);
  await getClaudeQuota(a);
});

test("quota floor: default 5% skips like cooldown even with weighting off, and a bound session moves", (t) => {
  const { a, b, channel, select } = fixture();
  assert.equal(channel.quotaWeighted, false);
  assert.equal(getPublicGlobalSettings().credentialQuotaFloorPercent, 5);
  t.mock.method(Math, "random", () => 0);
  headers(a, 0.2, 0.3); headers(b, 0.2, 0.3);
  const session = randomUUID();
  const bound = select(session);
  assert.equal(bound.credential.id, a);
  recordChannelSuccess(bound.channel, 1);
  // 6% left on the weekly window is above the floor: the session stays put.
  headers(a, 0.2, 0.94);
  assert.equal(select(session).credential.id, a);
  // The 5h window is free to use up; only the weekly window counts.
  headers(a, 0.99, 0.2);
  assert.equal(select(session).credential.id, a);
  assert.equal(claudeQuotaFloorState(a, null).skipped, false);
  // Exactly 5% weekly is at the floor. The bound session moves on its next request.
  headers(a, 0.1, 0.95);
  assert.deepEqual(claudeQuotaFloorState(a, null).triggered_by, ["7d 额度 剩余 5%"]);
  const moved = select(session);
  assert.equal(moved.credential.id, b);
  recordChannelSuccess(moved.channel, 1);
  // When A recovers the session does not jump back.
  headers(a, 0, 0);
  assert.equal(select(session).credential.id, b);
});

test("quota floor: unknown, stale and reset windows are not treated as below the floor", (t) => {
  const { a, b, select } = fixture();
  t.mock.method(Math, "random", () => 0);
  updateClaudeCredential(b, { enabled: false });
  // Unknown: no quota data at all for A.
  assert.equal(select().credential.id, a);
  // Stale: a 2% observation older than 60 minutes no longer blocks.
  headers(a, 0.98, 0.98, now - 61 * minute);
  assert.equal(select().credential.id, a);
  // Fresh: the same value blocks, and with no alternative the error is explicit.
  headers(a, 0.98, 0.98, now);
  assert.throws(() => select(), (error) => error.status === 503 && error.code === "credential_quota_floor");
  // Reset: once the window's reset time passes, A is usable again without new data.
  headers(a, 0.98, 0.98, now, now + minute);
  assert.throws(() => select(), (error) => error.code === "credential_quota_floor");
  now += minute;
  assert.equal(select().credential.id, a);
});

test("quota floor: a newer observation above the floor restores the credential", (t) => {
  const { a, b, select } = fixture();
  t.mock.method(Math, "random", () => 0);
  headers(a, 0.5, 0.97); headers(b, 0.2, 0.2);
  assert.equal(select().credential.id, b);
  now += minute;
  headers(a, 0.5, 0.5);
  assert.equal(select().credential.id, a);
});

test("quota floor: a model-family weekly window only blocks that family", async (t) => {
  const { a, b, select } = fixture();
  t.mock.method(Math, "random", () => 0);
  // Opus weekly 97% used; shared 5h/7d have room.
  response = () => Response.json(usage(10, 20, 97));
  await getClaudeQuota(a);
  headers(b, 0.2, 0.2);
  assert.equal(select(randomUUID(), "claude-opus-4-7").credential.id, b);
  assert.equal(select(randomUUID(), "claude-sonnet-4-6").credential.id, a);
  const report = await getClaudeQuota(a, { refreshIfStale: false });
  assert.equal(report.quota_floor.skipped, false);
  assert.deepEqual(report.quota_floor.skipped_scopes, ["opus"]);
  assert.deepEqual(report.quota_floor.triggered_by, ["Opus 周额度 剩余 3%"]);
});

test("quota floor: lower-priority channels still serve before the explicit floor error", (t) => {
  const { a, select } = fixture();
  t.mock.method(Math, "random", () => 0);
  const low = credential();
  const backup = createChannel({ provider: "claude", credentialIds: [low], priority: 1 });
  headers(a, 0.99, 0.99);
  getMainDb().prepare("UPDATE claude_credentials SET enabled = 0 WHERE id NOT IN (?, ?)").run(a, low);
  const key = createApiKey({ channelAllowlist: [] });
  const apiKey = authenticateRelayRequest(new Request("http://relay.invalid/v1/messages", {
    headers: { authorization: `Bearer ${key.key}` },
  }));
  const pick = () => selectChannelForRequest({ operation: "messages", model: "claude-sonnet-4-6", apiKey });
  // The higher-priority channel's only usable account is at the floor; the backup serves.
  assert.equal(pick().channel.id, backup.id);
  headers(low, 0.99, 0.99);
  assert.throws(pick, (error) => error.status === 503 && error.code === "credential_quota_floor");
  void select;
});

test("quota floor: configurable, 0 disables, invalid values are rejected", (t) => {
  const { a, b, select } = fixture();
  t.mock.method(Math, "random", () => 0);
  headers(a, 0.85, 0.85); headers(b, 0.5, 0.5);
  assert.equal(select().credential.id, a);
  patchGlobalSettings({ credentialQuotaFloorPercent: 20 });
  assert.equal(select().credential.id, b);
  headers(a, 0.99, 0.99);
  patchGlobalSettings({ credentialQuotaFloorPercent: 0 });
  assert.equal(select().credential.id, a);
  for (const value of [-1, 51, 2.5, "", "abc"]) {
    assert.throws(() => patchGlobalSettings({ credentialQuotaFloorPercent: value }),
      (error) => error.code === "invalid_credential_quota_floor");
  }
  assert.equal(getPublicGlobalSettings().credentialQuotaFloorPercent, 0);
});

test("quota floor: Codex uses the WHAM cache and newer live headers, with the same rules", () => {
  const id = randomUUID();
  upsertCodexCredential({ id, email: "codex@example.invalid", accountId: randomUUID(), planType: "plus",
    tokens: { access_token: "synthetic", refresh_token: "", id_token: "", expired: "2099-01-01T00:00:00Z", last_refresh: "" } });
  const reset = new Date(now + 86400_000).toISOString();
  const cache = (fiveUsed, weekUsed, at) => upsertCodexQuotaCache({ credentialId: id, status: "low",
    retrievedAt: new Date(at).toISOString(), cache: { windows: [
      { id: "code-5h", remaining_percent: 100 - fiveUsed, reset_at: reset },
      { id: "code-7d", remaining_percent: 100 - weekUsed, reset_at: reset },
    ] } });
  assert.equal(codexQuotaFloorState(id).skipped, false);
  // An exhausted 5h window is left to the 429 cooldown, not the floor.
  cache(99, 10, now);
  assert.equal(codexQuotaFloorState(id).skipped, false);
  cache(10, 96, now);
  assert.equal(codexQuotaFloorState(id).skipped, true);
  assert.equal(codexQuotaFloorState(id).lowest_remaining_percent, 4);
  assert.deepEqual(codexQuotaFloorState(id).triggered_by, ["7d 额度 剩余 4%"]);
  // Stale WHAM data is unknown, not low.
  cache(10, 96, now - 61 * minute);
  assert.equal(codexQuotaFloorState(id).skipped, false);
  // A newer live response header above the floor wins over the older low cache.
  cache(10, 96, now - minute);
  accountQuotaHeaders("codex", id, new Headers({
    "x-codex-primary-used-percent": "10", "x-codex-primary-window-minutes": "300",
    "x-codex-secondary-used-percent": "50", "x-codex-secondary-window-minutes": "10080",
  }), now);
  assert.equal(codexQuotaFloorState(id).skipped, false);
  assert.equal(codexQuotaFloorState(id).lowest_remaining_percent, 50);
});

test("quota burn: per-cycle deltas with precision error, shared accounts, and split token classes", () => {
  now = Math.floor(Date.now() / (5 * minute)) * 5 * minute;
  const account = randomUUID(); const a = credential(account); const b = credential(account);
  const other = credential();
  const weekly = (id, week, at, reset, five) => recordClaudeQuotaHeaders(id, new Headers({
    "anthropic-ratelimit-unified-7d-utilization": String(week),
    "anthropic-ratelimit-unified-7d-reset": String(reset / 1000),
    ...(five === undefined ? {} : { "anthropic-ratelimit-unified-5h-utilization": String(five),
      "anthropic-ratelimit-unified-5h-reset": String((now + 3 * 3600_000) / 1000) }),
  }), at);
  const log = (id, at, usage) => appendRequestLog({ credentialId: id, startedAt: new Date(at).toISOString(),
    method: "POST", path: "/v1/messages", requestType: "messages", stream: true, statusCode: 200, latencyMs: 1,
    usage: { ...usage, totalTokens: usage.promptTokens + usage.completionTokens } });
  // Previous cycle, reset two hours ago: 80% -> 90% with 2M tokens between.
  const oldReset = now - 2 * 3600_000;
  weekly(a, 0.80, now - 10 * 3600_000, oldReset);
  log(a, now - 7 * 3600_000, { promptTokens: 2_000_000, cachedTokens: 1_000_000, cacheWriteTokens: 0, completionTokens: 0 });
  weekly(a, 0.90, now - 4 * 3600_000, oldReset);
  // Current cycle, observed through both imports of the account. 4% after 5%
  // is another upstream replica answering, so each end may be off by 2 steps.
  const reset = now + 5 * 86400_000;
  log(a, now - 100 * minute, { promptTokens: 9_000_000, cachedTokens: 0, completionTokens: 0 });
  weekly(a, 0.02, now - 90 * minute, reset, 0.30);
  log(a, now - 80 * minute, { promptTokens: 3_800_000, cachedTokens: 3_500_000, cacheWriteTokens: 200_000, completionTokens: 200_000 });
  weekly(b, 0.05, now - 60 * minute, reset);
  log(other, now - 50 * minute, { promptTokens: 7_000_000, cachedTokens: 0, completionTokens: 0 });
  weekly(a, 0.04, now - 55 * minute, reset);
  // Logged before cache writes were split: input and cache write together.
  log(b, now - 40 * minute, { promptTokens: 4_100_000, cachedTokens: 3_900_000, completionTokens: 100_000 });
  weekly(b, 0.10, now - 30 * minute, reset, 0.31);
  log(a, now - 10 * minute, { promptTokens: 5_000_000, cachedTokens: 0, completionTokens: 0 });

  const report = getQuotaBurnReport("claude", a);
  assert.equal(report.shared_credentials, 2);
  const week = report.windows.find((window) => window.id === "7d");
  assert.equal(week.resetAt, new Date(reset).toISOString());
  assert.equal(week.resolution, 1);
  assert.deepEqual(week.current.tokens, { requests: 2, requestsWithoutTokens: 0, input: 100_000,
    cacheRead: 7_400_000, cacheWrite: 200_000, inputUnsplit: 200_000, output: 300_000, total: 8_200_000 });
  assert.equal(week.current.delta, 8);
  assert.equal(week.current.deltaError, 2);
  assert.equal(week.current.status, "rough");
  assert.deepEqual([week.current.tokensPerPercent, week.current.tokensPerPercentLow, week.current.tokensPerPercentHigh],
    [1_025_000, 820_000, 1_366_667]);
  // The previous cycle adds its own 10% (��1) and 2M tokens; nothing spans the reset.
  assert.equal(week.recent.cycles, 2);
  assert.equal(week.recent.delta, 18);
  assert.equal(week.recent.deltaError, 3);
  assert.equal(week.recent.tokens.total, 10_200_000);
  assert.equal(week.recent.status, "ok");
  assert.deepEqual([week.recent.tokensPerPercent, week.recent.tokensPerPercentLow, week.recent.tokensPerPercentHigh],
    [566_667, 485_714, 680_000]);
  // 30% -> 31% is within one reporting step: no ratio.
  const five = report.windows.find((window) => window.id === "5h");
  assert.equal(five.current.status, "insufficient");
  assert.equal(five.current.tokensPerPercent, null);
  assert.match(five.current.reason, /精度误差/);
});

test("quota burn: Codex WHAM and header samples with reset jitter share a cycle; a reset starts over", () => {
  now = Math.floor(Date.now() / (5 * minute)) * 5 * minute;
  const id = randomUUID();
  upsertCodexCredential({ id, email: "codex@example.invalid", accountId: randomUUID(), planType: "plus",
    tokens: { access_token: "synthetic", refresh_token: "", id_token: "", expired: "2099-01-01T00:00:00Z", last_refresh: "" } });
  const reset = now - 15 * minute;
  const header = (used, at, resetAt) => accountQuotaHeaders("codex", id, new Headers({
    "x-codex-primary-used-percent": String(used), "x-codex-primary-window-minutes": "10080",
    "x-codex-primary-reset-at": String(Math.floor(resetAt / 1000)),
    "x-codex-secondary-used-percent": "0", "x-codex-secondary-window-minutes": "0", "x-codex-secondary-reset-at": "",
  }), at);
  header(10, now - 60 * minute, reset);
  appendRequestLog({ credentialId: id, startedAt: new Date(now - 40 * minute).toISOString(), method: "POST",
    path: "/v1/responses", requestType: "responses", stream: true, statusCode: 200, latencyMs: 1,
    usage: { promptTokens: 1_200_000, cachedTokens: 1_000_000, completionTokens: 50_000, totalTokens: 1_250_000 } });
  // The same reset reported 40 seconds later (reset_after_seconds drift).
  header(30, now - 20 * minute, reset + 40_000);
  // The window reset; the new cycle has a single observation.
  header(1, now - 10 * minute, reset + 7 * 86400_000);
  appendRequestLog({ credentialId: id, startedAt: new Date(now - 5 * minute).toISOString(), method: "POST",
    path: "/v1/responses", requestType: "responses", stream: true, statusCode: 200, latencyMs: 1,
    usage: { promptTokens: 9_000_000, cachedTokens: 0, completionTokens: 0, totalTokens: 9_000_000 } });

  const week = getQuotaBurnReport("codex", id).windows.find((window) => window.id === "7d");
  assert.equal(week.current.status, "insufficient");
  assert.equal(week.current.tokensPerPercent, null);
  assert.equal(week.recent.cycles, 1);
  assert.equal(week.recent.delta, 20);
  assert.equal(week.recent.deltaError, 1);
  assert.deepEqual(week.recent.tokens, { requests: 1, requestsWithoutTokens: 0, input: 200_000,
    cacheRead: 1_000_000, cacheWrite: null, inputUnsplit: 0, output: 50_000, total: 1_250_000 });
  assert.deepEqual([week.recent.tokensPerPercent, week.recent.tokensPerPercentLow, week.recent.tokensPerPercentHigh],
    [62_500, 59_524, 65_789]);
  assert.equal(getLogDb().prepare("SELECT COUNT(DISTINCT reset_key) AS n FROM quota_snapshots").get().n, 2);
});

test("Claude usage keeps cache writes separate from input", () => {
  const raw = { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 4 };
  const tracker = new UsageTracker(true);
  tracker.consume({ type: "message_start", message: { usage: raw } });
  assert.equal(tracker.usage.promptTokens, 60);
  assert.equal(tracker.usage.cachedTokens, 30);
  assert.equal(tracker.usage.cacheWriteTokens, 20);
  const message = extractUsageFromClaudeMessage({ usage: raw });
  assert.equal(message.promptTokens, 60);
  assert.equal(message.cacheWriteTokens, 20);
});