import "server-only";

import { getMainDb } from "@/src/server/db/sqlite";
import type { ChannelRecord, ChannelStatus } from "@/src/shared/types/entities";
import { jsonStringify, safeJsonParse } from "@/src/server/services/crypto";

type ChannelRow = {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  credential_id: string;
  enabled: number;
  priority: number;
  weight: number;
  model_allowlist_json: string;
  status: string;
  health_score: number;
  cooldown_until: string | null;
  last_error: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

export interface SaveChannelInput {
  id: string;
  name: string;
  baseUrl: string;
  credentialId: string;
  enabled: boolean;
  priority: number;
  weight: number;
  modelAllowlist: string[];
  status?: ChannelStatus;
}

export function listChannels(): ChannelRecord[] {
  const rows = getMainDb()
    .prepare("SELECT * FROM channels ORDER BY priority DESC, created_at ASC")
    .all() as ChannelRow[];
  return rows.map((row: ChannelRow) => toChannelRecord(row));
}

export function getChannelById(id: string): ChannelRecord | null {
  const row = getMainDb()
    .prepare("SELECT * FROM channels WHERE id = ?")
    .get(id) as ChannelRow | undefined;
  return row ? toChannelRecord(row) : null;
}

export function getChannelByCredentialId(credentialId: string) {
  const row = getMainDb()
    .prepare(
      "SELECT * FROM channels WHERE credential_id = ? ORDER BY created_at ASC LIMIT 1",
    )
    .get(credentialId) as ChannelRow | undefined;
  return row ? toChannelRecord(row) : null;
}

export function insertChannel(input: SaveChannelInput) {
  const now = new Date().toISOString();
  getMainDb()
    .prepare(
      `INSERT INTO channels (
        id, name, provider, base_url, credential_id, enabled, priority,
        weight, model_allowlist_json, status, health_score, created_at, updated_at
      ) VALUES (?, ?, 'codex', ?, ?, ?, ?, ?, ?, ?, 100, ?, ?)`,
    )
    .run(
      input.id,
      input.name,
      input.baseUrl,
      input.credentialId,
      input.enabled ? 1 : 0,
      input.priority,
      input.weight,
      jsonStringify(input.modelAllowlist),
      input.status || "healthy",
      now,
      now,
    );
  return getChannelById(input.id);
}

export function updateChannel(
  id: string,
  patch: Partial<
    Pick<
      ChannelRecord,
      | "name"
      | "baseUrl"
      | "credentialId"
      | "enabled"
      | "priority"
      | "weight"
      | "modelAllowlist"
      | "status"
      | "healthScore"
      | "cooldownUntil"
      | "lastError"
      | "lastUsedAt"
    >
  >,
) {
  const existing = getChannelById(id);
  if (!existing) {
    return null;
  }
  const next = { ...existing, ...patch };
  getMainDb()
    .prepare(
      `UPDATE channels SET
        name = ?, base_url = ?, credential_id = ?, enabled = ?,
        priority = ?, weight = ?, model_allowlist_json = ?, status = ?,
        health_score = ?, cooldown_until = ?, last_error = ?,
        last_used_at = ?, updated_at = ?
      WHERE id = ?`,
    )
    .run(
      next.name,
      next.baseUrl,
      next.credentialId,
      next.enabled ? 1 : 0,
      next.priority,
      next.weight,
      jsonStringify(next.modelAllowlist),
      next.status,
      next.healthScore,
      next.cooldownUntil,
      next.lastError,
      next.lastUsedAt,
      new Date().toISOString(),
      id,
    );
  return getChannelById(id);
}

export function deleteChannel(id: string) {
  const result = getMainDb()
    .prepare("DELETE FROM channels WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

export function markChannelUsed(id: string) {
  updateChannel(id, { lastUsedAt: new Date().toISOString() });
}

function toChannelRecord(row: ChannelRow): ChannelRecord {
  return {
    id: row.id,
    name: row.name,
    provider: "codex",
    baseUrl: row.base_url,
    credentialId: row.credential_id,
    enabled: row.enabled === 1,
    priority: row.priority,
    weight: row.weight,
    modelAllowlist: safeJsonParse<string[]>(row.model_allowlist_json, []),
    status: normalizeStatus(row.status),
    healthScore: row.health_score,
    cooldownUntil: row.cooldown_until,
    lastError: row.last_error,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeStatus(value: string): ChannelStatus {
  if (
    value === "healthy" ||
    value === "degraded" ||
    value === "cooling_down" ||
    value === "disabled"
  ) {
    return value;
  }
  return "healthy";
}
