import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { after, afterEach, beforeEach, test } from "node:test";

// Never use the developer's databases, imported credentials, proxies or remote upstreams.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-upstream-route-"));
process.env.DATA_DIR = dataDir;
process.env.RELAY_MAIN_DB_PATH = path.join(dataDir, "main.sqlite");
process.env.RELAY_LOG_DB_PATH = path.join(dataDir, "logs.sqlite");
process.env.RELAY_ENCRYPTION_KEY = "synthetic-upstream-route-encryption-secret";
process.env.RELAY_IMPORT_LEGACY_CREDENTIALS = "0";
for (const name of ["RELAY_GLOBAL_SOCKS_PROXY", "RELAY_GLOBAL_PROXY", "CODEX_PROXY"]) delete process.env[name];
const projectRoot = new URL("../", import.meta.url);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  if (specifier.startsWith("@/")) return nextResolve(new URL(specifier.slice(2) + ".ts", projectRoot).href, context);
  return nextResolve(specifier, context);
} });

const calls = [];
const mockErrors = [];
const blockedRequests = [];
const secrets = [];
const originalFetch = globalThis.fetch;
const catalogUrls = new Set([
  "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json",
  "https://models.router-for.me/models.json",
]);
const text = "你好🌍";
const system = "CALLER_ONLY_SYSTEM: Keep the caller instructions unchanged.";
const usage = { input_tokens: 7, output_tokens: 4, total_tokens: 11, input_tokens_details: { cached_tokens: 2 } };
const chatUsage = { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11, prompt_tokens_details: { cached_tokens: 2 } };
const claudeUsage = { input_tokens: 5, output_tokens: 4, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 };
const event = (type, value = {}) => "event: " + type + "\ndata: " + JSON.stringify({ type, ...value }) + "\n\n";

function responseHeaders(provider) {
  const reset = new Date(Date.now() + 3600_000).toISOString();
  return {
    "content-type": "application/json", "x-request-id": "synthetic-local-request",
    "set-cookie": "synthetic-private-upstream-cookie", "chatgpt-account-id": "synthetic-private-account",
    "anthropic-organization-id": "synthetic-private-organization",
    "x-relay-quota-provider": "codex", "x-relay-quota-source": "forged-upstream-quota",
    ...(provider === "anthropic" ? {
      "anthropic-ratelimit-requests-limit": "100", "anthropic-ratelimit-requests-remaining": "75",
      "anthropic-ratelimit-requests-reset": reset,
    } : {
      "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "75",
      "x-ratelimit-reset-requests": reset,
    }),
  };
}
function openAIResponse(model) {
  return { id: "resp_synthetic", object: "response", status: "completed", model,
    output: [{ id: "msg_synthetic", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }] }], usage };
}
function claudeSse(model, { complete = true, tools = false } = {}) {
  return event("message_start", { message: {
    id: "msg_synthetic", type: "message", role: "assistant", model, content: [],
    usage: { ...claudeUsage, output_tokens: 0 },
  } }) + event("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    + event("content_block_delta", { index: 0, delta: { type: "text_delta", text } })
    + event("content_block_stop", { index: 0 })
    + (tools ? event("content_block_start", { index: 1,
      content_block: { type: "tool_use", id: "tool_synthetic", name: "bash", input: {} } })
      + event("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' } })
      + event("content_block_stop", { index: 1 }) : "")
    + event("message_delta", { delta: { stop_reason: tools ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } })
    + (complete ? event("message_stop") : "");
}
function sendSse(res, value, headers = {}) {
  res.writeHead(200, { ...headers, "content-type": "text/event-stream; charset=utf-8" });
  const bytes = Buffer.from(value);
  for (let offset = 0; offset < bytes.length; offset += 17) res.write(bytes.subarray(offset, offset + 17));
  res.end();
}
function nativeReply(call, res) {
  const provider = call.path.includes("anthropic") ? "anthropic" : "openai";
  const headers = responseHeaders(provider);
  const model = call.payload?.model ?? call.form?.get("model");
  const stream = call.payload?.stream === true || call.form?.get("stream") === "true";
  let result;
  if (call.path.endsWith("/messages/count_tokens")) result = { input_tokens: 23 };
  else if (call.path.endsWith("/messages")) {
    if (stream) return sendSse(res, claudeSse(model, { tools: call.payload.tools?.some((tool) => tool.name === "bash") }), headers);
    result = { id: "msg_synthetic", type: "message", role: "assistant", model,
      content: [{ type: "text", text }], stop_reason: "end_turn", usage: claudeUsage };
  } else if (call.path.endsWith("/chat/completions")) {
    if (stream) return sendSse(res, "data: " + JSON.stringify({ id: "chatcmpl_synthetic", object: "chat.completion.chunk", model,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }) + "\n\n"
      + "data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: chatUsage }) + "\n\n"
      + "data: [DONE]\n\n", headers);
    result = { id: "chatcmpl_synthetic", object: "chat.completion", model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: chatUsage };
  } else if (call.path.endsWith("/responses")) {
    result = openAIResponse(model);
    if (stream) return sendSse(res, event("response.created", { response: { ...result, status: "in_progress", output: [] } })
      + event("response.output_text.delta", { output_index: 0, content_index: 0, delta: text })
      + event("response.completed", { response: result }), headers);
  } else if (/\/images\/(generations|edits)$/.test(call.path)) {
    const prefix = call.path.endsWith("/edits") ? "image_edit" : "image_generation";
    const n = Number(call.payload?.n ?? call.form?.get("n") ?? 1);
    const data = Array.from({ length: n }, () => ({ b64_json: "aW1hZ2U=" }));
    if (stream) return sendSse(res, data.map((image, image_index) =>
      event(prefix + ".partial_image", { image_index, b64_json: "cGFydA==" })
        + event(prefix + ".completed", { image_index, model, ...image })).join("")
      + event(prefix + ".usage", { usage }), headers);
    result = { created: 123, model, data, usage };
  } else {
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":{"message":"Unexpected synthetic upstream path"}}');
    return;
  }
  res.writeHead(200, headers);
  res.end(JSON.stringify(result));
}
let reply = nativeReply;
const upstream = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const contentType = req.headers["content-type"] || "";
    const call = { method: req.method, path: req.url, headers: req.headers, bytes,
      payload: contentType.includes("application/json") ? JSON.parse(bytes.toString()) : undefined,
      form: contentType.startsWith("multipart/form-data")
        ? await new Response(bytes, { headers: { "content-type": contentType } }).formData() : undefined };
    calls.push(call);
    await reply(call, res);
  } catch (error) {
    mockErrors.push(error);
    if (!res.headersSent) res.writeHead(500);
    res.end("Synthetic mock failure");
  }
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const origin = "http://127.0.0.1:" + upstream.address().port;
// An accidental OAuth dispatch is still local and can be observed, never sent to a real account.
process.env.CODEX_BASE_URL = origin + "/oauth/codex";
process.env.CLAUDE_BASE_URL = origin + "/oauth/claude";

const { handleChatCompletions, handleOpenAIResponses, handleImagesGenerations, handleImagesEdits,
  handleClaudeMessages, handleClaudeCountTokens, handleModels } = await import("../src/server/http/relay.ts");
const { createUpstreamCredential } = await import("../src/server/services/upstreamCredentials.ts");
const { getUpstreamCredentialWithSecret } = await import("../src/server/repositories/upstreamCredentials.ts");
const { createChannel, patchChannel } = await import("../src/server/services/channels.ts");
const { createApiKey } = await import("../src/server/services/apiKeys.ts");
const { patchGlobalSettings } = await import("../src/server/services/settings.ts");
const { upsertCodexCredential, getCodexCredentialWithTokens } = await import("../src/server/repositories/codexCredentials.ts");
const { upsertClaudeCredential, getClaudeCredentialWithTokens } = await import("../src/server/repositories/claudeCredentials.ts");
const { getMainDb, getLogDb } = await import("../src/server/db/sqlite.ts");
patchGlobalSettings({ fullRequestLoggingEnabled: true });
const routes = {
  chat: [handleChatCompletions, "/v1/chat/completions"], responses: [handleOpenAIResponses, "/v1/responses"],
  messages: [handleClaudeMessages, "/v1/messages"], count_tokens: [handleClaudeCountTokens, "/v1/messages/count_tokens"],
  images_generations: [handleImagesGenerations, "/v1/images/generations"], images_edits: [handleImagesEdits, "/v1/images/edits"],
};

// These scenarios share a mock server/reply and deliberately run sequentially.
beforeEach((t) => {
  calls.length = 0;
  mockErrors.length = 0;
  blockedRequests.length = 0;
  reply = nativeReply;
  t.mock.method(globalThis, "fetch", (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (catalogUrls.has(url.href)) return Promise.resolve(Response.json({
      "codex-plus": [{ id: "gpt-5.4", object: "model" }, { id: "oauth-catalog-only", object: "model" }],
      "codex-pro": [{ id: "gpt-5.4", object: "model" }, { id: "oauth-catalog-only", object: "model" }],
      claude: [{ id: "claude-sonnet-4-6", object: "model" }, { id: "claude-oauth-catalog-only", object: "model" }],
    }));
    if (url.origin !== origin) {
      blockedRequests.push(url.href);
      throw new Error("Non-local network access is forbidden in upstream route tests");
    }
    return originalFetch(input, init);
  });
});
afterEach(() => {
  assert.deepEqual(mockErrors, [], "The local HTTP mock must not hide a parsing/fixture failure");
  assert.deepEqual(blockedRequests, [], "API channels must not refresh OAuth tokens or contact remote upstreams");
  const db = getLogDb();
  for (const table of ["request_logs", "request_log_details", "channel_health_events", "usage_records", "usage_daily_buckets"]) {
    const serialized = JSON.stringify(db.prepare("SELECT * FROM " + table).all());
    for (const secret of secrets) for (const value of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
      assert.ok(!serialized.includes(value), table + " must not contain an upstream API key");
    }
  }
});
after(async () => {
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  getMainDb().close();
  getLogDb().close();
  const resolved = path.resolve(dataDir);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith("relay-upstream-route-"));
  fs.rmSync(resolved, { recursive: true, force: true });
});

