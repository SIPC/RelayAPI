import "server-only";

import {
  alignClaudeBillingVersion, applyClaudeCredentialIdentity, applyClaudeModelOptions, claudePayloadHasOneHourCache, claudeSessionId,
  cloakClaudeRequest, isClaudeProbeOrHelperRequest, isClaudeSubagentRequest,
  isNativeClaudeCodeRequest, normalizeClaudeSampling, relocateClaudeCountSystem,
} from "@/src/server/claude/wire";
import {
  countCacheControls, enforceCacheControlLimit, ensureCacheControl, MAX_CACHE_CONTROL_BLOCKS,
} from "@/src/server/claude/cacheControl";
import { claudeCacheTtlFor } from "@/src/server/claude/cacheTtl";

const CLAUDE_CCH_SEED = BigInt("0x4d659218e32a3268");
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
    sessionId?: string;
    countTokens?: boolean;
    // The credential's latest response put it on overage billing (see cacheTtl.ts).
    overage?: boolean;
  },
): ClaudeOAuthPreparedPayload {
  let payload = cloneRecord(inputPayload);
  const native = isNativeClaudeCodeRequest(input.sourceHeaders, payload, input.countTokens);
  const sessionId = input.sessionId || claudeSessionId(payload, input.sourceHeaders);
  // Standard Anthropic cache controls already express caller intent. Do not
  // require a Relay-only flag to keep their anchors, scope and default 5m TTL.
  const explicitCache = recordValue(payload.prompt_cache_options)?.mode === "explicit"
    || countCacheControls(payload) > 0;
  applyClaudeModelOptions(payload);
  if (input.countTokens) payload = relocateClaudeCountSystem(payload, native);
  else if (native) alignClaudeBillingVersion(payload, input.claudeUserAgent);
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
    if (!input.countTokens) {
      // Native Claude Code keeps probes, title helpers and subagents on the
      // default 5m pool; only main-agent turns use the 1h pool. A 1h write
      // costs 2x base input versus 1.25x for 5m, and helpers never reuse it.
      const ttl = claudeCacheTtlFor({ subscriber: true, overage: Boolean(input.overage),
        shortLane: shouldUseShortCache(inputPayload, input.sourceHeaders) });
      walkCacheControls(payload, (control) => {
        if (!control.ttl && ttl === "1h") control.ttl = "1h";
      });
    }
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

// Probes, title helpers and subagents get the default 5m pool; everything else
// gets 1h. A subagent that already asked for 1h (its own marker or the caller's
// beta) keeps it, matching native Claude Code.
function shouldUseShortCache(original: Record<string, unknown>, headers: Headers) {
  if (isClaudeProbeOrHelperRequest(original)) return true;
  if (!isClaudeSubagentRequest(headers, original)) return false;
  if (claudePayloadHasOneHourCache(original)) return false;
  return !(headers.get("anthropic-beta") || "")
    .split(",").some((beta) => beta.trim() === "extended-cache-ttl-2025-04-11");
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
    xxHash64(Buffer.from(normalizeClaudeCCHInput(JSON.parse(unsignedBody))), CLAUDE_CCH_SEED) & BigInt(0xfffff)
  )
    .toString(16)
    .padStart(5, "0");
  firstSystem.text = stringValue(firstSystem.text).replace(
    BILLING_CCH_PATTERN,
    `cch=${cch};`,
  );
  return { payload, body: JSON.stringify(payload), extraBetas };
}

