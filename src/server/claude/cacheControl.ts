import "server-only";

// Default prompt-cache breakpoints, shared by the Claude OAuth path and the
// Anthropic API Key path. Nothing here depends on a credential kind: where the
// breakpoints go and the four-breakpoint limit are the same for both, as in CPA.
// TTL policy stays with each caller because only OAuth may use the 1h pool.

export const MAX_CACHE_CONTROL_BLOCKS = 4;

export function ensureCacheControl(payload: Record<string, unknown>) {
  // A system breakpoint already includes all tools. Match CPA by spending
  // that slot on conversation history instead of a redundant tools prefix.
  const system = typeof payload.system === "string" ? payload.system.trim()
    : (Array.isArray(payload.system) ? payload.system : [])
      .some((block) => stringValue(recordValue(block)?.text));
  if (!system) injectToolsCacheControl(payload);
  injectSystemCacheControl(payload);
  injectMessagesCacheControl(payload);
  return payload;
}

function injectToolsCacheControl(payload: Record<string, unknown>) {
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  if (
    tools.length === 0 ||
    tools.some((tool) => recordValue(tool)?.cache_control !== undefined)
  ) {
    return;
  }
  const lastTool = recordValue(tools[tools.length - 1]);
  if (lastTool) {
    lastTool.cache_control = { type: "ephemeral" };
  }
}

function injectSystemCacheControl(payload: Record<string, unknown>) {
  if (payload.system === undefined) {
    return;
  }
  if (typeof payload.system === "string") {
    payload.system = [textBlock(payload.system, { type: "ephemeral" })];
    return;
  }
  const system = Array.isArray(payload.system) ? payload.system : [];
  if (
    system.length === 0 ||
    system.some((item) => recordValue(item)?.cache_control !== undefined)
  ) {
    return;
  }
  const lastSystem = recordValue(system[system.length - 1]);
  if (lastSystem) {
    lastSystem.cache_control = { type: "ephemeral" };
  }
}

function injectMessagesCacheControl(payload: Record<string, unknown>) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = recordValue(messages[index]);
    if (!message || !["user", "assistant"].includes(stringValue(message.role))) continue;
    if (typeof message.content === "string") {
      if (!message.content.trim()) continue;
      message.content = [textBlock(message.content, { type: "ephemeral" })];
      return;
    }
    if (!Array.isArray(message.content)) continue;
    const parts = message.content;
    const last = recordValue(parts[parts.length - 1]);
    if (message.role === "assistant" && ["thinking", "redacted_thinking"].includes(stringValue(last?.type))) continue;
    if (parts.some((part) => recordValue(part)?.cache_control)) return;
    for (let block = parts.length - 1; block >= 0; block--) {
      const part = recordValue(parts[block]);
      if (!part || ["thinking", "redacted_thinking"].includes(stringValue(part.type))) continue;
      if (part.type === "text" && !stringValue(part.text)) continue;
      part.cache_control = { type: "ephemeral" };
      return;
    }
  }
}

export function enforceCacheControlLimit(
  payload: Record<string, unknown>,
  maxBlocks: number,
) {
  let excess = countCacheControls(payload) - maxBlocks;
  if (excess <= 0) {
    return payload;
  }

  const removeFromItems = (items: unknown[], preserveLast: boolean) => {
    const cacheIndexes = items.flatMap((item, index) =>
      recordValue(item)?.cache_control !== undefined ? [index] : [],
    );
    const preserved = preserveLast ? cacheIndexes.at(-1) : undefined;
    for (const index of cacheIndexes) {
      if (excess <= 0) {
        return;
      }
      if (index === preserved) {
        continue;
      }
      const item = recordValue(items[index]);
      if (item) {
        delete item.cache_control;
        excess -= 1;
      }
    }
  };

  removeFromItems(Array.isArray(payload.system) ? payload.system : [], true);
  removeFromItems(Array.isArray(payload.tools) ? payload.tools : [], true);

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of messages) {
    if (excess <= 0) {
      break;
    }
    removeFromItems(messageContentParts(message), false);
  }

  removeFromItems(Array.isArray(payload.system) ? payload.system : [], false);
  removeFromItems(Array.isArray(payload.tools) ? payload.tools : [], false);
  return payload;
}

export function countCacheControls(payload: Record<string, unknown>) {
  // Automatic caching consumes a slot too, even without block-level markers.
  let count = payload.cache_control !== undefined ? 1 : 0;
  const countBlock = (item: unknown) => {
    if (recordValue(item)?.cache_control !== undefined) {
      count += 1;
    }
  };
  for (const system of Array.isArray(payload.system) ? payload.system : []) {
    countBlock(system);
  }
  for (const tool of Array.isArray(payload.tools) ? payload.tools : []) {
    countBlock(tool);
  }
  for (const message of Array.isArray(payload.messages)
    ? payload.messages
    : []) {
    for (const item of messageContentParts(message)) {
      countBlock(item);
    }
  }
  return count;
}

// An Anthropic API Key channel gets the same default breakpoints as OAuth: CPA
// places them for every non-native caller that wrote none, and keeps what a
// caller wrote. TTL stays the API default (5m): the 1h pool, and its beta, are
// only used when a caller's own marker asks for it, which the beta derivation
// reads from the body that is actually sent.
export function prepareAnthropicApiCacheControl(
  input: Record<string, unknown>,
  headers: Headers,
  isNativeClaudeCode: (payload: Record<string, unknown>) => boolean,
) {
  const payload = structuredClone(input);
  const explicit = recordValue(payload.prompt_cache_options)?.mode === "explicit";
  delete payload.prompt_cache_options;
  if (!explicit && countCacheControls(payload) === 0 && !isNativeClaudeCode(payload)) {
    ensureCacheControl(payload);
  }
  return enforceCacheControlLimit(payload, MAX_CACHE_CONTROL_BLOCKS);
}
function textBlock(text: string, cacheControl?: Record<string, string>) {
  return {
    type: "text",
    text,
    ...(cacheControl ? { cache_control: cacheControl } : {}),
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageContentParts(message: unknown): unknown[] {
  const record = recordValue(message);
  const content = record?.content;
  return Array.isArray(content) ? content : [];
}

function stringValue(value: unknown) {
  return typeof value === "string"
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : "";
}