function credential(provider, options = {}) {
  const secret = "sk-synthetic-" + provider + "-" + randomUUID();
  secrets.push(secret);
  return { secret, record: createUpstreamCredential({ provider, name: "Synthetic " + provider, apiKey: secret, ...options }) };
}
function setup(provider = "openai", options = {}) {
  const model = options.model ?? (provider === "anthropic" ? "claude-api-custom(high)" : "vendor-api-custom(high)");
  const upstreamKey = credential(provider, { priority: 1000 });
  const channel = createChannel({ provider, name: "Synthetic API channel", credentialIds: [upstreamKey.record.id],
    baseUrl: origin + "/custom/" + provider + "/v1", enabled: true,
    modelAllowlist: [model], capabilities: provider === "openai"
      ? ["chat", "responses", "images_generations", "images_edits"] : ["messages", "count_tokens"],
    ...options.channel });
  const key = createApiKey({ channelAllowlist: [channel.id], modelAllowlist: [model], ...options.key });
  return { model, channel, key, credential: upstreamKey.record, secret: upstreamKey.secret };
}
function oauth(provider, model) {
  const id = "synthetic-oauth-" + randomUUID();
  const input = { id, email: "synthetic@example.invalid", accountId: "10000000-0000-4000-8000-000000000001",
    tokens: { access_token: "synthetic-oauth-access", refresh_token: "synthetic-oauth-refresh-must-not-be-used",
      expired: "2099-01-01T00:00:00Z" }, metadata: { upstream_transport: "http" } };
  const get = provider === "claude" ? getClaudeCredentialWithTokens : getCodexCredentialWithTokens;
  if (provider === "claude") upsertClaudeCredential(input);
  else upsertCodexCredential({ ...input, planType: "plus" });
  const channel = createChannel({ provider, credentialId: id, baseUrl: origin + "/oauth/" + provider,
    modelAllowlist: [model], priority: 1 });
  return { channel, snapshot: () => get(id) };
}
function request(key, operation, payload, extra = {}) {
  const headers = new Headers({ authorization: "Bearer " + key.key, cookie: "synthetic-downstream-cookie=private",
    "x-api-key": "synthetic-downstream-other-key", "user-agent": "claude-cli/synthetic-downstream",
    "chatgpt-account-id": "synthetic-downstream-account", originator: "synthetic-downstream-cli",
    "x-app": "cli", "x-claude-code-session-id": "synthetic-downstream-session",
    "x-stainless-os": "synthetic-downstream-os", "x-codex-routing-hint": "synthetic-downstream-hint", ...extra });
  if (!(payload instanceof FormData)) headers.set("content-type", "application/json");
  return new Request("http://relay.invalid" + routes[operation][1], {
    method: "POST", headers, body: payload instanceof FormData ? payload : JSON.stringify(payload),
  });
}
function run(fixture, operation, payload, headers) {
  return routes[operation][0](request(fixture.key, operation, payload, headers));
}
function payloadFor(operation, model) {
  if (operation === "responses") return { model, input: "Hi" };
  if (operation.startsWith("images_")) return { model, prompt: "Draw a synthetic cat",
    ...(operation === "images_edits" ? { images: [{ file_id: "synthetic-file" }] } : {}) };
  return { model, messages: [{ role: "user", content: "Hi" }], ...(operation === "messages" ? { max_tokens: 77 } : {}) };
}
function assertAuth(call, fixture, accept = "application/json") {
  assert.equal(call.method, "POST");
  assert.equal(call.headers.accept, accept);
  if (fixture.channel.provider === "openai") {
    assert.equal(call.headers.authorization, "Bearer " + fixture.secret);
    assert.equal(call.headers["x-api-key"], undefined);
    assert.equal(call.headers["anthropic-version"], undefined);
  } else {
    assert.equal(call.headers["x-api-key"], fixture.secret);
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers["anthropic-version"], "2023-06-01");
  }
  for (const name of ["cookie", "chatgpt-account-id", "originator", "x-app", "x-claude-code-session-id", "x-stainless-os", "x-codex-routing-hint"]) {
    assert.equal(call.headers[name], undefined, "Do not forward downstream " + name);
  }
  assert.ok(!call.headers["user-agent"]?.includes("synthetic-downstream"));
}
function assertQuota(response, provider) {
  assert.equal(response.headers.get("x-relay-quota-provider"), provider);
  assert.equal(response.headers.get("x-relay-quota-source"), "upstream");
  const raw = provider === "openai" ? "x-ratelimit-remaining-requests" : "anthropic-ratelimit-requests-remaining";
  assert.equal(response.headers.get(raw), "75");
  for (const name of ["set-cookie", "chatgpt-account-id", "anthropic-organization-id"]) assert.equal(response.headers.get(name), null);
}
function lastLog(channel) {
  return getLogDb().prepare("SELECT * FROM request_logs WHERE channel_id = ? ORDER BY rowid DESC LIMIT 1").get(channel.id);
}
function detail(log) {
  return getLogDb().prepare("SELECT * FROM request_log_details WHERE request_log_id = ?").get(log.id);
}
function assertLogged(fixture, tokens = [7, 4, 11, 2]) {
  const log = lastLog(fixture.channel);
  assert.ok(log, "The handler must append a local request log");
  assert.equal(log.status_code, 200);
  assert.equal(log.model, fixture.model);
  assert.equal(log.api_key_id, fixture.key.id);
  assert.equal(log.credential_id, fixture.credential.id);
  assert.deepEqual([log.prompt_tokens, log.completion_tokens, log.total_tokens, log.cached_tokens], tokens);
  const recordedUsage = getLogDb().prepare("SELECT * FROM usage_records WHERE channel_id = ? ORDER BY rowid DESC LIMIT 1").get(fixture.channel.id);
  if (tokens[2] > 0) {
    assert.ok(recordedUsage, "Usage must be persisted locally, not only returned to the caller");
    assert.deepEqual([recordedUsage.prompt_tokens, recordedUsage.completion_tokens, recordedUsage.total_tokens, recordedUsage.cached_tokens], tokens);
  } else {
    assert.equal(recordedUsage, undefined, "Zero/estimated usage must not create a usage record for this channel");
  }
  const captured = detail(log);
  assert.ok(captured?.forwarded_body_text);
  assert.ok(captured.upstream_body_text);
  const authHeader = fixture.channel.provider === "openai" ? "authorization" : "x-api-key";
  assert.equal(JSON.parse(captured.forwarded_headers_json)[authHeader], "[REDACTED]");
  return captured;
}
function sseValues(body) {
  return body.split(/\r?\n/).filter((line) => line.startsWith("data: ") && line !== "data: [DONE]").map((line) => JSON.parse(line.slice(6)));
}

