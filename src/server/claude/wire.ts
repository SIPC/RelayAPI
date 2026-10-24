import "server-only";
import crypto from "node:crypto";
import { HttpError } from "@/src/server/http/errors";
import { parseClaudeModelSuffixes } from "@/src/server/claude/modelSuffix";
import { CLAUDE_MODEL_POLICIES } from "@/src/server/claude/modelPolicies";

type RecordValue = Record<string, unknown>;
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dates = new Map<string, { date: string; expires: number }>();
const budgetByEffort: Record<string, number> = {
  none: 0, auto: -1, minimal: 512, low: 1024, medium: 8192,
  high: 24576, xhigh: 32768, max: 128000,
};

export function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}
export function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
export function claudePolicy(model: unknown) {
  const id = parseClaudeModelSuffixes(model).baseModel.replace(/-latest$/, "");
  const exact = CLAUDE_MODEL_POLICIES.find((entry) => entry.id === id);
  return exact || CLAUDE_MODEL_POLICIES.find((entry) => entry.id.startsWith(id + "-") && /^\d{8}$/.test(entry.id.slice(id.length + 1))) || null;
}
export function legacyClaudeSystem(model: unknown) {
  const id = text(model);
  return /^(claude-(?:3-[357]|(?:haiku|sonnet|opus)-4(?:-|$)))/.test(id)
    && !/^claude-opus-4-[8-9]/.test(id);
}
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => text(record(part)?.text)).filter(Boolean).join("\n\n");
}
function userIdentity(payload: RecordValue) {
  const value = text(record(payload.metadata)?.user_id);
  try { return record(JSON.parse(value)); } catch {
    const match = /^user_([a-f0-9]{64})_account_([a-f0-9-]{36})_session_([a-f0-9-]{36})$/i.exec(value);
    return match ? { device_id: match[1], account_uuid: match[2], session_id: match[3] } : null;
  }
}
export function isNativeClaudeCodeRequest(headers: Headers, payload: RecordValue, countTokens = false) {
  const ua = headers.get("user-agent") || "";
  const entrypoint = /^claude-cli\/\d+\.\d+\.\d+ \(external,\s*([^,)]+)/i.exec(ua)?.[1];
  const identity = userIdentity(payload);
  return Boolean(entrypoint && ["cli", "sdk-cli", "sdk-ts", "claude-vscode"].includes(entrypoint)
    && headers.get("x-app") === "cli"
    && (headers.get("anthropic-beta") || "").split(",").some((beta) => beta.trim() === "claude-code-20250219")
    && (countTokens || (identity && /^[a-f0-9]{64}$/i.test(text(identity.device_id))
      && UUID.test(text(identity.account_uuid)) && UUID.test(text(identity.session_id)))));
}
export function stableUuid(seed: string) {
  const hash = crypto.createHash("sha1").update(seed).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}
