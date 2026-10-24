import "server-only";

import {
  applyClaudeCredentialIdentity, applyClaudeModelOptions, claudeSessionId,
  cloakClaudeRequest, isNativeClaudeCodeRequest, normalizeClaudeSampling,
  relocateClaudeCountSystem,
} from "@/src/server/claude/wire";

const CLAUDE_CCH_SEED = BigInt("0x6e52736ac806831e");
const MAX_CACHE_CONTROL_BLOCKS = 4;
const BILLING_CCH_PATTERN = /\bcch=([0-9a-f]{5});/;

export interface ClaudeOAuthPreparedPayload {
  payload: Record<string, unknown>;
  body: string;
  extraBetas: string[];
  native: boolean;
  sessionId: string;
}

export function prepareClaudeOAuthUpstreamPayload(
  inputPayload: Record<string, unknown>,
  input: {
    accessToken: string;
    sourceHeaders: Headers;
    claudeUserAgent: string;
    accountId: string;
    deviceId: string;
    countTokens?: boolean;
  },
): ClaudeOAuthPreparedPayload {
  let payload = cloneRecord(inputPayload);
  const native = isNativeClaudeCodeRequest(input.sourceHeaders, payload, input.countTokens);
  const sessionId = claudeSessionId(payload, input.sourceHeaders, native);
  const explicitCache = recordValue(payload.prompt_cache_options)?.mode === "explicit";
  applyClaudeModelOptions(payload);
  if (input.countTokens) payload = relocateClaudeCountSystem(payload, native);
  else payload = cloakClaudeRequest(payload, {
    native, sessionId, userAgent: input.claudeUserAgent, explicitCache,
    workload: input.sourceHeaders.get("x-cpa-claude-workload") || "",
  });
  payload = disableThinkingIfToolChoiceForced(payload);
  if (!payload.thinking && !inputPayload.context_management) delete payload.context_management;
  normalizeClaudeSampling(payload, native);
  if (!native && !explicitCache && !input.countTokens) payload = ensureCacheControl(payload);
  payload = enforceCacheControlLimit(payload, MAX_CACHE_CONTROL_BLOCKS);
  if (!native && !explicitCache) {
    if (!input.countTokens) walkCacheControls(payload, (control) => { if (!control.ttl) control.ttl = "1h"; });
    payload = normalizeCacheControlTTL(payload);
  }
  delete payload.prompt_cache_options;
  if (!input.countTokens) applyClaudeCredentialIdentity(payload, { accountId: input.accountId, deviceId: input.deviceId, sessionId });
  const { payload: withoutBetas, extraBetas } = extractAndRemoveBetas(payload);
  payload = sanitizeClaudeMessagesForClaudeUpstream(withoutBetas);
  if (input.countTokens) {
    // Count only the business payload, including relocated caller instructions.
    delete payload.max_tokens;
    delete payload.stream;
    delete payload.metadata;
    delete payload.context_management;
    delete payload.diagnostics;
  }
  return { ...signAnthropicMessagesPayload(payload, extraBetas), native, sessionId };
}

function walkCacheControls(value: unknown, visit: (control: Record<string, unknown>) => void) {
  if (Array.isArray(value)) { for (const item of value) walkCacheControls(item, visit); return; }
  const item = recordValue(value);
  if (!item) return;
  const control = recordValue(item.cache_control);
  if (control) visit(control);
  for (const [key, child] of Object.entries(item)) if (key !== "cache_control") walkCacheControls(child, visit);
}

function disableThinkingIfToolChoiceForced(payload: Record<string, unknown>) {
  const toolChoice = recordValue(payload.tool_choice);
  const type = stringValue(toolChoice?.type);
  if (type !== "any" && type !== "tool") {
    return payload;
  }
  delete payload.thinking;
  const outputConfig = recordValue(payload.output_config);
  if (outputConfig) {
    delete outputConfig.effort;
    if (Object.keys(outputConfig).length === 0) {
      delete payload.output_config;
    }
  }
  return payload;
}

