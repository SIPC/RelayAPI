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
  credentialId?: string;
  credentialIds?: string[];
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
  const credentialIdsByChannelId = channelCredentialIdsByChannelId(
    rows.map((row) => row.id),
  );
  return rows.map((row: ChannelRow) =>
    toChannelRecord(row, credentialIdsByChannelId.get(row.id)),
  );
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
      `SELECT channels.*
       FROM channels
       LEFT JOIN channel_credentials
         ON channel_credentials.channel_id = channels.id
       WHERE channels.credential_id = ? OR channel_credentials.credential_id = ?
       ORDER BY channels.created_at ASC
       LIMIT 1`,
    )
    .get(credentialId, credentialId) as ChannelRow | undefined;
  return row ? toChannelRecord(row) : null;
}

export function insertChannel(input: SaveChannelInput) {
  const now = new Date().toISOString();
  const credentialIds = normalizeCredentialIds(input);
  const primaryCredentialId = credentialIds[0] || "";
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
      primaryCredentialId,
      input.enabled ? 1 : 0,
      input.priority,
      input.weight,
      jsonStringify(input.modelAllowlist),
      input.status || "healthy",
      now,
      now,
    );
  setChannelCredentialIds(input.id, credentialIds);
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
      | "credentialIds"
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
  const nextCredentialIds =
    patch.credentialIds !== undefined
      ? normalizeCredentialIds({ credentialIds: patch.credentialIds })
      : patch.credentialId !== undefined
        ? normalizeCredentialIds({ credentialId: patch.credentialId })
        : normalizeCredentialIds({ credentialIds: existing.credentialIds });
  const primaryCredentialId = nextCredentialIds[0] || "";
  const next = {
    ...existing,
    ...patch,
    credentialId: primaryCredentialId,
    credentialIds: nextCredentialIds,
  };
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
  setChannelCredentialIds(id, nextCredentialIds);
  return getChannelById(id);
}

export function deleteChannel(id: string) {
  const result = getMainDb()
    .prepare("DELETE FROM channels WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

export function detachCredentialFromChannels(credentialId: string) {
  for (const channel of listChannels()) {
    if (!channel.credentialIds.includes(credentialId)) {
      continue;
    }
    const remainingCredentialIds = channel.credentialIds.filter(
      (id) => id !== credentialId,
    );
    if (remainingCredentialIds.length > 0) {
      updateChannel(channel.id, { credentialIds: remainingCredentialIds });
    }
  }
}

export function markChannelUsed(id: string) {
  updateChannel(id, { lastUsedAt: new Date().toISOString() });
}

export function getChannelCredentialIds(
  channelId: string,
  fallbackCredentialId?: string,
) {
  const ids = channelCredentialIdsByChannelId([channelId]).get(channelId) || [];
  return ids.length > 0 || !fallbackCredentialId ? ids : [fallbackCredentialId];
}

function channelCredentialIdsByChannelId(channelIds: string[]) {
  const uniqueIds = [...new Set(channelIds.filter(Boolean))];
  const result = new Map<string, string[]>();
  for (const channelId of uniqueIds) {
    result.set(channelId, []);
  }
  if (uniqueIds.length === 0) {
    return result;
  }

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = getMainDb()
    .prepare(
      `SELECT channel_id, credential_id
       FROM channel_credentials
       WHERE channel_id IN (${placeholders})
       ORDER BY channel_id ASC, created_at ASC, credential_id ASC`,
    )
    .all(...uniqueIds) as Array<{ channel_id: string; credential_id: string }>;
  for (const row of rows) {
    if (!row.credential_id) {
      continue;
    }
    const ids = result.get(row.channel_id) || [];
    ids.push(row.credential_id);
    result.set(row.channel_id, ids);
  }
  return result;
}

export function setChannelCredentialIds(
  channelId: string,
  credentialIds: string[],
) {
  const db = getMainDb();
  const now = new Date().toISOString();
  const uniqueIds = cleanUniqueStrings(credentialIds);
  db.prepare("DELETE FROM channel_credentials WHERE channel_id = ?").run(
    channelId,
  );
  const statement = db.prepare(
    `INSERT OR IGNORE INTO channel_credentials
      (channel_id, credential_id, created_at)
     VALUES (?, ?, ?)`,
  );
  for (const credentialId of uniqueIds) {
    statement.run(channelId, credentialId, now);
  }
}

function toChannelRecord(
  row: ChannelRow,
  credentialIds = getChannelCredentialIds(row.id, row.credential_id),
): ChannelRecord {
  return {
    id: row.id,
    name: row.name,
    provider: "codex",
    baseUrl: row.base_url,
    credentialId: row.credential_id,
    credentialIds:
      credentialIds.length > 0
        ? credentialIds
        : [row.credential_id].filter(Boolean),
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

function normalizeCredentialIds(input: {
  credentialId?: string;
  credentialIds?: string[];
}) {
  return cleanUniqueStrings([
    ...(Array.isArray(input.credentialIds) ? input.credentialIds : []),
    ...(input.credentialId ? [input.credentialId] : []),
  ]);
}

function cleanUniqueStrings(values: unknown[]) {
  return [
    ...new Set(
      values
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  ];
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