export function claudeSessionId(payload: RecordValue, headers: Headers, native: boolean) {
  const metadata = record(payload.metadata);
  const candidates = [
    metadata?.session_id, payload.session_id, payload.conversation_id,
    headers.get("session-id"), headers.get("session_id"),
    ...(native ? [headers.get("x-claude-code-session-id"), userIdentity(payload)?.session_id] : []),
  ];
  for (const candidate of candidates) {
    const value = text(candidate);
    if (value) return UUID.test(value) ? value : stableUuid("claude:session:" + value);
  }
  const firstUser = (Array.isArray(payload.messages) ? payload.messages : [])
    .find((message) => record(message)?.role === "user");
  const root = JSON.stringify([payload.system, record(firstUser)?.content]);
  const relayKey = (headers.get("authorization") || headers.get("x-api-key") || "").replace(/^Bearer\s+/i, "").trim();
  return stableUuid("claude:root:" + relayKey + ":" + root);
}
export function applyClaudeCredentialIdentity(
  payload: RecordValue,
  identity: { accountId: string; deviceId: string; sessionId: string },
) {
  if (!identity.accountId) {
    throw new HttpError(502, "claude_account_id_missing", "Claude credential has no account ID; refresh or re-import the credential");
  }
  const extras = { ...(userIdentity(payload) || {}) };
  delete extras.device_id; delete extras.account_uuid; delete extras.session_id;
  payload.metadata = {
    ...(record(payload.metadata) || {}),
    user_id: JSON.stringify({
      device_id: identity.deviceId, account_uuid: identity.accountId, session_id: identity.sessionId, ...extras,
    }),
  };
}
export function applyClaudeThinkingEffort(payload: RecordValue, rawEffort: unknown) {
  let effort = text(rawEffort).toLowerCase();
  if (!effort) return;
  const policy = claudePolicy(payload.model);
  const output = { ...(record(payload.output_config) || {}) };
  const levels = policy?.thinking?.levels || [];
  if (effort === "-1") effort = "auto";
  if (effort === "0") effort = "none";
  if (effort === "none") {
    if (policy?.thinking?.zero_allowed === false) {
      throw new HttpError(400, "unsupported_thinking_effort", "This Claude model does not support disabling thinking");
    }
    payload.thinking = { type: policy?.thinking?.disable_type || "disabled" };
    delete output.effort;
  } else if (levels.length > 0) {
    if (/^\d+$/.test(effort)) {
      const budget = Number(effort);
      effort = budget <= 1024 ? "low" : budget <= 8192 ? "medium" : budget <= 24576 ? "high" : "xhigh";
    }
    if (effort === "minimal") effort = "low";
    if (!levels.includes(effort) && effort === "xhigh") effort = "high";
    if (effort !== "auto" && !levels.includes(effort)) {
      throw new HttpError(400, "unsupported_thinking_effort", "Unsupported Claude thinking effort: " + effort);
    }
    payload.thinking = { type: "adaptive" };
    if (effort !== "auto") output.effort = effort;
    else delete output.effort;
  } else {
    const requested = /^\d+$/.test(effort) ? Number(effort) : budgetByEffort[effort];
    if (requested === undefined) throw new HttpError(400, "unsupported_thinking_effort", "Unsupported Claude thinking effort: " + effort);
    const maxTokens = Number(payload.max_tokens) || 32000;
    const budget = Math.min(Math.max(policy?.thinking?.min || 1024, requested < 0 ? 8192 : requested),
      policy?.thinking?.max || 128000, maxTokens - 1);
    payload.thinking = { type: "enabled", budget_tokens: budget };
    delete output.effort;
  }
  if (Object.keys(output).length) payload.output_config = output;
  else delete payload.output_config;
}
export function applyClaudeModelOptions(payload: RecordValue) {
  const parsed = parseClaudeModelSuffixes(payload.model);
  payload.model = parsed.baseModel;
  if (parsed.hasThinkingSuffix) applyClaudeThinkingEffort(payload, parsed.thinkingEffort);
  if (parsed.hasContextSuffix) {
    const betas = Array.isArray(payload.betas) ? payload.betas : [];
    payload.betas = [...new Set([...betas, "context-1m-2025-08-07"])];
  }
}
function currentDate(sessionId: string) {
  const now = Date.now();
  const existing = dates.get(sessionId);
  if (existing && existing.expires > now) {
    existing.expires = now + 7 * 86400000;
    return existing.date;
  }
  if (dates.size > 10000) {
    for (const [id, entry] of dates) if (entry.expires <= now) dates.delete(id);
    if (dates.size > 10000) dates.delete(dates.keys().next().value!);
  }
  const date = new Date(now).toISOString().slice(0, 10);
  dates.set(sessionId, { date, expires: now + 7 * 86400000 });
  return date;
}
function insertBeforeText(content: unknown, blocks: RecordValue[]) {
  const parts = typeof content === "string" ? [{ type: "text", text: content }]
    : Array.isArray(content) ? [...content] : [];
  let index = 0;
  while (record(parts[index])?.type === "tool_result") index++;
  parts.splice(index, 0, ...blocks);
  return parts;
}
export function cloakClaudeRequest(
  payload: RecordValue,
  input: { native: boolean; sessionId: string; userAgent: string; explicitCache: boolean; workload: string },
) {
  if (input.native) return payload;
  const original = typeof payload.system === "string" ? [{ type: "text", text: payload.system }]
    : Array.isArray(payload.system) ? payload.system : [];
  const forwarded = original.filter((block) => {
    const item = record(block);
    if (!item || item.type !== "text") throw new HttpError(400, "invalid_system_block", "Claude system instructions support text blocks only");
    return text(item.text) && !text(item.text).startsWith("x-anthropic-billing-header:")
      && text(item.text) !== CLAUDE_CODE_IDENTITY;
  });
  const version = /claude-cli\/([\d.]+)/.exec(input.userAgent)?.[1] || "2.1.280";
  const messages = Array.isArray(payload.messages) ? payload.messages as RecordValue[] : [];
  const firstUserIndex = messages.findIndex((message) => message.role === "user");
  const firstUser = messages[firstUserIndex];
  const fingerprintText = contentText(firstUser?.content);
  const chars = Array.from(fingerprintText);
  const hash = crypto.createHash("sha256").update("59cf53e54c78" + [4, 7, 20].map((i) => chars[i] || "0").join("") + version).digest("hex").slice(0, 3);
  const billing = "x-anthropic-billing-header: cc_version=" + version + "." + hash
    + "; cc_entrypoint=cli; cch=00000;" + (input.workload ? " cc_workload=" + input.workload + ";" : "");
  payload.system = [
    { type: "text", text: billing },
    { type: "text", text: CLAUDE_CODE_IDENTITY, ...(input.explicitCache ? {} : { cache_control: { type: "ephemeral" } }) },
  ];
  if (firstUser) {
    if (legacyClaudeSystem(payload.model)) {
      firstUser.content = insertBeforeText(firstUser.content, forwarded.map((block) => ({
        type: "text", text: "<system-reminder>\n" + record(block)!.text + "\n</system-reminder>",
        ...(input.explicitCache && record(block)?.cache_control ? { cache_control: record(block)!.cache_control } : {}),
      })));
    } else {
      let insertion = firstUserIndex + 1;
      while (messages[insertion]?.role === "user") insertion++;
      messages.splice(insertion, 0, ...forwarded.map((block) => ({
        role: "system", content: [{ ...record(block), ...(input.explicitCache ? {} : { cache_control: { type: "ephemeral" } }) }],
      })));
    }
    const reminder = "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is "
      + currentDate(input.sessionId) + ".\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n\n";
    firstUser.content = insertBeforeText(firstUser.content, [{ type: "text", text: reminder }]);
    if (!input.explicitCache && Array.isArray(firstUser.content)) {
      const actual = firstUser.content.find((block) => record(block)?.type === "text" && !text(record(block)?.text).startsWith("<system-reminder>"));
      if (record(actual) && text(record(actual)?.text)) record(actual)!.cache_control = { type: "ephemeral" };
    }
  }
  payload.messages = messages;
  const thinking = record(payload.thinking);
  if (thinking && ["adaptive", "enabled"].includes(text(thinking.type))) {
    if (!payload.context_management) payload.context_management = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
    if (!thinking.display && /claude-(?:opus-5-5|fable-5-1|sonnet-5)/.test(text(payload.model))) thinking.display = "updates";
  }
  if (!payload.fallbacks && text(payload.model) === "claude-opus-5-5") payload.fallbacks = [{ model: "claude-opus-4-8" }];
  if (!payload.fallbacks && text(payload.model) === "claude-fable-5-1") payload.fallbacks = [{ model: "claude-opus-5" }];
  return payload;
}
export function relocateClaudeCountSystem(payload: RecordValue, native: boolean) {
  const blocks = typeof payload.system === "string" ? [{ type: "text", text: payload.system }]
    : Array.isArray(payload.system) ? payload.system : [];
  const caller = blocks.filter((block) => text(record(block)?.text)
    && !text(record(block)?.text).startsWith("x-anthropic-billing-header:")
    && text(record(block)?.text) !== CLAUDE_CODE_IDENTITY);
  if (native) {
    if (caller.length) payload.system = caller;
    else delete payload.system;
    return payload;
  }
  delete payload.system;
  const messages = Array.isArray(payload.messages) ? payload.messages as RecordValue[] : [];
  const index = messages.findIndex((message) => message.role === "user");
  if (index < 0 || caller.length === 0) return payload;
  if (legacyClaudeSystem(payload.model)) {
    messages[index].content = insertBeforeText(messages[index].content, caller.map((block) => ({
      type: "text", text: "<system-reminder>\n" + record(block)!.text + "\n</system-reminder>",
    })));
  } else {
    let insertion = index + 1;
    while (messages[insertion]?.role === "user") insertion++;
    messages.splice(insertion, 0, ...caller.map((block) => ({ role: "system", content: [block] })));
  }
  return payload;
}

