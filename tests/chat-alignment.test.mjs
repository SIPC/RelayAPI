import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
const projectRoot = new URL("../", import.meta.url);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  if (specifier.startsWith("@/")) return nextResolve(new URL(specifier.slice(2) + ".ts", projectRoot).href, context);
  return nextResolve(specifier, context);
} });
const codex = await import("../src/server/codex/client.ts");
const { chatCompletionsToClaude, responsesToClaude } = await import("../src/server/claude/chat.ts");
const { prepareClaudeOAuthUpstreamPayload } = await import("../src/server/claude/compat.ts");
const { claudeBetas } = await import("../src/server/claude/wire.ts");
const accountId = "10000000-0000-4000-8000-000000000001";
const deviceId = "ab".repeat(32);
const context = {
  accessToken: "sk-ant-oat01-synthetic", sourceHeaders: new Headers(),
  claudeUserAgent: "claude-cli/2.1.280 (external, cli)", accountId, deviceId,
};
const system = "CUSTOM_SYSTEM_SENTINEL: Always reply in Chinese. Output JSON only.";
function cc(extra = {}) {
  return chatCompletionsToClaude({
    model: "claude-sonnet-4-5", messages: [
      { role: "system", content: system }, { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" }, { role: "user", content: "Continue" },
    ], ...extra,
  }, { stream: true }).payload;
}
function prepare(payload, overrides = {}) {
  return prepareClaudeOAuthUpstreamPayload(payload, { ...context, ...overrides });
}
function cacheControls(value, result = []) {
  if (!value || typeof value !== "object") return result;
  if (value.cache_control) result.push(value.cache_control);
  for (const [key, child] of Object.entries(value)) if (key !== "cache_control") cacheControls(child, result);
  return result;
}
for (const protocol of ["chat", "responses"]) {
  test("OAI " + protocol + ": preserve explicit parallel=false, cache key and ultrafast", () => {
    const input = { model: "gpt-6.1-sol", messages: [{ role: "user", content: "Hi" }], input: "Hi",
      parallel_tool_calls: false, prompt_cache_key: "caller-cache", service_tier: "ultrafast" };
    const converted = protocol === "chat" ? codex.chatCompletionsToCodex(input, { stream: true }).payload
      : codex.normalizeResponsesPayload(input, { stream: true });
    const payload = codex.prepareCodexPayloadForUpstream(converted, {
      planType: "plus", fastServiceTier: true, promptCacheKey: "fallback-cache",
    });
    assert.equal(payload.parallel_tool_calls, false);
    assert.equal(payload.prompt_cache_key, "caller-cache");
    assert.equal(payload.service_tier, "ultrafast");
    assert.equal(payload.stream, true);
    assert.equal(payload.store, false);
  });
}
test("OAI defaults do not request summaries; explicit effort and visibility are honored", () => {
  const build = (fields) => codex.chatCompletionsToCodex({
    model: "gpt-6.1-sol", messages: [{ role: "user", content: "Hi" }], ...fields,
  }).payload;
  assert.deepEqual(build({}).reasoning, { effort: "medium" });
  assert.equal(build({ reasoning_effort: "high" }).reasoning.summary, "auto");
  assert.equal(build({ reasoning_effort: "none" }).reasoning.summary, undefined);
  assert.equal(build({ reasoning_effort: "high", include_reasoning: false }).reasoning.summary, undefined);
  assert.equal(build({ reasoning: { effort: "high", summary: "concise" } }).reasoning.summary, "concise");
});
test("OAI Responses retains requested search sources and removes unsupported fields", () => {
  const payload = codex.prepareCodexPayloadForUpstream(codex.normalizeResponsesPayload({
    model: "gpt-6.1-sol", input: "Hi", temperature: 0.5, top_p: 0.8,
    max_output_tokens: 500, previous_response_id: "old", include: ["web_search_call.action.sources"],
  }), { planType: "plus", transport: "http" });
  assert.deepEqual(payload.include, ["reasoning.encrypted_content", "web_search_call.action.sources"]);
  for (const field of ["temperature", "top_p", "max_output_tokens", "previous_response_id"]) assert.equal(payload[field], undefined);
});
test("OAI fast aliases and no-tool parallel field match CPA", () => {
  for (const tier of ["fast", " FAST ", "priority"]) {
    assert.equal(codex.prepareCodexPayloadForUpstream({ model: "gpt-6.1-sol", service_tier: tier }, { planType: "free" }).service_tier, "priority");
  }
  const payload = codex.prepareCodexPayloadForUpstream({ model: "gpt-6.1-sol", parallel_tool_calls: true }, { planType: "free" });
  assert.equal(payload.parallel_tool_calls, undefined);
});
test("CC OAuth preserves custom system instructions without the old fixed coding prompt", () => {
  const result = prepare(cc());
  assert.ok(result.body.includes(system));
  assert.equal(result.payload.system.length, 2);
  assert.ok(result.payload.messages[0].content.some((part) => part.text.includes(system)));
  assert.ok(!result.body.includes("# Doing tasks"));
  assert.ok(!result.body.includes("cch=00000;"));
  assert.equal(result.payload.system[1].text, "You are Claude Code, Anthropic's official CLI for Claude.");
});
test("CC modern models relocate caller system into the first conversation turn", () => {
  const result = prepare(cc({ model: "claude-opus-5-5" }));
  assert.equal(result.payload.messages[1].role, "system");
  assert.equal(result.payload.messages[1].content[0].text, system);
  assert.deepEqual(result.payload.fallbacks, [{ model: "claude-opus-4-8" }]);
});
test("CC keeps one conversation identity as messages grow and separates distinct roots", () => {
  const original = cc();
  const first = prepare(original);
  const continued = structuredClone(original);
  continued.messages.push({ role: "assistant", content: "Reply" }, { role: "user", content: "Next" });
  const second = prepare(continued);
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(first.payload.metadata.user_id, second.payload.metadata.user_id);
  const identity = JSON.parse(first.payload.metadata.user_id);
  assert.equal(identity.account_uuid, accountId);
  assert.equal(identity.device_id, deviceId);
  assert.equal(identity.session_id, first.sessionId);
  const other = cc(); other.messages[0].content[0].text = "Different conversation";
  assert.notEqual(first.sessionId, prepare(other).sessionId);
});
test("CC cache markers use the latest eligible message, enforce four and add OAuth TTL", () => {
  const result = prepare(cc());
  assert.deepEqual(result.payload.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral", ttl: "1h" });
  assert.ok(cacheControls(result.payload).length <= 4);
  assert.ok(cacheControls(result.payload).every((cc) => cc.ttl === "1h"));
});
test("CC explicit caching retains marker and TTL intent", () => {
  const payload = cc();
  payload.prompt_cache_options = { mode: "explicit" };
  payload.messages.at(-1).content[0].cache_control = { type: "ephemeral", ttl: "5m" };
  const result = prepare(payload).payload;
  assert.equal(result.prompt_cache_options, undefined);
  assert.equal(cacheControls(result).length, 1);
  assert.equal(cacheControls(result)[0].ttl, "5m");
});
for (const [model, type, effort] of [
  ["claude-sonnet-4-5", "enabled", "high"],
  ["claude-sonnet-4-6", "adaptive", "high"],
  ["claude-opus-4-7", "adaptive", "xhigh"],
]) {
  test("CC model-aware thinking: " + model, () => {
    const result = cc({ model, reasoning_effort: effort });
    assert.equal(result.thinking.type, type);
    if (type === "enabled") assert.equal(result.thinking.budget_tokens, 24576);
    else assert.equal(result.output_config.effort, effort);
  });
}
test("CC model suffix wins over body effort and long context adds its beta", () => {
  const payload = cc({ model: "claude-sonnet-4-6(1m)(high)", reasoning_effort: "low" });
  assert.equal(payload.model, "claude-sonnet-4-6");
  assert.equal(payload.output_config.effort, "high");
  assert.ok(payload.betas.includes("context-1m-2025-08-07"));
});
test("CC translated sampling is removed; forced tool use disables thinking and its auto context edit", () => {
  const payload = cc({ model: "claude-sonnet-4-6", reasoning_effort: "high", temperature: 0.2, top_p: 0.5,
    tool_choice: "required" });
  const result = prepare(payload).payload;
  assert.equal(result.temperature, undefined);
  assert.equal(result.top_p, undefined);
  assert.equal(result.thinking, undefined);
  assert.equal(result.output_config, undefined);
  assert.equal(result.context_management, undefined);
});
test("CC native caller owns system, cache placement and valid sampling, while identity is rebound", () => {
  const sessionId = "20000000-0000-4000-8000-000000000002";
  const payload = {
    model: "claude-sonnet-4-6", system: [{ type: "text", text: "Native caller system", cache_control: { type: "ephemeral", ttl: "5m" } }],
    metadata: { user_id: JSON.stringify({ device_id: "cd".repeat(32), account_uuid: accountId, session_id: sessionId, extra: 1 }) },
    messages: [{ role: "user", content: "Hi" }], temperature: 0.7, max_tokens: 100,
  };
  const headers = new Headers({ "user-agent": "claude-cli/2.1.280 (external, cli)", "x-app": "cli",
    "anthropic-beta": "claude-code-20250219", "x-claude-code-session-id": sessionId });
  const result = prepare(payload, { sourceHeaders: headers });
  assert.equal(result.native, true);
  assert.deepEqual(result.payload.system, payload.system);
  assert.deepEqual(result.payload.messages, payload.messages);
  assert.equal(result.payload.temperature, 0.7);
  assert.equal(JSON.parse(result.payload.metadata.user_id).device_id, deviceId);
  assert.equal(JSON.parse(result.payload.metadata.user_id).extra, 1);
  assert.equal(result.sessionId, sessionId);
});
test("CC copied User-Agent alone does not bypass the normal request pipeline", () => {
  const result = prepare(cc(), { sourceHeaders: new Headers({ "user-agent": "claude-cli/2.1.280 (external, cli)" }) });
  assert.equal(result.native, false);
  assert.ok(result.payload.system[0].text.startsWith("x-anthropic-billing-header:"));
});
test("CC betas follow body features instead of the old unconditional list", () => {
  const payload = prepare(cc()).payload;
  const normal = claudeBetas(payload, null, [], false).split(",");
  assert.ok(normal.includes("oauth-2025-04-20"));
  assert.ok(normal.includes("extended-cache-ttl-2025-04-11"));
  assert.ok(!normal.includes("fast-mode-2026-02-01"));
  assert.ok(!normal.includes("structured-outputs-2025-12-15"));
  const fast = claudeBetas({ ...payload, speed: "fast" }, null, [], false);
  assert.ok(fast.includes("fast-mode-2026-02-01"));
});
test("Claude Responses conversion retains system and explicit cache settings", () => {
  const converted = responsesToClaude({
    model: "claude-sonnet-4-6", instructions: system, input: "Hi",
    prompt_cache_options: { mode: "explicit" }, reasoning: { effort: "high" },
  }).payload;
  assert.equal(converted.prompt_cache_options.mode, "explicit");
  assert.ok(prepare(converted).body.includes(system));
});

test("CC legacy bare aliases use the matching dated policy, not a newer model", () => {
  const result = cc({ model: "claude-opus-4", reasoning_effort: "high" });
  assert.equal(result.thinking.type, "enabled");
  assert.equal(result.thinking.budget_tokens, 24576);
});
test("CC derived sessions normalize Relay authentication style and separate API keys", () => {
  const payload = cc();
  const bearer = prepare(payload, { sourceHeaders: new Headers({ authorization: "Bearer synthetic-key-a" }) });
  const xKey = prepare(payload, { sourceHeaders: new Headers({ "x-api-key": "synthetic-key-a" }) });
  const other = prepare(payload, { sourceHeaders: new Headers({ "x-api-key": "synthetic-key-b" }) });
  assert.equal(bearer.sessionId, xKey.sessionId);
  assert.notEqual(xKey.sessionId, other.sessionId);
});

test("Claude OAI compatibility preserves sequential tools and structured-output instructions", () => {
  const payload = cc({ parallel_tool_calls: false, tools: [{
    type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } },
  }], response_format: { type: "json_schema", json_schema: {
    name: "answer", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
  } } });
  assert.deepEqual(payload.tool_choice, { type: "auto", disable_parallel_tool_use: true });
  const wire = prepare(payload);
  assert.ok(wire.body.includes("JSON Schema:"));
  assert.ok(wire.body.includes("Schema Name: answer"));
  assert.ok(wire.body.includes(system));
});
test("Claude Responses forwards parallel tool control and text.format", () => {
  const payload = responsesToClaude({ model: "claude-sonnet-4-6", input: "Hi", parallel_tool_calls: false,
    tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
    text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } } },
  }).payload;
  assert.equal(payload.tool_choice.disable_parallel_tool_use, true);
  assert.ok(prepare(payload).body.includes("Schema Name: answer"));
});
