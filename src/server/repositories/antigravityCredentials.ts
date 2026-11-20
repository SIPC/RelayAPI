import "server-only";

import { getMainDb } from "@/src/server/db/sqlite";
import { decryptJson, encryptJson, sha256 } from "@/src/server/services/crypto";
import type {
  AntigravityCredentialRecord,
  AntigravityCredentialWithTokens,
  AntigravityTokenBundle,
} from "@/src/shared/types/entities";

type Row = {
  id: string;
  account_id: string;
  email: string;
  project_id: string;
  token_envelope: string;
  enabled: number;
  priority: number;
  weight: number;
  expires_at: string;
  last_refresh_at: string;
  last_used_at: string | null;
  cooldown_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  models_json: string | null;
  model_cooldowns_json: string;
  metadata_json: string;
};

export type AntigravityModelCooldown = { until: string; level: number };

const QUOTA_BACKOFF_BASE_MS = 1000;
const QUOTA_BACKOFF_MAX_MS = 30 * 60 * 1000;

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function publicRecord(row: Row): AntigravityCredentialRecord {
  return {
    id: row.id,
    provider: "antigravity",
    accountId: row.account_id,
    email: row.email,
    enabled: row.enabled === 1,
    priority: row.priority,
    weight: row.weight,
    expiresAt: row.expires_at,
    lastRefreshAt: row.last_refresh_at,
    lastUsedAt: row.last_used_at,
    cooldownUntil: row.cooldown_until,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    proxy: null,
    proxyPoolId: null,
    useGlobalProxy: false,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    models: parseJson<string[] | null>(row.models_json, null),
    modelCooldowns: parseJson<Record<string, AntigravityModelCooldown>>(row.model_cooldowns_json, {}),
  };
}

export function listAntigravityCredentials() {
  const rows = getMainDb().prepare("SELECT * FROM antigravity_credentials ORDER BY created_at, id").all() as Row[];
  return rows.map(publicRecord);
}

export function getAntigravityCredential(id: string) {
  const row = getMainDb().prepare("SELECT * FROM antigravity_credentials WHERE id = ?").get(id) as Row | undefined;
  return row ? publicRecord(row) : null;
}

export function getAntigravityCredentialWithTokens(id: string): AntigravityCredentialWithTokens | null {
  const row = getMainDb().prepare("SELECT * FROM antigravity_credentials WHERE id = ?").get(id) as Row | undefined;
  if (!row) return null;
  return {
    ...publicRecord(row),
    projectId: row.project_id,
    tokenEnvelope: row.token_envelope,
    tokens: decryptJson<AntigravityTokenBundle>(row.token_envelope),
  };
}

export function saveAntigravityCredential(input: {
  accountId: string;
  email: string;
  projectId: string;
  tokens: AntigravityTokenBundle;
}) {
  const now = new Date().toISOString();
  const id = "agy_" + sha256(JSON.stringify([input.accountId, input.projectId]));
  const row = getMainDb().prepare(`
    INSERT INTO antigravity_credentials (
      id, account_id, email, project_id, token_envelope, expires_at, last_refresh_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email, token_envelope = excluded.token_envelope,
      expires_at = excluded.expires_at, last_refresh_at = excluded.last_refresh_at,
      cooldown_until = NULL, model_cooldowns_json = '{}', last_error = NULL, enabled = 1,
      updated_at = excluded.updated_at
    RETURNING *
  `).get(id, input.accountId, input.email, input.projectId, encryptJson(input.tokens),
    input.tokens.expired, input.tokens.last_refresh, now, now) as Row;
  return publicRecord(row);
}

export function replaceAntigravityTokens(credential: AntigravityCredentialWithTokens, tokens: AntigravityTokenBundle) {
  getMainDb().prepare(`
    UPDATE antigravity_credentials SET token_envelope = ?, expires_at = ?, last_refresh_at = ?,
      updated_at = ?
    WHERE id = ? AND token_envelope = ?
  `).run(encryptJson(tokens), tokens.expired, tokens.last_refresh, tokens.last_refresh,
    credential.id, credential.tokenEnvelope);
}

