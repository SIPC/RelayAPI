import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { after, beforeEach, test } from "node:test";

// Real authentication, migrations, bindings, normalizer and cache; never real accounts.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-usage-route-"));
process.env.DATA_DIR = dataDir;
process.env.RELAY_MAIN_DB_PATH = path.join(dataDir, "main.sqlite");
process.env.RELAY_LOG_DB_PATH = path.join(dataDir, "logs.sqlite");
process.env.RELAY_ENCRYPTION_KEY = "synthetic-usage-test-secret";
process.env.RELAY_IMPORT_LEGACY_CREDENTIALS = "0";
for (const name of ["RELAY_GLOBAL_SOCKS_PROXY", "RELAY_GLOBAL_PROXY", "CODEX_PROXY"]) delete process.env[name];
const projectRoot = new URL("../", import.meta.url);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  if (specifier.startsWith("@/")) return nextResolve(new URL(specifier.slice(2) + ".ts", projectRoot).href, context);
  return nextResolve(specifier, context);
} });

const { GET } = await import("../app/v1/usage/route.ts");
const { createApiKey, patchApiKey, authenticateRelayRequest } = await import("../src/server/services/apiKeys.ts");
const { createChannel, patchChannel } = await import("../src/server/services/channels.ts");
const { getChannelById } = await import("../src/server/repositories/channels.ts");
const { upsertCodexCredential, getCodexCredentialById, updateCodexCredential } = await import("../src/server/repositories/codexCredentials.ts");
const { getCodexQuota, WHAM_USAGE_URL } = await import("../src/server/services/codexQuota.ts");
const { getCodexQuotaCacheByCredentialId, upsertCodexQuotaCache } = await import("../src/server/repositories/quota.ts");
const { appendUsageRecord } = await import("../src/server/repositories/logs.ts");
const { getMainDb, getLogDb } = await import("../src/server/db/sqlite.ts");
const scriptSource = fs.readFileSync(new URL("../docs/cc-switch-usage.js", import.meta.url), "utf8");
const script = vm.runInNewContext(scriptSource);
const calls = [];
const originalFetch = globalThis.fetch;
let reply;
globalThis.fetch = async (url, init) => {
  assert.equal(url, WHAM_USAGE_URL, "unexpected external network request blocked");
  calls.push(init);
  return reply(init);
};

const now = Date.parse("2026-11-21T10:00:00Z");
function wham(used5h = 23, used7d = 68) {
  return Response.json({ rate_limit: {
    primary_window: { limit_window_seconds: 18_000, used_percent: used5h, reset_at: (Date.now() + 3600_000) / 1000 },
    secondary_window: { limit_window_seconds: 604_800, used_percent: used7d, reset_at: (Date.now() + 86_400_000) / 1000 },
  }, email: "private-upstream@example.invalid", account_id: "private-upstream-id", raw: "private-raw" });
}
function credential(options = {}) {
  const id = randomUUID();
  return upsertCodexCredential({ id, email: id + "@private.invalid", accountId: "account-" + id,
    planType: "private-plan", tokens: { access_token: "access-" + id, refresh_token: "refresh-" + id,
      id_token: "id-" + id, expired: "2099-01-01T00:00:00Z", last_refresh: "" }, ...options });
}
function channel(credentials, options = {}) {
  return createChannel({ provider: "codex", credentialIds: credentials.map(c => c.id), ...options });
}
function request(key, query = "") {
  return new Request("https://relay.invalid/v1/usage" + query, { headers: key ? { Authorization: "Bearer " + key.key } : {} });
}
async function read(key, query = "") {
  const response = await GET(request(key, query));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}
