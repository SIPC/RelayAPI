import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { after, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cache-ttl-"));
process.env.DATA_DIR = dataDir;
process.env.RELAY_MAIN_DB_PATH = path.join(dataDir, "main.sqlite");
process.env.RELAY_LOG_DB_PATH = path.join(dataDir, "logs.sqlite");
process.env.RELAY_ENCRYPTION_KEY = "synthetic-cache-ttl-encryption";
process.env.RELAY_IMPORT_LEGACY_CREDENTIALS = "0";
for (const name of ["RELAY_GLOBAL_SOCKS_PROXY", "RELAY_GLOBAL_PROXY", "CODEX_PROXY"]) delete process.env[name];
const projectRoot = new URL("../", import.meta.url);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  if (specifier.startsWith("@/")) return nextResolve(new URL(specifier.slice(2) + ".ts", projectRoot).href, context);
  return nextResolve(specifier, context);
} });

const { handleClaudeMessages, handleChatCompletions } = await import("../src/server/http/relay.ts");
const { upsertClaudeCredential } = await import("../src/server/repositories/claudeCredentials.ts");
const { createChannel } = await import("../src/server/services/channels.ts");
const { createApiKey } = await import("../src/server/services/apiKeys.ts");
const { getMainDb, getLogDb } = await import("../src/server/db/sqlite.ts");
const { resetClaudeOverageHints, claudeCacheTtlFor, isUsingOverageHeaders } = await import("../src/server/claude/cacheTtl.ts");

