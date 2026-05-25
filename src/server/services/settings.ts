import "server-only";

import { serverConfig } from "@/src/server/config/env";
import { HttpError } from "@/src/server/http/errors";
import {
  deleteSettingValue,
  getSettingUpdatedAt,
  getSettingValue,
  upsertSettingValue,
} from "@/src/server/repositories/settings";
import { decryptJson, encryptJson } from "@/src/server/services/crypto";
import type {
  CredentialProxyConfig,
  CredentialProxyType,
  GlobalSettingsRecord,
  PublicCredentialProxyConfig,
} from "@/src/shared/types/entities";

const GLOBAL_PROXY_SETTING_KEY = "global_proxy";
const CODEX_USER_AGENT_SETTING_KEY = "codex_user_agent";
const FULL_REQUEST_LOGGING_SETTING_KEY = "full_request_logging";
const CODEX_AUTO_DISABLE_REFRESH_EXHAUSTED_SETTING_KEY =
  "codex_auto_disable_refresh_exhausted";
const REQUEST_LOG_RETENTION_DAYS_SETTING_KEY = "request_log_retention_days";
const REQUEST_LOG_DETAIL_RETENTION_DAYS_SETTING_KEY =
  "request_log_detail_retention_days";

const DEFAULT_REQUEST_LOG_RETENTION_DAYS = 90;
const DEFAULT_REQUEST_LOG_DETAIL_RETENTION_DAYS = 14;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;
const MAX_USER_AGENT_LENGTH = 2048;

export function getGlobalProxySetting(): CredentialProxyConfig | null {
  const stored = readStoredGlobalProxy();
  return stored || serverConfig.globalProxy;
}

export function getGlobalUserAgentSetting() {
  return readStoredUserAgent() || serverConfig.userAgent;
}

export function getEffectiveCodexUserAgent(input?: {
  userAgent?: string | null;
}) {
  return (
    normalizeStoredUserAgent(input?.userAgent) || getGlobalUserAgentSetting()
  );
}

export function getPublicGlobalSettings(): GlobalSettingsRecord {
  const stored = readStoredGlobalProxy();
  const storedUserAgent = readStoredUserAgent();
  const fullRequestLoggingEnabled = getFullRequestLoggingSetting();
  const codexAutoDisableRefreshExhausted =
    getCodexAutoDisableRefreshExhaustedSetting();
  const retentionSettings = getRequestLogRetentionSettings();
  const updatedAt = latestUpdatedAt(
    getSettingUpdatedAt(GLOBAL_PROXY_SETTING_KEY),
    getSettingUpdatedAt(CODEX_USER_AGENT_SETTING_KEY),
    getSettingUpdatedAt(FULL_REQUEST_LOGGING_SETTING_KEY),
    getSettingUpdatedAt(CODEX_AUTO_DISABLE_REFRESH_EXHAUSTED_SETTING_KEY),
    getSettingUpdatedAt(REQUEST_LOG_RETENTION_DAYS_SETTING_KEY),
    getSettingUpdatedAt(REQUEST_LOG_DETAIL_RETENTION_DAYS_SETTING_KEY),
  );
  if (stored) {
    return {
      proxy: publicProxy(stored),
      proxySource: "database",
      userAgent: storedUserAgent || serverConfig.userAgent,
      userAgentSource: storedUserAgent
        ? "database"
        : serverConfig.userAgentSource,
      fullRequestLoggingEnabled,
      codexAutoDisableRefreshExhausted,
      ...retentionSettings,
      updatedAt,
    };
  }
  if (serverConfig.globalProxy) {
    return {
      proxy: publicProxy(serverConfig.globalProxy),
      proxySource: "environment",
      userAgent: storedUserAgent || serverConfig.userAgent,
      userAgentSource: storedUserAgent
        ? "database"
        : serverConfig.userAgentSource,
      fullRequestLoggingEnabled,
      codexAutoDisableRefreshExhausted,
      ...retentionSettings,
      updatedAt,
    };
  }
  return {
    proxy: null,
    proxySource: "none",
    userAgent: storedUserAgent || serverConfig.userAgent,
    userAgentSource: storedUserAgent
      ? "database"
      : serverConfig.userAgentSource,
    fullRequestLoggingEnabled,
    codexAutoDisableRefreshExhausted,
    ...retentionSettings,
    updatedAt,
  };
}

