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