for (const scenario of [
  { operation: "chat", model: "vendor-chat-model(high)" },
  { operation: "responses", model: "vendor-responses-model(high)", stream: false },
  { operation: "chat", model: "claude-openai-compatible(high)", stream: true },
  { operation: "responses", model: "claude-openai-compatible(high)", stream: true },
]) {
  test("OpenAI " + scenario.operation + " stream=" + scenario.stream + ": native route, original model/body and isolated API auth", { timeout: 15000 }, async () => {
    const fixture = setup("openai", { model: scenario.model });
    const payload = { ...payloadFor(scenario.operation, fixture.model), system, store: true,
      include: ["reasoning.encrypted_content", "caller.extension"], previous_response_id: "resp_caller_previous",
      max_tokens: 77, temperature: 0.4, custom_extension: { untouched: true } };
    if (scenario.operation === "chat") payload.messages.unshift({ role: "system", content: system });
    else payload.instructions = system;
    if (scenario.stream !== undefined) payload.stream = scenario.stream;
    if (scenario.operation === "responses" && scenario.stream === false) {
      payload.tools = [{ type: "function", name: "bash", parameters: { type: "object" } }];
      payload.tool_choice = "none";
    }
    const response = await run(fixture, scenario.operation, payload);
    assert.equal(response.status, 200);
    assertQuota(response, "openai");
    const body = await response.text();
    assert.ok(body.includes(text));
    if (scenario.stream) {
      assert.match(response.headers.get("content-type"), /^text\/event-stream/);
      assert.ok(body.includes(scenario.operation === "chat" ? "[DONE]" : "response.completed"));
    } else {
      const result = JSON.parse(body);
      assert.equal(result.model, fixture.model);
      assert.equal(result.object, scenario.operation === "chat" ? "chat.completion" : "response");
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/custom/openai" + routes[scenario.operation][1]);
    assert.deepEqual(calls[0].payload, payload, "Do not run OAuth system/store/include/token/tool/model normalization");
    assertAuth(calls[0], fixture, scenario.stream ? "text/event-stream" : "application/json");
    assertLogged(fixture);
  });
}

for (const operation of ["images_generations", "images_edits"]) for (const stream of [false, true]) {
  test("OpenAI " + operation + " stream=" + stream + ": unregistered image model bypasses Codex policy and retains native JSON/SSE", { timeout: 15000 }, async () => {
    const fixture = setup("openai", { model: operation === "images_generations" ? "dall-e-like" : "custom-image-model" });
    const payload = { ...payloadFor(operation, fixture.model), stream, n: 2, size: "caller-defined-size", quality: "caller-quality",
      response_format: "b64_json", custom_image_option: "unchanged" };
    if (operation === "images_edits") {
      payload.images = [{ image_url: "https://example.invalid/not-fetched.png" }, { file_id: "synthetic-file" }];
      payload.mask = { file_id: "synthetic-mask" };
      payload.input_fidelity = "high";
    }
    const response = await run(fixture, operation, payload);
    assert.equal(response.status, 200);
    assertQuota(response, "openai");
    if (stream) {
      const values = sseValues(await response.text());
      const prefix = operation === "images_edits" ? "image_edit" : "image_generation";
      const completed = values.filter((value) => value.type === prefix + ".completed");
      assert.equal(completed.length, payload.n);
      assert.deepEqual(completed.map((value) => value.image_index), [0, 1]);
      for (const image of completed) {
        assert.equal(image.model, fixture.model);
        assert.equal(image.b64_json, "aW1hZ2U=");
      }
      assert.equal(values.filter((value) => value.usage).length, 1);
      assert.equal(values.at(-1).type, prefix + ".usage");
      assert.deepEqual(values.at(-1).usage, usage);
    } else {
      const result = await response.json();
      assert.equal(result.model, fixture.model);
      assert.equal(result.data.length, payload.n);
      assert.equal(result.data[0].b64_json, "aW1hZ2U=");
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/custom/openai" + routes[operation][1]);
    assert.deepEqual(calls[0].payload, payload);
    assertAuth(calls[0], fixture, stream ? "text/event-stream" : "application/json");
    assertLogged(fixture);
  });
}

for (const operation of ["images_generations", "images_edits"]) {
  test("OpenAI " + operation + ": multiple completed images and trailing usage survive through EOF and one final log", { timeout: 15000 }, async () => {
    const fixture = setup("openai", { model: "custom-multi-image-model" });
    const payload = { ...payloadFor(operation, fixture.model), stream: true, n: 2 };
    const prefix = operation === "images_edits" ? "image_edit" : "image_generation";
    const frames = [
      event(prefix + ".completed", { index: 0, model: fixture.model, b64_json: "Zmlyc3Q=",
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }),
      event(prefix + ".completed", { index: 1, model: fixture.model, b64_json: "c2Vjb25k" }),
      event(prefix + ".usage", { usage: { input_tokens: 17, output_tokens: 13, total_tokens: 30,
        input_tokens_details: { cached_tokens: 5 } } }),
    ];
    let upstreamResponse;
    reply = (_call, res) => {
      upstreamResponse = res;
      res.writeHead(200, { ...responseHeaders("openai"), "content-type": "text/event-stream; charset=utf-8" });
      res.write(frames[0]);
    };
    const response = await run(fixture, operation, payload);
    assert.equal(response.status, 200);
    assertQuota(response, "openai");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    const logs = () => getLogDb().prepare("SELECT * FROM request_logs WHERE api_key_id = ?").all(fixture.key.id);
    async function readThrough(frame) {
      while (!body.includes(frame)) {
        const { done, value } = await reader.read();
        assert.equal(done, false, "The stream must not end after an individual completed image");
        body += decoder.decode(value, { stream: true });
      }
    }
    try {
      // Read per-image markers before releasing the next chunk; redaction may buffer an SSE suffix.
      await readThrough('"index":0');
      assert.equal(logs().length, 0, "The first completed image is not request completion");
      upstreamResponse.write(frames[1]);
      await readThrough('"index":1');
      assert.equal(logs().length, 0, "Wait for trailing usage and EOF before recording success");
      upstreamResponse.end(frames[2]);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
      assert.equal(body, frames.join(""), "All native SSE bytes, including final usage, must pass through unchanged");
      const values = sseValues(body);
      assert.deepEqual(values.filter((value) => value.type === prefix + ".completed").map((value) => [value.index, value.b64_json]),
        [[0, "Zmlyc3Q="], [1, "c2Vjb25k"]]);
      assert.equal(values.at(-1).usage.total_tokens, 30);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, "/custom/openai" + routes[operation][1]);
      assert.deepEqual(calls[0].payload, payload);
      assertAuth(calls[0], fixture, "text/event-stream");
      assert.equal(logs().length, 1);
      const captured = assertLogged(fixture, [17, 13, 30, 5]);
      assert.equal(captured.upstream_body_text, body);
      const records = getLogDb().prepare("SELECT * FROM usage_records WHERE api_key_id = ?").all(fixture.key.id);
      assert.equal(records.length, 1);
      assert.deepEqual([records[0].prompt_tokens, records[0].completion_tokens, records[0].total_tokens, records[0].cached_tokens], [17, 13, 30, 5]);
    } finally {
      upstreamResponse.destroy();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  });
}

test("OpenAI images_generations: n=2 with only one completed image is a truncated stream logged once as 502", { timeout: 15000 }, async () => {
  const fixture = setup("openai", { model: "custom-incomplete-multi-image-model" });
  const payload = { ...payloadFor("images_generations", fixture.model), stream: true, n: 2 };
  reply = (_call, res) => sendSse(res,
    event("image_generation.completed", { index: 0, model: fixture.model, b64_json: "Zmlyc3Q=" })
      + event("image_generation.usage", { usage }), responseHeaders("openai"));
  const response = await run(fixture, "images_generations", payload);
  const values = sseValues(await response.text());
  assert.equal(values.filter((value) => value.type === "image_generation.completed").length, 1);
  assert.ok(values.some((value) => value.type === "error"), "EOF cannot complete an n=2 request with only one image");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/custom/openai/v1/images/generations");
  assert.deepEqual(calls[0].payload, payload);
  const logs = getLogDb().prepare("SELECT * FROM request_logs WHERE api_key_id = ?").all(fixture.key.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status_code, 502);
  assert.equal(logs[0].credential_id, fixture.credential.id);
  assert.equal(logs[0].model, fixture.model);
  assert.ok(logs[0].error_code);
  assert.ok(logs[0].error_message);
});

test("OpenAI multipart edits keep files, duplicate fields and a valid matching boundary instead of Codex data URLs", { timeout: 15000 }, async () => {
  const fixture = setup("openai", { model: "custom-multipart-image-model" });
  const form = new FormData();
  form.append("model", fixture.model);
  form.append("prompt", "First caller prompt");
  form.append("prompt", "Second caller prompt");
  form.append("n", "2");
  form.append("custom_extension", "first");
  form.append("custom_extension", "second");
  form.append("image[]", new File([new Uint8Array([0, 1, 2, 255])], "first.png", { type: "image/png" }));
  form.append("image[]", new File(["second-image"], "second.webp", { type: "image/webp" }));
  form.append("mask", new File(["synthetic-mask"], "mask.png", { type: "image/png" }));
  const response = await run(fixture, "images_edits", form);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].b64_json, "aW1hZ2U=");
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.path, "/custom/openai/v1/images/edits");
  assertAuth(call, fixture);
  assert.match(call.headers["content-type"], /^multipart\/form-data;\s*boundary=/i);
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(call.headers["content-type"]);
  assert.ok(boundary);
  assert.ok(call.bytes.includes(Buffer.from("--" + (boundary[1] || boundary[2]) + "\r\n")));
  assert.equal(call.payload, undefined);
  assert.deepEqual(call.form.getAll("prompt"), ["First caller prompt", "Second caller prompt"]);
  assert.deepEqual(call.form.getAll("custom_extension"), ["first", "second"]);
  assert.equal(call.form.get("n"), "2");
  assert.equal(call.form.get("model"), fixture.model);
  assert.equal(call.form.get("response_format"), null);
  const images = call.form.getAll("image[]");
  assert.equal(images.length, 2);
  assert.equal(images[0].name, "first.png");
  assert.equal(images[0].type, "image/png");
  assert.deepEqual(new Uint8Array(await images[0].arrayBuffer()), new Uint8Array([0, 1, 2, 255]));
  assert.equal(images[1].name, "second.webp");
  assert.equal(images[1].type, "image/webp");
  assert.equal(await images[1].text(), "second-image");
  assert.equal(call.form.get("mask").name, "mask.png");
  assert.equal(await call.form.get("mask").text(), "synthetic-mask");
  assert.ok(!call.bytes.toString().includes("data:image/"));
  assertLogged(fixture);
});

