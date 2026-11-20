import "server-only";

import { HttpError } from "@/src/server/http/errors";
import { getMainDb } from "@/src/server/db/sqlite";
import { detachCredentialFromChannels } from "@/src/server/repositories/channels";
import {
  deleteUpstreamCredential,
  getUpstreamCredentialWithSecret,
  insertUpstreamCredential,
  listUpstreamCredentials,
  updateUpstreamCredential,
  type UpdateUpstreamCredentialInput,
} from "@/src/server/repositories/upstreamCredentials";
import { getProxyPoolItemById } from "@/src/server/repositories/proxyPool";
import { credentialUsageHealth } from "@/src/server/repositories/logs";
import { randomId } from "@/src/server/services/crypto";
import { getProxyPoolCredentialProxy } from "@/src/server/services/proxyPool";
import { getGlobalProxySetting } from "@/src/server/services/settings";
import type { ApiUpstreamProvider, CredentialProxyConfig } from "@/src/shared/types/entities";

export function listPublicUpstreamCredentials() {
  const credentials = listUpstreamCredentials();
  const health = credentialUsageHealth(credentials.map((credential) => credential.id));
  return credentials.map((credential) => ({ ...credential, usageHealth: health[credential.id] }));
}

export function createUpstreamCredential(input: unknown) {
  const body = objectInput(input);
  const provider = normalizeProvider(body.provider);
  const apiKey = normalizeKey(body.apiKey);
  if (!apiKey) throw new HttpError(400, "missing_upstream_api_key", "Upstream API key is required");
  return insertUpstreamCredential({
    id: randomId("upstream"), provider,
    name: stringValue(body.name) || (provider === "openai" ? "OpenAI API key" : "Anthropic API key"),
    apiKey, ...routingPatch(body, null),
  });
}

export function patchUpstreamCredential(id: string, input: unknown) {
  const body = objectInput(input);
  const existing = getUpstreamCredentialWithSecret(id);
  if (!existing) throw notFound();
  if (body.provider !== undefined && body.provider !== existing.provider) {
    throw new HttpError(400, "upstream_provider_immutable", "Upstream provider cannot be changed after creation");
  }
  const updated = updateUpstreamCredential(id, {
    ...routingPatch(body, existing.proxy),
    ...(body.name !== undefined ? { name: stringValue(body.name) || existing.name } : {}),
    ...(body.apiKey !== undefined ? { apiKey: normalizeKey(body.apiKey) } : {}),
  });
  if (!updated) throw notFound();
  return updated;
}

export function removeUpstreamCredential(id: string) {
  const existing = getUpstreamCredentialWithSecret(id);
  if (!existing) throw notFound();
  const db = getMainDb();
  db.exec("BEGIN");
  try {
    detachCredentialFromChannels(id, existing.provider);
    if (!deleteUpstreamCredential(id)) throw notFound();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function resolveUpstreamCredentialProxy(input: {
  proxy: CredentialProxyConfig | null;
  proxyPoolId: string | null;
  useGlobalProxy: boolean;
}): CredentialProxyConfig | null {
  if (input.proxy?.enabled) return input.proxy;
  const pooled = getProxyPoolCredentialProxy(input.proxyPoolId);
  if (pooled?.enabled) return pooled;
  return input.useGlobalProxy ? getGlobalProxySetting() : null;
}

function routingPatch(body: Record<string, unknown>, proxy: CredentialProxyConfig | null): UpdateUpstreamCredentialInput {
  return {
    ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
    ...(body.priority !== undefined ? { priority: integer(body.priority, 100) } : {}),
    ...(body.weight !== undefined ? { weight: Math.max(1, integer(body.weight, 1)) } : {}),
    ...(body.useGlobalProxy !== undefined ? { useGlobalProxy: Boolean(body.useGlobalProxy) } : {}),
    ...(Object.hasOwn(body, "proxyPoolId") ? { proxyPoolId: normalizePoolId(body.proxyPoolId) } : {}),
    ...(Object.hasOwn(body, "proxy") ? { proxy: normalizeProxy(body.proxy, proxy) } : {}),
  };
}

function normalizeProvider(input: unknown): ApiUpstreamProvider {
  if (input === "openai" || input === "anthropic") return input;
  throw new HttpError(400, "invalid_upstream_provider", "Upstream provider must be openai or anthropic");
}

function normalizeKey(input: unknown) {
  if (typeof input !== "string" || /[\r\n]/.test(input.trim())) {
    throw new HttpError(400, "invalid_upstream_api_key", "Upstream API key must be a single-line string");
  }
  return input.trim();
}

function normalizePoolId(input: unknown) {
  const id = stringValue(input);
  if (!id) return null;
  if (!getProxyPoolItemById(id)) throw new HttpError(400, "proxy_pool_not_found", "Selected proxy pool item does not exist");
  return id;
}

function normalizeProxy(input: unknown, existing: CredentialProxyConfig | null): CredentialProxyConfig | null {
  if (input === null || input === false) return null;
  let body: Record<string, unknown>;
  if (typeof input === "string") body = { url: input };
  else body = objectInput(input);
  const url = stringValue(body.url);
  if (url) {
    let parsed: URL;
    try { parsed = new URL(url); } catch {
      throw new HttpError(400, "invalid_credential_proxy_url", "Invalid proxy URL");
    }
    try {
      body = { ...body, type: parsed.protocol.replace(/:$/, ""), host: parsed.hostname,
        port: parsed.port, username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) };
    } catch {
      throw new HttpError(400, "invalid_credential_proxy_url", "Invalid proxy URL encoding");
    }
  }
  const type = stringValue(body.type).toLowerCase() || existing?.type || "socks5h";
  if (type !== "socks5" && type !== "socks5h") {
    throw new HttpError(400, "unsupported_credential_proxy_type", "Only socks5 and socks5h credential proxies are supported");
  }
  const host = stringValue(body.host) || existing?.host || "";
  const port = Number(body.port ?? existing?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(400, "invalid_credential_proxy_port", "Credential proxy port must be between 1 and 65535");
  }
  if (!host) throw new HttpError(400, "missing_credential_proxy_host", "Credential proxy host is required");
  return {
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : (existing?.enabled ?? true),
    type, host, port,
    username: body.username !== undefined ? stringValue(body.username) : existing?.username || "",
    password: body.password !== undefined && typeof body.password === "string" ? body.password : existing?.password || "",
  };
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "invalid_upstream_credential", "Credential input must be an object");
  }
  return input as Record<string, unknown>;
}

function stringValue(input: unknown) { return typeof input === "string" ? input.trim() : ""; }
function integer(input: unknown, fallback: number) {
  const number = Number(input);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}
function notFound() { return new HttpError(404, "upstream_credential_not_found", "Upstream credential not found"); }
