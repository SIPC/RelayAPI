import "server-only";

import { HttpError } from "@/src/server/http/errors";
import {
  createProxyPoolItem,
  deleteProxyPoolItem,
  getProxyPoolItemWithSecret,
  listProxyPoolItems,
  markProxyPoolItemUsed,
  proxyPoolItemToCredentialProxy,
  updateProxyPoolItem,
  type SaveProxyPoolItemInput,
} from "@/src/server/repositories/proxyPool";
import { listCodexCredentials } from "@/src/server/repositories/codexCredentials";
import type {
  CredentialProxyConfig,
  CredentialProxyType,
} from "@/src/shared/types/entities";

export function listPublicProxyPoolItems() {
  return listProxyPoolItems();
}

export function createPublicProxyPoolItem(input: unknown) {
  const normalized = normalizeProxyPoolInput(input, null);
  const created = createProxyPoolItem(normalized);
  if (!created) {
    throw new HttpError(
      500,
      "proxy_pool_create_failed",
      "Proxy pool item could not be created",
    );
  }
  return created;
}

export function patchPublicProxyPoolItem(id: string, input: unknown) {
  const existing = getProxyPoolItemWithSecret(id);
  if (!existing) {
    throw notFoundError();
  }
  const normalized = normalizeProxyPoolInput(input, {
    name: existing.name,
    enabled: existing.enabled,
    type: existing.type,
    host: existing.host,
    port: existing.port,
    username: existing.username,
    notes: existing.notes,
  });
  const updated = updateProxyPoolItem(id, normalized);
  if (!updated) {
    throw notFoundError();
  }
  return updated;
}

export function removePublicProxyPoolItem(id: string) {
  const referencingCredentials = listCodexCredentials().filter(
    (credential) => credential.proxyPoolId === id,
  );
  if (referencingCredentials.length > 0) {
    throw new HttpError(
      409,
      "proxy_pool_in_use",
      `Cannot delete proxy because ${referencingCredentials.length} credential(s) still reference it`,
      {
        credentialIds: referencingCredentials.map(
          (credential) => credential.id,
        ),
      },
    );
  }
  if (!deleteProxyPoolItem(id)) {
    throw notFoundError();
  }
}

export function getProxyPoolCredentialProxy(
  id: string | null | undefined,
): CredentialProxyConfig | null {
  if (!id) {
    return null;
  }
  const item = getProxyPoolItemWithSecret(id);
  if (!item?.enabled) {
    return null;
  }
  markProxyPoolItemUsed(id);
  return proxyPoolItemToCredentialProxy(item);
}

function normalizeProxyPoolInput(
  input: unknown,
  existing: SaveProxyPoolItemInput | null,
): SaveProxyPoolItemInput {
  const object = objectValue(input);
  if (!object) {
    throw new HttpError(
      400,
      "invalid_proxy_pool_item",
      "Proxy pool item must be an object",
    );
  }

  const name = stringValue(object.name ?? existing?.name).trim();
  const type = normalizeProxyType(object.type, existing?.type || "socks5h");
  const host = stringValue(object.host ?? existing?.host).trim();
  const port = normalizePort(object.port ?? existing?.port);
  const username = stringValue(object.username ?? existing?.username).trim();
  const enabled =
    object.enabled !== undefined
      ? Boolean(object.enabled)
      : (existing?.enabled ?? true);
  const notes = stringValue(object.notes ?? existing?.notes).trim();

  if (!name) {
    throw new HttpError(400, "invalid_proxy_name", "Proxy name is required");
  }
  assertProxyEndpoint({ type, host, port });

  return {
    name,
    enabled,
    type,
    host,
    port,
    username,
    ...(Object.hasOwn(object, "password")
      ? { password: stringValue(object.password) }
      : {}),
    notes,
  };
}

function normalizeProxyType(
  value: unknown,
  fallback: CredentialProxyType,
): CredentialProxyType {
  if (value === "socks5" || value === "socks5h") {
    return value;
  }
  return fallback;
}

function normalizePort(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new HttpError(
      400,
      "invalid_proxy_port",
      "Proxy port must be an integer between 1 and 65535",
    );
  }
  return parsed;
}

function assertProxyEndpoint(input: {
  type: CredentialProxyType;
  host: string;
  port: number;
}) {
  if (!input.host) {
    throw new HttpError(400, "invalid_proxy_host", "Proxy host is required");
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new HttpError(
      400,
      "invalid_proxy_port",
      "Proxy port must be an integer between 1 and 65535",
    );
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function notFoundError() {
  return new HttpError(
    404,
    "proxy_pool_not_found",
    "Proxy pool item not found",
  );
}