for (const scenario of [{ operation: "messages", stream: false }, { operation: "messages", stream: true }, { operation: "count_tokens" }]) {
  test("Anthropic native " + scenario.operation + " stream=" + scenario.stream + ": API version/key and caller payload without OAuth preparation", { timeout: 15000 }, async () => {
    const fixture = setup("anthropic");
    const payload = { ...payloadFor(scenario.operation, fixture.model), system,
      tools: [{ name: "bash", input_schema: { type: "object" } }], custom_extension: "caller-only" };
    if (scenario.stream !== undefined) payload.stream = scenario.stream;
    const response = await run(fixture, scenario.operation, payload,
      scenario.operation === "count_tokens" ? {} : { "anthropic-version": "2023-06-01", "anthropic-beta": "caller-explicit-beta" });
    assert.equal(response.status, 200);
    assertQuota(response, "anthropic");
    if (scenario.stream) assert.ok((await response.text()).includes("event: message_stop"));
    else if (scenario.operation === "count_tokens") assert.deepEqual(await response.json(), { input_tokens: 23 });
    else assert.equal((await response.json()).content[0].text, text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/custom/anthropic" + routes[scenario.operation][1]);
    assert.deepEqual(calls[0].payload, payload);
    assertAuth(calls[0], fixture, scenario.stream ? "text/event-stream" : "application/json");
    assert.equal(calls[0].headers["anthropic-beta"], scenario.operation === "count_tokens" ? undefined : "caller-explicit-beta");
    // count_tokens is an estimate, not actual inference usage or daily token consumption.
    assertLogged(fixture, scenario.operation === "count_tokens" ? [0, 0, 0, 0] : [10, 4, 14, 3]);
  });
}

for (const operation of ["chat", "responses"]) for (const stream of [false, true]) {
  test("Anthropic via " + operation + " stream=" + stream + ": exact gateway(high) model converts without suffix-derived thinking, tool renaming or OAuth identity", { timeout: 15000 }, async () => {
    const fixture = setup("anthropic", { model: "gateway(high)", channel: { capabilities: ["messages"] } });
    assert.deepEqual(fixture.channel.modelAllowlist, ["gateway(high)"]);
    assert.deepEqual(fixture.key.modelAllowlist, ["gateway(high)"]);
    const tools = ["bash", "read_file"].map((name) => operation === "chat"
      ? { type: "function", function: { name, parameters: { type: "object", properties: { command: { type: "string" } } } } }
      : { type: "function", name, parameters: { type: "object", properties: { command: { type: "string" } } } });
    const payload = { ...payloadFor(operation, fixture.model), stream, max_tokens: 77, tools };
    if (operation === "chat") payload.messages.unshift({ role: "system", content: system });
    else payload.instructions = system;
    const response = await run(fixture, operation, payload);
    assert.equal(response.status, 200);
    assertQuota(response, "anthropic");
    if (stream) {
      const body = await response.text();
      assert.ok(body.includes(text));
      assert.ok(body.includes(operation === "chat" ? "[DONE]" : "response.completed"));
      assert.ok(sseValues(body).some((value) => operation === "chat"
        ? value.choices?.some((choice) => choice.delta?.tool_calls?.some((tool) => tool.function?.name === "bash"))
        : value.item?.type === "function_call" && value.item.name === "bash"));
      assert.ok(!body.includes('"name":"Bash"'));
    } else {
      const result = await response.json();
      if (operation === "chat") {
        assert.equal(result.choices[0].message.content, text);
        assert.equal(result.choices[0].message.tool_calls[0].function.name, "bash");
      } else {
        assert.equal(result.output_text, text);
        assert.equal(result.output.find((item) => item.type === "function_call").name, "bash");
      }
      assert.equal(result.usage.total_tokens, 14);
    }
    assert.equal(calls.length, 1, "Conversion must not probe quotas or attempt OAuth refresh");
    assert.equal(calls[0].path, "/custom/anthropic/v1/messages");
    assertAuth(calls[0], fixture, "text/event-stream");
    assert.equal(calls[0].headers["anthropic-beta"], undefined);
    assert.equal(calls[0].payload.stream, true);
    assert.equal(calls[0].payload.max_tokens, 77);
    assert.equal(calls[0].payload.model, "gateway(high)", "An explicitly authorized API model is a literal, not an OAuth suffix expression");
    assert.equal(calls[0].payload.thinking, undefined);
    assert.equal(calls[0].payload.output_config, undefined);
    assert.deepEqual(calls[0].payload.tools.map((tool) => tool.name), ["bash", "read_file"]);
    assert.ok(JSON.stringify(calls[0].payload.system).includes(system));
    const sent = JSON.stringify(calls[0].payload);
    for (const forbidden of ["Claude Code", "user_id", "account_uuid", "device_id", "billing", "oauth", "cache_control"]) {
      assert.ok(!sent.includes(forbidden), "Do not inject OAuth " + forbidden);
    }
    assertLogged(fixture, [10, 4, 14, 3]);
  });
}

for (const provider of ["openai", "anthropic"]) for (const status of [401, 429]) {
  test(provider + " HTTP " + status + ": once only, no credential retry/OAuth fallback, preserved retry-after and credential cooldown", { timeout: 15000 }, async () => {
    const operation = provider === "openai" ? "chat" : "messages";
    const model = provider === "openai" ? "gpt-auth-failure-" + randomUUID() : "claude-auth-failure-" + randomUUID();
    const spare = credential(provider, { priority: 1 });
    const fixture = setup(provider, { model, channel: { priority: 1000 } });
    const old = oauth(provider === "openai" ? "codex" : "claude", model);
    const oauthBefore = old.snapshot();
    // Both alternate credentials and an authorized OAuth channel are available, but not retry targets.
    patchChannel(fixture.channel.id, { credentialIds: [fixture.credential.id, spare.record.id] });
    fixture.key = createApiKey({ channelAllowlist: [fixture.channel.id, old.channel.id], modelAllowlist: [model] });
    const error = provider === "anthropic"
      ? { type: "error", error: { type: status === 401 ? "authentication_error" : "rate_limit_error", message: "Rejected " + fixture.secret } }
      : { error: { code: status === 401 ? "invalid_api_key" : "rate_limit_exceeded", message: "Rejected " + fixture.secret } };
    reply = (_call, res) => {
      res.writeHead(status, { ...responseHeaders(provider), "retry-after": "37", "x-request-id": "rejected-" + fixture.secret });
      res.end(JSON.stringify(error));
    };
    const response = await run(fixture, operation, payloadFor(operation, model));
    assert.equal(response.status, status);
    assert.equal(response.headers.get("retry-after"), "37");
    assertQuota(response, provider);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { ...error, error: { ...error.error, message: "Rejected [REDACTED]" } },
      "Keep the native API error structure, but never reflect the server-owned key downstream");
    assert.ok(!body.includes(fixture.secret));
    assert.equal(response.headers.get("x-request-id"), "rejected-[REDACTED]");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/custom/" + provider + routes[operation][1]);
    assertAuth(calls[0], fixture);
    const current = getUpstreamCredentialWithSecret(fixture.credential.id);
    assert.ok(Date.parse(current.cooldownUntil) > Date.now());
    assert.ok(current.lastError);
    assert.ok(!current.lastError.includes(fixture.secret));
    assert.equal(getUpstreamCredentialWithSecret(spare.record.id).lastUsedAt, null);
    assert.equal(getUpstreamCredentialWithSecret(spare.record.id).cooldownUntil, null);
    assert.deepEqual(old.snapshot(), oauthBefore, "API failures must not mutate/refresh the OAuth store");
    const logs = getLogDb().prepare("SELECT * FROM request_logs WHERE channel_id = ?").all(fixture.channel.id);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status_code, status);
    assert.ok(logs[0].error_code);
    assert.ok(detail(logs[0]).upstream_body_text.includes("[REDACTED]"));
  });
}