export function normalizeClaudeSampling(payload: RecordValue, native: boolean) {
  const active = ["enabled", "adaptive", "auto"].includes(text(record(payload.thinking)?.type));
  if (!native) { delete payload.temperature; delete payload.top_p; if (active) delete payload.top_k; }
  else if (active) {
    if (payload.temperature !== undefined && payload.temperature !== 1) delete payload.temperature;
    if (payload.top_p !== undefined && Number(payload.top_p) < 0.95) delete payload.top_p;
    delete payload.top_k;
  } else if (payload.temperature !== undefined) delete payload.top_p;
}
export function claudeBetas(payload: RecordValue, source: string | null, extra: string[], native: boolean) {
  const requested = new Set([...(source || "").split(","), ...extra].map((v) => v.trim()).filter(Boolean));
  if (native) {
    const values = [...requested];
    if (!requested.has("oauth-2025-04-20")) values.splice(values[0] === "claude-code-20250219" ? 1 : 0, 0, "oauth-2025-04-20");
    if (!requested.has("extended-cache-ttl-2025-04-11")) values.push("extended-cache-ttl-2025-04-11");
    return values.join(",");
  }
  const values = ["claude-code-20250219", "oauth-2025-04-20"];
  const add = (beta: string, condition = true) => { if (condition && !values.includes(beta)) values.push(beta); };
  add("context-1m-2025-08-07", requested.has("context-1m-2025-08-07"));
  add("interleaved-thinking-2025-05-14");
  add("redact-thinking-2026-02-12", !record(payload.thinking)?.display);
  for (const beta of ["thinking-token-count-2026-05-13", "context-management-2025-06-27", "prompt-caching-scope-2026-01-05"]) add(beta);
  const modern = !legacyClaudeSystem(payload.model);
  const perTurn = /^claude-(?:opus-5-5|fable-5-1)/.test(text(payload.model));
  add("mid-conversation-system-2026-04-07", modern);
  add("per-turn-control-2026-07-01", perTurn || requested.has("per-turn-control-2026-07-01"));
  add("timing-2026-09-09", requested.has("timing-2026-09-09"));
  add("mid-conversation-tool-changes-2026-07-01", modern && !/^claude-sonnet-5(?:-|$)/.test(text(payload.model)));
  const tools = Array.isArray(payload.tools) ? payload.tools as RecordValue[] : [];
  add("advisor-tool-2026-03-01", tools.some((t) => text(t.type).startsWith("advisor_")) || requested.has("advisor-tool-2026-03-01"));
  add("advanced-tool-use-2025-11-20", tools.some((t) => text(t.type).startsWith("tool_search_tool_") || t.defer_loading || t.input_examples || t.allowed_callers) || requested.has("advanced-tool-use-2025-11-20"));
  add("effort-2025-11-24", !text(payload.model).includes("haiku") && record(payload.thinking)?.type !== "disabled");
  add("server-side-fallback-2026-06-01", Boolean(payload.fallbacks) || requested.has("server-side-fallback-2026-06-01"));
  add("fallback-credit-2026-06-01", Boolean(payload.fallbacks || payload.fallback_credit_token) || requested.has("fallback-credit-2026-06-01"));
  for (const beta of ["structured-outputs-2025-12-15", "thinking-binding-controls-2026-08-01", "thinking-display-updates-2026-08-18", "thinking-resumption-2026-07-17", "afk-mode-2026-01-31"]) {
    add(beta, requested.has(beta) || (beta === "structured-outputs-2025-12-15" && Boolean(record(payload.output_config)?.format))
      || (beta === "thinking-display-updates-2026-08-18" && record(payload.thinking)?.display === "updates")
      || (beta === "thinking-binding-controls-2026-08-01" && Boolean(record(payload.thinking)?.block_binding)));
  }
  add("fast-mode-2026-02-01", payload.speed === "fast" || requested.has("fast-mode-2026-02-01"));
  add("extended-cache-ttl-2025-04-11");
  add("prompt-caching-evict-2026-05-12", JSON.stringify(payload).includes('"evict_on_complete"') || requested.has("prompt-caching-evict-2026-05-12"));
  add("cache-diagnosis-2026-04-07", Boolean(payload.diagnostics));
  return values.join(",");
}
