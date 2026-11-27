import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const projectRoot = new URL("../", import.meta.url);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  if (specifier.startsWith("@/")) return nextResolve(new URL(specifier.slice(2) + ".ts", projectRoot).href, context);
  return nextResolve(specifier, context);
} });
const { prepareClaudeOAuthUpstreamPayload: prepare } = await import("../src/server/claude/compat.ts");
const { createClaudeNativeSseStream } = await import("../src/server/claude/nativeStream.ts");
const sessionId = "20000000-0000-4000-8000-000000000002";
const identity = { device_id: "ab".repeat(32), account_uuid: "10000000-0000-4000-8000-000000000001", session_id: sessionId };
const context = { accessToken: "sk-ant-oat01-synthetic", sourceHeaders: new Headers(),
  claudeUserAgent: "claude-cli/2.1.332 (external, cli)", accountId: identity.account_uuid, deviceId: identity.device_id, sessionId };
const nativeContext = { ...context, sourceHeaders: new Headers({ "user-agent": context.claudeUserAgent,
  "x-app": "cli", "anthropic-beta": "claude-code-20250219" }) };
const cch = (result) => /cch=([0-9a-f]{5});/.exec(result.payload.system[0].text)[1];
function nativePayload() {
  return { model: "claude-sonnet-4-6", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.220.test; cc_entrypoint=sdk-cli; cch=00000;" },
      { type: "text", text: "system-x" }], tools: [], metadata: { user_id: JSON.stringify(identity) }, max_tokens: 1,
    thinking: { type: "adaptive", display: "omitted" }, context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    output_config: { effort: "high" }, stream: true };
}
function conversation() {
  return { model: "claude-opus-5-5", max_tokens: 128, system: "Stable caller instructions",
    tools: [{ name: "lookup", input_schema: { type: "object" } }], messages: [
      { role: "user", content: [{ type: "text", text: "Initial question with enough distinct text" }] },
      { role: "assistant", content: "First answer" }, { role: "user", content: "Next question" },
    ] };
}
function markers(value, path = "", result = []) {
  if (!value || typeof value !== "object") return result;
  if (value.cache_control) result.push([path, value.cache_control]);
  for (const [key, child] of Object.entries(value)) {
    if (key !== "cache_control") markers(child, path ? `${path}.${key}` : key, result);
  }
  return result;
}

test("Claude CCH ignores only CPA dispatch fields and model values, not conversation growth", () => {
  const original = nativePayload();
  const first = prepare(original, nativeContext);
  // Independently computed with the local CPA claude_signing.go, not Relay's hash, over the body\n  // after its billing block is restated for Relay's Claude Code profile (2.1.332, cli).
  assert.equal(cch(first), "9adfd");
  assert.equal(prepare(original, nativeContext).body, first.body);
  for (const extra of [{ model: "claude-opus-4-6" }, { max_tokens: 999 },
    { fallbacks: [{ model: "claude-opus-4-8" }] }, { fallback_credit_token: "synthetic-credit" }]) {
    assert.equal(cch(prepare({ ...original, ...extra }, nativeContext)), cch(first), JSON.stringify(extra));
  }
  const next = structuredClone(original);
  next.messages.push({ role: "assistant", content: "Reply" }, { role: "user", content: "Continue" });
  assert.notEqual(cch(prepare(next, nativeContext)), cch(first));
  assert.equal(first.payload.model, original.model);
  assert.equal(first.payload.max_tokens, 1);
  assert.equal(original.system[0].text.includes("cch=00000;"), true, "must not mutate caller payload");
});

test("Claude CCH matches CPA recursive normalization and trailing-dispatch golden vectors", () => {
  for (const [extra, expected] of [
    [{ model: "a", plain: "b" }, "54bdc"],
    [{ max_tokens: 999, plain: "b" }, "415ce"],
    [{ plain: "b", max_tokens: 999, fallbacks: [] }, "c0837"],
    [{ max_tokens: 999, fallbacks: [], fallback_credit_token: "fake" }, "03aea"],
    [{ max_tokens: 999, model: "a", fallbacks: [] }, "3f5ae"],
    [{ plain: 'literal "model":"a" and "max_tokens":1 cch=00000; 🐈 中文', max_tokens: 123 }, "df2ce"],
  ]) {
    const result = prepare({ ...nativePayload(), extra }, nativeContext);
    assert.equal(cch(result), expected);
    assert.deepEqual(result.payload.extra, extra, "normalization must not change the wire payload");
  }
});

