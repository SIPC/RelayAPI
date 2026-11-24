import "server-only";

import { createHash } from "node:crypto";
import { getMainDb } from "@/src/server/db/sqlite";
import { safeJsonParse } from "@/src/server/services/crypto";
import type { ClaudeQuotaWindow } from "@/src/shared/types/entities";

export interface ClaudeQuotaObservation extends ClaudeQuotaWindow {
  observedAt: number;
  source: "oauth_usage" | "anthropic_headers";
  scope: string | null;
  rejected: boolean;
}

type CacheRow = {
  windows_json: string;
  extra_usage_enabled: number | null;
  last_usage_at: number;
  next_attempt_at: number;
  failures: number;
  last_error: string | null;
};

// Duplicate credential imports for one subscription share refreshes and samples.
// Keep organizations separate; the same user can belong to several plans.
export function claudeQuotaAccountKey(credentialId: string) {
  const credential = getMainDb().prepare(
    "SELECT account_id, metadata_json FROM claude_credentials WHERE id = ?",
  ).get(credentialId) as { account_id: string; metadata_json: string } | undefined;
  if (!credential) return null;
  const metadata = safeJsonParse<Record<string, unknown>>(credential.metadata_json, {});
  return createHash("sha256").update(JSON.stringify([
    credential.account_id || credentialId,
    metadata.organization_uuid || metadata.organization_id || "",
  ])).digest("hex");
}

export function getClaudeQuotaCache(accountKey: string) {
  const row = getMainDb().prepare("SELECT * FROM claude_quota_cache WHERE account_key = ?")
    .get(accountKey) as CacheRow | undefined;
  return {
    windows: safeJsonParse<ClaudeQuotaObservation[]>(row?.windows_json, []),
    extraUsageEnabled: row?.extra_usage_enabled === null || !row ? null : row.extra_usage_enabled === 1,
    lastUsageAt: row?.last_usage_at ?? 0,
    nextAttemptAt: row?.next_attempt_at ?? 0,
    failures: row?.failures ?? 0,
    lastError: row?.last_error ?? null,
  };
}

export function mergeClaudeQuotaObservations(
  accountKey: string, observations: ClaudeQuotaObservation[],
  usage?: { observedAt: number; extraUsageEnabled: boolean | null },
) {
  const db = getMainDb();
  // A savepoint also works inside a caller's transaction and makes merging
  // partial headers atomic across Node workers sharing this database.
  db.exec("SAVEPOINT claude_quota_merge");
  try {
    db.prepare("INSERT OR IGNORE INTO claude_quota_cache (account_key) VALUES (?)").run(accountKey);
    const cache = getClaudeQuotaCache(accountKey);
    const windows = new Map(cache.windows.map((window) => [window.id, window]));
    if (usage) {
      // A full read can remove a model-specific limit. Keep any newer inference sample.
      const returned = new Set(observations.map((window) => window.id));
      for (const [id, window] of windows) {
        if (id.startsWith("unified-") && !returned.has(id) && window.observedAt <= usage.observedAt) windows.delete(id);
      }
    }
    for (const observation of observations) {
      const previous = windows.get(observation.id);
      if (!previous || previous.observedAt <= observation.observedAt) {
        // Status/reset-only headers must not relabel an old percentage as fresh.
        if (previous && observation.remaining_percent === null &&
          (!observation.reset_at || observation.reset_at === previous.reset_at)) {
          windows.set(observation.id, { ...previous, rejected: observation.rejected,
            exhausted: observation.rejected || previous.exhausted });
        } else windows.set(observation.id, observation);
      }
    }
    db.prepare("UPDATE claude_quota_cache SET windows_json = ? WHERE account_key = ?")
      .run(JSON.stringify([...windows.values()]), accountKey);
    if (usage && usage.observedAt >= cache.lastUsageAt) {
      db.prepare(`UPDATE claude_quota_cache SET last_usage_at = ?, extra_usage_enabled = ?
        WHERE account_key = ?`).run(usage.observedAt,
        usage.extraUsageEnabled === null ? null : Number(usage.extraUsageEnabled), accountKey);
    }
    db.exec("RELEASE claude_quota_merge");
  } catch (error) {
    db.exec("ROLLBACK TO claude_quota_merge");
    db.exec("RELEASE claude_quota_merge");
    throw error;
  }
}

export function acquireClaudeQuotaRefresh(accountKey: string, owner: string, now: number) {
  return getMainDb().prepare(`
    INSERT INTO claude_quota_cache (account_key, owner, lease_until, last_attempt_at)
    SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM claude_quota_cache WHERE lease_until > ?) < 2
    ON CONFLICT(account_key) DO UPDATE SET owner = excluded.owner,
      lease_until = excluded.lease_until, last_attempt_at = excluded.last_attempt_at
    WHERE claude_quota_cache.lease_until <= ? AND claude_quota_cache.next_attempt_at <= ?
    RETURNING failures
  `).get(accountKey, owner, now + 30_000, now, now, now, now) as { failures: number } | undefined;
}

export function finishClaudeQuotaRefresh(
  accountKey: string, owner: string, failures: number, nextAttemptAt: number, error: string | null,
) {
  getMainDb().prepare(`UPDATE claude_quota_cache SET owner = NULL, lease_until = 0,
    failures = ?, next_attempt_at = ?, last_error = ? WHERE account_key = ? AND owner = ?`)
    .run(failures, nextAttemptAt, error, accountKey, owner);
}

export function ownsClaudeQuotaRefresh(accountKey: string, owner: string) {
  return Boolean(getMainDb().prepare(
    "SELECT 1 FROM claude_quota_cache WHERE account_key = ? AND owner = ? AND lease_until > ?",
  ).get(accountKey, owner, Date.now()));
}