for (const [provider, operation] of [
  ["openai", "chat"], ["openai", "responses"], ["anthropic", "chat"], ["anthropic", "responses"],
  ["anthropic", "messages"], ["anthropic", "count_tokens"],
]) {
  test(provider + " " + operation + ": destroyed upstream connection returns one redacted 502 log without retry or OAuth fallback", { timeout: 15000 }, async (t) => {
    const consoleErrors = t.mock.method(console, "error", () => {});
    const model = (provider === "openai" ? "gpt-" : "claude-") + "connection-failure-" + randomUUID();
    const fixture = setup(provider, { model, channel: { priority: 1000 } });
    const spare = credential(provider, { priority: 1 });
    patchChannel(fixture.channel.id, { credentialIds: [fixture.credential.id, spare.record.id] });
    const old = oauth(provider === "openai" ? "codex" : "claude", model);
    const oauthBefore = old.snapshot();
    fixture.key = createApiKey({ channelAllowlist: [fixture.channel.id, old.channel.id], modelAllowlist: [model] });
    const payload = { ...payloadFor(operation, model), custom_extension: fixture.secret };
    reply = (_call, res) => res.destroy();
    const response = await run(fixture, operation, payload);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("x-relay-quota-provider"), provider);
    const body = await response.text();
    const result = JSON.parse(body);
    if (operation === "messages" || operation === "count_tokens") {
      assert.equal(result.type, "error");
      assert.equal(result.error.type, "api_error");
      assert.ok(result.error.message);
    } else {
      assert.equal(result.type, undefined, "Chat/Responses connection errors must use the OpenAI envelope, even on Anthropic channels");
      assert.equal(result.error.code, "upstream_connection_error");
    }
    assert.equal(calls.length, 1, "A failed API connection cannot retry another credential or fall back to OAuth");
    assert.equal(calls[0].path, provider === "anthropic" && (operation === "chat" || operation === "responses")
      ? "/custom/anthropic/v1/messages" : "/custom/" + provider + routes[operation][1]);
    if (provider === "openai" || operation === "messages" || operation === "count_tokens") {
      assert.deepEqual(calls[0].payload, payload, "The original request really contains the synthetic key before logging redaction");
    }
    assertAuth(calls[0], fixture, provider === "anthropic" && (operation === "chat" || operation === "responses")
      ? "text/event-stream" : "application/json");
    const logs = getLogDb().prepare("SELECT * FROM request_logs WHERE api_key_id = ?").all(fixture.key.id);
    assert.equal(logs.length, 1, "The API callback must log once without reaching the OAuth outer catch");
    const log = logs[0];
    assert.equal(log.status_code, 502);
    assert.equal(log.channel_id, fixture.channel.id);
    assert.equal(log.credential_id, fixture.credential.id);
    assert.equal(log.model, model);
    assert.ok(log.request_type.endsWith("." + provider));
    assert.equal(log.error_code, "upstream_connection_error");
    assert.ok(log.error_message);
    const captured = detail(log);
    assert.ok(captured);
    assert.deepEqual(JSON.parse(captured.request_body_text), { ...payload, custom_extension: "[REDACTED]" });
    assert.equal(getLogDb().prepare("SELECT COUNT(*) AS n FROM usage_records WHERE api_key_id = ?").get(fixture.key.id).n, 0);
    const health = getLogDb().prepare("SELECT * FROM channel_health_events WHERE channel_id = ?").all(fixture.channel.id);
    assert.equal(health.length, 1);
    assert.equal(health[0].event_type, "failure");
    assert.equal(health[0].status_code, 502);
    const printedErrors = consoleErrors.mock.calls.map((call) => call.arguments);
    const channelError = getMainDb().prepare("SELECT last_error FROM channels WHERE id = ?").get(fixture.channel.id);
    for (const output of [body, JSON.stringify([...response.headers]), JSON.stringify(log), JSON.stringify(captured),
      JSON.stringify(health), JSON.stringify(printedErrors), JSON.stringify(channelError)]) {
      assert.ok(!output.includes(fixture.secret), "Connection failures must not expose the upstream key in responses, logs or health metadata");
    }
    assert.equal(getUpstreamCredentialWithSecret(spare.record.id).lastUsedAt, null);
    assert.equal(getUpstreamCredentialWithSecret(spare.record.id).cooldownUntil, null);
    assert.deepEqual(old.snapshot(), oauthBefore, "Connection failure must not mutate or refresh OAuth credentials");
  });
}

