import "server-only";

import { getMainDb } from "@/src/server/db/sqlite";
import type {
  CodexCredentialRecord,
  CodexCredentialWithTokens,
  CodexTokenBundle,
} from "@/src/shared/types/entities";
import {
  decryptJson,
  encryptJson,
  jsonStringify,
  safeJsonParse,
} from "@/src/server/services/crypto";

type CodexCredentialRow = {
  id: string;
  provider: string;
  email: string;
  account_id: string;
  plan_type: string;
  token_envelope: string;
  expires_at: string | null;
  last_refresh_at: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export interface SaveCodexCredentialInput {
  id: string;
  email: string;
  accountId: string;
  planType: string;
  tokens: CodexTokenBundle;
  metadata?: Record<string, unknown>;
}

export function listCodexCredentials(): CodexCredentialRecord[] {
  const rows = getMainDb()
    .prepare("SELECT * FROM codex_credentials ORDER BY created_at DESC")
    .all() as CodexCredentialRow[];
  return rows.map((row: CodexCredentialRow) => toCodexCredentialRecord(row));
}

export function getCodexCredentialById(
  id: string,
): CodexCredentialRecord | null {
  const row = getMainDb()
    .prepare("SELECT * FROM codex_credentials WHERE id = ?")
    .get(id) as CodexCredentialRow | undefined;
  return row ? toCodexCredentialRecord(row) : null;
}

export function getCodexCredentialWithTokens(id: string) {
  const row = getMainDb()
    .prepare("SELECT * FROM codex_credentials WHERE id = ?")
    .get(id) as CodexCredentialRow | undefined;
  return row ? toCodexCredentialWithTokens(row) : null;
}

export function getFirstCodexCredential() {
  const row = getMainDb()
    .prepare("SELECT * FROM codex_credentials ORDER BY created_at ASC LIMIT 1")
    .get() as CodexCredentialRow | undefined;
  return row ? toCodexCredentialRecord(row) : null;
}

export function upsertCodexCredential(input: SaveCodexCredentialInput) {
  const existing = getCodexCredentialById(input.id);
  const now = new Date().toISOString();
  const createdAt = existing?.createdAt || now;
  getMainDb()
    .prepare(
      `INSERT INTO codex_credentials (
        id, provider, email, account_id, plan_type, token_envelope,
        expires_at, last_refresh_at, metadata_json, created_at, updated_at
      ) VALUES (?, 'codex', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        account_id = excluded.account_id,
        plan_type = excluded.plan_type,
        token_envelope = excluded.token_envelope,
        expires_at = excluded.expires_at,
        last_refresh_at = excluded.last_refresh_at,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    )
    .run(
      input.id,
      input.email,
      input.accountId,
      input.planType,
      encryptJson(input.tokens),
      input.tokens.expired || null,
      input.tokens.last_refresh || null,
      jsonStringify(input.metadata || {}),
      createdAt,
      now,
    );
  return getCodexCredentialWithTokens(input.id);
}

export function deleteCodexCredential(id: string) {
  const result = getMainDb()
    .prepare("DELETE FROM codex_credentials WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

function toCodexCredentialRecord(
  row: CodexCredentialRow,
): CodexCredentialRecord {
  return {
    id: row.id,
    provider: "codex",
    email: row.email,
    accountId: row.account_id,
    planType: row.plan_type,
    expiresAt: row.expires_at,
    lastRefreshAt: row.last_refresh_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata_json, {}),
  };
}

function toCodexCredentialWithTokens(
  row: CodexCredentialRow,
): CodexCredentialWithTokens {
  return {
    ...toCodexCredentialRecord(row),
    tokens: decryptJson<CodexTokenBundle>(row.token_envelope),
  };
}
