import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { registerHooks } from "node:module";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const proxyState = globalThis.__upstreamClientTestProxy = { pool: null, global: null, calls: [] };
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
    if (specifier === "@/src/server/services/proxyPool") return {
      url: "data:text/javascript,export function getProxyPoolCredentialProxy(id) { const s = globalThis.__upstreamClientTestProxy; s.calls.push(['pool', id]); return s.pool; }",
      shortCircuit: true,
    };
    if (specifier === "@/src/server/services/settings") return {
      url: "data:text/javascript,export function getGlobalProxySetting() { const s = globalThis.__upstreamClientTestProxy; s.calls.push(['global']); return s.global; }",
      shortCircuit: true,
    };
    if (/^@\/src\/server\/(?:codex\/|claude\/(?:client|compat)|services\/(?:codexCredentials|claudeCredentials))/.test(specifier)) {
      throw new Error("API key forwarding must not import OAuth clients or preparation: " + specifier);
    }
    if (specifier.startsWith("@/")) return nextResolve(new URL(specifier.slice(2) + ".ts", root).href, context);
    return nextResolve(specifier, context);
  },
});
const { forwardApiKeyRequest } = await import("../src/server/upstream/forward.ts");
const { apiUpstreamUrl } = await import("../src/server/upstream/client.ts");
const { serverConfig } = await import("../src/server/config/env.ts");
const { chatCompletionsToClaude, responsesToClaude } = await import("../src/server/claude/chat.ts");
const key = "sk-test-server-key-not-a-real-secret";
const encoder = new TextEncoder();

function fixture(overrides = {}) {
  const provider = overrides.provider || "openai";
  const credential = {
    id: "upstream-test", provider, name: "Mock key", apiKey: key,
    proxy: null, useGlobalProxy: false, proxyPoolId: null, ...overrides.credential,
  };
  return {
    request: new Request("http://relay.test/v1/chat/completions", { headers: {
      authorization: "Bearer downstream-only", cookie: "private=downstream", "x-api-key": "downstream-key",
      "chatgpt-account-id": "downstream-account", "x-claude-code-session-id": "downstream-session",
      "user-agent": "claude-cli/should-never-be-forwarded", originator: "codex-tui", "x-stainless-os": "downstream-os",
    } }),
    channel: { id: "channel-test", provider, baseUrl: "http://mock.test/custom/prefix/v1", capabilities: [] },
    credential,
    operation: overrides.operation || "chat",
    payload: { model: "unregistered-model(high)", messages: [{ role: "user", content: "hello" }] },
    ...Object.fromEntries(Object.entries(overrides).filter(([name]) => !["provider", "credential"].includes(name))),
  };
}

function mockFetch(t, reply) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, ...init });
    return typeof reply === "function" ? reply(url, init) : reply;
  };
  t.after(() => { globalThis.fetch = original; proxyState.pool = null; proxyState.global = null; proxyState.calls.length = 0; });
  return requests;
}

async function forward(input) {
  const results = [];
  const response = await forwardApiKeyRequest({ ...input, onResult: (result) => results.push(result) });
  return { response, results };
}

function stream(text, chunkSize = 7, ending = "close") {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset < bytes.length) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize)); offset += chunkSize;
      } else if (ending === "error") controller.error(new Error("synthetic socket failure " + key));
      else if (ending === "close") controller.close();
    },
  });
}
const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
function claudeSse(stop = true) {
  return event("message_start", { message: { id: "msg_mock", model: "claude-custom", role: "assistant", content: [], usage: {
    input_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 0,
  } } }) + event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "你好🌍" } }) +
    event("content_block_stop", { index: 0 }) +
    event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }) +
    (stop ? event("message_stop", {}) : "");
}
function sseResponse(text, size = 7, ending = "close") {
  return new Response(stream(text, size, ending), { headers: { "content-type": "text/event-stream; charset=utf-8", "request-id": "req_mock" } });
}
const claudeUsage = { promptTokens: 10, completionTokens: 4, totalTokens: 14, cachedTokens: 3 };

for (const [operation, path] of [
  ["chat", "/chat/completions"], ["responses", "/responses"],
  ["images_generations", "/images/generations"], ["images_edits", "/images/edits"],
]) {
  test("OpenAI " + operation + " preserves JSON, custom API prefix and native results", async (t) => {
    const result = { native: true, data: [{ url: "http://images.test/original.png" }], usage: {
      input_tokens: 8, output_tokens: 9, total_tokens: 17, input_tokens_details: { cached_tokens: 2 },
    } };
    const requests = mockFetch(t, Response.json(result));
    const payload = { model: "external-image-or-chat-model(high)", tools: [{ type: "custom", untouched: true }],
      store: true, include: ["custom.extension"], stream: false, response_format: "url", arbitrary_extension: { x: 1 } };
    const { response, results } = await forward(fixture({ operation, payload, captureBody: true }));
    assert.equal(requests[0].url, "http://mock.test/custom/prefix/v1" + path);
    assert.deepEqual(JSON.parse(requests[0].body), payload);
    assert.deepEqual(await response.json(), result);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].usage, { promptTokens: 8, completionTokens: 9, totalTokens: 17, cachedTokens: 2 });
    assert.deepEqual(results[0].forwardedBody, payload);
    assert.equal(requests[0].redirect, "manual");
    assert.deepEqual(Object.fromEntries(requests[0].headers), {
      accept: "application/json", authorization: "Bearer " + key, "content-type": "application/json",
    });
    assert.equal(results[0].forwardedHeaders.authorization, "[REDACTED]");
  });
}

test("OpenAI Chat usage and streaming parameters are not normalized or injected", async (t) => {
  const requests = mockFetch(t, Response.json({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14, prompt_tokens_details: { cached_tokens: 6 } } }));
  const payload = { model: "vendor-model", messages: [], stream_options: { include_usage: true } };
  const { response, results } = await forward(fixture({ payload }));
  await response.text();
  assert.deepEqual(JSON.parse(requests[0].body), payload);
  assert.deepEqual(results[0].usage, { promptTokens: 11, completionTokens: 3, totalTokens: 14, cachedTokens: 6 });
  assert.equal(results[0].upstreamBody, undefined);
  assert.equal(results[0].forwardedBody, undefined);
  assert.equal(results[0].forwardedHeaders, undefined);
});

