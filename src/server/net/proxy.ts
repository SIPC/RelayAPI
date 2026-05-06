import "server-only";

import nodeFetch, {
  type RequestInit as NodeFetchRequestInit,
} from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { CredentialProxyConfig } from "@/src/shared/types/entities";

type CachedProxyAgent = {
  agent: SocksProxyAgent;
  lastUsedAt: number;
};

const proxyAgents = new Map<string, CachedProxyAgent>();
const PROXY_AGENT_IDLE_TTL_MS = 10 * 60 * 1000;
const PROXY_AGENT_RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export async function proxiedFetch(
  url: string,
  init: RequestInit = {},
  proxy: CredentialProxyConfig | null | undefined,
): Promise<Response> {
  if (!proxy?.enabled) {
    return fetch(url, init);
  }

  const proxyKey = proxyUrl(proxy);
  cleanupIdleProxyAgents();

  try {
    return await doProxyFetch(url, init, proxyKey);
  } catch (error) {
    if (!isRetryableProxyError(error)) {
      throw wrapProxyError(proxy, error);
    }

    destroyProxyAgent(proxyKey);
    try {
      return await doProxyFetch(url, init, proxyKey);
    } catch (retryError) {
      throw wrapProxyError(proxy, retryError);
    }
  }
}

async function doProxyFetch(
  url: string,
  init: RequestInit,
  proxyKey: string,
): Promise<Response> {
  const agent = getProxyAgent(proxyKey);
  const response = await nodeFetch(url, {
    method: init.method,
    headers: init.headers as NodeFetchRequestInit["headers"],
    body: init.body as NodeFetchRequestInit["body"],
    signal: init.signal as NodeFetchRequestInit["signal"],
    redirect: init.redirect as NodeFetchRequestInit["redirect"],
    agent,
  });

  const headers = new Headers();
  response.headers.forEach((value, name) => headers.append(name, value));
  const body = response.body as BodyInit | null;

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getProxyAgent(proxyKey: string) {
  const existing = proxyAgents.get(proxyKey);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing.agent;
  }

  const agent = new SocksProxyAgent(proxyKey, {
    keepAlive: true,
    keepAliveMsecs: 15_000,
    maxSockets: 64,
    maxFreeSockets: 8,
    timeout: 120_000,
  });
  proxyAgents.set(proxyKey, { agent, lastUsedAt: Date.now() });
  return agent;
}

function destroyProxyAgent(proxyKey: string) {
  const cached = proxyAgents.get(proxyKey);
  if (!cached) {
    return;
  }
  proxyAgents.delete(proxyKey);
  cached.agent.destroy();
}

function cleanupIdleProxyAgents() {
  const now = Date.now();
  for (const [proxyKey, cached] of proxyAgents.entries()) {
    if (now - cached.lastUsedAt < PROXY_AGENT_IDLE_TTL_MS) {
      continue;
    }
    proxyAgents.delete(proxyKey);
    cached.agent.destroy();
  }
}

function isRetryableProxyError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const current = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };

  const code = String(current.code || "").toUpperCase();
  if (code && PROXY_AGENT_RETRYABLE_ERROR_CODES.has(code)) {
    return true;
  }

  const message = String(current.message || "").toLowerCase();
  if (
    message.includes("socket") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("network")
  ) {
    return true;
  }

  if (current.cause && current.cause !== error) {
    return isRetryableProxyError(current.cause);
  }

  return false;
}

function proxyUrl(proxy: CredentialProxyConfig) {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : "";
  return `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

function publicProxyLabel(proxy: CredentialProxyConfig) {
  return `${proxy.type}://${proxy.host}:${proxy.port}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "request failed";
}

function wrapProxyError(proxy: CredentialProxyConfig, error: unknown) {
  return new Error(
    `Proxy request failed via ${publicProxyLabel(proxy)}: ${errorMessage(error)}`,
  );
}
