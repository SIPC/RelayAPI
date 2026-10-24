import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { after, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-chat-route-"));
process.env.DATA_DIR = dataDir;
process.env.RELAY_MAIN_DB_PATH = path.join(dataDir, "main.sqlite");
process.env.RELAY_LOG_DB_PATH = path.join(dataDir, "logs.sqlite");
process.env.RELAY_ENCRYPTION_KEY = "synthetic-chat-route-encryption";
process.env.RELAY_IMPORT_LEGACY_CREDENTIALS = "0";
for (const name of ["RELAY_GLOBAL_SOCKS_PROXY", "RELAY_GLOBAL_PROXY", "CODEX_PROXY"]) delete process.env[name];
const projectRoot = new URL("../", import.meta.url);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  if (specifier.startsWith("@/")) return nextResolve(new URL(specifier.slice(2) + ".ts", projectRoot).href, context);
  return nextResolve(specifier, context);
} });
const { handleChatCompletions, handleOpenAIResponses: handleResponses, handleClaudeMessages, handleClaudeCountTokens } =
  await import("../src/server/http/relay.ts");
const { upsertCodexCredential } = await import("../src/server/repositories/codexCredentials.ts");
const { upsertClaudeCredential, getClaudeCredentialWithTokens } = await import("../src/server/repositories/claudeCredentials.ts");
const { createChannel } = await import("../src/server/services/channels.ts");
const { createApiKey } = await import("../src/server/services/apiKeys.ts");
const { getMainDb, getLogDb } = await import("../src/server/db/sqlite.ts");
const calls = [];
const accountId = "10000000-0000-4000-8000-000000000001";
const system = "CUSTOM_SYSTEM_SENTINEL: Reply in Chinese.";
let mode = "normal";
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString());
  calls.push({ path: req.url, headers: req.headers, payload });
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const quotaHeaders = req.url.endsWith("/responses") ? {
    "x-codex-primary-used-percent": "25", "x-codex-primary-window-minutes": "300",
    "x-codex-secondary-used-percent": "40", "x-codex-secondary-window-minutes": "10080",
    "x-codex-primary-reset-at": reset, "x-codex-secondary-reset-at": reset,
  } : {
    "anthropic-ratelimit-unified-5h-utilization": "0.25", "anthropic-ratelimit-unified-7d-utilization": "0.4",
    "anthropic-ratelimit-unified-5h-reset": reset, "anthropic-ratelimit-unified-7d-reset": reset,
  };
  if (mode === "rate-limited") {
    res.writeHead(429, { "content-type": "application/json", ...quotaHeaders });
    res.end('{"type":"error","error":{"type":"rate_limit_error","message":"synthetic limit"}}'); return;
  }
  if (mode === "reject") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end('{"type":"error","error":{"type":"invalid_request_error","message":"synthetic rejection"}}'); return;
  }
  const headers = { "content-type": "application/json", "set-cookie": "private", "anthropic-organization-id": "private-org", ...quotaHeaders };
  if (req.url.includes("count_tokens")) { res.writeHead(200, headers); res.end('{"input_tokens":12}'); return; }
  if (req.url.endsWith("/responses")) {
    res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
    const response = { id: "resp-test", object: "response", model: payload.model,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "你好" }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
    const events = [
      { type: "response.created", response: { ...response, output: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "你好" },
      { type: "response.completed", response },
    ];
    for (const event of events) res.write("data: " + JSON.stringify(event) + "\n\n");
    res.end(); return;
  }
  const message = { id: "msg-test", type: "message", role: "assistant", model: payload.model,
    content: [{ type: "text", text: "你好" }], stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 } };
  if (!payload.stream) { res.writeHead(200, headers); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
  const events = [
    { type: "message_start", message: { ...message, content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    ...(mode === "truncated" ? [] : [{ type: "message_stop" }]),
  ];
  const bytes = Buffer.from(events.map((event) => "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n").join(""));
  for (let i = 0; i < bytes.length; i += 17) res.write(bytes.subarray(i, i + 17));
  res.end();
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const baseUrl = "http://127.0.0.1:" + upstream.address().port;
after(async () => {
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  getMainDb().close(); getLogDb().close();
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dataDir).startsWith("relay-chat-route-"));
  fs.rmSync(dataDir, { recursive: true, force: true });
});
function setup(provider) {
  const id = "synthetic-" + randomUUID();
  const model = provider === "claude" ? "claude-sonnet-4-6" : "gpt-6.1-sol";
  const input = { id, email: "test@example.invalid", accountId,
    tokens: { access_token: provider === "claude" ? "sk-ant-oat01-synthetic" : "synthetic-codex",
      expired: "2099-01-01T00:00:00Z" }, metadata: { upstream_transport: "websocket" } };
  if (provider === "claude") upsertClaudeCredential(input);
  else upsertCodexCredential({ ...input, planType: "plus" });
  const channel = createChannel({ provider, credentialId: id,
    baseUrl: baseUrl + (provider === "claude" ? "" : "/backend-api/codex"), modelAllowlist: [model] });
  const key = createApiKey({ channelAllowlist: [channel.id], modelAllowlist: [model] });
  return { id, channel, key, model };
}
function request(key, payload, url = "/v1/chat/completions", extra = {}) {
  return new Request("http://relay.invalid" + url, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key.key, ...extra },
    body: JSON.stringify(payload),
  });
}
function log(channel) {
  return getLogDb().prepare("SELECT * FROM request_logs WHERE channel_id=? ORDER BY rowid DESC LIMIT 1").get(channel.id);
}
function assertQuota(response, provider) {
  assert.equal(response.headers.get("x-relay-quota-provider"), provider);
  assert.equal(response.headers.get("x-relay-quota-source"), "upstream");
  assert.equal(response.headers.get("x-relay-quota-5h-remaining-percent"), "75");
  assert.equal(response.headers.get("x-relay-quota-7d-remaining-percent"), "60");
  assert.ok(response.headers.get("x-relay-quota-5h-reset-at"));
  const raw = provider === "codex" ? "x-codex-primary-used-percent" : "anthropic-ratelimit-unified-5h-utilization";
  assert.ok(response.headers.get(raw));
}
for (const protocol of ["chat", "responses"]) for (const stream of [false, true]) {
  test("OAI " + protocol + ", stream=" + stream + ": real HTTP request and parameter fidelity", async () => {
    mode = "normal";
    const { channel, key, model } = setup("codex");
    const payload = { model, stream, service_tier: "ultrafast", prompt_cache_key: "caller-cache", parallel_tool_calls: false };
    if (protocol === "chat") payload.messages = [{ role: "user", content: "Hi" }];
    else payload.input = "Hi";
    const response = await (protocol === "chat" ? handleChatCompletions : handleResponses)(request(key, payload, "/v1/" + protocol, { "thread-id": "caller-thread" }));
    assert.equal(response.status, 200);
    assertQuota(response, "codex");
    assert.ok((await response.text()).includes("你好"));
    const call = calls.at(-1);
    assert.equal(call.path, "/backend-api/codex/responses");
    assert.equal(call.headers.upgrade, undefined);
    assert.equal(call.headers.accept, "text/event-stream");
    assert.equal(call.headers["x-codex-routing-hint"], "model=" + model + ";tier=ultrafast");
    assert.equal(call.headers["thread-id"], "caller-thread");
    assert.equal(call.payload.parallel_tool_calls, false);
    assert.equal(call.payload.prompt_cache_key, "caller-cache");
    assert.equal(call.payload.service_tier, "ultrafast");
    assert.equal(log(channel).status_code, 200);
  });
}
for (const protocol of ["chat", "responses"]) for (const stream of [false, true]) {
  test("Claude via " + protocol + ", stream=" + stream + ": system, headers and persistent identity", async () => {
    mode = "normal";
    const { id, channel, key, model } = setup("claude");
    const payload = { model, stream, reasoning_effort: "high" };
    if (protocol === "chat") payload.messages = [{ role: "system", content: system }, { role: "user", content: "Hi" }];
    else { payload.instructions = system; payload.input = "Hi"; }
    const run = () => (protocol === "chat" ? handleChatCompletions : handleResponses)(request(key, payload));
    const first = await run();
    assert.equal(first.status, 200);
    assertQuota(first, "claude");
    assert.ok((await first.text()).includes("你好"));
    const call = calls.at(-1);
    assert.equal(call.path, "/v1/messages?beta=true");
    assert.ok(JSON.stringify(call.payload).includes(system));
    const identity = JSON.parse(call.payload.metadata.user_id);
    assert.equal(identity.account_uuid, accountId);
    assert.equal(identity.session_id, call.headers["x-claude-code-session-id"]);
    assert.equal(identity.device_id, getClaudeCredentialWithTokens(id).metadata.device_ids[0]);
    assert.equal(call.headers["user-agent"], "claude-cli/2.1.280 (external, cli)");
    assert.equal(call.headers["x-stainless-package-version"], "0.112.1");
    assert.ok(call.headers["anthropic-beta"].includes("extended-cache-ttl-2025-04-11"));
    assert.ok(!call.headers["anthropic-beta"].includes("fast-mode-2026-02-01"));
    const second = await run(); await second.text();
    assert.equal(calls.at(-1).payload.metadata.user_id, call.payload.metadata.user_id);
    assert.equal(log(channel).status_code, 200);
  });
}
for (const stream of [false, true]) {
  test("Native Claude Messages, stream=" + stream + ": native protocol and usage logging", async () => {
    mode = "normal";
    const { channel, key, model } = setup("claude");
    const response = await handleClaudeMessages(request(key, {
      model, stream, max_tokens: 100, system, messages: [{ role: "user", content: "Hi" }],
    }, "/v1/messages"));
    assert.equal(response.status, 200);
    assertQuota(response, "claude");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("anthropic-organization-id"), null);
    const body = await response.text();
    if (stream) {
      assert.ok(body.includes("event: message_stop"));
      assert.ok(!body.includes("chat.completion"));
    } else {
      const result = JSON.parse(body);
      assert.equal(result.type, "message");
      assert.equal(result.content[0].text, "你好");
    }
    assert.equal(log(channel).prompt_tokens, 10);
    assert.equal(log(channel).completion_tokens, 5);
  });
}
test("Native Claude token counting keeps caller instructions in the counted payload", async () => {
  mode = "normal";
  const { key, model } = setup("claude");
  const response = await handleClaudeCountTokens(request(key, {
    model, system, messages: [{ role: "user", content: "Hi" }],
  }, "/v1/messages/count_tokens"));
  assert.equal(response.status, 200);
  assertQuota(response, "claude");
  assert.deepEqual(await response.json(), { input_tokens: 12 });
  const call = calls.at(-1);
  assert.equal(call.path, "/v1/messages/count_tokens?beta=true");
  assert.ok(JSON.stringify(call.payload).includes(system));
  assert.equal(call.payload.stream, undefined);
  assert.equal(call.payload.max_tokens, undefined);
});
test("Native Claude truncated SSE is an error in output and logs", async () => {
  mode = "truncated";
  const { channel, key, model } = setup("claude");
  const response = await handleClaudeMessages(request(key, { model, stream: true, messages: [{ role: "user", content: "Hi" }] }));
  assert.ok((await response.text()).includes("ended before message_stop"));
  assert.equal(log(channel).status_code, 502);
  assert.equal(log(channel).error_code, "stream_error");
});
test("Native Claude upstream errors retain the Claude error format", async () => {
  mode = "reject";
  const { channel, key, model } = setup("claude");
  const response = await handleClaudeMessages(request(key, { model, messages: [{ role: "user", content: "Hi" }] }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.type, "invalid_request_error");
  assert.equal(log(channel).error_code, "upstream_error");
});

test("OAI Responses defaults to a JSON response when stream is omitted", async () => {
  mode = "normal";
  const { key, model } = setup("codex");
  const response = await handleResponses(request(key, { model, input: "Hi" }, "/v1/responses"));
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("content-type").startsWith("application/json"));
  assert.ok(JSON.stringify(await response.json()).includes("你好"));
});
test("Native Claude Code HTTP request preserves native body and rebinds selected OAuth identity", async () => {
  mode = "normal";
  const { key, model } = setup("claude");
  const sessionId = "20000000-0000-4000-8000-000000000002";
  const payload = { model, stream: false, max_tokens: 100,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "5m" } }],
    messages: [{ role: "user", content: "Hi" }], temperature: 0.7,
    metadata: { user_id: JSON.stringify({ device_id: "cd".repeat(32), account_uuid: accountId, session_id: sessionId }) } };
  const response = await handleClaudeMessages(new Request("http://relay.invalid/v1/messages", {
    method: "POST", body: JSON.stringify(payload),
    headers: { "content-type": "application/json", "x-api-key": key.key,
      "user-agent": "claude-cli/2.1.280 (external, cli)", "x-app": "cli",
      "anthropic-beta": "claude-code-20250219", "x-claude-code-session-id": sessionId,
      "x-stainless-package-version": "0.112.1" },
  }));
  assert.equal(response.status, 200);
  await response.text();
  const call = calls.at(-1);
  assert.deepEqual(call.payload.system, payload.system);
  assert.deepEqual(call.payload.messages, payload.messages);
  assert.equal(call.payload.temperature, 0.7);
  assert.equal(call.headers.authorization, "Bearer sk-ant-oat01-synthetic");
  assert.equal(call.headers["x-api-key"], undefined);
  assert.equal(call.headers["x-claude-code-session-id"], sessionId);
  assert.equal(JSON.parse(call.payload.metadata.user_id).session_id, sessionId);
  assert.notEqual(JSON.parse(call.payload.metadata.user_id).device_id, "cd".repeat(32));
});

for (const provider of ["codex", "claude"]) for (const protocol of ["chat", "responses"]) for (const stream of [false, true]) {
  test(provider + " " + protocol + " stream=" + stream + ": quota survives upstream 429 without another probe", async () => {
    mode = "rate-limited";
    const { key, model } = setup(provider);
    const payload = { model, stream };
    if (protocol === "chat") payload.messages = [{ role: "user", content: "Hi" }];
    else payload.input = "Hi";
    const before = calls.length;
    const response = await (protocol === "chat" ? handleChatCompletions : handleResponses)(request(key, payload));
    assert.equal(response.status, 429);
    assertQuota(response, provider);
    await response.text();
    assert.equal(calls.length, before + 1);
  });
}
for (const stream of [false, true]) test("Native Claude stream=" + stream + ": quota survives upstream 429", async () => {
  mode = "rate-limited";
  const { key, model } = setup("claude");
  const response = await handleClaudeMessages(request(key, { model, stream, messages: [{ role: "user", content: "Hi" }] }));
  assert.equal(response.status, 429);
  assertQuota(response, "claude");
  assert.equal((await response.json()).error.type, "rate_limit_error");
});