// Default cache breakpoints are the only change to a native Messages body; undo them to compare the caller's own fields.
const asCallerBody = (body) => {
  const copy = JSON.parse(JSON.stringify(body, (key, value) => key === "cache_control" ? undefined : value));
  const flat = (parts) => Array.isArray(parts) && parts.length === 1 && parts[0].type === "text" && Object.keys(parts[0]).length === 2 ? parts[0].text : parts;
  if (copy.system) copy.system = flat(copy.system);
  for (const message of copy.messages ?? []) message.content = flat(message.content);
  return copy;
};
for (const operation of ["messages", "count_tokens"]) {
  test("Anthropic native " + operation + " bypasses OAuth preparation and max_tokens policy", async (t) => {
    const requests = mockFetch(t, Response.json(operation === "count_tokens" ? { input_tokens: 23 } : {
      id: "msg_native", content: [], usage: { input_tokens: 5, output_tokens: 4, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
    }));
    const payload = { model: "claude-custom(high)", messages: [], system: "Only the caller system", tools: [{ name: "bash", input_schema: { type: "object" } }], custom_extension: true };
    const request = new Request("http://relay.test/v1/messages", { headers: { "anthropic-version": "2023-06-01", "anthropic-beta": "caller-explicit-beta", authorization: "Bearer downstream" } });
    const { response, results } = await forward(fixture({ provider: "anthropic", operation, request, payload, captureBody: true }));
    assert.equal(response.status, 200);
    assert.equal(requests[0].url, "http://mock.test/custom/prefix/v1/messages" + (operation === "count_tokens" ? "/count_tokens" : ""));
    assert.deepEqual(asCallerBody(JSON.parse(requests[0].body)), payload);
    // Inference gets default breakpoints on the last cacheable blocks; a token-count estimate never writes a cache.
    assert.equal(JSON.stringify(JSON.parse(requests[0].body)).includes("cache_control"), operation === "messages");
    assert.deepEqual(Object.fromEntries(requests[0].headers), {
      accept: "application/json", "anthropic-version": "2023-06-01",
      "content-type": "application/json", "x-api-key": key,
    });
    assert.deepEqual(results[0].usage, operation === "count_tokens" ? { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 } : claudeUsage);
    if (operation === "count_tokens") assert.deepEqual(await response.json(), { input_tokens: 23 });
    assert.equal(results[0].forwardedHeaders["x-api-key"], "[REDACTED]");
  });
}

test("Anthropic defaults only API version, without OAuth/CLI beta or identity", async (t) => {
  const requests = mockFetch(t, Response.json({ input_tokens: 1 }));
  await forward(fixture({ provider: "anthropic", operation: "count_tokens" }));
  assert.deepEqual(Object.fromEntries(requests[0].headers), {
    accept: "application/json", "anthropic-version": "2023-06-01", "content-type": "application/json", "x-api-key": key,
  });
});

test("oauth:false preserves tool names in both converters; omitted option retains OAuth behavior", () => {
  for (const convert of [chatCompletionsToClaude, responsesToClaude]) {
    const payload = { model: "claude-custom", messages: [{ role: "user", content: "hi" }], input: "hi", tools: [{ type: "function", name: "bash", function: { name: "bash", parameters: { type: "object" } } }] };
    assert.equal(convert(payload, { stream: true, oauth: false }).payload.tools[0].name, "bash");
    assert.deepEqual(convert(payload, { stream: true, oauth: false }).reverseToolNameMap, {});
    assert.equal(convert(payload, { stream: true }).payload.tools[0].name, "Bash");
  }
});

for (const operation of ["chat", "responses"]) {
  for (const streaming of [false, true]) {
    test(`Anthropic converts ${operation} ${streaming ? "SSE" : "aggregate"}, including byte-split UTF-8 and CRLF`, async (t) => {
      const text = claudeSse().replaceAll("\n", "\r\n");
      const requests = mockFetch(t, sseResponse(text, 1));
      const { response, results } = await forward(fixture({ provider: "anthropic", operation, captureBody: true,
        payload: { model: "claude-custom", messages: [{ role: "system", content: "CALLER_ONLY_SYSTEM" }, { role: "user", content: "hi" }],
          input: "hi", instructions: "CALLER_ONLY_SYSTEM", max_tokens: 77, stream: streaming,
          tools: [{ type: "function", name: "bash", function: { name: "bash", parameters: { type: "object" } } }] },
      }));
      const sent = JSON.parse(requests[0].body);
      assert.equal(sent.stream, true);
      assert.equal(sent.max_tokens, 77);
      assert.equal(sent.tools[0].name, "bash");
      const serialized = JSON.stringify(sent);
      assert.ok(serialized.includes("CALLER_ONLY_SYSTEM"));
      for (const forbidden of ["Claude Code", "billing", "user_id", "oauth"]) assert.ok(!serialized.includes(forbidden));
      assert.ok(serialized.includes("cache_control"), "Converted requests get the same default breakpoints as OAuth");
      if (streaming) {
        assert.equal(results.length, 0);
        const output = await response.text();
        assert.ok(output.includes("你好🌍"));
        assert.ok(output.includes(operation === "chat" ? "[DONE]" : "response.completed"));
        assert.ok(!output.includes("stream_error"));
      } else {
        const output = await response.json();
        assert.equal(operation === "chat" ? output.choices[0].message.content : output.output_text, "你好🌍");
        assert.equal(output.usage.total_tokens, 14);
      }
      assert.equal(results.length, 1);
      assert.equal(results[0].statusCode, 200);
      assert.deepEqual(results[0].usage, claudeUsage);
      assert.ok(results[0].upstreamBody.includes("message_stop"));
      assert.equal(results[0].upstreamHeaders.get("content-type"), "text/event-stream; charset=utf-8");
    });
  }
}

const nativeCases = [
  { provider: "openai", operation: "chat", text: 'data: {"choices":[{"delta":{"content":"你好🌍"}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5, cachedTokens: 0 } },
  { provider: "openai", operation: "responses", text: event("response.completed", { response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }), usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5, cachedTokens: 0 } },
  ...["images_generations", "images_edits"].map((operation) => ({ provider: "openai", operation, text: event(operation === "images_edits" ? "image_edit.completed" : "image_generation.completed", { b64_json: "original-native-image", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }), usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5, cachedTokens: 0 } })),
  { provider: "anthropic", operation: "messages", text: claudeSse(), usage: claudeUsage },
];
for (const value of nativeCases) {
  test("native SSE remains byte-identical: " + value.provider + " " + value.operation, async (t) => {
    mockFetch(t, sseResponse(value.text, 1));
    const { response, results } = await forward(fixture({ provider: value.provider, operation: value.operation, payload: { model: "native-model", stream: true } }));
    assert.equal(results.length, 0);
    assert.equal(await response.text(), value.text);
    assert.equal(results.length, 1);
    assert.equal(results[0].statusCode, 200);
    assert.deepEqual(results[0].usage, value.usage);
  });
}