export function patchGlobalSettings(input: {
  proxy?: unknown;
  userAgent?: unknown;
  fullRequestLoggingEnabled?: unknown;
  codexAutoDisableRefreshExhausted?: unknown;
  requestLogRetentionDays?: unknown;
  requestLogDetailRetentionDays?: unknown;
}) {
  if (Object.hasOwn(input, "proxy")) {
    const proxy = normalizeProxyInput(input.proxy, readStoredGlobalProxy());
    if (proxy) {
      upsertSettingValue(GLOBAL_PROXY_SETTING_KEY, encryptJson(proxy));
    } else {
      deleteSettingValue(GLOBAL_PROXY_SETTING_KEY);
    }
  }
  if (Object.hasOwn(input, "userAgent")) {
    const userAgent = normalizeCodexUserAgentInput(input.userAgent);
    if (userAgent) {
      upsertSettingValue(CODEX_USER_AGENT_SETTING_KEY, userAgent);
    } else {
      deleteSettingValue(CODEX_USER_AGENT_SETTING_KEY);
    }
  }
  if (Object.hasOwn(input, "fullRequestLoggingEnabled")) {
    upsertSettingValue(
      FULL_REQUEST_LOGGING_SETTING_KEY,
      input.fullRequestLoggingEnabled ? "1" : "0",
    );
  }
  if (Object.hasOwn(input, "codexAutoDisableRefreshExhausted")) {
    upsertSettingValue(
      CODEX_AUTO_DISABLE_REFRESH_EXHAUSTED_SETTING_KEY,
      input.codexAutoDisableRefreshExhausted ? "1" : "0",
    );
  }
  if (Object.hasOwn(input, "requestLogRetentionDays")) {
    upsertSettingValue(
      REQUEST_LOG_RETENTION_DAYS_SETTING_KEY,
      String(normalizeRetentionDays(input.requestLogRetentionDays)),
    );
  }
  if (Object.hasOwn(input, "requestLogDetailRetentionDays")) {
    upsertSettingValue(
      REQUEST_LOG_DETAIL_RETENTION_DAYS_SETTING_KEY,
      String(normalizeRetentionDays(input.requestLogDetailRetentionDays)),
    );
  }
  return getPublicGlobalSettings();
}

export function getFullRequestLoggingSetting() {
  return getSettingValue(FULL_REQUEST_LOGGING_SETTING_KEY) === "1";
}

export function getCodexAutoDisableRefreshExhaustedSetting() {
  return (
    getSettingValue(CODEX_AUTO_DISABLE_REFRESH_EXHAUSTED_SETTING_KEY) === "1"
  );
}

export function getRequestLogRetentionSettings() {
  return {
    requestLogRetentionDays: readRetentionDays(
      REQUEST_LOG_RETENTION_DAYS_SETTING_KEY,
      DEFAULT_REQUEST_LOG_RETENTION_DAYS,
    ),
    requestLogDetailRetentionDays: readRetentionDays(
      REQUEST_LOG_DETAIL_RETENTION_DAYS_SETTING_KEY,
      DEFAULT_REQUEST_LOG_DETAIL_RETENTION_DAYS,
    ),
  };
}

function readRetentionDays(key: string, fallback: number) {
  const value = getSettingValue(key);
  if (value === undefined) {
    return fallback;
  }
  return normalizeRetentionDays(value);
}

function normalizeRetentionDays(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(
      400,
      "invalid_log_retention_days",
      "Log retention days must be a finite number",
    );
  }
  const days = Math.floor(parsed);
  if (days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
    throw new HttpError(
      400,
      "invalid_log_retention_days",
      `Log retention days must be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`,
    );
  }
  return days;
}

function readStoredUserAgent() {
  return normalizeStoredUserAgent(
    getSettingValue(CODEX_USER_AGENT_SETTING_KEY),
  );
}

function normalizeStoredUserAgent(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim();
  if (normalized.length > MAX_USER_AGENT_LENGTH) {
    return "";
  }
  return /[^\t\x20-\x7e]/.test(normalized) ? "" : normalized;
}

