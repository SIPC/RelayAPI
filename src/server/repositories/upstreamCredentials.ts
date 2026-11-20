import "server-only";

import { getMainDb } from "@/src/server/db/sqlite";
import { decryptJson, encryptJson, jsonStringify, safeJsonParse } from "@/src/server/services/crypto";
import type {
  ApiUpstreamProvider,
  CredentialProxyConfig,
  UpstreamCredentialRecord,
  UpstreamCredentialWithSecret,
} from "@/src/shared/types/entities";

type UpstreamCredentialRow = {
  id: string;
  provider: ApiUpstreamProvider;
  name: string;
  key_prefix: string;
  key_envelope: string;
  enabled: number;
  priority: number;
  weight: number;
  use_global_proxy: number;
  proxy_pool_id: string | null;
  proxy_envelope: string | null;
  last_used_at: string | null;
  cooldown_until: string | null;
  last_error: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export interface SaveUpstreamCredentialInput {
  id: string;
  provider: ApiUpstreamProvider;
  name: string;
  apiKey: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  useGlobalProxy?: boolean;
  proxyPoolId?: string | null;
  proxy?: CredentialProxyConfig | null;
  metadata?: Record<string, unknown>;
}

export type UpdateUpstreamCredentialInput = Partial<Pick<
  UpstreamCredentialWithSecret,
  | "name" | "apiKey" | "enabled" | "priority" | "weight"
  | "useGlobalProxy" | "proxyPoolId" | "proxy" | "lastUsedAt"
  | "cooldownUntil" | "lastError" | "metadata"
>>;

export function listUpstreamCredentials(provider?: ApiUpstreamProvider): UpstreamCredentialRecord[] {
  const rows = getMainDb().prepare(
    "SELECT * FROM upstream_credentials WHERE (? IS NULL OR provider = ?) ORDER BY created_at DESC",
  ).all(provider ?? null, provider ?? null) as UpstreamCredentialRow[];
  return rows.map(toPublicRecord);
}

export function getUpstreamCredentialWithSecret(id: string): UpstreamCredentialWithSecret | null {
  const row = getRow(id);
  return row ? {
    ...toPublicRecord(row),
    proxy: privateProxy(row),
    apiKey: decryptJson<string>(row.key_envelope),
  } : null;
}

export function insertUpstreamCredential(input: SaveUpstreamCredentialInput): UpstreamCredentialRecord {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("Upstream API key is required");
  const now = new Date().toISOString();
  getMainDb().prepare(`INSERT INTO upstream_credentials (
    id, provider, name, key_prefix, key_envelope, enabled, priority, weight,
    use_global_proxy, proxy_pool_id, proxy_envelope, metadata_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.id, input.provider, input.name, keyPrefix(apiKey), encryptJson(apiKey),
    (input.enabled ?? true) ? 1 : 0, input.priority ?? 100, Math.max(1, input.weight ?? 1),
    input.useGlobalProxy ? 1 : 0, input.proxyPoolId ?? null,
    input.proxy ? encryptJson(input.proxy) : null, jsonStringify(input.metadata ?? {}), now, now,
  );
  return toPublicRecord(getRow(input.id)!);
}

export function updateUpstreamCredential(
  id: string,
  patch: UpdateUpstreamCredentialInput,
): UpstreamCredentialRecord | null {
  const row = getRow(id);
  if (!row) return null;
  const apiKey = patch.apiKey?.trim();
  getMainDb().prepare(`UPDATE upstream_credentials SET
    name = ?, key_prefix = ?, key_envelope = ?, enabled = ?, priority = ?, weight = ?,
    use_global_proxy = ?, proxy_pool_id = ?, proxy_envelope = ?, last_used_at = ?,
    cooldown_until = ?, last_error = ?, metadata_json = ?, updated_at = ? WHERE id = ?`).run(
    patch.name ?? row.name,
    apiKey ? keyPrefix(apiKey) : row.key_prefix,
    apiKey ? encryptJson(apiKey) : row.key_envelope,
    patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
    patch.priority ?? row.priority, Math.max(1, patch.weight ?? row.weight),
    patch.useGlobalProxy === undefined ? row.use_global_proxy : patch.useGlobalProxy ? 1 : 0,
    patch.proxyPoolId === undefined ? row.proxy_pool_id : patch.proxyPoolId,
    patch.proxy === undefined ? row.proxy_envelope : patch.proxy ? encryptJson(patch.proxy) : null,
    patch.lastUsedAt === undefined ? row.last_used_at : patch.lastUsedAt,
    patch.cooldownUntil === undefined ? row.cooldown_until : patch.cooldownUntil,
    patch.lastError === undefined ? row.last_error : patch.lastError,
    patch.metadata === undefined ? row.metadata_json : jsonStringify(patch.metadata),
    new Date().toISOString(), id,
  );
  return toPublicRecord(getRow(id)!);
}

export function markUpstreamCredentialUsed(id: string) {
  const now = new Date().toISOString();
  getMainDb().prepare(
    "UPDATE upstream_credentials SET last_used_at = ?, updated_at = ? WHERE id = ?",
  ).run(now, now, id);
}

export function deleteUpstreamCredential(id: string) {
  return getMainDb().prepare("DELETE FROM upstream_credentials WHERE id = ?").run(id).changes > 0;
}

function getRow(id: string) {
  return getMainDb().prepare("SELECT * FROM upstream_credentials WHERE id = ?")
    .get(id) as UpstreamCredentialRow | undefined;
}

function privateProxy(row: UpstreamCredentialRow): CredentialProxyConfig | null {
  return row.proxy_envelope ? decryptJson<CredentialProxyConfig>(row.proxy_envelope) : null;
}

function toPublicRecord(row: UpstreamCredentialRow): UpstreamCredentialRecord {
  const proxy = privateProxy(row);
  return {
    id: row.id, provider: row.provider, name: row.name,
    keyPrefix: row.key_prefix, keySet: Boolean(row.key_envelope),
    enabled: row.enabled === 1, priority: row.priority, weight: row.weight,
    useGlobalProxy: row.use_global_proxy === 1, proxyPoolId: row.proxy_pool_id,
    proxy: proxy ? {
      enabled: proxy.enabled, type: proxy.type, host: proxy.host, port: proxy.port,
      username: proxy.username, passwordSet: Boolean(proxy.password),
    } : null,
    lastUsedAt: row.last_used_at, cooldownUntil: row.cooldown_until, lastError: row.last_error,
    createdAt: row.created_at, updatedAt: row.updated_at,
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata_json, {}),
  };
}

function keyPrefix(apiKey: string) {
  // Short keys must not accidentally be returned in full as their own prefix.
  return apiKey.length > 12 ? `${apiKey.slice(0, 8)}…` : "…";
}