for (const [name, provider, operation, text] of [
  ["Chat EOF", "openai", "chat", 'data: {"choices":[]}\n\n'],
  ["Responses DONE alone", "openai", "responses", "data: [DONE]\n\n"],
  ["Images partial only", "openai", "images_generations", event("image_generation.partial_image", { b64_json: "partial" })],
  ["Claude missing stop", "anthropic", "messages", claudeSse(false)],
  ["unterminated completion frame", "openai", "chat", "data: [DONE]\n"],
  ["malformed JSON", "openai", "chat", "data: {broken}\n\n"],
]) {
  test("SSE truncation/malformed data logs 502, emits a protocol error: " + name, async (t) => {
    mockFetch(t, sseResponse(text));
    const { response, results } = await forward(fixture({ provider, operation, payload: { model: "test", stream: true } }));
    const output = await response.text();
    assert.ok(output.includes('"error"'));
    assert.equal(results.length, 1);
    assert.equal(results[0].statusCode, 502);
    assert.ok(results[0].errorCode);
  });
}

for (const [operation, text] of [
  ["responses", event("response.failed", { response: { status: "failed", error: { code: "quota_exceeded", message: "No quota" } } })],
  ["responses", event("response.incomplete", { response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } })],
  ["responses", event("response.completed", { response: { status: "incomplete" } })],
  ["chat", 'data: {"error":{"message":"stream denied"}}\n\ndata: [DONE]\n\n'],
]) {
  test("upstream explicit error/incomplete is never a success: " + operation + " " + text.slice(0, 45), async (t) => {
    mockFetch(t, sseResponse(text, 4096));
    const { response, results } = await forward(fixture({ operation, payload: { stream: true } }));
    assert.equal(await response.text(), text);
    assert.equal(results.length, 1);
    assert.equal(results[0].statusCode, 502);
  });
}

for (const operation of ["chat", "responses"]) {
  for (const streaming of [false, true]) {
    for (const failure of ["error", "truncated", "socket"]) {
      test(`Anthropic ${operation} ${streaming ? "stream" : "aggregate"} rejects ${failure} without fabricated success`, async (t) => {
        const text = claudeSse(false) + (failure === "error" ? event("error", { error: { type: "overloaded_error", message: "denied " + key } }) + event("message_stop", {}) : "");
        mockFetch(t, sseResponse(text, 4096, failure === "socket" ? "error" : "close"));
        const { response, results } = await forward(fixture({ provider: "anthropic", operation, captureBody: true, payload: { model: "claude-custom", input: "hi", messages: [], stream: streaming } }));
        const output = await response.text();
        assert.equal(response.status, streaming ? 200 : 502);
        assert.ok(output.includes('"error"'));
        assert.ok(!output.includes("response.completed"));
        assert.equal(results.length, 1);
        assert.equal(results[0].statusCode, 502);
        assert.ok(!JSON.stringify(results[0]).includes(key));
      });
    }
  }
}

test("native Claude preserves its error frame but records failure even with later message_stop", async (t) => {
  const text = event("error", { error: { type: "overloaded_error", message: "try later" } }) + event("message_stop", {});
  mockFetch(t, sseResponse(text, 4096));
  const { response, results } = await forward(fixture({ provider: "anthropic", operation: "messages", payload: { stream: true } }));
  assert.equal(await response.text(), text);
  assert.equal(results[0].statusCode, 502);
});

test("native transport failure emits a protocol error and redacts secrets from callbacks", async (t) => {
  mockFetch(t, sseResponse('data: {"choices":[]}\n\n', 4096, "error"));
  const { response, results } = await forward(fixture({ payload: { stream: true }, captureBody: true }));
  const text = await response.text();
  assert.ok(text.includes("[REDACTED]"));
  assert.ok(!text.includes(key));
  assert.equal(results.length, 1);
  assert.equal(results[0].statusCode, 502);
  assert.ok(!JSON.stringify(results[0]).includes(key));
});

test("downstream cancellation before terminal records failure once and aborts upstream", async (t) => {
  const requests = mockFetch(t, sseResponse('data: {"choices":[]}\n\n', 4096, "hang"));
  const { response, results } = await forward(fixture({ payload: { stream: true } }));
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel("client disconnected");
  assert.equal(results.length, 1);
  assert.equal(results[0].statusCode, 502);
  assert.equal(results[0].errorCode, "downstream_cancelled");
  assert.equal(requests[0].signal.aborted, true);
});

test("request.signal abort is logged even before the caller reads its streaming response", async (t) => {
  const abort = new AbortController();
  mockFetch(t, sseResponse("", 1, "hang"));
  const { response, results } = await forward(fixture({ request: new Request("http://relay.test", { signal: abort.signal }), payload: { stream: true } }));
  abort.abort();
  assert.equal(results.length, 1);
  assert.equal(results[0].statusCode, 502);
  assert.ok((await response.text()).includes("upstream_stream_aborted"));
});

for (const operation of ["chat", "responses"]) {
  test("canceling converted " + operation + " SSE cannot report success", async (t) => {
    mockFetch(t, sseResponse(claudeSse(false), 50, "hang"));
    const { response, results } = await forward(fixture({ provider: "anthropic", operation, payload: { model: "claude-custom", input: "hi", messages: [], stream: true } }));
    await response.body.cancel();
    assert.equal(results.length, 1);
    assert.equal(results[0].statusCode, 502);
  });
}

test("SSE capture is opt-in, capped at 512 KiB and does not corrupt forwarded UTF-8", async (t) => {
  const text = 'data: ' + JSON.stringify({ choices: [{ delta: { content: "🌍".repeat(150000) } }] }) + '\n\ndata: [DONE]\n\n';
  mockFetch(t, sseResponse(text, 4093));
  const { response, results } = await forward(fixture({ payload: { stream: true }, captureBody: true }));
  assert.equal(await response.text(), text);
  assert.ok(encoder.encode(results[0].upstreamBody).length <= 512 * 1024);
  assert.ok(!results[0].upstreamBody.includes("�"));
});

test("response headers filter account identity, cookies, connection-nominated headers and stale entity metadata", async (t) => {
  mockFetch(t, Response.json({ ok: true }, { headers: {
    "set-cookie": "private=1", "set-cookie2": "private=2", connection: "x-private-hop", "x-private-hop": "hidden",
    "x-account-id": "private", "x-user-id": "private", "openai-organization": "private", "anthropic-organization-id": "private",
    "content-encoding": "gzip", "content-length": "123", "transfer-encoding": "chunked", "x-codex-account": "private",
    "request-id": "req-safe", "x-request-id": "xreq-safe", "retry-after": "5", "x-ratelimit-remaining-tokens": "20",
    "anthropic-ratelimit-input-tokens-limit": "100", "openai-processing-ms": "12",
  } }));
  const { response, results } = await forward(fixture());
  assert.deepEqual(Object.fromEntries(response.headers), {
    "content-type": "application/json", "request-id": "req-safe", "x-request-id": "xreq-safe", "retry-after": "5",
    "x-ratelimit-remaining-tokens": "20", "anthropic-ratelimit-input-tokens-limit": "100", "openai-processing-ms": "12",
  });
  assert.deepEqual(Object.fromEntries(results[0].upstreamHeaders), Object.fromEntries(response.headers));
});

