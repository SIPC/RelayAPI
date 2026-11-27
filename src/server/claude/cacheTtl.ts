import "server-only";

// Which prompt-cache pool a Claude request writes to, following Claude Code
// 2.1.332 (tWe / XVn): the 1h pool is for a subscriber's main thread (and sdk,
// auto_mode, memdir) and never while the account is billed as overage, where a
// 1h write would cost 2x for no reuse. API Keys stay on the default 5m pool.
// Relay sees no querySource, so "main thread" is "not a subagent, probe or
// helper"; those three are the lanes Claude Code itself keeps on 5m.

export type ClaudeCacheTtl = "1h" | "5m";

export interface ClaudeCacheTtlInput {
  subscriber: boolean;
  overage: boolean;
  // Probes, title helpers and subagents: lanes outside Claude Code's 1h allowlist.
  shortLane: boolean;
}

export function claudeCacheTtlFor(input: ClaudeCacheTtlInput): ClaudeCacheTtl {
  if (!input.subscriber || input.overage || input.shortLane) return "5m";
  return "1h";
}

// The unified rate-limit headers decide it, as in Claude Code's Ye(): the
// window is rejected and the overage pool is allowed to serve the request.
export function isUsingOverageHeaders(headers: Headers) {
  if (headers.get("anthropic-ratelimit-unified-status") !== "rejected") return false;
  const overage = headers.get("anthropic-ratelimit-unified-overage-status");
  return overage === "allowed" || overage === "allowed_warning";
}

// The latest response per credential. It lives in memory on purpose: it is a
// short-lived hint about the last answer, and unknown means "not overage" (as in
// Claude Code, where an absent reading leaves the 1h allowlist in charge).
const OVERAGE_HINT_MS = 10 * 60_000;
const hints = new Map<string, { overage: boolean; at: number }>();

export function recordClaudeOverage(credentialId: string, headers: Headers, now = Date.now()) {
  // A response without the unified headers says nothing; keep what we knew.
  if (headers.get("anthropic-ratelimit-unified-status") === null) return;
  hints.set(credentialId, { overage: isUsingOverageHeaders(headers), at: now });
}

export function claudeCredentialInOverage(credentialId: string, now = Date.now()) {
  const hint = hints.get(credentialId);
  return Boolean(hint && hint.overage && now - hint.at < OVERAGE_HINT_MS);
}

export function resetClaudeOverageHints() {
  hints.clear();
}
