import "server-only";

type RecordValue = Record<string, unknown>;

// Betas a caller may ask for that change only how the model treats a request whose
// body looks the same with or without them. Each is kept only when the caller asked
// and the body can use it.
const REQUESTABLE: Record<string, (payload: RecordValue) => boolean> = {
  "interleaved-thinking-2025-05-14": thinkingActive,
  "thinking-token-count-2026-05-13": thinkingActive,
  "thinking-resumption-2026-07-17": thinkingActive,
  "context-1m-2025-08-07": () => true,
  "token-counting-2024-11-01": () => true,
  "prompt-caching-scope-2026-01-05": (payload) => has(payload, (item) => Boolean(record(item.cache_control))),
  "mid-conversation-system-2026-04-07": hasSystemMessage,
  "mid-conversation-tool-changes-2026-07-01": hasSystemMessage,
};

// Betas a body field cannot be sent without. They are added whenever the body uses
// the feature, whether or not the caller declared them, and dropped otherwise.
const REQUIRED_BY_BODY: Record<string, (payload: RecordValue) => boolean> = {
  "context-management-2025-06-27": (payload) => payload.context_management !== undefined,
  "effort-2025-11-24": (payload) => Boolean(record(payload.output_config)?.effort) ||
    messages(payload).some((message) => Boolean(record(message.output_config)?.effort)),
  "per-turn-control-2026-07-01": (payload) => messages(payload).some((message) => message.output_config !== undefined),
  "timing-2026-09-09": (payload) => has(payload, (item) => Boolean(record(item.output_config)?.timing)),
  "inline-tools-2026-09-15": (payload) => has(payload, (item) => item.type === "tool_addition"),
  "mid-conversation-system-clear-at-2026-08-21": (payload) => messages(payload).some((message) => message.clear_at !== undefined),
  "advisor-tool-2026-03-01": (payload) => tools(payload).some((tool) => text(tool.type).startsWith("advisor_")),
  "advanced-tool-use-2025-11-20": (payload) => tools(payload).some((tool) => text(tool.type).startsWith("tool_search_tool_") ||
    Boolean(tool.defer_loading) || tool.input_examples !== undefined || tool.allowed_callers !== undefined),
  "structured-outputs-2025-12-15": (payload) => Boolean(record(payload.output_config)?.format),
  "thinking-display-updates-2026-08-18": (payload) => record(payload.thinking)?.display === "updates",
  "thinking-binding-controls-2026-08-01": (payload) => record(payload.thinking)?.block_binding !== undefined,
  "fast-mode-2026-02-01": (payload) => payload.speed === "fast",
  "extended-cache-ttl-2025-04-11": (payload) => has(payload, (item) => record(item.cache_control)?.ttl === "1h"),
  "prompt-caching-evict-2026-05-12": (payload) => has(payload, (item) => item.evict_on_complete !== undefined),
  "server-side-fallback-2026-06-01": (payload) => payload.fallbacks !== undefined,
  "fallback-credit-2026-06-01": (payload) => payload.fallback_credit_token !== undefined,
  "dangerous-tool-use-2026-09-03": (payload) => payload.safeguards !== undefined,
  "message-threads-2026-08-12": (payload) => record(payload.thread) !== undefined,
};

// An Anthropic API Key channel authenticates with the channel's key, not the caller's
// client. Relay therefore builds the Anthropic-Beta header from the body it sends
// instead of forwarding whatever the client declared: OAuth and Claude Code identity
// betas (oauth-2025-04-20, claude-code-20250219), client display preferences
// (redact-thinking, afk-mode) and unknown betas are dropped. Client identity fields
// in the body (metadata.user_id, the Claude Code billing block, diagnostics) are
// removed for the same reason; messages, system text, tools and thinking stay.
export function prepareAnthropicApiPayload(input: RecordValue, headerBetas: string | null) {
  const payload: RecordValue = { ...input };
  const requested = requestedAnthropicBetas(headerBetas, betaList(payload.betas));
  delete payload.betas;
  delete payload.diagnostics;
  const metadata = record(payload.metadata);
  if (metadata && "user_id" in metadata) {
    const rest = { ...metadata };
    delete rest.user_id;
    if (Object.keys(rest).length) payload.metadata = rest;
    else delete payload.metadata;
  }
  if (Array.isArray(payload.system)) {
    const system = payload.system.filter((block) => !text(record(block)?.text).startsWith("x-anthropic-billing-header:"));
    if (system.length !== payload.system.length) {
      if (system.length) payload.system = system;
      else delete payload.system;
    }
  }
  return { payload, beta: anthropicBodyBetas(payload, requested).join(",") };
}

// The feature betas a body needs, shared with the Claude OAuth profile: requested betas count only as
// opt-ins the body can use, and betas a body field cannot be sent without are always included.
export function anthropicBodyBetas(payload: RecordValue, requested: Set<string>) {
  return [
    ...Object.entries(REQUESTABLE).filter(([beta, usable]) => requested.has(beta) && usable(payload)).map(([beta]) => beta),
    ...Object.entries(REQUIRED_BY_BODY).filter(([, required]) => required(payload)).map(([beta]) => beta),
  ];
}

export function requestedAnthropicBetas(header: string | null, extra: string[]) {
  return new Set([...(header || "").split(","), ...extra].map((beta) => beta.trim()).filter(Boolean));
}

function betaList(value: unknown) {
  if (Array.isArray(value)) return value.map(text);
  return text(value).split(",");
}

function thinkingActive(payload: RecordValue) {
  return ["enabled", "adaptive", "auto"].includes(text(record(payload.thinking)?.type));
}

function hasSystemMessage(payload: RecordValue) {
  return messages(payload).some((message) => message.role === "system");
}

function messages(payload: RecordValue) {
  return (Array.isArray(payload.messages) ? payload.messages : []).map(record).filter((item): item is RecordValue => Boolean(item));
}

function tools(payload: RecordValue) {
  return (Array.isArray(payload.tools) ? payload.tools : []).map(record).filter((item): item is RecordValue => Boolean(item));
}

function has(value: unknown, match: (item: RecordValue) => boolean, depth = 0): boolean {
  if (depth > 16 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => has(item, match, depth + 1));
  const item = value as RecordValue;
  return match(item) || Object.values(item).some((child) => has(child, match, depth + 1));
}

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}