for (const status of [300, 301, 302, 303, 304, 307, 308]) {
  test("redirect " + status + " is refused without forwarding a key to Location", async (t) => {
    const requests = mockFetch(t, new Response(null, { status, headers: { location: "http://evil.test/capture", "set-cookie": "secret=1" } }));
    const { response, results } = await forward(fixture());
    assert.equal(requests.length, 1);
    assert.equal(requests[0].redirect, "manual");
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("location"), null);
    assert.equal(results[0].statusCode, 502);
    assert.equal(results[0].errorCode, "upstream_redirect_rejected");
  });
}

for (const bad of ["file:///etc/passwd", "ftp://host/v1", "http://user:password@host/v1", "http://host/v1?secret=1", "not-a-url"]) {
  test("reject invalid or non-HTTP(S) API root: " + bad, () => {
    assert.throws(() => apiUpstreamUrl("openai", bad, "chat"), (error) => error.status === 400);
  });
}

test("default roots and unsupported protocol combinations", async (t) => {
  assert.equal(apiUpstreamUrl("anthropic", "", "messages"), "https://api.anthropic.com/v1/messages");
  assert.equal(apiUpstreamUrl("openai", "", "responses"), "https://api.openai.com/v1/responses");
  assert.equal(apiUpstreamUrl("anthropic", "http://local.test/", "count_tokens"), "http://local.test/v1/messages/count_tokens");
  const requests = mockFetch(t, Response.json({}));
  await assert.rejects(forward(fixture({ operation: "messages" })), (error) => error.code === "unsupported_upstream_operation");
  await assert.rejects(forward(fixture({ provider: "anthropic", operation: "images_generations" })), (error) => error.code === "unsupported_upstream_operation");
  await assert.rejects(forward(fixture({ channel: { provider: "anthropic" } })), (error) => error.code === "upstream_provider_mismatch");
  assert.equal(requests.length, 0);
});

test("HTTP errors preserve native structure and status while redacting the server key downstream and in logs", async (t) => {
  const native = { error: { code: "invalid_api_key", message: "Rejected " + key } };
  mockFetch(t, Response.json(native, { status: 401 }));
  const { response, results } = await forward(fixture({ payload: { arbitrary: key }, captureBody: true }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: { code: "invalid_api_key", message: "Rejected [REDACTED]" } });
  assert.equal(results[0].errorCode, "invalid_api_key");
  assert.ok(!JSON.stringify(results[0]).includes(key));
});