for (const [provider, operation] of [["openai", "responses"], ["anthropic", "messages"]]) {
  test(provider + " truncated SSE is a protocol failure and produces a local 502 log, never a successful request", { timeout: 15000 }, async () => {
    const fixture = setup(provider);
    reply = (_call, res) => sendSse(res, provider === "openai"
      ? event("response.output_text.delta", { output_index: 0, content_index: 0, delta: "partial" })
      : claudeSse(fixture.model, { complete: false }), responseHeaders(provider));
    const response = await run(fixture, operation, { ...payloadFor(operation, fixture.model), stream: true });
    const body = await response.text();
    assert.ok(body.includes('"error"'));
    assert.ok(!body.includes(provider === "openai" ? "response.completed" : "event: message_stop"));
    assert.equal(calls.length, 1);
    const log = lastLog(fixture.channel);
    assert.equal(log.status_code, 502);
    assert.ok(log.error_code);
    assert.ok(log.error_message);
    assert.equal(log.credential_id, fixture.credential.id);
    assert.equal(getLogDb().prepare("SELECT COUNT(*) AS n FROM request_logs WHERE channel_id = ? AND status_code = 200").get(fixture.channel.id).n, 0);
  });
}

for (const provider of ["openai", "anthropic"]) {
  test(provider + ": downstream JSON and full logs redact reflected API keys in bodies, headers and health metadata", { timeout: 15000 }, async () => {
    const operation = provider === "openai" ? "chat" : "messages";
    const fixture = setup(provider);
    const payload = { ...payloadFor(operation, fixture.model), custom_extension: fixture.secret };
    reply = (call, res) => {
      res.writeHead(200, { ...responseHeaders(provider), "x-request-id": "echo-" + fixture.secret });
      res.end(JSON.stringify(provider === "openai" ? {
        model: call.payload.model, choices: [{ message: { role: "assistant", content: fixture.secret } }], usage: chatUsage,
      } : { id: "msg_redaction", type: "message", role: "assistant", model: call.payload.model,
        content: [{ type: "text", text: fixture.secret }], stop_reason: "end_turn", usage: claudeUsage }));
    };
    const response = await run(fixture, operation, payload);
    assert.equal(response.status, 200);
    const body = await response.text();
    const result = JSON.parse(body);
    assert.equal(provider === "openai" ? result.choices[0].message.content : result.content[0].text, "[REDACTED]");
    assert.ok(!body.includes(fixture.secret), "A successful native JSON reply must not reflect its API key downstream");
    assert.equal(response.headers.get("x-request-id"), "echo-[REDACTED]");
    assert.equal(calls.length, 1);
    const captured = assertLogged(fixture, provider === "openai" ? [7, 4, 11, 2] : [10, 4, 14, 3]);
    for (const column of ["request_body_text", "forwarded_body_text", "upstream_body_text", "upstream_headers_json"]) {
      assert.ok(captured[column].includes("[REDACTED]"), column + " must redact reflected upstream key material");
    }
  });
}

test("OpenAI plain-text upstream errors retain status/text while replacing every reflected key downstream and in logs", { timeout: 15000 }, async () => {
  const fixture = setup("openai");
  reply = (_call, res) => {
    res.writeHead(400, { ...responseHeaders("openai"), "content-type": "text/plain; charset=utf-8" });
    res.end("Denied " + fixture.secret + "; repeated " + fixture.secret + "\n");
  };
  const response = await run(fixture, "chat", payloadFor("chat", fixture.model));
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type"), /^text\/plain/);
  const body = await response.text();
  assert.equal(body, "Denied [REDACTED]; repeated [REDACTED]\n");
  assert.ok(!body.includes(fixture.secret));
  assert.equal(calls.length, 1);
  const log = lastLog(fixture.channel);
  assert.equal(log.status_code, 400);
  assert.equal(detail(log).upstream_body_text, body);
});