async function readInWorker(key) {
  const source = `
    import { registerHooks } from "node:module";
    const root = ${JSON.stringify(projectRoot.href)};
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
      if (specifier.startsWith("@/")) return nextResolve(new URL(specifier.slice(2) + ".ts", root).href, context);
      return nextResolve(specifier, context);
    } });
    let attempts = 0;
    globalThis.fetch = async () => { attempts++; return Response.json({ rate_limit: {
      primary_window: { limit_window_seconds: 18000, used_percent: 31 }
    } }); };
    const { GET } = await import(new URL("app/v1/usage/route.ts", root));
    const response = await GET(new Request("https://relay.invalid/v1/usage?force=1", {
      headers: { Authorization: "Bearer " + process.env.SYNTHETIC_USAGE_KEY }
    }));
    console.log(JSON.stringify({ attempts, status: response.status, body: await response.json() }));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, SYNTHETIC_USAGE_KEY: key.key }, timeout: 15_000,
  });
  return JSON.parse(stdout.trim());
}
function fixture() {
  const c = credential();
  const ch = channel([c]);
  const key = createApiKey({ channelAllowlist: [ch.id] });
  return { c, ch, key };
}
beforeEach(() => { calls.length = 0; reply = () => wham(); });
after(() => {
  globalThis.fetch = originalFetch;
  getMainDb().close(); getLogDb().close();
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dataDir).startsWith("relay-usage-route-"));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("only explicit bound channels disclose enabled Codex credentials, deduplicated without routing side effects", async () => {
  const a = credential(), b = credential(), hidden = credential(), disabled = credential({ enabled: false });
  const high = channel([a], { priority: 100, modelAllowlist: ["gpt-6.1-sol"] });
  const low = channel([a, b, disabled], { priority: 1, modelAllowlist: ["gpt-6.1-sol"] });
  const off = channel([hidden], { enabled: false });
  const mismatch = channel([hidden], { modelAllowlist: ["gpt-6.2-sol"] });
  channel([hidden]);
  updateCodexCredential(b.id, { cooldownUntil: "2099-01-01T00:00:00Z" });
  const key = createApiKey({ channelAllowlist: [high.id, low.id, off.id, mismatch.id], modelAllowlist: ["gpt-6.1-sol(high)"] });
  const result = await read(key, "?force=1&refresh=1&raw=1&credentialId=" + hidden.id);
  assert.equal(result.selection, "bound_channels");
  assert.equal(result.credentials.length, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(result.credentials.map(c => c.routingState).sort(), ["cooldown", "eligible"]);
  const serialized = JSON.stringify(result);
  for (const secret of [a.id, b.id, hidden.id, disabled.id, a.email, a.accountId, a.tokens.access_token,
    "private-plan", "private-upstream", "private-raw", "credential_id", "account_id", "proxy", "raw"]) {
    assert.ok(!serialized.includes(secret), "must not disclose " + secret);
  }
  assert.equal(getChannelById(high.id).lastUsedAt, null);
  assert.equal(getCodexCredentialById(a.id).lastUsedAt, null);
  assert.equal((await read(key)).credentials[0].ref, result.credentials[0].ref);
  assert.equal(calls.length, 2, "client force/raw never bypass TTL");
  const otherKey = createApiKey({ channelAllowlist: [high.id] });
  const other = await read(otherKey);
  assert.ok(!result.credentials.some(c => c.ref === other.credentials[0].ref), "aliases are Key-scoped");
  assert.deepEqual((await read(createApiKey())).credentials, [], "empty allowlist does not reveal the OAuth pool");
  patchChannel(low.id, { credentialIds: [a.id] });
  patchChannel(high.id, { enabled: false });
  assert.equal((await read(key)).credentials.length, 1, "removed credentials are not disclosed from cache");
  updateCodexCredential(a.id, { enabled: false });
  assert.deepEqual((await read(key)).credentials, [], "disabled credentials withdraw visibility");
  patchApiKey(key.id, { channelAllowlist: [] });
  assert.deepEqual((await read(key)).credentials, [], "revocation ignores previously cached visibility");
});

test("authentication rejects missing/invalid/disabled/expired keys, but daily exhaustion does not block usage", async (t) => {
  t.mock.method(console, "error", () => {});
  const { ch } = fixture();
  for (const [key, status] of [[null, 401], [{ key: "invalid" }, 401],
    [createApiKey({ enabled: false }), 403], [createApiKey({ expiresAt: "2000-01-01T00:00:00Z" }), 403]]) {
    const response = await GET(request(key));
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const key = createApiKey({ channelAllowlist: [ch.id], tokenLimitDaily: 1 });
  appendUsageRecord({ createdAt: new Date().toISOString(), apiKeyId: key.id, model: "gpt-6.1-sol",
    usage: { promptTokens: 12, completionTokens: 5, totalTokens: 17, cachedTokens: 0 } });
  assert.throws(() => authenticateRelayRequest(request(key)), e => e.status === 429);
  assert.equal((await read(key)).credentials.length, 1);
  assert.throws(() => authenticateRelayRequest(request(key)), e => e.status === 429, "generation admission stays unchanged");
});

test("two credentials keep four independent rows, reset times, 0% and 100%; extractor joins base URLs correctly", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const a = credential(), b = credential();
  const ch = channel([a, b]);
  const key = createApiKey({ channelAllowlist: [ch.id] });
  reply = init => init.headers["Chatgpt-Account-Id"] === a.accountId ? wham(0, 91) : wham(100, 42);
  const result = await read(key);
  const rows = JSON.parse(JSON.stringify(script.extractor(result)));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => row.remaining).sort((a,b) => a-b), [0, 9, 58, 100]);
  assert.ok(rows.every(row => row.total === 100 && row.unit === "%"));
  assert.equal(new Set(rows.map(row => row.planName)).size, 4);
  assert.ok(rows.some(row => row.extra.includes("2026-11-21T11:00:00.000Z")));
  assert.ok(rows.some(row => row.extra.includes("2026-11-22T10:00:00.000Z")));
  assert.ok(rows.every(row => row.extra.includes("快照 2026-11-21T10:00:00.000Z")));
  for (const base of ["https://relay.invalid/prefix", "https://relay.invalid/prefix/", "https://relay.invalid/prefix/v1", "https://relay.invalid/prefix/v1/"]) {
    const configured = vm.runInNewContext(scriptSource.replaceAll("{{baseUrl}}", base).replaceAll("{{apiKey}}", "synthetic-key"));
    assert.equal(configured.request.url, "https://relay.invalid/prefix/v1/usage");
    assert.equal(configured.request.headers.Authorization, "Bearer synthetic-key");
  }
});

test("concurrent keys and admin refresh share one WHAM request and cannot force a fresh snapshot", async () => {
  const { c, ch, key } = fixture();
  const secondKey = createApiKey({ channelAllowlist: [ch.id] });
  let release;
  reply = () => new Promise(resolve => { release = resolve; });
  const admin = getCodexQuota({ credentialId: c.id, forceRefresh: true, includeRaw: true });
  const reads = Array.from({ length: 12 }, (_, i) => read(i % 2 ? key : secondKey, "?force=1&raw=1"));
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  release(wham());
  const [report, ...results] = await Promise.all([admin, ...reads]);
  assert.ok(report.raw);
  assert.ok(results.every(result => !JSON.stringify(result).includes("private-raw")));
  await getCodexQuota({ credentialId: c.id, forceRefresh: true });
  await read(key, "?refresh=1");
  assert.equal(calls.length, 1);
});

test("stale snapshots survive 429, honor Retry-After, hide only reset windows, and expire after ten minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  t.mock.method(console, "error", () => {});
  const { c, key } = fixture();
  await read(key);
  // Keep the real normalized snapshot, with one earlier independent reset.
  const cached = getCodexQuotaCacheByCredentialId(c.id);
  cached.cache.windows[0].reset_at = new Date(now + 120_000).toISOString();
  upsertCodexQuotaCache({ ...cached, cache: cached.cache });
  t.mock.timers.tick(121_000);
  reply = () => new Response("private-upstream-error", { status: 429, headers: { "retry-after": "600" } });
  const result = await read(key);
  assert.equal(result.credentials[0].cache.state, "stale");
  assert.equal(result.credentials[0].windows[0].usedPercent, null);
  assert.equal(result.credentials[0].windows[0].state, "reset_pending");
  assert.equal(result.credentials[0].windows[1].remainingPercent, 32);
  assert.equal(calls.length, 2);
  assert.equal(script.extractor(result).length, 1);
  assert.ok(script.extractor(result)[0].extra.includes("另有 1 项额度未知"));
  t.mock.timers.tick(480_000);
  const expired = await read(key, "?force=1");
  assert.equal(expired.credentials[0].cache.state, "expired");
  assert.ok(expired.credentials[0].windows.every(w => w.usedPercent === null));
  assert.throws(() => script.extractor(expired), /暂无可用快照/);
  assert.equal(calls.length, 2, "Retry-After survives polling");
  assert.equal(getCodexQuotaCacheByCredentialId(c.id).retrievedAt, new Date(now).toISOString());
  t.mock.timers.tick(120_000);
  reply = () => wham(7, 81);
  assert.equal((await read(key)).credentials[0].windows[1].remainingPercent, 19);
  assert.equal(calls.length, 3);
});

test("cold failures back off exponentially, keep missing values unknown, and recover", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  t.mock.method(console, "error", () => {});
  const { key } = fixture();
  reply = () => { throw new Error("private-network-error"); };
  const missing = await read(key);
  assert.equal(missing.credentials[0].cache.state, "missing");
  assert.ok(missing.credentials[0].windows.every(w => w.remainingPercent === null));
  assert.ok(!JSON.stringify(missing).includes("private-network-error"));
  assert.throws(() => script.extractor(missing), /暂无可用快照/);
  await read(key); assert.equal(calls.length, 1);
  t.mock.timers.tick(30_000);
  await read(key); assert.equal(calls.length, 2);
  t.mock.timers.tick(30_000);
  await read(key); assert.equal(calls.length, 2, "second failure waits 60 seconds");
  t.mock.timers.tick(30_000);
  reply = () => wham();
  assert.equal((await read(key)).credentials[0].windows[0].usedPercent, 23);
  assert.equal(calls.length, 3);
});

test("nonstandard durations are not mislabeled, and a primary weekly window is not duplicated as 5h", async () => {
  const { key } = fixture();
  reply = () => Response.json({ rate_limit: {
    primary_window: { limit_window_seconds: 604_800, used_percent: 37 },
    secondary_window: { limit_window_seconds: 86_400, used_percent: 88 },
  } });
  const result = await read(key);
  assert.equal(result.credentials[0].windows[0].remainingPercent, null);
  assert.equal(result.credentials[0].windows[1].remainingPercent, 63);
  assert.equal(script.extractor(result).length, 1);
});

test("an overall exhausted flag does not fabricate missing per-window percentages", async () => {
  const { key } = fixture();
  reply = () => Response.json({ rate_limit: { limit_reached: true, allowed: false,
    primary_window: { limit_window_seconds: 18_000, used_percent: 100, reset_after_seconds: 300 },
    secondary_window: { limit_window_seconds: 604_800, reset_after_seconds: 3600 },
  } });
  const result = await read(key);
  assert.equal(result.credentials[0].windows[0].remainingPercent, 0);
  assert.equal(result.credentials[0].windows[1].remainingPercent, null);
  const rows = script.extractor(result);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].remaining, 0);
  assert.ok(rows[0].extra.includes("另有 1 项额度未知"));
});

test("binding revocation during an in-flight refresh is applied before responding", async () => {
  const { key } = fixture();
  let release;
  reply = () => new Promise(resolve => { release = resolve; });
  const pending = read(key);
  await new Promise(setImmediate);
  patchApiKey(key.id, { channelAllowlist: [] });
  release(wham());
  assert.deepEqual((await pending).credentials, []);
});

test("global refresh cap returns missing for overflow credentials then fills them on a later poll", async () => {
  const credentials = Array.from({ length: 6 }, () => credential());
  const ch = channel(credentials);
  const key = createApiKey({ channelAllowlist: [ch.id] });
  const releases = [];
  reply = () => new Promise(resolve => releases.push(resolve));
  const pending = read(key);
  await new Promise(setImmediate);
  assert.equal(calls.length, 4);
  releases.forEach(resolve => resolve(wham()));
  const first = await pending;
  assert.equal(first.credentials.filter(c => c.cache.state === "missing").length, 2);
  reply = () => wham();
  assert.ok((await read(key)).credentials.every(c => c.cache.state === "fresh"));
  assert.equal(calls.length, 6);
});

test("independent workers honor shared leases, persistent backoff, and recover abandoned leases", async (t) => {
  t.mock.method(console, "error", () => {});
  const { key } = fixture();
  let release;
  reply = () => new Promise(resolve => { release = resolve; });
  const pending = read(key);
  await new Promise(setImmediate);
  try {
    const locked = await readInWorker(key);
    assert.equal(locked.status, 200);
    assert.equal(locked.attempts, 0);
    assert.equal(locked.body.credentials[0].cache.state, "missing");
  } finally {
    release(wham());
    await pending;
  }
  const fresh = await readInWorker(key);
  assert.equal(fresh.attempts, 0);
  assert.equal(fresh.body.credentials[0].windows[0].remainingPercent, 77);

  const failing = fixture();
  reply = () => new Response("synthetic", { status: 503 });
  await read(failing.key);
  const backoff = await readInWorker(failing.key);
  assert.equal(backoff.attempts, 0, "a fresh worker cannot bypass persisted retry state");
  assert.equal(backoff.body.credentials[0].cache.state, "missing");

  const abandoned = fixture();
  getMainDb().prepare(`INSERT INTO codex_quota_refresh (credential_id, owner, lease_until) VALUES (?, ?, ?)`)
    .run(abandoned.c.id, "stopped-worker", Date.now() - 1000);
  const recovered = await readInWorker(abandoned.key);
  assert.equal(recovered.attempts, 1);
  assert.equal(recovered.body.credentials[0].windows[0].remainingPercent, 69);
});

test("invalid successful upstream responses preserve the last usable snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  t.mock.method(console, "error", () => {});
  const { c, key } = fixture();
  await read(key);
  t.mock.timers.tick(121_000);
  reply = () => new Response("<html>private-error-page</html>", { status: 200 });
  const result = await read(key);
  assert.equal(result.credentials[0].cache.state, "stale");
  assert.equal(result.credentials[0].windows[0].remainingPercent, 77);
  assert.equal(getCodexQuotaCacheByCredentialId(c.id).retrievedAt, new Date(now).toISOString());
  await read(key);
  assert.equal(calls.length, 2, "malformed payloads are failures subject to backoff");
});
