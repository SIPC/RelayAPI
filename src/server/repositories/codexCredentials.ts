import "server-only";

import { getMainDb } from "@/src/server/db/sqlite";
import type {
  CodexCredentialRecord,
  CodexCredentialWithTokens,
  CodexTokenBundle,
  CodexUpstreamTransport,
  CredentialProxyConfig,
  PublicCredentialProxyConfig,
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
  proxy_envelope: string | null;
  enabled: number;
  priority: number;
  weight: number;
  expires_at: string | null;
  last_refresh_at: string | null;
  last_used_at: string | null;
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
  proxy?: CredentialProxyConfig | null;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export function listCodexCredentials(): CodexCredentialRecord[] {
  const rows = getMainDb()
    .prepare("SELECT * FROM codex_credentials ORDER BY created_at DESC")
    .all() as CodexCredentialRow[];
  return rows.map((row: CodexCredentialRow) => toCodexCredentialRecord(row));
}

export function listCodexCredentialsWithTokens(): CodexCredentialWithTokens[] {
  const rows = getMainDb()
    .prepare("SELECT * FROM codex_credentials ORDER BY created_at DESC")
    .all() as CodexCredentialRow[];
  return rows.map((row: CodexCredentialRow) =>
    toCodexCredentialWithTokens(row),
  );
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
  const existing = getCodexCredentialWithTokens(input.id);
  const now = new Date().toISOString();
  const createdAt = existing?.createdAt || now;
  getMainDb()
    .prepare(
      `INSERT INTO codex_credentials (
        id, provider, email, account_id, plan_type, token_envelope,
        proxy_envelope, enabled, priority, weight, expires_at, last_refresh_at,
        last_used_at, metadata_json, created_at, updated_at
      ) VALUES (?, 'codex', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        account_id = excluded.account_id,
        plan_type = excluded.plan_type,
        token_envelope = excluded.token_envelope,
        proxy_envelope = excluded.proxy_envelope,
        enabled = excluded.enabled,
        priority = excluded.priority,
        weight = excluded.weight,
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
      encryptedProxyEnvelope(input.proxy, existing?.proxy),
      (input.enabled ?? existing?.enabled ?? true) ? 1 : 0,
      input.priority ?? existing?.priority ?? 100,
      Math.max(1, input.weight ?? existing?.weight ?? 1),
      input.tokens.expired || null,
      input.tokens.last_refresh || null,
      existing?.lastUsedAt || null,
      jsonStringify({
        ...(existing?.metadata || {}),
        ...(input.metadata || {}),
      }),
      createdAt,
      now,
    );
  return getCodexCredentialWithTokens(input.id);
}

export function updateCodexCredential(
  id: string,
  patch: Partial<
    Pick<
      CodexCredentialRecord,
      | "enabled"
      | "priority"
      | "weight"
      | "fastEnabled"
      | "upstreamTransport"
      | "useGlobalProxy"
      | "proxyPoolId"
      | "proxy"
      | "lastUsedAt"
      | "cooldownUntil"
      | "lastError"
      | "metadata"
    >
  >,
) {
  const existing = getCodexCredentialWithTokens(id);
  if (!existing) {
    return null;
  }
  const next = { ...existing, ...patch };
  const metadata = {
    ...next.metadata,
    fast_service_tier: next.fastEnabled,
    upstream_transport: next.upstreamTransport,
    use_global_proxy: next.useGlobalProxy,
    proxy_pool_id: next.proxyPoolId,
    cooldown_until: next.cooldownUntil,
    last_error: next.lastError,
  };
  getMainDb()
    .prepare(
      `UPDATE codex_credentials SET
        enabled = ?, priority = ?, weight = ?, proxy_envelope = ?,
        last_used_at = ?, metadata_json = ?, updated_at = ?
      WHERE id = ?`,
    )
    .run(
      next.enabled ? 1 : 0,
      next.priority,
      Math.max(1, next.weight),
      next.proxy ? encryptJson(next.proxy) : null,
      next.lastUsedAt,
      jsonStringify(metadata),
      new Date().toISOString(),
      id,
    );
  return getCodexCredentialWithTokens(id);
}

export function markCodexCredentialUsed(id: string) {
  const now = new Date().toISOString();
  getMainDb()
    .prepare(
      "UPDATE codex_credentials SET last_used_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(now, now, id);
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
  const metadata = safeJsonParse<Record<string, unknown>>(
    row.metadata_json,
    {},
  );
  return {
    id: row.id,
    provider: "codex",
    email: row.email,
    accountId: row.account_id,
    planType: row.plan_type,
    enabled: row.enabled === 1,
    priority: row.priority,
    weight: row.weight,
    fastEnabled: metadata.fast_service_tier === true,
    upstreamTransport: codexUpstreamTransportFromMetadata(metadata),
    useGlobalProxy: metadata.use_global_proxy === true,
    proxyPoolId: stringOrNull(metadata.proxy_pool_id),
    proxy: publicProxyFromEnvelope(row.proxy_envelope),
    expiresAt: row.expires_at,
    lastRefreshAt: row.last_refresh_at,
    lastUsedAt: row.last_used_at,
    cooldownUntil: stringOrNull(metadata.cooldown_until),
    lastError: stringOrNull(metadata.last_error),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata,
  };
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function codexUpstreamTransportFromMetadata(
  metadata: Record<string, unknown>,
): CodexUpstreamTransport {
  const value = metadata.upstream_transport;
  if (value === "http" || value === "websocket") {
    return value;
  }
  return "websocket";
}

function toCodexCredentialWithTokens(
  row: CodexCredentialRow,
): CodexCredentialWithTokens {
  return {
    ...toCodexCredentialRecord(row),
    proxy: credentialProxyFromEnvelope(row.proxy_envelope),
    tokens: decryptJson<CodexTokenBundle>(row.token_envelope),
  };
}

function encryptedProxyEnvelope(
  proxy: CredentialProxyConfig | null | undefined,
  existingProxy: CredentialProxyConfig | null | undefined,
) {
  const nextProxy = proxy === undefined ? existingProxy : proxy;
  return nextProxy ? encryptJson(nextProxy) : null;
}

function credentialProxyFromEnvelope(envelope: string | null) {
  if (!envelope) {
    return null;
  }
  try {
    return decryptJson<CredentialProxyConfig>(envelope);
  } catch {
    return null;
  }
}

function publicProxyFromEnvelope(
  envelope: string | null,
): PublicCredentialProxyConfig | null {
  const proxy = credentialProxyFromEnvelope(envelope);
  if (!proxy) {
    return null;
  }
  return {
    enabled: proxy.enabled,
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    passwordSet: Boolean(proxy.password),
  };
}