// The wire body above is compact JSON.stringify output, so its hash view can
// be rebuilt in insertion order without a raw JSON scanner. Normalize only
// the hash view, never the payload: messages still participate in the CCH.
function normalizeClaudeCCHInput(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(normalizeClaudeCCHInput).join(",") + "]";
  const item = recordValue(value);
  if (!item) return JSON.stringify(value);
  const members = Object.entries(item);
  const kept: string[] = [];
  let trailingDispatch = 0;
  for (const [key, child] of members) {
    if (["max_tokens", "fallbacks", "fallback_credit_token"].includes(key)) {
      trailingDispatch++;
      continue;
    }
    trailingDispatch = 0;
    kept.push(JSON.stringify(key) + ":" + (key === "model" && typeof child === "string"
      ? '""' : normalizeClaudeCCHInput(child)));
  }
  // CPA reproduces the native hash-view quirk: multiple trailing dispatch
  // members leave a comma after any retained members (this is not wire JSON).
  return "{" + kept.join(",") + (kept.length && trailingDispatch > 1 ? "," : "") + "}";
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

// xxHash64 on 32-bit halves. A BigInt version took seconds of event-loop time on the 25 MB bodies
// Claude Code sends once a session carries images, stalling every other request on this process.
const P1H = 0x9e3779b1, P1L = 0x85ebca87, P2H = 0xc2b2ae3d, P2L = 0x27d4eb4f, P3H = 0x165667b1, P3L = 0x9e3779f9;
const P4H = 0x85ebca77, P4L = 0xc2b2ae63, P5H = 0x27d4eb2f, P5L = 0x165667c5, NEG_P1H = 0x61c8864e, NEG_P1L = 0x7a143579;
// Every helper returns its 64-bit result in (rh, rl).
let rh = 0, rl = 0;

function mulHi32(a: number, b: number) {
  const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
  return (a1 * b1 + Math.floor((a0 * b1 + a1 * b0 + ((a0 * b0) >>> 16)) / 65536)) >>> 0;
}
function mul(ah: number, al: number, bh: number, bl: number) {
  rl = Math.imul(al, bl) >>> 0;
  rh = (mulHi32(al, bl) + Math.imul(ah, bl) + Math.imul(al, bh)) >>> 0;
}
function add(ah: number, al: number, bh: number, bl: number) {
  const low = al + bl;
  rl = low >>> 0;
  rh = (ah + bh + (low > 0xffffffff ? 1 : 0)) >>> 0;
}
function rotl(h: number, l: number, n: number) {
  rh = ((h << n) | (l >>> (32 - n))) >>> 0;
  rl = ((l << n) | (h >>> (32 - n))) >>> 0;
}
function round(ah: number, al: number, ih: number, il: number) {
  mul(ih, il, P2H, P2L);
  add(ah, al, rh, rl);
  rotl(rh, rl, 31);
  mul(rh, rl, P1H, P1L);
}
function mergeRound(ah: number, al: number, vh: number, vl: number) {
  round(0, 0, vh, vl);
  mul(ah ^ rh, al ^ rl, P1H, P1L);
  add(rh, rl, P4H, P4L);
}

function xxHash64(buffer: Buffer, seed: bigint) {
  const sh = Number(seed >> BigInt(32)) >>> 0;
  const sl = Number(seed & BigInt(0xffffffff)) >>> 0;
  const length = buffer.length;
  let offset = 0;
  let hh: number, hl: number;

  if (length >= 32) {
    add(sh, sl, P1H, P1L);
    add(rh, rl, P2H, P2L);
    let v1h = rh, v1l = rl;
    add(sh, sl, P2H, P2L);
    let v2h = rh, v2l = rl;
    let v3h = sh, v3l = sl;
    add(sh, sl, NEG_P1H, NEG_P1L);
    let v4h = rh, v4l = rl;

    const limit = length - 32;
    while (offset <= limit) {
      round(v1h, v1l, buffer.readUInt32LE(offset + 4), buffer.readUInt32LE(offset));
      v1h = rh; v1l = rl;
      round(v2h, v2l, buffer.readUInt32LE(offset + 12), buffer.readUInt32LE(offset + 8));
      v2h = rh; v2l = rl;
      round(v3h, v3l, buffer.readUInt32LE(offset + 20), buffer.readUInt32LE(offset + 16));
      v3h = rh; v3l = rl;
      round(v4h, v4l, buffer.readUInt32LE(offset + 28), buffer.readUInt32LE(offset + 24));
      v4h = rh; v4l = rl;
      offset += 32;
    }

    rotl(v1h, v1l, 1);
    let ah = rh, al = rl;
    rotl(v2h, v2l, 7);
    add(ah, al, rh, rl);
    ah = rh; al = rl;
    rotl(v3h, v3l, 12);
    add(ah, al, rh, rl);
    ah = rh; al = rl;
    rotl(v4h, v4l, 18);
    add(ah, al, rh, rl);
    mergeRound(rh, rl, v1h, v1l);
    mergeRound(rh, rl, v2h, v2l);
    mergeRound(rh, rl, v3h, v3l);
    mergeRound(rh, rl, v4h, v4l);
    hh = rh; hl = rl;
  } else {
    add(sh, sl, P5H, P5L);
    hh = rh; hl = rl;
  }

  add(hh, hl, 0, length >>> 0);
  hh = rh; hl = rl;

  while (offset + 8 <= length) {
    round(0, 0, buffer.readUInt32LE(offset + 4), buffer.readUInt32LE(offset));
    rotl(hh ^ rh, hl ^ rl, 27);
    mul(rh, rl, P1H, P1L);
    add(rh, rl, P4H, P4L);
    hh = rh; hl = rl;
    offset += 8;
  }

  if (offset + 4 <= length) {
    mul(0, buffer.readUInt32LE(offset), P1H, P1L);
    rotl(hh ^ rh, hl ^ rl, 23);
    mul(rh, rl, P2H, P2L);
    add(rh, rl, P3H, P3L);
    hh = rh; hl = rl;
    offset += 4;
  }

  while (offset < length) {
    mul(0, buffer[offset], P5H, P5L);
    rotl(hh ^ rh, hl ^ rl, 11);
    mul(rh, rl, P1H, P1L);
    hh = rh; hl = rl;
    offset += 1;
  }

  // h ^= h >> 33; h *= P2; h ^= h >> 29; h *= P3; h ^= h >> 32
  mul(hh, hl ^ (hh >>> 1), P2H, P2L);
  mul(rh ^ (rh >>> 29), rl ^ (((rh << 3) | (rl >>> 29)) >>> 0), P3H, P3L);
  const high = (rh >>> 0);
  const low = (rl ^ rh) >>> 0;
  return (BigInt(high) << BigInt(32)) | BigInt(low);
}
