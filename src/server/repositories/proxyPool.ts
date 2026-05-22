import "server-only";

import { getMainDb } from "@/src/server/db/sqlite";
import {
  decryptJson,
  encryptJson,
  randomId,
} from "@/src/server/services/crypto";
import type {
  CredentialProxyConfig,
  CredentialProxyType,
  ProxyPoolRecord,
  ProxyPoolRecordWithSecret,
} from "@/src/shared/types/entities";

type ProxyPoolRow = {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  username: string;
  password_envelope: string | null;
  enabled: number;
  notes: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
};

export interface SaveProxyPoolItemInput {
  name: string;
  enabled: boolean;
  type: CredentialProxyType;
  host: string;
  port: number;
  username: string;
  password?: string;
  notes: string;
}

export function listProxyPoolItems(): ProxyPoolRecord[] {
  const rows = getMainDb()
    .prepare("SELECT * FROM proxy_pool ORDER BY enabled DESC, updated_at DESC")
    .all() as ProxyPoolRow[];
  return rows.map(toPublicProxyPoolRecord);
}

export function getProxyPoolItemById(id: string): ProxyPoolRecord | null {
  const row = getProxyPoolRow(id);
  return row ? toPublicProxyPoolRecord(row) : null;
}

export function getProxyPoolItemWithSecret(
  id: string,
): ProxyPoolRecordWithSecret | null {
  const row = getProxyPoolRow(id);
  return row ? toProxyPoolRecordWithSecret(row) : null;
}

export function createProxyPoolItem(input: SaveProxyPoolItemInput) {
  const now = new Date().toISOString();
  const id = randomId("proxy");
  getMainDb()
    .prepare(
      `INSERT INTO proxy_pool (
        id, name, type, host, port, username, password_envelope,
        enabled, notes, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      id,
      input.name,
      input.type,
      input.host,
      input.port,
      input.username,
      input.password ? encryptJson(input.password) : null,
      input.enabled ? 1 : 0,
      input.notes,
      now,
      now,
    );
  return getProxyPoolItemById(id);
}

export function updateProxyPoolItem(
  id: string,
  input: Partial<SaveProxyPoolItemInput>,
) {
  const existing = getProxyPoolRow(id);
  if (!existing) {
    return null;
  }
  const now = new Date().toISOString();
  const passwordEnvelope = Object.hasOwn(input, "password")
    ? input.password
      ? encryptJson(input.password)
      : null
    : existing.password_envelope;

  getMainDb()
    .prepare(
      `UPDATE proxy_pool SET
        name = ?, type = ?, host = ?, port = ?, username = ?,
        password_envelope = ?, enabled = ?, notes = ?, updated_at = ?
      WHERE id = ?`,
    )
    .run(
      input.name ?? existing.name,
      input.type ?? normalizeProxyType(existing.type),
      input.host ?? existing.host,
      input.port ?? existing.port,
      input.username ?? existing.username,
      passwordEnvelope,
      input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
      input.notes ?? existing.notes,
      now,
      id,
    );
  return getProxyPoolItemById(id);
}

export function deleteProxyPoolItem(id: string) {
  const result = getMainDb()
    .prepare("DELETE FROM proxy_pool WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

export function markProxyPoolItemUsed(id: string) {
  const now = new Date().toISOString();
  getMainDb()
    .prepare("UPDATE proxy_pool SET last_used_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, id);
}

export function proxyPoolItemToCredentialProxy(
  item: ProxyPoolRecordWithSecret,
): CredentialProxyConfig {
  return {
    enabled: item.enabled,
    type: item.type,
    host: item.host,
    port: item.port,
    username: item.username,
    password: item.password,
  };
}

function getProxyPoolRow(id: string) {
  return getMainDb()
    .prepare("SELECT * FROM proxy_pool WHERE id = ?")
    .get(id) as ProxyPoolRow | undefined;
}

function toPublicProxyPoolRecord(row: ProxyPoolRow): ProxyPoolRecord {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    type: normalizeProxyType(row.type),
    host: row.host,
    port: row.port,
    username: row.username,
    passwordSet: Boolean(row.password_envelope),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

function toProxyPoolRecordWithSecret(row: ProxyPoolRow): ProxyPoolRecordWithSecret {
  return {
    ...toPublicProxyPoolRecord(row),
    password: row.password_envelope
      ? decryptJson<string>(row.password_envelope)
      : "",
  };
}

function normalizeProxyType(value: string): CredentialProxyType {
  return value === "socks5" ? "socks5" : "socks5h";
}