function extractAndRemoveBetas(payload: Record<string, unknown>) {
  const rawBetas = payload.betas;
  if (rawBetas === undefined) {
    return { payload, extraBetas: [] as string[] };
  }
  delete payload.betas;
  const extraBetas = Array.isArray(rawBetas)
    ? rawBetas.map(stringValue).filter(Boolean)
    : stringValue(rawBetas)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  return { payload, extraBetas };
}

function ensureCacheControl(payload: Record<string, unknown>) {
  injectToolsCacheControl(payload);
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

function enforceCacheControlLimit(
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

function normalizeCacheControlTTL(payload: Record<string, unknown>) {
  let seenFiveMinute = false;
  const process = (item: unknown) => {
    const block = recordValue(item);
    if (!block || block.cache_control === undefined) {
      return;
    }
    const cacheControl = recordValue(block.cache_control);
    if (!cacheControl || cacheControl.ttl !== "1h") {
      seenFiveMinute = true;
      return;
    }
    if (seenFiveMinute) {
      delete cacheControl.ttl;
    }
  };

  for (const tool of Array.isArray(payload.tools) ? payload.tools : []) {
    process(tool);
  }
  for (const system of Array.isArray(payload.system) ? payload.system : []) {
    process(system);
  }
  for (const message of Array.isArray(payload.messages)
    ? payload.messages
    : []) {
    for (const item of messageContentParts(message)) {
      process(item);
    }
  }
  return payload;
}

function countCacheControls(payload: Record<string, unknown>) {
  let count = 0;
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

function sanitizeClaudeMessagesForClaudeUpstream(
  payload: Record<string, unknown>,
) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of messages) {
    const record = recordValue(message);
    if (!record || !Array.isArray(record.content)) {
      continue;
    }
    record.content = record.content.flatMap((rawPart) => {
      const part = recordValue(rawPart);
      if (!part) {
        return [rawPart];
      }
      if (
        part.type === "thinking" &&
        !hasLikelyClaudeSignature(part.signature)
      ) {
        return [];
      }
      if (part.type === "tool_use" && part.signature !== undefined) {
        delete part.signature;
      }
      return [part];
    });
  }
  return payload;
}

function hasLikelyClaudeSignature(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length > 0 && decoded[0] === 0x12;
  } catch {
    return false;
  }
}

function signAnthropicMessagesPayload(
  payload: Record<string, unknown>,
  extraBetas: string[],
): Omit<ClaudeOAuthPreparedPayload, "native" | "sessionId"> {
  const system = Array.isArray(payload.system) ? payload.system : [];
  const firstSystem = recordValue(system[0]);
  if (!firstSystem) {
    return { payload, body: JSON.stringify(payload), extraBetas };
  }
  const billingHeader = stringValue(firstSystem.text);
  if (
    !billingHeader.startsWith("x-anthropic-billing-header:") ||
    !BILLING_CCH_PATTERN.test(billingHeader)
  ) {
    return { payload, body: JSON.stringify(payload), extraBetas };
  }

  firstSystem.text = billingHeader.replace(BILLING_CCH_PATTERN, "cch=00000;");
  const unsignedBody = JSON.stringify(payload);
  const cch = (
    xxHash64(Buffer.from(unsignedBody), CLAUDE_CCH_SEED) & BigInt(0xfffff)
  )
    .toString(16)
    .padStart(5, "0");
  firstSystem.text = stringValue(firstSystem.text).replace(
    BILLING_CCH_PATTERN,
    `cch=${cch};`,
  );
  return { payload, body: JSON.stringify(payload), extraBetas };
}

function textBlock(text: string, cacheControl?: Record<string, string>) {
  return {
    type: "text",
    text,
    ...(cacheControl ? { cache_control: cacheControl } : {}),
  };
}