export function normalizeCodexUserAgentInput(input: unknown) {
  if (input === null || input === false) {
    return null;
  }
  if (typeof input !== "string") {
    throw new HttpError(
      400,
      "invalid_codex_user_agent",
      "Codex User-Agent must be a string or null",
    );
  }
  const value = input.trim();
  if (!value) {
    return null;
  }
  if (value.length > MAX_USER_AGENT_LENGTH) {
    throw new HttpError(
      400,
      "invalid_codex_user_agent",
      `Codex User-Agent must be ${MAX_USER_AGENT_LENGTH} characters or fewer`,
    );
  }
  if (/[^\t\x20-\x7e]/.test(value)) {
    throw new HttpError(
      400,
      "invalid_codex_user_agent",
      "Codex User-Agent must not contain control characters",
    );
  }
  return value;
}

function readStoredGlobalProxy() {
  const value = getSettingValue(GLOBAL_PROXY_SETTING_KEY);
  if (!value) {
    return null;
  }
  try {
    return decryptJson<CredentialProxyConfig>(value);
  } catch {
    return null;
  }
}

function normalizeProxyInput(
  input: unknown,
  existingProxy: CredentialProxyConfig | null,
): CredentialProxyConfig | null {
  if (input === null || input === false) {
    return null;
  }
  if (typeof input === "string") {
    return parseProxyUrl(input, existingProxy?.enabled ?? true);
  }
  const object = objectValue(input);
  if (!object) {
    throw new HttpError(
      400,
      "invalid_global_proxy",
      "Global proxy must be a SOCKS5 URL, object, or null",
    );
  }

  const url = stringValue(object.url);
  if (url) {
    const parsed = parseProxyUrl(url, existingProxy?.enabled ?? true);
    return {
      ...parsed,
      enabled:
        object.enabled !== undefined ? Boolean(object.enabled) : parsed.enabled,
    };
  }

  const type = normalizeProxyType(
    object.type,
    existingProxy?.type || "socks5h",
  );
  const host = stringValue(object.host) || existingProxy?.host || "";
  const port = normalizePort(object.port ?? existingProxy?.port);
  const username =
    object.username !== undefined
      ? stringValue(object.username)
      : existingProxy?.username || "";
  const password =
    object.password !== undefined
      ? stringValue(object.password)
      : existingProxy?.password || "";
  const enabled =
    object.enabled !== undefined
      ? Boolean(object.enabled)
      : (existingProxy?.enabled ?? true);

  assertProxyEndpoint({ host, port });
  return { enabled, type, host, port, username, password };
}

function parseProxyUrl(input: string, enabled: boolean): CredentialProxyConfig {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new HttpError(400, "invalid_global_proxy_url", "Invalid proxy URL");
  }
  const type = normalizeProxyType(parsed.protocol.replace(/:$/, ""), "socks5h");
  const host = parsed.hostname;
  const port = normalizePort(parsed.port);
  const username = decodeURIComponent(parsed.username || "");
  const password = decodeURIComponent(parsed.password || "");
  assertProxyEndpoint({ host, port });
  return { enabled, type, host, port, username, password };
}

function normalizeProxyType(
  value: unknown,
  fallback: CredentialProxyType,
): CredentialProxyType {
  const type = stringValue(value).toLowerCase();
  if (type === "socks5" || type === "socks5h") {
    return type;
  }
  if (!type) {
    return fallback;
  }
  throw new HttpError(
    400,
    "unsupported_global_proxy_type",
    "Only socks5 and socks5h global proxies are supported",
  );
}

function normalizePort(value: unknown) {
  const port =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value || ""), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(
      400,
      "invalid_global_proxy_port",
      "Global proxy port must be between 1 and 65535",
    );
  }
  return port;
}

function assertProxyEndpoint(input: { host: string; port: number }) {
  if (!input.host.trim()) {
    throw new HttpError(
      400,
      "missing_global_proxy_host",
      "Global proxy host is required",
    );
  }
}

function publicProxy(
  proxy: CredentialProxyConfig,
): PublicCredentialProxyConfig {
  return {
    enabled: proxy.enabled,
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    passwordSet: Boolean(proxy.password),
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function latestUpdatedAt(...values: Array<string | null>) {
  return values.filter(Boolean).sort().at(-1) || null;
}
