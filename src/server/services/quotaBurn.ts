import "server-only";

import { getLogDb } from "@/src/server/db/sqlite";
import { HttpError } from "@/src/server/http/errors";
import { claudeQuotaAccountKey } from "@/src/server/repositories/claudeQuota";
import { listClaudeCredentials } from "@/src/server/repositories/claudeCredentials";
import { getCodexCredentialById } from "@/src/server/repositories/codexCredentials";
import {
  listQuotaSnapshots, type QuotaSnapshotRow, type QuotaSnapshotWindow,
} from "@/src/server/repositories/quotaSnapshots";
import type {
  QuotaBurnEstimate, QuotaBurnReport, QuotaBurnTokens, QuotaBurnWindow,
} from "@/src/shared/types/entities";

const HOUR = 3_600_000;
const LOOKBACK_MS: Record<QuotaSnapshotWindow, number> = { "5h": 7 * 24 * HOUR, "7d": 14 * 24 * HOUR };
// A ratio whose range is wider than ±20% is shown as rough.
const ROUGH_RELATIVE_ERROR = 0.2;
const PRICE_WEIGHTS = {
  claude: { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
  codex: { input: 1, cacheRead: 0.1, cacheWrite: null, output: 8 },
} as const;

type Cycle = { resetKey: number; rows: QuotaSnapshotRow[] };

export function getQuotaBurnReport(provider: "claude" | "codex", credentialId: string, now = Date.now()): QuotaBurnReport {
  let subject: string;
  let credentialIds: string[];
  if (provider === "claude") {
    const key = claudeQuotaAccountKey(credentialId);
    if (!key) throw new HttpError(404, "claude_credential_not_found", "Claude credential not found");
    subject = key;
    // Duplicate imports of one subscription draw on the same quota.
    credentialIds = listClaudeCredentials().map((item) => item.id)
      .filter((id) => id === credentialId || claudeQuotaAccountKey(id) === key);
  } else {
    if (!getCodexCredentialById(credentialId)) {
      throw new HttpError(404, "codex_credential_not_found", "Codex credential not found");
    }
    subject = credentialId;
    credentialIds = [credentialId];
  }
  const windows = (["5h", "7d"] as const).map((id) =>
    burnWindow(provider, subject, credentialIds, id, now));
  return {
    provider, credential_id: credentialId, generated_at: new Date(now).toISOString(),
    shared_credentials: credentialIds.length, price_weights: PRICE_WEIGHTS[provider], windows,
  };
}

function burnWindow(
  provider: "claude" | "codex", subject: string, credentialIds: string[], id: QuotaSnapshotWindow, now: number,
): QuotaBurnWindow {
  const rows = listQuotaSnapshots(provider, subject, id, now - LOOKBACK_MS[id]);
  const cycles: Cycle[] = [];
  for (const row of rows) {
    if (cycles.at(-1)?.resetKey !== row.reset_key) cycles.push({ resetKey: row.reset_key, rows: [] });
    cycles.at(-1)!.rows.push(row);
  }
  const resolution = quantizationStep(rows);
  const latest = cycles.at(-1);
  const live = latest && latest.resetKey * 60_000 > now ? latest : undefined;
  const tokens = (from: number, to: number) => sumTokens(provider, credentialIds, from, to);
  return {
    id,
    resetAt: live ? new Date(live.resetKey * 60_000).toISOString() : null,
    resolution,
    current: live ? estimate([live], resolution, tokens)
      : insufficient(cycles.length ? "窗口已重置，等待重置后的新额度数据" : "暂无额度快照：升级后从收到的响应头和查额开始记录"),
    recent: cycles.length ? estimate(cycles, resolution, tokens)
      : insufficient("暂无额度快照：升级后从收到的响应头和查额开始记录"),
  };
}

// The smallest step between distinct reported values, capped at 1 point.
// Claude and Codex both report whole percents today.
function quantizationStep(rows: QuotaSnapshotRow[]) {
  const values = [...new Set(rows.flatMap((row) => [row.first_used, row.last_used, row.min_used, row.max_used]))]
    .sort((a, b) => a - b);
  let step = 1;
  for (let index = 1; index < values.length; index++) {
    const difference = Math.round((values[index] - values[index - 1]) * 1e6) / 1e6;
    if (difference > 0) step = Math.min(step, difference);
  }
  return rows.length ? step : null;
}

// Each cycle contributes its observed rise and the tokens relayed between its
// first and last observation, so no interval spans a reset. Each end of a
// cycle can be off by one step (rounding); a cycle whose reported value moved
// back down (several upstream replicas disagree) gets one more step per end.
function estimate(
  cycles: Cycle[], resolution: number | null, tokens: (from: number, to: number) => QuotaBurnTokens,
): QuotaBurnEstimate {
  const step = resolution ?? 1;
  let delta = 0;
  let error = 0;
  let used = 0;
  let from: number | null = null;
  let to: number | null = null;
  let usedFrom: number | null = null;
  let usedTo: number | null = null;
  let decreased = false;
  const total = emptyTokens();
  for (const cycle of cycles) {
    const first = cycle.rows[0];
    const last = cycle.rows.at(-1)!;
    if (last.last_at <= first.first_at) continue;
    let peak = -Infinity;
    let flapping = false;
    for (const row of cycle.rows) {
      if (row.min_used < peak || row.last_used < row.max_used || row.first_used > row.min_used) flapping = true;
      peak = Math.max(peak, row.max_used);
    }
    const rise = last.last_used - first.first_used;
    const cycleError = step * (flapping ? 2 : 1);
    // A drop larger than the noise means the provider reset or adjusted the
    // window early; that cycle cannot be compared end to end.
    if (rise < -cycleError) { decreased = true; continue; }
    used++;
    delta += rise;
    error += cycleError;
    addTokens(total, tokens(first.first_at, last.last_at));
    from ??= first.first_at;
    to = last.last_at;
    usedFrom ??= first.first_used;
    usedTo = last.last_used;
  }
  const base = {
    from: from === null ? null : new Date(from).toISOString(),
    to: to === null ? null : new Date(to).toISOString(),
    cycles: used, usedFrom, usedTo,
    delta: used ? round(delta) : null, deltaError: used ? round(error) : null, tokens: total,
  };
  const none = { tokensPerPercent: null, tokensPerPercentLow: null, tokensPerPercentHigh: null };
  if (!used) {
    return { ...base, ...none, status: "insufficient",
      reason: decreased ? "额度在周期内回退（提前重置或调整），无法比较" : "只有一个观测点，至少需要两个时间点" };
  }
  if (delta <= error) {
    return { ...base, ...none, status: "insufficient",
      reason: `额度变化 ${round(delta)}% 不超过精度误差 ±${round(error)}%，继续使用后再看` };
  }
  if (total.total === 0) {
    return { ...base, ...none, status: "insufficient",
      reason: "额度在变但 Relay 没有记录到这段时间的 token（可能在 Relay 之外使用）" };
  }
  return {
    ...base, status: error / delta > ROUGH_RELATIVE_ERROR ? "rough" : "ok", reason: null,
    tokensPerPercent: Math.round(total.total / delta),
    tokensPerPercentLow: Math.round(total.total / (delta + error)),
    tokensPerPercentHigh: Math.round(total.total / (delta - error)),
  };
}

function insufficient(reason: string): QuotaBurnEstimate {
  return {
    status: "insufficient", reason, from: null, to: null, cycles: 0, usedFrom: null, usedTo: null,
    delta: null, deltaError: null, tokens: emptyTokens(),
    tokensPerPercent: null, tokensPerPercentLow: null, tokensPerPercentHigh: null,
  };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function emptyTokens(): QuotaBurnTokens {
  return { requests: 0, requestsWithoutTokens: 0, input: 0, cacheRead: 0, cacheWrite: null,
    inputUnsplit: 0, output: 0, total: 0 };
}

function addTokens(target: QuotaBurnTokens, add: QuotaBurnTokens) {
  target.requests += add.requests;
  target.requestsWithoutTokens += add.requestsWithoutTokens;
  target.input += add.input;
  target.cacheRead += add.cacheRead;
  target.cacheWrite = add.cacheWrite === null && target.cacheWrite === null ? null
    : (target.cacheWrite ?? 0) + (add.cacheWrite ?? 0);
  target.inputUnsplit += add.inputUnsplit;
  target.output += add.output;
  target.total += add.total;
}

// prompt_tokens include cached reads for both providers and, for Claude, cache
// writes. Claude rows logged before cache_write_tokens existed cannot split
// input from cache writes; they are reported as inputUnsplit.
function sumTokens(provider: "claude" | "codex", credentialIds: string[], from: number, to: number): QuotaBurnTokens {
  const row = getLogDb().prepare(`SELECT COUNT(*) AS requests,
      COALESCE(SUM(total_tokens = 0), 0) AS without_tokens,
      COALESCE(SUM(prompt_tokens), 0) AS prompt, COALESCE(SUM(cached_tokens), 0) AS cached,
      COALESCE(SUM(completion_tokens), 0) AS output, SUM(cache_write_tokens) AS cache_write,
      COALESCE(SUM(CASE WHEN cache_write_tokens IS NULL THEN prompt_tokens - cached_tokens ELSE 0 END), 0) AS unsplit
    FROM request_logs INDEXED BY idx_request_logs_credential
    WHERE credential_id IN (${credentialIds.map(() => "?").join(", ")}) AND started_at > ? AND started_at <= ?`)
    .get(...credentialIds, new Date(from).toISOString(), new Date(to).toISOString()) as Record<string, number | null>;
  const prompt = Number(row.prompt);
  const cacheRead = Number(row.cached);
  const output = Number(row.output);
  const claude = provider === "claude";
  const cacheWrite = claude && row.cache_write !== null ? Number(row.cache_write) : null;
  const inputUnsplit = claude ? Number(row.unsplit) : 0;
  return {
    requests: Number(row.requests), requestsWithoutTokens: Number(row.without_tokens),
    input: Math.max(0, prompt - cacheRead - (cacheWrite ?? 0) - inputUnsplit),
    cacheRead, cacheWrite: claude ? cacheWrite ?? (inputUnsplit ? null : 0) : null,
    inputUnsplit, output, total: prompt + output,
  };
}
