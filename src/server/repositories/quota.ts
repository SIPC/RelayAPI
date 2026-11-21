import "server-only";

import { getMainDb } from "@/src/server/db/sqlite";
import { jsonStringify, safeJsonParse } from "@/src/server/services/crypto";

type CodexQuotaCacheRow = {
  credential_id: string;
  status: string;
  cache_json: string;
  retrieved_at: string;
  updated_at: string;
};

export interface CodexQuotaCacheRecord {
  credentialId: string;
  status: string;
  cache: Record<string, unknown>;
  retrievedAt: string;
  updatedAt: string;
}

export interface UpsertCodexQuotaCacheInput {
  credentialId: string;
  status: string;
  cache: Record<string, unknown>;
  retrievedAt: string;
}

export function getCodexQuotaCacheByCredentialId(credentialId: string) {
  const row = getMainDb()
    .prepare("SELECT * FROM codex_quota_cache WHERE credential_id = ?")
    .get(credentialId) as CodexQuotaCacheRow | undefined;
  return row ? toCodexQuotaCacheRecord(row) : null;
}

export function upsertCodexQuotaCache(input: UpsertCodexQuotaCacheInput) {
  const now = new Date().toISOString();
  // Quota cache lives in the main DB because routing may later use current
  // quota state when automatically selecting channels.
  getMainDb()
    .prepare(
      `INSERT INTO codex_quota_cache (
        credential_id, status, cache_json, retrieved_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(credential_id) DO UPDATE SET
        status = excluded.status,
        cache_json = excluded.cache_json,
        retrieved_at = excluded.retrieved_at,
        updated_at = excluded.updated_at`,
    )
    .run(
      input.credentialId,
      input.status,
      jsonStringify(input.cache),
      input.retrievedAt,
      now,
    );
  return getCodexQuotaCacheByCredentialId(input.credentialId);
}

// A single atomic statement coordinates workers sharing the main SQLite DB.
// Expiring leases recover from a stopped process; failed refreshes retain cache.
export function acquireCodexQuotaRefresh(credentialId: string, owner: string, leaseMs: number) {
  const now = Date.now();
  return getMainDb().prepare(`
    INSERT INTO codex_quota_refresh (credential_id, owner, lease_until)
    SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM codex_quota_refresh WHERE lease_until > ?) < 4
    ON CONFLICT(credential_id) DO UPDATE SET owner = excluded.owner, lease_until = excluded.lease_until
    WHERE codex_quota_refresh.lease_until <= ? AND codex_quota_refresh.next_attempt_at <= ?
    RETURNING failures
  `).get(credentialId, owner, now + leaseMs, now, now, now) as { failures: number } | undefined;
}

export function finishCodexQuotaRefresh(
  credentialId: string, owner: string, failures: number, delayMs: number,
) {
  getMainDb().prepare(`
    UPDATE codex_quota_refresh SET lease_until = 0, failures = ?, next_attempt_at = ?
    WHERE credential_id = ? AND owner = ?
  `).run(failures, Date.now() + delayMs, credentialId, owner);
}

function toCodexQuotaCacheRecord(
  row: CodexQuotaCacheRow,
): CodexQuotaCacheRecord {
  return {
    credentialId: row.credential_id,
    status: row.status,
    cache: safeJsonParse<Record<string, unknown>>(row.cache_json, {}),
    retrievedAt: row.retrieved_at,
    updatedAt: row.updated_at,
  };
}