test("Claude default cache layout preserves the first-user anchor with tools and a growing tail", () => {
  const original = conversation();
  const first = prepare(original, context);
  assert.deepEqual(markers(first.payload).map(([path]) => path), [
    "system.1", "messages.0.content.1", "messages.1.content.0", "messages.3.content.0",
  ]);
  const next = structuredClone(original);
  next.messages.push({ role: "assistant", content: "Second answer" }, { role: "user", content: "Third question" });
  const second = prepare(next, context);
  assert.deepEqual(first.payload.messages[0], second.payload.messages[0]);
  assert.deepEqual(first.payload.messages[1], second.payload.messages[1]);
  assert.deepEqual(second.payload.messages.at(-1).content[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(prepare(next, context).body, second.body);
});

test("Claude honors four caller cache anchors without requiring a Relay-only explicit flag", () => {
  const original = conversation();
  const control = { type: "ephemeral", ttl: "5m", scope: "global" };
  original.system = [{ type: "text", text: original.system, cache_control: control }];
  original.messages = Array.from({ length: 7 }, (_, index) => ({ role: index % 2 ? "assistant" : "user",
    content: [{ type: "text", text: `History ${index}`, ...(index % 2 ? { cache_control: control } : {}) }] }));
  const result = prepare(original, context);
  assert.equal(markers(result.payload).length, 4);
  for (const index of [1, 3, 5]) assert.deepEqual(result.payload.messages[index + 1], original.messages[index]);
  assert.deepEqual(result.payload.messages[1].content[0].cache_control, control);
  assert.deepEqual(result.payload.system.map((block) => block.cache_control), [undefined, undefined]);
});

test("Claude top-level automatic cache control owns its TTL and does not gain synthetic breakpoints", () => {
  const original = { ...conversation(), cache_control: { type: "ephemeral", ttl: "5m" } };
  const result = prepare(original, context);
  assert.deepEqual(markers(result.payload), [["", original.cache_control]]);
});

test("Claude keep-all retains signed historical thinking and caller context edits", () => {
  const original = conversation();
  original.thinking = { type: "adaptive" };
  const thinking = { type: "thinking", thinking: "Synthetic reasoning", signature: "EgE=" };
  original.messages[1].content = [thinking, { type: "text", text: "First answer" }];
  const result = prepare(original, context);
  assert.deepEqual(result.payload.context_management, { edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
  assert.deepEqual(result.payload.messages[2].content[0], thinking);
  assert.equal(markers(result.payload).some(([path]) => path === "messages.2.content.0"), false);
  original.context_management = { edits: [{ type: "clear_thinking_20251015", keep: { type: "thinking_turns", value: 2 } }] };
  assert.deepEqual(prepare(original, context).payload.context_management, original.context_management);
});

test("Claude attribution fingerprint matches CPA UTF-16 vectors for emoji", () => {
  for (const [text, expected] of [["😀abcdefghijklmnopqrstuvwxyz", "e4b"], ["abc😀abcdefghijklmnop", "880"]]) {
    const original = conversation();
    original.messages[0].content = text;
    assert.match(prepare(original, context).payload.system[0].text, new RegExp(`cc_version=2\\.1\\.332\\.${expected};`));
  }
});

test("Claude native stream completes at message_stop even if the transport fails afterwards", async () => {
  let upstream;
  const body = new ReadableStream({ start(controller) { upstream = controller; } });
  const completed = [], errors = [];
  const stream = createClaudeNativeSseStream(body, {
    onCompleted: (usage) => completed.push(usage), onError: (error) => errors.push(error),
  });
  const terminal = 'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n'
    + 'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n'
    + 'data: {"type":"message_stop"}\n\n';
  const reader = stream.getReader();
  upstream.enqueue(new TextEncoder().encode(terminal));
  assert.equal(new TextDecoder().decode((await reader.read()).value), terminal);
  upstream.error(new Error("Socket failed after the complete response"));
  assert.equal((await reader.read()).done, true);
  assert.equal(errors.length, 0);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].promptTokens, 7);
  assert.equal(completed[0].completionTokens, 3);
});