// The mock upstream answers like api.anthropic.com's unified rate limiter. A scenario sets the
// headers the NEXT response carries; every request body and header is recorded for inspection.
const calls = [];
let rateLimit = {};
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  calls.push({ path: req.url, headers: req.headers, payload: JSON.parse(Buffer.concat(chunks).toString()) });
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const streaming = JSON.parse(Buffer.concat(chunks).toString()).stream === true;
  res.writeHead(200, { "content-type": streaming ? "text/event-stream" : "application/json",
    "anthropic-ratelimit-unified-5h-utilization": "0.25", "anthropic-ratelimit-unified-7d-utilization": "0.4",
    "anthropic-ratelimit-unified-5h-reset": reset, "anthropic-ratelimit-unified-7d-reset": reset,
    "anthropic-ratelimit-unified-status": "allowed", ...rateLimit });
  const message = { id: "msg-test", type: "message", role: "assistant", model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };
  const body = calls.at(-1).payload;
  if (body.stream !== true) return res.end(JSON.stringify(message));
  const events = [
    { type: "message_start", message: { ...message, content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  res.end(events.map((event) => "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n").join(""));
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const baseUrl = "http://127.0.0.1:" + upstream.address().port;
after(async () => {
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  getMainDb().close(); getLogDb().close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function fixture() {
  const id = "synthetic-" + randomUUID();
  upsertClaudeCredential({ id, email: "ttl@example.invalid", accountId: "10000000-0000-4000-8000-000000000001",
    tokens: { access_token: "sk-ant-oat01-synthetic", expired: "2099-01-01T00:00:00Z" } });
  const channel = createChannel({ provider: "claude", credentialId: id, baseUrl, modelAllowlist: ["claude-sonnet-4-6"] });
  const key = createApiKey({ channelAllowlist: [channel.id], modelAllowlist: ["claude-sonnet-4-6"] });
  return { id, key };
}
function request(key, payload, headers = {}) {
  return new Request("http://relay.invalid/v1/messages", { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key.key, ...headers },
    body: JSON.stringify(payload) });
}
async function send(fx, payload = {}, headers = {}) {
  const before = calls.length;
  const response = await handleClaudeMessages(request(fx.key, { model: "claude-sonnet-4-6", max_tokens: 64, system: "Stable instructions",
    messages: [{ role: "user", content: "Hello there, a question with some text" }], ...payload }, headers));
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(calls.length, before + 1);
  return calls.at(-1);
}
function ttls(body) {
  const found = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(visit);
    if (value.cache_control) found.push(value.cache_control.ttl ?? "5m");
    for (const [key, child] of Object.entries(value)) if (key !== "cache_control") visit(child);
  };
  visit(body);
  return found;
}
const betas = (call) => (call.headers["anthropic-beta"] || "").split(",");
const OVERAGE = { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-overage-status": "allowed" };

test("TTL decision follows Claude Code 2.1.332: 1h only for a subscriber's main lane, never on overage", () => {
  assert.equal(claudeCacheTtlFor({ subscriber: true, overage: false, shortLane: false }), "1h");
  assert.equal(claudeCacheTtlFor({ subscriber: true, overage: true, shortLane: false }), "5m");
  assert.equal(claudeCacheTtlFor({ subscriber: true, overage: false, shortLane: true }), "5m");
  assert.equal(claudeCacheTtlFor({ subscriber: false, overage: false, shortLane: false }), "5m", "API Keys stay on 5m");
  // Overage is read exactly as Claude Code's Ye(): window rejected AND the overage pool allowed.
  const headers = (entries) => new Headers(entries);
  assert.equal(isUsingOverageHeaders(headers({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-overage-status": "allowed" })), true);
  assert.equal(isUsingOverageHeaders(headers({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-overage-status": "allowed_warning" })), true);
  assert.equal(isUsingOverageHeaders(headers({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-overage-status": "rejected" })), false);
  assert.equal(isUsingOverageHeaders(headers({ "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-overage-status": "allowed" })), false, "overage allowed alone is not overage use");
  assert.equal(isUsingOverageHeaders(headers({})), false);
});

test("subscriber main thread: default breakpoints go out on the 1h pool with its beta", async () => {
  resetClaudeOverageHints(); rateLimit = {};
  const call = await send(fixture());
  const found = ttls(call.payload);
  assert.ok(found.length >= 2 && found.every((ttl) => ttl === "1h"), JSON.stringify(found));
  assert.ok(betas(call).includes("extended-cache-ttl-2025-04-11"));
});

test("overage: once the account is billed as overage the next request falls back to 5m and drops the 1h beta", async () => {
  resetClaudeOverageHints();
  const fx = fixture();
  rateLimit = {};
  const normal = await send(fx);
  assert.ok(ttls(normal.payload).every((ttl) => ttl === "1h"));
  // This response reports overage use; Relay learns it from the headers, like Claude Code does.
  rateLimit = OVERAGE;
  await send(fx);
  const during = await send(fx);
  assert.ok(ttls(during.payload).length >= 2 && ttls(during.payload).every((ttl) => ttl === "5m"), JSON.stringify(ttls(during.payload)));
  assert.ok(!betas(during).includes("extended-cache-ttl-2025-04-11"), "5m needs no extended TTL beta");
  // The 5m pool keeps the prefix bytes identical apart from the dropped ttl field.
  const strip = (body) => JSON.stringify(body).replaceAll(',"ttl":"1h"', "");
  assert.equal(strip(normal.payload.messages), strip(during.payload.messages));
  // Recovery: the next response without overage puts the account back on 1h.
  rateLimit = {};
  await send(fx);
  const recovered = await send(fx);
  assert.ok(ttls(recovered.payload).every((ttl) => ttl === "1h"));
});

test("overage is per credential and unknown means not overage", async () => {
  resetClaudeOverageHints();
  const overaged = fixture(), other = fixture();
  rateLimit = OVERAGE;
  await send(overaged);
  rateLimit = {};
  assert.ok(ttls((await send(other)).payload).every((ttl) => ttl === "1h"), "another account is not affected");
  assert.ok(ttls((await send(overaged)).payload).every((ttl) => ttl === "5m"), "the overaged account stays on 5m until it recovers");
  // A response without any unified header says nothing, so a fresh credential has no overage reading.
  resetClaudeOverageHints();
  const fresh = fixture();
  assert.ok(ttls((await send(fresh)).payload).every((ttl) => ttl === "1h"), "no reading: the 1h allowlist decides");
});

test("a caller's explicit TTL is kept, including 1h during overage", async () => {
  resetClaudeOverageHints();
  const fx = fixture();
  rateLimit = OVERAGE;
  await send(fx);
  const payload = { system: [{ type: "text", text: "Stable instructions", cache_control: { type: "ephemeral", ttl: "1h" } }] };
  const kept = await send(fx, payload);
  assert.deepEqual(ttls(kept.payload), ["1h"], "the caller asked for 1h and owns the marker");
  assert.ok(betas(kept).includes("extended-cache-ttl-2025-04-11"), "an explicit 1h still needs its beta");
  const fiveMinutes = await send(fx, { system: [{ type: "text", text: "Stable instructions", cache_control: { type: "ephemeral", ttl: "5m" } }] });
  assert.deepEqual(ttls(fiveMinutes.payload), ["5m"]);
  rateLimit = {};
});

// Subagent and helper lanes are classified by isClaudeSubagentRequest, which ships separately; without it every OAuth
// turn is a main turn, so this test only applies once that classifier is present.
const laneRules = fs.readFileSync(new URL("../src/server/claude/wire.ts", import.meta.url), "utf8").includes("export function isClaudeSubagentRequest");
test("subagent and helper lanes stay on 5m even on a healthy subscription", { skip: !laneRules && "lane classifier not present" }, async () => {
  resetClaudeOverageHints(); rateLimit = {};
  const fx = fixture();
  const subagent = await send(fx, {}, { "x-claude-code-agent-id": "agent-1" });
  assert.ok(ttls(subagent.payload).length >= 2 && ttls(subagent.payload).every((ttl) => ttl === "5m"));
  assert.ok(!betas(subagent).includes("extended-cache-ttl-2025-04-11"));
  const main = await send(fx);
  assert.ok(ttls(main.payload).every((ttl) => ttl === "1h"), "the main lane on the same account still gets 1h");
});

test("converted Chat requests follow the same TTL rules", async () => {
  resetClaudeOverageHints();
  const fx = fixture();
  const chat = async () => {
    const before = calls.length;
    const response = await handleChatCompletions(request(fx.key, { model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Hi, a question with enough text" }] }));
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(calls.length, before + 1);
    return calls.at(-1);
  };
  rateLimit = {};
  assert.ok(ttls((await chat()).payload).every((ttl) => ttl === "1h"));
  rateLimit = OVERAGE;
  await chat();
  assert.ok(ttls((await chat()).payload).every((ttl) => ttl === "5m"));
  rateLimit = {};
});