for (const [provider, operation] of [
  ["openai", "chat"], ["openai", "responses"], ["anthropic", "messages"], ["anthropic", "responses"],
]) {
  test(provider + " " + operation + ": downstream SSE redacts a key split across HTTP chunks without corrupting events or usage logs", { timeout: 15000 }, async (t) => {
    const fixture = setup(provider, { model: provider === "openai" ? "vendor-reflection-api-model" : "claude-reflection-api-model" });
    const payload = { ...payloadFor(operation, fixture.model), stream: true };
    const marker = "SAFE_REFLECTION_PREFIX:";
    const safeText = marker + text + ".".repeat(128);
    const reflectedText = "before-key " + fixture.secret + " after-key";
    const expectedText = safeText + "before-key [REDACTED] after-key";
    let wire;
    if (provider === "openai" && operation === "chat") {
      const chunk = (content) => "data: " + JSON.stringify({ id: "chatcmpl_reflection", object: "chat.completion.chunk",
        model: fixture.model, choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + "\n\n";
      wire = chunk(safeText) + chunk(reflectedText)
        + "data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: chatUsage })
        + "\n\ndata: [DONE]\n\n";
    } else if (provider === "openai") {
      const completed = openAIResponse(fixture.model);
      completed.output[0].content[0].text = safeText + reflectedText;
      wire = event("response.created", { response: { ...completed, status: "in_progress", output: [] } })
        + event("response.output_text.delta", { output_index: 0, content_index: 0, delta: safeText })
        + event("response.output_text.delta", { output_index: 0, content_index: 0, delta: reflectedText })
        + event("response.completed", { response: completed });
    } else {
      const stop = event("content_block_stop", { index: 0 });
      wire = claudeSse(fixture.model).replace(text, safeText).replace(stop,
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: reflectedText } }) + stop);
    }
    const keyOffset = wire.indexOf(fixture.secret);
    assert.ok(keyOffset > 0);
    const split = keyOffset + Math.floor(fixture.secret.length / 2);
    let upstreamResponse;
    t.after(() => upstreamResponse?.destroy());
    reply = (_call, res) => {
      upstreamResponse = res;
      res.writeHead(200, { ...responseHeaders(provider), "content-type": "text/event-stream; charset=utf-8",
        "x-request-id": "echo-" + fixture.secret });
      res.write(wire.slice(0, split));
    };
    const response = await run(fixture, operation, payload);
    assert.equal(response.status, 200);
    assertQuota(response, provider);
    assert.equal(response.headers.get("x-request-id"), "echo-[REDACTED]");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    try {
      // Observe output from the first upstream read before releasing the key's remaining bytes.
      while (!body.includes(marker)) {
        const { done, value } = await reader.read();
        assert.equal(done, false, "The safe prefix must stream before the split key is complete");
        body += decoder.decode(value, { stream: true });
      }
      upstreamResponse.end(wire.slice(split));
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
      assert.ok(!body.includes(fixture.secret), "Joining downstream chunks must never reconstruct the upstream API key");
      assert.ok(body.includes("[REDACTED]"));
      assert.ok(!JSON.stringify([...response.headers]).includes(fixture.secret));
      const values = sseValues(body);
      let content;
      if (operation === "responses") {
        content = values.filter((value) => value.type === "response.output_text.delta").map((value) => value.delta).join("");
        assert.ok(values.some((value) => value.type === "response.completed"));
      } else if (operation === "chat") {
        content = values.flatMap((value) => value.choices ?? []).map((choice) => choice.delta?.content ?? "").join("");
        assert.ok(body.includes("data: [DONE]"));
      } else {
        content = values.filter((value) => value.type === "content_block_delta").map((value) => value.delta.text ?? "").join("");
        assert.ok(values.some((value) => value.type === "message_stop"));
      }
      assert.equal(content, expectedText, "Protocol conversion must not undo downstream key redaction");
      if (provider === "openai" || operation === "messages") assert.equal(body, wire.split(fixture.secret).join("[REDACTED]"));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, provider === "anthropic" ? "/custom/anthropic/v1/messages" : "/custom/openai" + routes[operation][1]);
      assertAuth(calls[0], fixture, "text/event-stream");
      const logs = getLogDb().prepare("SELECT * FROM request_logs WHERE api_key_id = ?").all(fixture.key.id);
      assert.equal(logs.length, 1);
      const captured = assertLogged(fixture, provider === "openai" ? [7, 4, 11, 2] : [10, 4, 14, 3]);
      assert.ok(captured.upstream_body_text.includes("[REDACTED]"));
    } finally {
      upstreamResponse.destroy();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  });
}

for (const provider of ["openai", "anthropic"]) {
  test(provider + ": handler enforces key/channel exact-model lists and explicit paid-channel authorization before any HTTP call", { timeout: 15000 }, async () => {
    const operation = provider === "openai" ? "responses" : "messages";
    for (const scenario of [
      { name: "empty channel allowlist is OAuth-only", key: { channelAllowlist: [] }, status: 503 },
      { name: "another channel is not paid authorization", key: { channelAllowlist: ["synthetic-unrelated-channel"] }, status: 503 },
      { name: "key model filter", key: { modelAllowlist: ["synthetic-other-model"] }, status: 403 },
      { name: "channel model filter", suffix: "-unlisted", key: { modelAllowlist: [] }, status: 503 },
      { name: "OAuth thinking suffix is not an API alias", suffix: "(high)", key: { modelAllowlist: [] }, status: 503 },
      { name: "disabled API channel", channel: { enabled: false }, status: 503 },
      { name: "API channel defaults to disabled", channel: { enabled: undefined }, status: 503 },
    ]) {
      const fixture = setup(provider, { model: "guard-" + provider + "-" + randomUUID(), key: scenario.key, channel: scenario.channel });
      const response = await run(fixture, operation, payloadFor(operation, fixture.model + (scenario.suffix || "")));
      assert.equal(response.status, scenario.status, scenario.name);
      const result = await response.json();
      assert.ok(result.error?.message, scenario.name);
        if (provider === "openai") assert.equal(result.error.code, scenario.status === 403 ? "model_not_allowed" : "no_available_channel", scenario.name);
    }
    assert.equal(calls.length, 0, "Denied API requests cannot spend an upstream API key");
  });
}