export function replaceAntigravityModels(id: string, models: string[]) {
  getMainDb().prepare("UPDATE antigravity_credentials SET models_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify([...new Set(models)].sort()), new Date().toISOString(), id);
}

export function markAntigravityCredentialUsed(id: string) {
  getMainDb().prepare("UPDATE antigravity_credentials SET last_used_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
}

export function updateAntigravityCredentialHealth(id: string, patch: { cooldownUntil: string | null; lastError: string | null }) {
  getMainDb().prepare("UPDATE antigravity_credentials SET cooldown_until = ?, last_error = ?, updated_at = ? WHERE id = ?")
    .run(patch.cooldownUntil, patch.lastError, new Date().toISOString(), id);
}

// Per-model cooldown as in CPA: an explicit retry delay wins; otherwise quota failures back off
// exponentially from 1s to 30m. Failures inside an open window reuse it instead of escalating.
export function markAntigravityModelCooldown(id: string, model: string, input: { retryAfterMs?: number; message: string }) {
  const row = getMainDb().prepare("SELECT model_cooldowns_json FROM antigravity_credentials WHERE id = ?")
    .get(id) as Pick<Row, "model_cooldowns_json"> | undefined;
  if (!row) return null;
  const now = Date.now();
  const cooldowns = parseJson<Record<string, AntigravityModelCooldown>>(row.model_cooldowns_json, {});
  const previous = cooldowns[model];
  let next = previous;
  if (input.retryAfterMs !== undefined) {
    next = { until: new Date(now + input.retryAfterMs).toISOString(), level: previous?.level ?? 0 };
  } else if (!previous || Date.parse(previous.until) <= now) {
    const level = previous?.level ?? 0;
    const delay = Math.min(QUOTA_BACKOFF_BASE_MS * 2 ** level, QUOTA_BACKOFF_MAX_MS);
    next = { until: new Date(now + delay).toISOString(), level: delay >= QUOTA_BACKOFF_MAX_MS ? level : level + 1 };
  }
  cooldowns[model] = next!;
  getMainDb().prepare("UPDATE antigravity_credentials SET model_cooldowns_json = ?, last_error = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(cooldowns), input.message, new Date().toISOString(), id);
  return next!.until;
}

export function clearAntigravityModelCooldown(id: string, model: string) {
  const row = getMainDb().prepare("SELECT model_cooldowns_json FROM antigravity_credentials WHERE id = ?")
    .get(id) as Pick<Row, "model_cooldowns_json"> | undefined;
  const cooldowns = parseJson<Record<string, AntigravityModelCooldown>>(row?.model_cooldowns_json ?? null, {});
  if (!(model in cooldowns)) return;
  delete cooldowns[model];
  getMainDb().prepare("UPDATE antigravity_credentials SET model_cooldowns_json = ? WHERE id = ?")
    .run(JSON.stringify(cooldowns), id);
}

export function updateAntigravityCredentialSettings(id: string, patch: {
  enabled?: boolean;
  priority?: number;
  weight?: number;
  metadata?: Record<string, unknown>;
  cooldownUntil?: null;
  lastError?: null;
  modelCooldowns?: Record<string, never>;
}) {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.enabled !== undefined) { sets.push("enabled = ?"); values.push(patch.enabled ? 1 : 0); }
  if (patch.priority !== undefined) { sets.push("priority = ?"); values.push(patch.priority); }
  if (patch.weight !== undefined) { sets.push("weight = ?"); values.push(patch.weight); }
  if (patch.metadata !== undefined) { sets.push("metadata_json = ?"); values.push(JSON.stringify(patch.metadata)); }
  if (patch.cooldownUntil !== undefined) { sets.push("cooldown_until = NULL"); }
  if (patch.lastError !== undefined) { sets.push("last_error = NULL"); }
  if (patch.modelCooldowns !== undefined) { sets.push("model_cooldowns_json = '{}'"); }
  sets.push("updated_at = ?");
  values.push(new Date().toISOString(), id);
  const row = getMainDb().prepare(`UPDATE antigravity_credentials SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
    .get(...values) as Row | undefined;
  return row ? publicRecord(row) : null;
}

export function deleteAntigravityCredential(id: string) {
  return Number(getMainDb().prepare("DELETE FROM antigravity_credentials WHERE id = ?").run(id).changes) > 0;
}

export function suspendAntigravityCredential(credential: AntigravityCredentialWithTokens, message: string) {
  getMainDb().prepare(`
    UPDATE antigravity_credentials SET enabled = 0, last_error = ?, updated_at = ?
    WHERE id = ? AND token_envelope = ?
  `).run(message, new Date().toISOString(), credential.id, credential.tokenEnvelope);
}
