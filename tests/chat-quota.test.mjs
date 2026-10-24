import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { after, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-chat-quota-"));
process.env.DATA_DIR = dataDir;
process.env.RELAY_MAIN_DB_PATH = path.join(dataDir, "main.sqlite");
process.env.RELAY_LOG_DB_PATH = path.join(dataDir, "logs.sqlite");
process.env.RELAY_ENCRYPTION_KEY = "synthetic-quota-encryption";
process.env.RELAY_IMPORT_LEGACY_CREDENTIALS = "0";
const projectRoot = new URL("../", import.meta.url);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  if (specifier.startsWith("@/")) return nextResolve(new URL(specifier.slice(2) + ".ts", projectRoot).href, context);
  return nextResolve(specifier, context);
} });
const { accountQuotaHeaders: quota, parseAccountQuotaHeaders: parse, withAccountQuotaHeaders, copyAccountQuotaHeaders } =
  await import("../src/server/http/accountQuota.ts");
const { addCorsHeaders } = await import("../src/server/http/cors.ts");
const { upsertCodexQuotaCache } = await import("../src/server/repositories/quota.ts");
const { upsertCodexCredential } = await import("../src/server/repositories/codexCredentials.ts");
const { getMainDb, getLogDb } = await import("../src/server/db/sqlite.ts");
const now = Date.parse("2026-10-24T12:00:00Z");
const live = () => new Headers({
  "x-codex-primary-used-percent": "25", "x-codex-primary-window-minutes": "300",
  "x-codex-primary-reset-after-seconds": "3600",
  "x-codex-secondary-used-percent": "40", "x-codex-secondary-window-minutes": "10080",
  "x-codex-secondary-reset-at": String((now + 86400000) / 1000),
});
after(() => {
  getMainDb().close(); getLogDb().close();
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dataDir).startsWith("relay-chat-quota-"));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("Codex quota maps durations, percentages and absolute/relative resets", () => {
  const headers = quota("codex", randomUUID(), live(), now);
  assert.equal(headers.get("x-relay-quota-provider"), "codex");
  assert.equal(headers.get("x-relay-quota-source"), "upstream");
  assert.equal(headers.get("x-relay-quota-5h-remaining-percent"), "75");
  assert.equal(headers.get("x-relay-quota-7d-remaining-percent"), "60");
  assert.equal(headers.get("x-relay-quota-5h-reset-at"), "2026-10-24T13:00:00.000Z");
  assert.equal(headers.get("x-relay-quota-7d-reset-at"), "2026-10-25T12:00:00.000Z");
  assert.equal(headers.get("x-codex-primary-used-percent"), "25");
});
test("Additional Codex model quotas cannot replace the primary account window", () => {
  const headers = live();
  headers.set("x-codex-additional-spark-primary-used-percent", "95");
  headers.set("x-codex-additional-spark-primary-window-minutes", "300");
  const result = quota("codex", randomUUID(), headers, now);
  assert.equal(result.get("x-relay-quota-5h-remaining-percent"), "75");
  assert.equal(result.get("x-relay-quota-additional-spark-primary-remaining-percent"), "5");
});
test("Claude utilization and request limits remain distinct quota windows", () => {
  const headers = quota("claude", randomUUID(), new Headers({
    "anthropic-ratelimit-unified-5h-utilization": "0.25",
    "anthropic-ratelimit-unified-7d-utilization": "0",
    "anthropic-ratelimit-unified-5h-reset": "2026-10-24T13:00:00Z",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-requests-limit": "100", "anthropic-ratelimit-requests-remaining": "80",
    "x-ratelimit-limit-tokens": "1000", "x-ratelimit-remaining-tokens": "500",
  }), now);
  assert.equal(headers.get("x-relay-quota-5h-remaining-percent"), "75");
  assert.equal(headers.get("x-relay-quota-7d-remaining-percent"), "100");
  assert.equal(headers.get("x-relay-quota-5h-status"), "allowed");
  assert.equal(headers.get("x-relay-quota-requests-remaining"), "80");
  assert.equal(headers.get("x-relay-quota-tokens-remaining-percent"), "50");
});
test("Missing or invalid quota values never become zero remaining", () => {
  for (const provider of ["codex", "claude"]) for (const value of ["", "NaN", "-1", "Infinity"]) {
    const name = provider === "codex" ? "x-codex-primary-used-percent" : "anthropic-ratelimit-unified-5h-utilization";
    const snapshot = parse(provider, new Headers({ [name]: value }), now);
    assert.equal(snapshot.windows.length, 0);
  }
  const result = quota("codex", randomUUID(), new Headers(), now);
  assert.equal(result.get("x-relay-quota-source"), "unavailable");
  assert.equal(result.get("x-relay-quota-5h-remaining-percent"), null);
  assert.equal(result.get("x-relay-quota-observed-at"), null);
});
test("Cache is isolated by account and provider, with an explicit age and expiry", () => {
  const id = randomUUID();
  quota("codex", id, live(), now);
  const cached = quota("codex", id, new Headers(), now + 10000);
  assert.equal(cached.get("x-relay-quota-source"), "cache");
  assert.equal(cached.get("x-relay-quota-age-seconds"), "10");
  assert.equal(cached.get("x-relay-quota-observed-at"), new Date(now).toISOString());
  assert.equal(cached.get("x-codex-primary-used-percent"), null);
  assert.equal(quota("codex", randomUUID(), new Headers(), now).get("x-relay-quota-source"), "unavailable");
  assert.equal(quota("claude", id, new Headers(), now).get("x-relay-quota-source"), "unavailable");
  assert.equal(quota("codex", id, new Headers(), now + 300001).get("x-relay-quota-source"), "unavailable");
  assert.equal(quota("codex", id, new Headers(), now - 1).get("x-relay-quota-source"), "unavailable");
});
test("Cached windows are dropped individually after their reset time", () => {
  const id = randomUUID();
  const headers = live(); headers.set("x-codex-primary-reset-after-seconds", "5");
  quota("codex", id, headers, now);
  const cached = quota("codex", id, new Headers(), now + 6000);
  assert.equal(cached.get("x-relay-quota-5h-remaining-percent"), null);
  assert.equal(cached.get("x-relay-quota-7d-remaining-percent"), "60");
});
test("Codex existing persisted cache is used only while fresh, without account details", () => {
  const id = randomUUID();
  upsertCodexCredential({ id, email: "private@example.invalid", accountId: "private-account", planType: "plus",
    tokens: { access_token: "synthetic", expired: "2099-01-01T00:00:00Z" } });
  upsertCodexQuotaCache({ credentialId: id, status: "ok", retrievedAt: new Date(now - 2000).toISOString(),
    cache: { email: "private@example.invalid", account_id: "private-account", windows: [
      { id: "code-5h", used_percent: 10, remaining_percent: 90, reset_at: "2026-10-24T13:00:00Z" },
      { id: "code-7d", used_percent: null, remaining_percent: null },
    ] } });
  const result = quota("codex", id, new Headers(), now);
  assert.equal(result.get("x-relay-quota-source"), "cache");
  assert.equal(result.get("x-relay-quota-age-seconds"), "2");
  assert.equal(result.get("x-relay-quota-5h-remaining-percent"), "90");
  assert.equal(result.get("x-relay-quota-7d-remaining-percent"), null);
  assert.ok(!JSON.stringify([...result]).includes("private"));
  assert.equal(quota("codex", id, new Headers(), now + 300000).get("x-relay-quota-source"), "unavailable");
});
test("Response decoration preserves SSE body and status, strips forged Relay quota fields", async () => {
  const response = withAccountQuotaHeaders(new Response("data: hello\n\n", { status: 429, headers: {
    ...Object.fromEntries(live()), "content-type": "text/event-stream",
    "x-relay-quota-provider": "forged", "x-relay-quota-fake-remaining-percent": "100",
  } }), "codex", randomUUID());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("x-relay-quota-provider"), "codex");
  assert.equal(response.headers.get("x-relay-quota-fake-remaining-percent"), null);
  assert.equal(await response.text(), "data: hello\n\n");
});
test("Converted response headers copy only quota fields and CORS exposes them", () => {
  const upstream = quota("codex", randomUUID(), live(), now);
  for (const name of ["authorization", "chatgpt-account-id", "set-cookie"]) upstream.set(name, "private");
  const copied = copyAccountQuotaHeaders(upstream);
  for (const name of ["authorization", "chatgpt-account-id", "set-cookie"]) assert.equal(copied.get(name), null);
  copied.set("Access-Control-Expose-Headers", "X-Existing");
  const response = addCorsHeaders(new Response("hello", { headers: copied }));
  const exposed = response.headers.get("access-control-expose-headers").toLowerCase().split(/,\s*/);
  assert.ok(exposed.includes("x-existing"));
  assert.ok(exposed.includes("x-relay-quota-5h-remaining-percent"));
  assert.ok(exposed.includes("x-codex-primary-used-percent"));
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});