function cloneRecord(value: Record<string, unknown>) {
  return structuredClone(value) as Record<string, unknown>;
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

const MASK_64 = (BigInt(1) << BigInt(64)) - BigInt(1);
const PRIME64_1 = BigInt("11400714785074694791");
const PRIME64_2 = BigInt("14029467366897019727");
const PRIME64_3 = BigInt("1609587929392839161");
const PRIME64_4 = BigInt("9650029242287828579");
const PRIME64_5 = BigInt("2870177450012600261");

function xxHash64(buffer: Buffer, seed: bigint) {
  let offset = 0;
  let hash: bigint;

  if (buffer.length >= 32) {
    let v1 = add64(add64(seed, PRIME64_1), PRIME64_2);
    let v2 = add64(seed, PRIME64_2);
    let v3 = seed & MASK_64;
    let v4 = sub64(seed, PRIME64_1);

    const limit = buffer.length - 32;
    while (offset <= limit) {
      v1 = xxHashRound(v1, readUInt64LE(buffer, offset));
      offset += 8;
      v2 = xxHashRound(v2, readUInt64LE(buffer, offset));
      offset += 8;
      v3 = xxHashRound(v3, readUInt64LE(buffer, offset));
      offset += 8;
      v4 = xxHashRound(v4, readUInt64LE(buffer, offset));
      offset += 8;
    }

    hash = add64(
      add64(rotl64(v1, 1), rotl64(v2, 7)),
      add64(rotl64(v3, 12), rotl64(v4, 18)),
    );
    hash = xxHashMergeRound(hash, v1);
    hash = xxHashMergeRound(hash, v2);
    hash = xxHashMergeRound(hash, v3);
    hash = xxHashMergeRound(hash, v4);
  } else {
    hash = add64(seed, PRIME64_5);
  }

  hash = add64(hash, BigInt(buffer.length));

  while (offset + 8 <= buffer.length) {
    const k1 = xxHashRound(BigInt(0), readUInt64LE(buffer, offset));
    hash = xor64(hash, k1);
    hash = add64(mul64(rotl64(hash, 27), PRIME64_1), PRIME64_4);
    offset += 8;
  }

  if (offset + 4 <= buffer.length) {
    hash = xor64(hash, mul64(BigInt(buffer.readUInt32LE(offset)), PRIME64_1));
    hash = add64(mul64(rotl64(hash, 23), PRIME64_2), PRIME64_3);
    offset += 4;
  }

  while (offset < buffer.length) {
    hash = xor64(hash, mul64(BigInt(buffer[offset]), PRIME64_5));
    hash = mul64(rotl64(hash, 11), PRIME64_1);
    offset += 1;
  }

  hash = xor64(hash, hash >> BigInt(33));
  hash = mul64(hash, PRIME64_2);
  hash = xor64(hash, hash >> BigInt(29));
  hash = mul64(hash, PRIME64_3);
  hash = xor64(hash, hash >> BigInt(32));
  return hash & MASK_64;
}

function xxHashRound(acc: bigint, input: bigint) {
  acc = add64(acc, mul64(input, PRIME64_2));
  acc = rotl64(acc, 31);
  acc = mul64(acc, PRIME64_1);
  return acc;
}

function xxHashMergeRound(acc: bigint, value: bigint) {
  acc = xor64(acc, xxHashRound(BigInt(0), value));
  return add64(mul64(acc, PRIME64_1), PRIME64_4);
}

function readUInt64LE(buffer: Buffer, offset: number) {
  return (
    BigInt(buffer[offset]) |
    (BigInt(buffer[offset + 1]) << BigInt(8)) |
    (BigInt(buffer[offset + 2]) << BigInt(16)) |
    (BigInt(buffer[offset + 3]) << BigInt(24)) |
    (BigInt(buffer[offset + 4]) << BigInt(32)) |
    (BigInt(buffer[offset + 5]) << BigInt(40)) |
    (BigInt(buffer[offset + 6]) << BigInt(48)) |
    (BigInt(buffer[offset + 7]) << BigInt(56))
  );
}

function rotl64(value: bigint, shift: number) {
  const bits = BigInt(shift);
  return ((value << bits) | (value >> (BigInt(64) - bits))) & MASK_64;
}

function add64(left: bigint, right: bigint) {
  return (left + right) & MASK_64;
}

function sub64(left: bigint, right: bigint) {
  return (left - right) & MASK_64;
}

function mul64(left: bigint, right: bigint) {
  return (left * right) & MASK_64;
}

function xor64(left: bigint, right: bigint) {
  return (left ^ right) & MASK_64;
}