test("JSON Responses incomplete/error and malformed JSON are not logged as HTTP 200 successes", async (t) => {
  let reply;
  mockFetch(t, () => reply);
  for (const value of [{ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, { error: { message: "denied" } }, "not json"]) {
    reply = typeof value === "string" ? new Response(value) : Response.json(value);
    const { response, results } = await forward(fixture({ operation: "responses" }));
    assert.equal(response.status, 502);
    assert.equal(results[0].statusCode, 502);
  }
});

test("non-SSE success cannot be silently aggregated into an Anthropic converted success", async (t) => {
  mockFetch(t, Response.json({ id: "unexpected-json", content: [] }));
  const { response, results } = await forward(fixture({ provider: "anthropic", operation: "chat" }));
  assert.equal(response.status, 502);
  assert.equal(results[0].errorCode, "invalid_upstream_protocol");
});

test("connection exceptions may throw but cannot leak the upstream key through their cause", async (t) => {
  mockFetch(t, () => { throw new Error("network failure " + key, { cause: { authorization: key } }); });
  await assert.rejects(forward(fixture()), (error) => {
    assert.equal(error.status, 502);
    assert.ok(!error.message.includes(key));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("nonstream request abort while reading body returns a failure result once", async (t) => {
  const abort = new AbortController();
  mockFetch(t, new Response(stream("", 1, "hang"), { headers: { "content-type": "application/json" } }));
  const pending = forward(fixture({ request: new Request("http://relay.test", { signal: abort.signal }) }));
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  const { response, results } = await pending;
  assert.equal(response.status, 502);
  assert.equal(results.length, 1);
});

async function localHttp(t, responder) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, headers: req.headers, bytes: Buffer.concat(chunks) });
    responder(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/custom/v1`, requests };
}

// A minimal local SOCKS5 tunnel exercises the actual node-fetch path, not a fetch stub.
async function localSocks(t) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    let greeted = false;
    function receive(chunk) {
      pending = Buffer.concat([pending, chunk]);
      if (!greeted) {
        if (pending.length < 2 || pending.length < 2 + pending[1]) return;
        pending = pending.subarray(2 + pending[1]); greeted = true;
        socket.write(Buffer.from([5, 0]));
      }
      if (pending.length < 4) return;
      const type = pending[3];
      const length = type === 1 ? 10 : type === 3 && pending.length >= 5 ? 7 + pending[4] : Infinity;
      if (pending.length < length) return;
      const host = type === 1 ? Array.from(pending.subarray(4, 8)).join(".") : pending.subarray(5, 5 + pending[4]).toString();
      const port = pending.readUInt16BE(length - 2);
      const remainder = pending.subarray(length);
      socket.off("data", receive);
      const target = net.createConnection({ host, port });
      sockets.add(target); target.on("close", () => sockets.delete(target));
      target.on("error", () => socket.destroy()); socket.on("error", () => target.destroy());
      target.once("connect", () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        if (remainder.length) target.write(remainder);
        socket.pipe(target); target.pipe(socket);
      });
    }
    socket.on("data", receive);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  return { enabled: true, type: "socks5h", host: "127.0.0.1", port: server.address().port, username: "", password: "" };
}

for (const proxied of [false, true]) {
  test("multipart edits preserve repeated fields, files, mask and boundary via " + (proxied ? "SOCKS/node-fetch" : "native fetch"), { timeout: 15000 }, async (t) => {
    const local = await localHttp(t, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "local-multipart" });
      res.end(JSON.stringify({ data: [{ url: "http://native-image.test/original" }], usage: { input_tokens: 7, output_tokens: 8, total_tokens: 15 } }));
    });
    const proxy = proxied ? await localSocks(t) : null;
    const form = new FormData();
    form.append("model", "vendor-unregistered-image-model");
    form.append("prompt", "unchanged"); form.append("prompt", "second-value");
    form.append("image[]", new File([new Uint8Array([0, 1, 2, 255])], "a.png", { type: "image/png" }));
    form.append("image[]", new File(["second-file"], "b.webp", { type: "image/webp" }));
    form.append("mask", new File(["mask-file"], "mask.png", { type: "image/png" }));
    form.append("custom_extension", "kept");
    const { response, results } = await forward(fixture({ operation: "images_edits", payload: form,
      credential: { proxy }, channel: { provider: "openai", baseUrl: local.baseUrl }, captureBody: true,
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].url, "http://native-image.test/original");
    assert.equal(local.requests.length, 1);
    const sent = local.requests[0];
    assert.equal(sent.url, "/custom/v1/images/edits");
    assert.equal(sent.headers.authorization, "Bearer " + key);
    for (const name of ["cookie", "x-api-key", "originator", "chatgpt-account-id", "x-stainless-os", "x-claude-code-session-id"]) assert.equal(sent.headers[name], undefined);
    assert.ok(!sent.headers["user-agent"]?.includes("claude-cli"));
    const parsed = await new Response(sent.bytes, { headers: { "content-type": sent.headers["content-type"] } }).formData();
    assert.deepEqual(parsed.getAll("prompt"), ["unchanged", "second-value"]);
    const images = parsed.getAll("image[]");
    assert.equal(images.length, 2);
    assert.equal(images[0].name, "a.png"); assert.equal(images[1].name, "b.webp");
    assert.deepEqual(new Uint8Array(await images[0].arrayBuffer()), new Uint8Array([0, 1, 2, 255]));
    assert.equal(await parsed.get("mask").text(), "mask-file");
    assert.equal(parsed.get("model"), "vendor-unregistered-image-model");
    assert.equal(parsed.get("response_format"), null);
    assert.equal(parsed.get("custom_extension"), "kept");
    assert.equal(results[0].forwardedBody.filter(([name]) => name === "image[]").length, 2);
    assert.deepEqual(results[0].usage, { promptTokens: 7, completionTokens: 8, totalTokens: 15, cachedTokens: 0 });
  });
}

test("generic proxy priority is private, then pool, then opted-in global without OAuth credential access", { timeout: 15000 }, async (t) => {
  const local = await localHttp(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  const proxy = await localSocks(t);
  t.after(() => { proxyState.pool = null; proxyState.global = null; proxyState.calls.length = 0; });
  for (const mode of ["private", "pool", "global", "none"]) {
    proxyState.calls.length = 0;
    proxyState.pool = mode === "pool" ? proxy : null;
    proxyState.global = proxy;
    await forward(fixture({ channel: { provider: "openai", baseUrl: local.baseUrl }, credential: {
      proxy: mode === "private" ? proxy : null, proxyPoolId: "pool-id", useGlobalProxy: mode === "global",
    } }));
    assert.deepEqual(proxyState.calls.map(([name]) => name), mode === "private" ? [] : mode === "global" ? ["pool", "global"] : ["pool"]);
  }
  assert.equal(local.requests.length, 4);
});

test("real HTTP 307 cannot send authorization to a second local origin", { timeout: 15000 }, async (t) => {
  const target = await localHttp(t, (_req, res) => res.end("should-not-be-called"));
  const origin = await localHttp(t, (_req, res) => { res.writeHead(307, { location: target.baseUrl }); res.end(); });
  const { response, results } = await forward(fixture({ channel: { provider: "openai", baseUrl: origin.baseUrl } }));
  assert.equal(response.status, 502);
  assert.equal(results[0].errorCode, "upstream_redirect_rejected");
  assert.equal(origin.requests.length, 1);
  assert.equal(target.requests.length, 0);
});

for (const proxied of [false, true]) {
  test("real premature HTTP SSE close logs 502 via " + (proxied ? "SOCKS/node-fetch" : "native fetch"), { timeout: 15000 }, async (t) => {
    const local = await localHttp(t, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[],"usage":{"prompt_tokens":9}}\n\n');
      setTimeout(() => res.destroy(), 20);
    });
    const proxy = proxied ? await localSocks(t) : null;
    const { response, results } = await forward(fixture({ channel: { provider: "openai", baseUrl: local.baseUrl },
      credential: { proxy }, payload: { stream: true }, captureBody: true,
    }));
    const output = await response.text();
    assert.ok(output.includes('"error"'));
    assert.equal(results.length, 1);
    assert.equal(results[0].statusCode, 502);
    assert.equal(results[0].usage.promptTokens, 9);
  });
}

for (const streaming of [false, true]) {
  test("configured " + (streaming ? "stream" : "aggregate") + " timeout combines with request.signal", { timeout: 2000 }, async (t) => {
    const previous = [serverConfig.requestTimeoutMs, serverConfig.streamRequestTimeoutMs];
    serverConfig.requestTimeoutMs = streaming ? 1000 : 15;
    serverConfig.streamRequestTimeoutMs = streaming ? 15 : 1000;
    t.after(() => { [serverConfig.requestTimeoutMs, serverConfig.streamRequestTimeoutMs] = previous; });
    const requests = mockFetch(t, sseResponse("", 1, "hang"));
    // AbortSignal.timeout is unref'd; keep the test's event loop alive while it fires.
    const keepAlive = setTimeout(() => {}, 1500);
    t.after(() => clearTimeout(keepAlive));
    const { response, results } = await forward(fixture({ provider: "anthropic", operation: "chat", payload: { model: "claude-custom", stream: streaming } }));
    const output = await response.text();
    assert.ok(output.includes('"error"'));
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(results.length, 1);
    assert.equal(results[0].statusCode, 502);
  });
}

test("terminal events complete without waiting for an upstream socket to close", async (t) => {
  mockFetch(t, sseResponse('data: [DONE]\n\n', 4096, "hang"));
  const { response, results } = await forward(fixture({ payload: { stream: true } }));
  assert.equal(await response.text(), 'data: [DONE]\n\n');
  assert.equal(results.length, 1);
  assert.equal(results[0].statusCode, 200);
});

test("SSE handles lone CR separators and multi-line data without changing native bytes", async (t) => {
  const text = ': heartbeat\r\revent: response.completed\rdata: {"type":"response.completed",\rdata: "response":{"status":"completed"}}\r\r';
  mockFetch(t, sseResponse(text, 1));
  const { response, results } = await forward(fixture({ operation: "responses", payload: { stream: true } }));
  assert.equal(await response.text(), text);
  assert.equal(results[0].statusCode, 200);
});

test("invalid UTF-8 is a protocol failure, not replacement text followed by success", async (t) => {
  const bytes = new Uint8Array([...encoder.encode('data: {"text":"'), 0xff, ...encoder.encode('"}\n\ndata: [DONE]\n\n')]);
  mockFetch(t, new Response(bytes, { headers: { "content-type": "text/event-stream" } }));
  const { response, results } = await forward(fixture({ payload: { stream: true } }));
  assert.ok((await response.text()).includes('"error"'));
  assert.equal(results.length, 1);
  assert.equal(results[0].statusCode, 502);
});

test("Responses error events retain top-level official error details in the callback", async (t) => {
  const text = event("error", { code: "rate_limit_exceeded", message: "slow down", param: null });
  mockFetch(t, sseResponse(text));
  const { response, results } = await forward(fixture({ operation: "responses", payload: { stream: true } }));
  assert.equal(await response.text(), text);
  assert.equal(results[0].statusCode, 502);
  assert.equal(results[0].errorCode, "rate_limit_exceeded");
  assert.equal(results[0].errorMessage, "slow down");
});

test("JSON-escaped and URL-encoded keys cannot leak into callback bodies or errors", async (t) => {
  const unusualKey = 'synthetic"quoted/key+=';
  mockFetch(t, Response.json({ error: { message: "Rejected " + unusualKey + " " + encodeURIComponent(unusualKey) } }, { status: 401 }));
  const { results } = await forward(fixture({ credential: { apiKey: unusualKey }, payload: { custom: unusualKey }, captureBody: true }));
  assert.ok(!JSON.stringify(results[0]).includes(JSON.stringify(unusualKey).slice(1, -1)));
  assert.ok(!results[0].upstreamBody.includes(encodeURIComponent(unusualKey)));
});

for (const operation of ["images_generations", "images_edits"]) {
  test(operation + " forwards two completed images and final usage through EOF", async (t) => {
    const prefix = operation === "images_edits" ? "image_edit" : "image_generation";
    const frames = [
      event(prefix + ".completed", { index: 0, b64_json: "first-image", usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } }),
      event(prefix + ".completed", { index: 1, b64_json: "second-image" }),
      event(prefix + ".usage", { usage: { input_tokens: 7, output_tokens: 11, total_tokens: 18, input_tokens_details: { cached_tokens: 2 } } }),
    ];
    let index = 0;
    let reachedEof = false;
    let canceled = false;
    const body = new ReadableStream({
      pull(controller) {
        if (index < frames.length) controller.enqueue(encoder.encode(frames[index++]));
        else { reachedEof = true; controller.close(); }
      },
      cancel() { canceled = true; },
    }, { highWaterMark: 0 });
    mockFetch(t, new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const { response, results } = await forward(fixture({ operation, payload: { model: "native-image", n: 2, stream: true }, captureBody: true }));
    const reader = response.body.getReader();
    for (const frame of frames) {
      const { done, value } = await reader.read();
      assert.equal(done, false);
      assert.equal(new TextDecoder().decode(value), frame);
      assert.equal(results.length, 0, "image completion is not the request's terminal event");
      assert.equal(canceled, false);
    }
    assert.equal((await reader.read()).done, true);
    assert.equal(reachedEof, true);
    assert.equal(canceled, false);
    assert.equal(results.length, 1);
    assert.equal(results[0].statusCode, 200);
    assert.equal(results[0].upstreamBody, frames.join(""));
    assert.deepEqual(results[0].usage, { promptTokens: 7, completionTokens: 11, totalTokens: 18, cachedTokens: 2 });
  });
}

for (const ending of ["error", "cancel", "protocol_error"]) {
  test("Images remain a failure after one completed image followed by " + ending, async (t) => {
    const first = event("image_generation.completed", { index: 0, b64_json: "first-image" });
    const text = first + (ending === "protocol_error" ? event("error", { code: "second_image_failed", message: "Second image failed" }) : "");
    mockFetch(t, sseResponse(text, encoder.encode(first).length, ending === "protocol_error" ? "close" : ending === "cancel" ? "hang" : "error"));
    const { response, results } = await forward(fixture({ operation: "images_generations", payload: { n: 2, stream: true } }));
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), first);
    assert.equal(results.length, 0);
    if (ending === "cancel") await reader.cancel();
    else {
      let output = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += new TextDecoder().decode(value);
      }
      assert.ok(output.includes('"error"'));
    }
    assert.equal(results.length, 1);
    assert.equal(results[0].statusCode, 502);
  });
}

test("count_tokens ignores payload.stream:true and sends only a JSON token-count request", async (t) => {
  const requests = mockFetch(t, Response.json({ input_tokens: 23 }));
  const payload = Object.freeze({ model: "claude-native", messages: [], stream: true, extension: { kept: true } });
  const { response, results } = await forward(fixture({ provider: "anthropic", operation: "count_tokens", payload, captureBody: true }));
  assert.equal(requests[0].headers.get("accept"), "application/json");
  assert.equal(requests[0].headers.get("content-type"), "application/json");
  const expected = { model: "claude-native", messages: [], extension: { kept: true } };
  assert.deepEqual(JSON.parse(requests[0].body), expected);
  assert.deepEqual(results[0].forwardedBody, expected);
  assert.equal(payload.stream, true, "the caller's payload must not be mutated");
  assert.equal(results.length, 1, "JSON completion reports without reading a downstream stream");
  assert.equal(results[0].statusCode, 200);
  assert.deepEqual(results[0].usage, { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 });
  assert.deepEqual(await response.json(), { input_tokens: 23 });
});

test("count_tokens rejects an unexpected SSE response instead of entering streaming mode", async (t) => {
  const requests = mockFetch(t, sseResponse(claudeSse()));
  const { response, results } = await forward(fixture({ provider: "anthropic", operation: "count_tokens", payload: { stream: true } }));
  assert.equal(requests[0].headers.get("accept"), "application/json");
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(results.length, 1);
  assert.equal(results[0].errorCode, "invalid_upstream_protocol");
});

for (const path of ["connection", "http_error", "sse_error", "body_read_error"]) {
  test("API key reflections are redacted from " + path + " errors and reports", async (t) => {
    const secret = 'synthetic"reflected/key+=';
    const variants = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];
    const reflected = "Reflected " + secret + " " + encodeURIComponent(secret);
    const error = new Error(reflected + " " + variants[1], { cause: { authorization: secret } });
    error.name = secret;
    mockFetch(t, () => {
      if (path === "connection") throw error;
      if (path === "body_read_error") return new Response(new ReadableStream({ pull(controller) { controller.error(error); } }));
      const value = { code: secret, message: reflected };
      if (path === "sse_error") return sseResponse(event("error", value));
      return Response.json({ error: value }, { status: 401, headers: { "x-request-id": encodeURIComponent(secret) } });
    });
    const input = fixture({ credential: { apiKey: secret }, payload: { stream: path === "sse_error", extension: secret }, captureBody: true });
    let logged;
    if (path === "connection") {
      const results = [];
      await assert.rejects(forwardApiKeyRequest({ ...input, onResult: (result) => results.push(result) }), (failure) => {
        logged = { ...failure, name: failure.name, message: failure.message, stack: failure.stack };
        assert.equal(failure.code, "upstream_connection_error");
        assert.equal(failure.cause, undefined);
        return true;
      });
      assert.equal(results.length, 0, "connection failures belong to the parent's catch logger");
    } else {
      const { response, results } = await forward(input);
      await response.text();
      assert.equal(results.length, 1);
      assert.equal(results[0].statusCode, path === "http_error" ? 401 : 502);
      logged = { ...results[0], upstreamHeaders: Object.fromEntries(results[0].upstreamHeaders) };
    }
    const serialized = JSON.stringify(logged);
    for (const variant of variants) assert.ok(!serialized.includes(JSON.stringify(variant).slice(1, -1)), path + " must redact " + variant);
    assert.ok(serialized.includes("[REDACTED]"));
  });
}

for (const provider of ["openai", "anthropic"]) {
  for (const status of [200, 401]) {
    test(`${provider} JSON ${status} redacts actual downstream reflected key variants without changing structure`, async (t) => {
      const secret = 'synthetic"response/key+=';
      const message = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)].join(" | ");
      const native = status === 200 ? { id: "native", content: [{ text: message }], usage: { input_tokens: 1 } }
        : { type: "error", error: { type: "authentication_error", message } };
      mockFetch(t, Response.json(native, { status }));
      const { response, results } = await forward(fixture({ provider, operation: provider === "anthropic" ? "messages" : "chat", credential: { apiKey: secret } }));
      assert.equal(response.status, status);
      const output = await response.json();
      const expected = "[REDACTED] | [REDACTED] | [REDACTED]";
      assert.deepEqual(output, status === 200 ? { ...native, content: [{ text: expected }] }
        : { ...native, error: { ...native.error, message: expected } });
      assert.equal(results.length, 1);
    });
  }
  test(provider + " plain text errors redact all actual downstream key variants and keep status/content type", async (t) => {
    const secret = 'synthetic"text/key+=';
    const message = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)].join(" | ");
    mockFetch(t, new Response(message, { status: 429, headers: { "content-type": "text/plain", "retry-after": "7" } }));
    const { response } = await forward(fixture({ provider, operation: provider === "anthropic" ? "messages" : "responses", credential: { apiKey: secret } }));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("content-type"), "text/plain");
    assert.equal(response.headers.get("retry-after"), "7");
    assert.equal(await response.text(), "[REDACTED] | [REDACTED] | [REDACTED]");
  });
}

for (const [provider, operation] of [["openai", "chat"], ["openai", "responses"], ["openai", "images_generations"], ["anthropic", "messages"]]) {
  for (const failure of [false, true]) {
    test(`${provider} native ${operation} ${failure ? "error" : "success"} SSE redacts key variants split at every byte`, async (t) => {
      const secret = 'synthetic"SSE/key+=';
      const message = "你好🌍 " + [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)].join(" | ");
      const safe = "你好🌍 [REDACTED] | [REDACTED] | [REDACTED]";
      const frame = (content) => failure ? event("error", { code: "reflected", message: content })
        : operation === "images_generations" ? event("image_generation.completed", { b64_json: "safe-image", revised_prompt: content })
          : operation === "messages" ? event("content_block_delta", { index: 0, delta: { type: "text_delta", text: content } })
            : operation === "responses" ? event("response.output_text.delta", { delta: content })
              : 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n';
      const terminal = failure || operation === "images_generations" ? "" : operation === "chat" ? 'data: [DONE]\n\n'
        : operation === "responses" ? event("response.completed", { response: { status: "completed" } }) : event("message_stop", {});
      mockFetch(t, sseResponse(frame(message) + terminal, 1));
      const { response, results } = await forward(fixture({ provider, operation, credential: { apiKey: secret }, payload: { stream: true } }));
      assert.equal(await response.text(), frame(safe) + terminal);
      assert.equal(results.length, 1);
      assert.equal(results[0].statusCode, failure ? 502 : 200);
    });
  }
}

test("SSE redaction streams safe prefixes without waiting for a frame/EOF and preserves cancellation", async (t) => {
  const prefix = 'data: {"text":"' + "🌍".repeat(20000) + key.slice(0, 10);
  mockFetch(t, sseResponse(prefix, encoder.encode(prefix).length, "hang"));
  const { response, results } = await forward(fixture({ payload: { stream: true } }));
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.ok(first.startsWith('data: {"text":"🌍'));
  assert.ok(!first.endsWith(key.slice(0, 10)), "a possible secret suffix stays buffered");
  assert.equal(results.length, 0);
  await reader.cancel();
  assert.equal(results.length, 1);
  assert.equal(results[0].statusCode, 502);
});

for (const operation of ["chat", "responses"]) {
  for (const model of ["gateway(high)", "gateway(max)", "gateway(1m)", "gateway(1m)(high)", "gateway(32768)"]) {
    test(`API ${operation} preserves literal model ${model} without OAuth suffix options`, async (t) => {
      const requests = mockFetch(t, sseResponse(claudeSse()));
      const payload = { model, messages: [{ role: "user", content: "hi" }], input: "hi", max_tokens: 77 };
      const { response } = await forward(fixture({ provider: "anthropic", operation, payload }));
      assert.equal(response.status, 200);
      const sent = JSON.parse(requests[0].body);
      assert.equal(sent.model, model);
      assert.equal(sent.max_tokens, 77);
      for (const name of ["thinking", "output_config", "betas", "context_management"]) assert.equal(sent[name], undefined);
    });
  }
  test(`API ${operation} honors explicit reasoning rather than literal model suffix policy`, () => {
    const convert = operation === "chat" ? chatCompletionsToClaude : responsesToClaude;
    const payload = { model: "gateway(high)", messages: [], input: "hi", reasoning_effort: "low", max_tokens: 40000 };
    const sent = convert(payload, { stream: true, oauth: false }).payload;
    assert.equal(sent.model, payload.model);
    assert.equal(sent.thinking.budget_tokens, 1024);
    const baseline = convert({ ...payload, model: "gateway", reasoning_effort: undefined, max_tokens: undefined }, { stream: true, oauth: false }).payload;
    const alias = convert({ ...payload, model: "gateway-fable(max)", reasoning_effort: undefined, max_tokens: undefined }, { stream: true, oauth: false }).payload;
    assert.equal(alias.model, "gateway-fable(max)");
    assert.equal(alias.max_tokens, baseline.max_tokens, "model text must not select an OAuth token default");
    assert.equal(alias.thinking, undefined);
  });
}

for (const operation of ["images_generations", "images_edits"]) {
  const prefix = operation === "images_edits" ? "image_edit" : "image_generation";
  const complete = (image_index) => event(prefix + ".completed", { ...(image_index === undefined ? {} : { image_index }), b64_json: "complete-image" });
  const partial = (image_index) => event(prefix + ".partial_image", { image_index, partial_image_index: 0, b64_json: "partial-image" });
  for (const value of [
    { name: "n=2 only one completed", n: 2, text: complete(0), status: 502 },
    { name: "n=2 second partial at EOF", n: 2, text: complete(0) + partial(1), status: 502 },
    { name: "default n but known unfinished index", text: complete(0) + partial(1), status: 502 },
    { name: "duplicate completed index does not fill n", n: 2, text: complete(0) + complete("0"), status: 502 },
    { name: "two distinct completed indexes", n: 2, text: complete(0) + complete(1), status: 200 },
    { name: "two anonymous completions with default n", text: complete() + complete(), status: 200 },
    { name: "two anonymous completions with explicit n", n: 2, text: complete() + complete(), status: 200 },
    { name: "single batch completed with two images", n: 2, text: event(prefix + ".completed", { data: [{ b64_json: "first" }, { url: "http://native.test/second" }] }), status: 200 },
    { name: "batch duplicate image indexes", n: 2, text: event(prefix + ".completed", { data: [{ image_index: 0, b64_json: "first" }, { image_index: 0, b64_json: "duplicate" }] }), status: 502 },
    { name: "batch with an empty result", n: 2, text: event(prefix + ".completed", { data: [{ b64_json: "first" }, {}] }), status: 502 },
    { name: "batch resolves all known indexes", n: 2, text: partial(0) + partial(1) + event(prefix + ".completed", { data: [{ image_index: 0, b64_json: "first" }, { image_index: 1, b64_json: "second" }] }), status: 200 },
    { name: "ordered batch resolves prior indexed partials", n: 2, text: partial(0) + partial(1) + event(prefix + ".completed", { data: [{ b64_json: "first" }, { b64_json: "second" }] }), status: 200 },
    { name: "completed markers without image results do not fill n", n: 2, text: event(prefix + ".completed", { image_index: 0 }) + event(prefix + ".completed", { image_index: 1 }), status: 502 },
    { name: "partial_image_index is not an image ordinal", text: event(prefix + ".partial_image", { partial_image_index: 9, b64_json: "partial" }) + complete(), status: 200 },
  ]) {
    test(`${operation} completion accounting: ${value.name}`, async (t) => {
      mockFetch(t, sseResponse(value.text, 13));
      const { response, results } = await forward(fixture({ operation, payload: { stream: true, ...(value.n ? { n: value.n } : {}) } }));
      const output = await response.text();
      if (value.status === 200) assert.equal(output, value.text);
      else { assert.ok(output.startsWith(value.text)); assert.ok(output.includes('"error"')); }
      assert.equal(results.length, 1);
      assert.equal(results[0].statusCode, value.status);
      if (value.status === 502) assert.equal(results[0].errorCode, "upstream_images_incomplete");
    });
  }
}

for (const operation of ["chat", "responses"]) {
  for (const streaming of [false, true]) {
    test(`converted ${operation} ${streaming ? "SSE" : "JSON"} redacts reflected keys downstream`, async (t) => {
      const secret = 'synthetic"converted/key+=';
      const reflected = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)].join(" | ");
      const text = claudeSse().replace("你好🌍", "你好🌍 " + JSON.stringify(reflected).slice(1, -1));
      mockFetch(t, sseResponse(text, 1));
      const { response, results } = await forward(fixture({ provider: "anthropic", operation, credential: { apiKey: secret },
        payload: { model: "gateway(high)", input: "hi", messages: [], stream: streaming },
      }));
      if (streaming) {
        const output = await response.text();
        assert.ok(output.includes("你好🌍 [REDACTED] | [REDACTED] | [REDACTED]"));
        assert.ok(!output.includes(encodeURIComponent(secret)));
      } else {
        const output = await response.json();
        assert.equal(operation === "chat" ? output.choices[0].message.content : output.output_text,
          "你好🌍 [REDACTED] | [REDACTED] | [REDACTED]");
      }
      assert.equal(results.length, 1);
      assert.equal(results[0].statusCode, 200);
    });
  }
}

test("multipart image edits use requested n for completion accounting without changing the upload", async (t) => {
  const form = new FormData();
  form.append("model", "native-image"); form.append("n", "2"); form.append("stream", "true");
  form.append("image[]", new File(["original"], "original.png", { type: "image/png" }));
  const text = event("image_edit.completed", { image_index: 0, b64_json: "only-one-image" });
  const requests = mockFetch(t, sseResponse(text));
  const { response, results } = await forward(fixture({ operation: "images_edits", payload: form }));
  assert.ok((await response.text()).includes("upstream_images_incomplete"));
  assert.equal(results.length, 1);
  assert.equal(results[0].statusCode, 502);
  const sent = await new Response(requests[0].body, { headers: { "content-type": requests[0].headers.get("content-type") } }).formData();
  assert.equal(sent.get("n"), "2");
  assert.equal(await sent.get("image[]").text(), "original");
});

for (const encoding of ["unicode", "mixed_json", "mixed_percent"]) {
  test("downstream SSE redacts " + encoding + " secret escapes across byte boundaries", async (t) => {
    const secret = 'sk-synthetic"/key+=';
    const encoded = Array.from(secret, (char, index) => {
      if (encoding === "mixed_percent") return index % 2 ? char : "%" + char.charCodeAt(0).toString(16).padStart(2, "0").replace(/[a-f]/g, (hex) => index % 4 ? hex : hex.toUpperCase());
      return encoding === "mixed_json" && index % 2 ? JSON.stringify(char).slice(1, -1) : "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0");
    }).join("");
    const message = encoding === "mixed_percent" ? JSON.stringify(encoded).slice(1, -1) : encoded;
    const frame = 'data: {"error":{"code":"reflected","message":"' + message + '"}}\n\n';
    mockFetch(t, sseResponse(frame, 1));
    const { response, results } = await forward(fixture({ credential: { apiKey: secret }, payload: { stream: true }, captureBody: true }));
    assert.equal(await response.text(), 'data: {"error":{"code":"reflected","message":"[REDACTED]"}}\n\n');
    assert.equal(results.length, 1);
    assert.equal(results[0].statusCode, 502);
    assert.ok(!JSON.stringify(results[0]).includes(encoded));
  });
}

test("unreflected JSON preserves its exact formatting, literal model and UTF-8 bytes", async (t) => {
  const text = '{\n  "model": "gateway(high)", "content": "你好🌍", "details": [1, 2, 3]\n}\n';
  mockFetch(t, new Response(text, { headers: { "content-type": "application/json" } }));
  const { response } = await forward(fixture());
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), encoder.encode(text));
});
