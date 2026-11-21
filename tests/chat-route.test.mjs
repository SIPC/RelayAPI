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
let breakCodexStream;
let codexStreamClosed;
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
  if (req.url.endsWith("/responses") && mode === "codex-tool") {
    // Calls the first declared tool by its (possibly shortened) upstream name.
    res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
    const item = { type: "function_call", call_id: "call_1", name: payload.tools[0].name, arguments: "{\"q\":\"b\"}" };
    const response = { id: "resp-tool", object: "response", model: payload.model, output: [item],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
    for (const event of [
      { type: "response.created", response: { ...response, output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ]) res.write("data: " + JSON.stringify(event) + "\n\n");
    res.end(); return;
  }
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
    if (mode === "codex-socket-error") {
      for (const event of events.slice(0, 2)) res.write("data: " + JSON.stringify(event) + "\n\n");
      breakCodexStream = () => res.destroy();
      codexStreamClosed = once(res, "close");
      return;
    }
    if (mode === "codex-truncated") {
      for (const event of events.slice(0, 2)) res.write("data: " + JSON.stringify(event) + "\n\n");
      res.end();
      return;
    }
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
function setup(provider, model = provider === "claude" ? "claude-sonnet-4-6" : "gpt-6.1-sol") {
  const id = "synthetic-" + randomUUID();
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
test("Chat and Responses accept declared JSON bodies up to 100 MiB and reject larger ones", async () => {
  mode = "normal";
  const { key, model } = setup("claude");
  for (const [handler, url] of [[handleChatCompletions, "/v1/chat/completions"], [handleResponses, "/v1/responses"]]) {
    for (const [bytes, status] of [[25 * 1024 * 1024 + 1, 200], [100 * 1024 * 1024, 200], [100 * 1024 * 1024 + 1, 413]]) {
      const payload = url === "/v1/responses"
        ? { model, input: "Hi" } : { model, messages: [{ role: "user", content: "Hi" }] };
      const before = calls.length;
      // Exercise the early Content-Length gate without allocating a 100 MiB fixture.
      const response = await handler(request(key, payload, url, { "content-length": String(bytes) }));
      assert.equal(response.status, status, url + " Content-Length=" + bytes);
      const body = await response.json();
      if (status === 413) {
        assert.equal(body.error.code, "body_too_large");
        assert.equal(calls.length, before);
      } else {
        assert.ok(JSON.stringify(body).includes("你好"));
        assert.equal(calls.length, before + 1);
      }
    }
  }
});

test("Claude model aliases route and normalize across JSON, SSE and token counting", async () => {
  mode = "normal";
  const { channel, key } = setup("claude", "claude-opus-5-5");
  const handlers = [
    [handleChatCompletions, "/v1/chat/completions"],
    [handleResponses, "/v1/responses"],
    [handleClaudeMessages, "/v1/messages"],
    [handleClaudeCountTokens, "/v1/messages/count_tokens"],
  ];
  for (const model of ["anthropic/claude-opus-5-5", "anthropic/claude-opus-5.5", "claude-opus-5.5"]) {
    for (const [handler, url] of handlers) for (const stream of [false, true]) {
      const payload = url === "/v1/responses"
        ? { model, stream, input: "Hi" }
        : { model, stream, messages: [{ role: "user", content: "Hi" }] };
      const before = calls.length;
      const response = await handler(request(key, payload, url));
      assert.equal(response.status, 200, model + " " + url + " stream=" + stream);
      assert.ok(response.headers.get("content-type").startsWith(
        stream && !url.endsWith("count_tokens") ? "text/event-stream" : "application/json",
      ));
      const body = await response.text();
      assert.ok(body.includes(url.endsWith("count_tokens") ? '"input_tokens":12' : "你好"));
      assert.equal(calls.length, before + 1);
      assert.ok(calls.at(-1).path.startsWith("/v1/messages"));
      assert.equal(calls.at(-1).payload.model, "claude-opus-5-5");
      assert.equal(log(channel).status_code, 200);
    }
  }
  const response = await handleResponses(request(key, {
    model: "anthropic/claude-opus-5.5(1m)(high)", input: "Hi",
  }, "/v1/responses"));
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(calls.at(-1).payload.model, "claude-opus-5-5");
  assert.equal(calls.at(-1).payload.output_config.effort, "high");
  assert.ok(calls.at(-1).headers["anthropic-beta"].includes("context-1m-2025-08-07"));
  const aliasKey = createApiKey({ channelAllowlist: [channel.id], modelAllowlist: ["anthropic/claude-opus-5.5"] });
  const aliasResponse = await handleChatCompletions(request(aliasKey, {
    model: "anthropic/claude-opus-5.5", messages: [{ role: "user", content: "Hi" }],
  }));
  assert.equal(aliasResponse.status, 200);
  await aliasResponse.text();
  assert.equal(calls.at(-1).payload.model, "claude-opus-5-5");
});

test("Claude model aliases still enforce model and channel authorization", async () => {
  mode = "normal";
  const { key } = setup("claude", "claude-opus-5-5");
  const before = calls.length;
  for (const model of ["anthropic/claude-sonnet-4.6", "other/claude-opus-5-5", "anthropic/not-a-claude"]) {
    const response = await handleChatCompletions(request(key, {
      model, messages: [{ role: "user", content: "Hi" }],
    }));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "model_not_allowed");
  }
  const restricted = createApiKey({ channelAllowlist: ["nonexistent-channel"], modelAllowlist: ["claude-opus-5-5"] });
  const response = await handleChatCompletions(request(restricted, {
    model: "anthropic/claude-opus-5.5", messages: [{ role: "user", content: "Hi" }],
  }));
  assert.equal(response.status, 503);
  assert.equal(calls.length, before);
});

test("Codex accepts openai/ model prefixes without bypassing model authorization", async () => {
  mode = "normal";
  const { channel, key } = setup("codex", "gpt-6.2-sol");
  for (const [model, effort] of [["openai/gpt-6.2-sol", undefined], ["OpenAI/gpt-6.2-sol(high)", "high"]]) {
    for (const [handler, url] of [[handleChatCompletions, "/v1/chat/completions"], [handleResponses, "/v1/responses"]]) {
      const payload = url === "/v1/responses" ? { model, input: "Hi" } : { model, messages: [{ role: "user", content: "Hi" }] };
      const response = await handler(request(key, payload, url));
      assert.equal(response.status, 200, model + " " + url);
      await response.text();
      const call = calls.at(-1);
      assert.equal(call.path, "/backend-api/codex/responses");
      assert.equal(call.payload.model, "gpt-6.2-sol");
      assert.ok(call.headers["x-codex-routing-hint"].startsWith("model=gpt-6.2-sol"));
      if (effort) assert.equal(call.payload.reasoning?.effort, effort);
      assert.equal(log(channel).status_code, 200);
    }
  }
  const before = calls.length;
  for (const model of ["openai/gpt-6.1-sol", "other/gpt-6.2-sol"]) {
    const response = await handleChatCompletions(request(key, { model, messages: [{ role: "user", content: "Hi" }] }));
    assert.equal(response.status, 403, model);
    assert.equal((await response.json()).error.code, "model_not_allowed");
  }
  assert.equal(calls.length, before);
});

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
test("Codex Responses socket failure preserves partial output, emits an error and logs the cause once", async () => {
  mode = "codex-socket-error";
  const { channel, key, model } = setup("codex");
  const response = await handleResponses(request(key, { model, input: "Hi", stream: true }, "/v1/responses"));
  assert.equal(response.status, 200); // Headers were already sent before the upstream failed.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value, { stream: true });
  breakCodexStream();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  reader.releaseLock();
  assert.ok(text.includes("你好"));
  assert.match(text, /event: error\ndata: .*upstream_stream_incomplete/);
  assert.doesNotMatch(text, /response\.completed|\[DONE\]|UND_ERR_SOCKET/);
  const row = log(channel);
  assert.equal(row.status_code, 502);
  assert.equal(row.error_code, "stream_error");
  assert.match(row.error_message, /terminated/);
  assert.equal(getLogDb().prepare("SELECT count(*) n FROM request_logs WHERE channel_id=?").get(channel.id).n, 1);
  const detail = getLogDb().prepare("SELECT error_cause_json FROM request_log_details WHERE request_log_id=?").get(row.id);
  assert.match(detail.error_cause_json, /UND_ERR_SOCKET/);
});

test("Codex Responses still reports an EOF without completion as a failure", async () => {
  mode = "codex-truncated";
  const { channel, key, model } = setup("codex");
  const response = await handleResponses(request(key, { model, input: "Hi", stream: true }, "/v1/responses"));
  const text = await response.text();
  assert.match(text, /Upstream stream ended before completion/);
  assert.doesNotMatch(text, /response\.completed/);
  assert.equal(log(channel).error_code, "stream_error");
});

test("canceling Codex Responses closes upstream without recording an upstream failure", { timeout: 5000 }, async () => {
  mode = "codex-socket-error";
  const { channel, key, model } = setup("codex");
  const response = await handleResponses(request(key, { model, input: "Hi", stream: true }, "/v1/responses"));
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel("client disconnected");
  reader.releaseLock();
  await codexStreamClosed;
  assert.equal(log(channel), undefined);
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
for (const stream of [false, true]) test("Claude Code over Codex, stream=" + stream + ": Messages become Codex Responses", async () => {
  mode = "normal";
  const { channel, key, model } = setup("codex");
  const longTool = "mcp__" + "server_".repeat(10) + "lookup";
  const longId = "toolu_" + "x".repeat(80);
  const claudeSignature = "EqQBCkYIBxgCKkA" + "a".repeat(40);
  const codexSignature = "gAAAAABsynthetic-codex-reasoning";
  const sessionId = "30000000-0000-4000-8000-000000000003";
  const payload = {
    model, stream, max_tokens: 2048,
    system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2" }, { type: "text", text: system }],
    thinking: { type: "enabled", budget_tokens: 2000 },
    tools: [{ name: longTool, description: "Look up", input_schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" } },
      { type: "web_search_20250305", name: "web_search" }],
    tool_choice: { type: "tool", name: longTool },
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "from claude", signature: claudeSignature },
        { type: "thinking", thinking: "from codex", signature: codexSignature },
        { type: "tool_use", id: longId, name: longTool, input: { q: "a" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: longId, content: "found" }] },
    ],
  };
  const response = await handleClaudeMessages(request(key, payload, "/v1/messages",
    { "x-api-key": key.key, "x-claude-code-session-id": sessionId }));
  assert.equal(response.status, 200);
  assertQuota(response, "codex");
  const body = await response.text();
  if (stream) {
    const events = body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    assert.equal(events[0].type, "message_start");
    assert.ok(events.filter(event => event.delta?.type === "text_delta").map(event => event.delta.text).join(""));
    assert.equal(events.at(-2).usage.input_tokens, 10);
    assert.equal(events.at(-1).type, "message_stop");
  } else {
    const message = JSON.parse(body);
    assert.equal(message.type, "message");
    assert.equal(message.content[0].type, "text");
    assert.equal(message.usage.input_tokens, 10);
  }
  const call = calls.at(-1);
  assert.equal(call.path, "/backend-api/codex/responses");
  const upstreamPayload = call.payload;
  // Claude Code's attribution block is dropped; the real system prompt becomes a developer message.
  assert.deepEqual(upstreamPayload.input[0], { type: "message", role: "developer", content: [{ type: "input_text", text: system }] });
  // Only the Codex-issued reasoning signature is replayed.
  const reasoning = upstreamPayload.input.filter(item => item.type === "reasoning");
  assert.deepEqual(reasoning.map(item => item.encrypted_content), [codexSignature]);
  const toolCall = upstreamPayload.input.find(item => item.type === "function_call");
  const toolOutput = upstreamPayload.input.find(item => item.type === "function_call_output");
  assert.ok(toolCall.name.length <= 64 && toolCall.call_id.length <= 64);
  assert.equal(toolOutput.call_id, toolCall.call_id);
  assert.equal(upstreamPayload.tools[0].name, toolCall.name);
  assert.deepEqual(upstreamPayload.tools[0].parameters, { type: "object", properties: {} });
  assert.equal(upstreamPayload.tools[1].type, "web_search");
  assert.deepEqual(upstreamPayload.tool_choice, { type: "function", name: toolCall.name });
  assert.equal(upstreamPayload.reasoning.effort, "medium");
  assert.equal(upstreamPayload.max_output_tokens, undefined);
  // One Claude Code session keeps one Codex prompt cache, independent of the Relay key.
  const otherKey = createApiKey({ channelAllowlist: [channel.id], modelAllowlist: [model] });
  await (await handleClaudeMessages(request(otherKey, { model, messages: [{ role: "user", content: "Again" }] }, "/v1/messages",
    { "x-claude-code-session-id": sessionId }))).text();
  assert.equal(calls.at(-1).payload.prompt_cache_key, upstreamPayload.prompt_cache_key);
  assert.equal(log(channel).request_type, "claude.messages.codex");
});

for (const stream of [false, true]) test("Claude Code over Codex, stream=" + stream + ": shortened tool names map back", async () => {
  mode = "codex-tool";
  const { key, model } = setup("codex");
  const longTool = "mcp__" + "server_".repeat(10) + "lookup";
  const response = await handleClaudeMessages(request(key, {
    model, stream, tools: [{ name: longTool, input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "Look it up" }],
  }, "/v1/messages"));
  assert.equal(response.status, 200);
  assert.notEqual(calls.at(-1).payload.tools[0].name, longTool);
  const body = await response.text();
  if (stream) {
    const events = body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    const start = events.find(event => event.content_block?.type === "tool_use");
    assert.equal(start.content_block.name, longTool);
    assert.equal(events.find(event => event.delta?.type === "input_json_delta").delta.partial_json, "{\"q\":\"b\"}");
    assert.equal(events.at(-2).delta.stop_reason, "tool_use");
  } else {
    const message = JSON.parse(body);
    assert.deepEqual(message.content, [{ type: "tool_use", id: "call_1", name: longTool, input: { q: "b" } }]);
    assert.equal(message.stop_reason, "tool_use");
  }
});

test("Claude Code over Codex: count_tokens is computed locally from the converted request", async () => {
  mode = "normal";
  const { key, model } = setup("codex");
  const longTool = "mcp__" + "server_".repeat(10) + "lookup";
  const before = calls.length;
  // Count tokens locally without calling Codex.
  const counted = await handleClaudeCountTokens(request(key, {
    model, system, tools: [{ name: longTool, input_schema: { type: "object", properties: { q: { type: "string" } } } }],
    messages: [{ role: "user", content: "Hello there" }],
  }, "/v1/messages/count_tokens"));
  assert.equal(counted.status, 200);
  const { input_tokens: tokens } = await counted.json();
  assert.equal(calls.length, before);
  assert.ok(tokens > 10 && tokens < 80, String(tokens));
  const shorter = await handleClaudeCountTokens(request(key, { model, messages: [{ role: "user", content: "Hello there" }] },
    "/v1/messages/count_tokens"));
  assert.ok((await shorter.json()).input_tokens < tokens);
});

test("Errors raised after routing still log the selected channel account", async () => {
  mode = "normal";
  const id = "synthetic-expired-" + randomUUID();
  upsertCodexCredential({ id, email: "expired@example.invalid", accountId, planType: "plus",
    tokens: { access_token: "synthetic-codex", expired: "2000-01-01T00:00:00Z" } });
  const channel = createChannel({ provider: "codex", credentialId: id, baseUrl: baseUrl + "/backend-api/codex", modelAllowlist: ["gpt-6.1-sol"] });
  const key = createApiKey({ channelAllowlist: [channel.id], modelAllowlist: ["gpt-6.1-sol"] });
  const before = calls.length;
  for (const [handler, url, payload] of [
    [handleChatCompletions, "/v1/chat/completions", { model: "gpt-6.1-sol", messages: [{ role: "user", content: "Hi" }] }],
    [handleClaudeMessages, "/v1/messages", { model: "gpt-6.1-sol", messages: [{ role: "user", content: "Hi" }] }],
  ]) {
    const response = await handler(request(key, payload, url));
    assert.equal(response.status, 503, url);
    await response.text();
    const row = log(channel);
    assert.equal(row.error_code, "codex_token_expired", url);
    assert.equal(row.credential_id, id, url);
    assert.equal(row.credential_email, "expired@example.invalid", url);
  }
  assert.equal(calls.length, before);
});

for (const stream of [false, true]) test("Native Claude stream=" + stream + ": quota survives upstream 429", async () => {
  mode = "rate-limited";
  const { key, model } = setup("claude");
  const response = await handleClaudeMessages(request(key, { model, stream, messages: [{ role: "user", content: "Hi" }] }));
  assert.equal(response.status, 429);
  assertQuota(response, "claude");
  assert.equal((await response.json()).error.type, "rate_limit_error");
});