test("API channels accept vendor prefixes and send the channel's own model name upstream", { timeout: 15000 }, async () => {
  const id = randomUUID().slice(0, 8);
  async function upstreamModel(fixture, operation, model, form = false) {
    calls.length = 0;
    let payload = payloadFor(operation, model);
    if (form) {
      payload = new FormData();
      payload.append("model", model);
      payload.append("prompt", "Draw a synthetic cat");
      payload.append("image[]", new Blob(["a"], { type: "image/png" }), "a.png");
      payload.append("image[]", new Blob(["b"], { type: "image/png" }), "b.png");
    }
    const response = await run(fixture, operation, payload);
    assert.equal(response.status, 200, operation + " " + model);
    await response.arrayBuffer();
    assert.equal(calls.length, 1);
    if (form) assert.equal(calls[0].form.getAll("image[]").length, 2, "Multipart files survive the model rewrite");
    return calls[0].payload?.model ?? calls[0].form.get("model");
  }
  async function status(fixture, operation, model) {
    calls.length = 0;
    const response = await run(fixture, operation, payloadFor(operation, model));
    await response.arrayBuffer();
    assert.equal(calls.length, 0, model + " must not reach the upstream");
    return response.status;
  }

  // A plain upstream receives the bare name, whatever prefix the client sends; key and channel lists stay bare.
  const plain = setup("openai", { model: "gpt-plain-" + id });
  for (const operation of ["chat", "responses", "images_generations"]) {
    assert.equal(await upstreamModel(plain, operation, "openai/" + plain.model), plain.model);
    assert.equal(await upstreamModel(plain, operation, "OpenAI/" + plain.model), plain.model);
    assert.equal(await upstreamModel(plain, operation, plain.model), plain.model);
  }
  assert.equal(await upstreamModel(plain, "images_edits", "openai/" + plain.model, true), plain.model);
  assert.equal(lastLog(plain.channel).model, "openai/" + plain.model, "Logs keep the requested name");
  const claude = setup("anthropic", { model: "claude-plain-" + id });
  for (const operation of ["messages", "count_tokens", "chat"]) {
    assert.equal(await upstreamModel(claude, operation, "anthropic/" + claude.model), claude.model);
  }

  // An OpenRouter-style channel lists prefixed names and must keep receiving them, even for bare requests.
  const routed = setup("openai", { model: "openai/gpt-routed-" + id, key: { modelAllowlist: [] } });
  assert.equal(await upstreamModel(routed, "chat", routed.model), routed.model);
  assert.equal(await upstreamModel(routed, "chat", "gpt-routed-" + id), routed.model);
  const both = setup("openai", { model: "gpt-both-" + id, channel: { modelAllowlist: ["gpt-both-" + id, "openai/gpt-both-" + id] },
    key: { modelAllowlist: [] } });
  assert.equal(await upstreamModel(both, "chat", "openai/gpt-both-" + id), "openai/gpt-both-" + id, "An exact entry wins");
  assert.equal(await upstreamModel(both, "chat", "gpt-both-" + id), "gpt-both-" + id);

  // Only known vendor prefixes are equivalent, and only to the bare name or the same vendor.
  const llama = setup("openai", { model: "meta-llama/llama-" + id, key: { modelAllowlist: [] } });
  assert.equal(await status(llama, "chat", "llama-" + id), 503, "Other namespaces are part of the model name");
  assert.equal(await status(routed, "chat", "anthropic/gpt-routed-" + id), 503, "A different vendor is a different model");
  assert.equal(await status(plain, "chat", "openai/" + plain.model + "(high)"), 503, "Prefixes do not enable OAuth suffixes");

  // The key allowlist still restricts the model, in either spelling.
  const restricted = setup("openai", { model: "gpt-allowed-" + id,
    channel: { modelAllowlist: ["gpt-allowed-" + id, "gpt-denied-" + id] }, key: { modelAllowlist: ["openai/gpt-allowed-" + id] } });
  assert.equal(await upstreamModel(restricted, "chat", "gpt-allowed-" + id), "gpt-allowed-" + id);
  assert.equal(await status(restricted, "chat", "openai/gpt-denied-" + id), 403);
  assert.equal(await status(restricted, "chat", "gpt-denied-" + id), 403);
});

for (const [provider, operation, capabilities] of [
  ["openai", "chat", ["responses"]], ["openai", "responses", ["chat"]],
  ["openai", "images_generations", ["chat"]], ["openai", "images_edits", ["images_generations"]],
  ["anthropic", "messages", ["count_tokens"]], ["anthropic", "count_tokens", ["messages"]],
]) {
  test(provider + " " + operation + ": handler rejects a channel without this operation capability", { timeout: 15000 }, async () => {
    const fixture = setup(provider, { model: "capability-model-" + randomUUID(), channel: { capabilities } });
    const response = await run(fixture, operation, payloadFor(operation, fixture.model));
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.ok(result.error?.message);
    if (provider === "openai") assert.equal(result.error.code, "no_available_channel");
    assert.equal(calls.length, 0);
  });
}

test("/models exposes only explicitly authorized API channel models, filters key/channel state and never invents OAuth thinking variants", { timeout: 15000 }, async () => {
  const openaiModels = ["gpt-5.4", "claude-sonnet-4-6", "custom-image-catalog-model", "literal-api-model(high)"];
  const anthropicModels = ["anthropic-private-catalog-model", "custom-image-catalog-model"];
  const openai = setup("openai", { channel: { modelAllowlist: openaiModels } });
  const anthropic = setup("anthropic", { channel: { modelAllowlist: anthropicModels } });
  const disabled = setup("openai", { model: "disabled-api-catalog-model", channel: { enabled: false } });
  const old = oauth("codex", "gpt-5.4");
  oauth("claude", "claude-sonnet-4-6");
  async function models(channelAllowlist, modelAllowlist = []) {
    const key = createApiKey({ channelAllowlist, modelAllowlist });
    const response = await handleModels(new Request("http://relay.invalid/v1/models", { headers: { authorization: "Bearer " + key.key } }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.object, "list");
    assert.ok(result.data.every((entry) => entry.object === "model"));
    const ids = result.data.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, "API model IDs are deduplicated");
    return ids.sort();
  }
  assert.deepEqual(await models([openai.channel.id]), [...openaiModels].sort(), "API-only clients must not inherit any OAuth subscription catalog");
  assert.deepEqual(await models([anthropic.channel.id]), [...anthropicModels].sort());
  assert.deepEqual(await models([openai.channel.id, anthropic.channel.id]), [...new Set([...openaiModels, ...anthropicModels])].sort());
  assert.deepEqual(await models([openai.channel.id, anthropic.channel.id], ["claude-sonnet-4-6", "anthropic-private-catalog-model"]),
    ["anthropic-private-catalog-model", "claude-sonnet-4-6"]);
  assert.deepEqual(await models([openai.channel.id, disabled.channel.id]), [...openaiModels].sort());
  assert.deepEqual(await models([disabled.channel.id]), []);
  assert.deepEqual(await models([openai.channel.id], ["gpt-5.4(high)"]), [], "API model filtering is exact, unlike OAuth suffix matching");
  assert.deepEqual(await models([openai.channel.id], ["openai/gpt-5.4"]), ["gpt-5.4"],
    "A vendor-prefixed key entry lists the channel's bare model");
  const unbound = await models([]);
  for (const id of ["custom-image-catalog-model", "literal-api-model(high)", "anthropic-private-catalog-model", "disabled-api-catalog-model"]) {
    assert.ok(!unbound.includes(id), "An unbound RelayKey must not discover paid model " + id);
  }
  const oauthOnly = await models([old.channel.id], ["gpt-5.4"]);
  assert.ok(oauthOnly.includes("gpt-5.4"));
  assert.ok(oauthOnly.includes("gpt-5.4(high)"), "Authorized OAuth models keep the existing subscription variants");
  assert.ok(!oauthOnly.includes("custom-image-catalog-model"));
  assert.equal(calls.length, 0, "/models may read the mocked catalog, not probe API credentials or upstream model endpoints");
});
