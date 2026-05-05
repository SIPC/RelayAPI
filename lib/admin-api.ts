import type {
  AdminOverviewStats,
  ChannelRecord,
  CreatedApiKey,
  PublicApiKey,
  CodexCredentialRecord,
  JsonValue,
} from "@/src/shared/types/entities";

export type AdminListResponse<T> = {
  object: "list";
  data: T[];
};

export type AdminDeleteResponse = {
  id: string;
  deleted: true;
};

export type AdminApiErrorBody = {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
  message?: string;
};

export class AdminApiError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
  }) {
    super(input.message);
    this.name = "AdminApiError";
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
  }
}

export type AdminDashboardRequestLogRow = {
  id: string;
  started_at: string;
  method: string;
  path: string;
  request_type: string;
  stream: number;
  model: string;
  status_code: number;
  latency_ms: number;
  api_key_prefix: string | null;
  api_key_name: string | null;
  channel_name: string | null;
  credential_email: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  error_code: string | null;
};

export type ApiKeyPayload = {
  name?: string;
  scopes?: string[];
  modelAllowlist?: string[];
  channelAllowlist?: string[];
  enabled?: boolean;
  tokenLimitDaily?: number | null;
  rateLimitPerMinute?: number | null;
  expiresAt?: string | null;
};

export type ChannelPayload = {
  name?: string;
  baseUrl?: string;
  credentialId?: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  modelAllowlist?: string[];
  status?: ChannelRecord["status"];
  healthScore?: number;
  cooldownUntil?: string | null;
};

export type OAuthStartResponse = {
  state: string;
  redirectUri: string;
  authUrl: string;
};

export type CodexQuotaStatus =
  | "unknown"
  | "exhausted"
  | "low"
  | "medium"
  | "high"
  | "full"
  | "not_cached";

export type CodexQuotaWindow = {
  id: string;
  label: string;
  used_percent: number | null;
  remaining_percent: number | null;
  reset_label: string;
  exhausted: boolean;
};

export type CodexQuotaReport = {
  provider: "codex";
  credential_id: string;
  account_id: string;
  email: string;
  plan_type: string;
  status: CodexQuotaStatus;
  windows: CodexQuotaWindow[];
  additional_windows: CodexQuotaWindow[];
  retrieved_at: string;
  cached: boolean;
  cache_state: "cached" | "fresh" | "missing";
  message?: string;
  raw?: unknown;
};

export type AdminDashboardSnapshot = {
  apiKeys: PublicApiKey[];
  channels: ChannelRecord[];
  credentials: CodexCredentialRecord[];
  requestLogs: AdminDashboardRequestLogRow[];
  overviewStats: AdminOverviewStats;
  generatedAt: number;
};

export const WEB_AUTH_EXPIRED_EVENT = "relayapi:web-auth-expired";

let webAuthExpiredNotified = false;

type RequestJson = JsonValue | Record<string, unknown> | unknown[];

type AdminRequestInit = Omit<RequestInit, "body"> & {
  body?: RequestJson;
};

export async function adminRequest<T>(
  url: string,
  init: AdminRequestInit = {},
): Promise<T> {
  const { body, headers, ...rest } = init;
  const response = await fetch(url, {
    ...rest,
    credentials: rest.credentials ?? "same-origin",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const parsed = await parseResponseBody(response);
  if (!response.ok) {
    const error = toAdminApiError(response, parsed);
    notifyWebAuthExpired(error);
    throw error;
  }
  return parsed as T;
}

export async function listApiKeys() {
  const result = await adminRequest<AdminListResponse<PublicApiKey>>(
    "/api/admin/api-keys",
  );
  return result.data;
}

export function createApiKey(payload: ApiKeyPayload = {}) {
  return adminRequest<CreatedApiKey>("/api/admin/api-keys", {
    method: "POST",
    body: payload,
  });
}

export function updateApiKey(id: string, payload: ApiKeyPayload) {
  return adminRequest<PublicApiKey>(`/api/admin/api-keys/${encodePath(id)}`, {
    method: "PATCH",
    body: payload,
  });
}

export function deleteApiKey(id: string) {
  return adminRequest<AdminDeleteResponse>(
    `/api/admin/api-keys/${encodePath(id)}`,
    { method: "DELETE" },
  );
}

export function listChannels() {
  return adminRequest<ChannelRecord[]>("/api/admin/channels");
}

export function createChannel(payload: ChannelPayload) {
  return adminRequest<ChannelRecord>("/api/admin/channels", {
    method: "POST",
    body: payload,
  });
}

export function updateChannel(id: string, payload: ChannelPayload) {
  return adminRequest<ChannelRecord>(`/api/admin/channels/${encodePath(id)}`, {
    method: "PATCH",
    body: payload,
  });
}

export function deleteChannel(id: string) {
  return adminRequest<AdminDeleteResponse>(
    `/api/admin/channels/${encodePath(id)}`,
    { method: "DELETE" },
  );
}

export function listCredentials() {
  return adminRequest<CodexCredentialRecord[]>("/api/admin/codex/credentials");
}

export function importCredentialJson(
  credential: Record<string, unknown>,
  filename?: string,
) {
  return adminRequest<CodexCredentialRecord>(
    "/api/admin/codex/credentials/import",
    {
      method: "POST",
      body: { credential, filename },
    },
  );
}

export function deleteCredential(id: string) {
  return adminRequest<AdminDeleteResponse>(
    `/api/admin/codex/credentials/${encodePath(id)}`,
    { method: "DELETE" },
  );
}

export function refreshCredential(id: string) {
  return adminRequest<CodexCredentialRecord>(
    `/api/admin/codex/credentials/${encodePath(id)}/refresh`,
    { method: "POST" },
  );
}

export function getCredentialQuota(
  id: string,
  options: { refresh?: boolean; raw?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (options.refresh) {
    params.set("refresh", "1");
  }
  if (options.raw) {
    params.set("raw", "1");
  }
  const suffix = params.size ? `?${params.toString()}` : "";
  return adminRequest<CodexQuotaReport>(
    `/api/admin/codex/credentials/${encodePath(id)}/quota${suffix}`,
  );
}

export function startCodexOAuth() {
  return adminRequest<OAuthStartResponse>(
    "/api/admin/codex/credentials/oauth/start",
    { method: "POST" },
  );
}

export function finishCodexOAuth(callbackUrl: string) {
  return adminRequest<CodexCredentialRecord>(
    "/api/admin/codex/credentials/oauth/callback",
    {
      method: "POST",
      body: { callbackUrl },
    },
  );
}

export function logoutWebSession() {
  return adminRequest<{ authenticated: false }>("/api/auth/web-logout", {
    method: "POST",
  });
}

export function getOverview() {
  return adminRequest<AdminOverviewStats>("/api/admin/overview");
}

export async function getRequestLogs(limit = 100) {
  const params = new URLSearchParams({ limit: String(limit) });
  const result = await adminRequest<
    AdminListResponse<AdminDashboardRequestLogRow>
  >(`/api/admin/request-logs?${params.toString()}`);
  return result.data;
}

export async function getDashboardSnapshot(
  options: { requestLogLimit?: number } = {},
): Promise<AdminDashboardSnapshot> {
  const requestLogLimit = options.requestLogLimit ?? 100;
  const [apiKeys, channels, credentials, requestLogs, overviewStats] =
    await Promise.all([
      listApiKeys(),
      listChannels(),
      listCredentials(),
      getRequestLogs(requestLogLimit),
      getOverview(),
    ]);

  return {
    apiKeys,
    channels,
    credentials,
    requestLogs,
    overviewStats,
    generatedAt: Date.now(),
  };
}

export function adminErrorMessage(error: unknown) {
  if (isWebAuthError(error)) {
    return "管理台会话已过期，请重新登录";
  }
  if (error instanceof AdminApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isWebAuthError(error: unknown) {
  return error instanceof AdminApiError && error.code === "web_auth_required";
}

function notifyWebAuthExpired(error: unknown) {
  if (
    !isWebAuthError(error) ||
    webAuthExpiredNotified ||
    typeof window === "undefined"
  ) {
    return;
  }

  webAuthExpiredNotified = true;
  window.dispatchEvent(
    new CustomEvent(WEB_AUTH_EXPIRED_EVENT, {
      detail: { message: adminErrorMessage(error) },
    }),
  );
}

async function parseResponseBody(response: Response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (response.ok) {
      return text;
    }
    return { message: text } satisfies AdminApiErrorBody;
  }
}

function toAdminApiError(response: Response, parsed: unknown) {
  const body = isObject(parsed) ? (parsed as AdminApiErrorBody) : null;
  const error = isObject(body?.error) ? body.error : null;
  const fallbackCode =
    response.status === 401
      ? "web_auth_required"
      : response.status || "request_failed";

  return new AdminApiError({
    status: response.status,
    code: String(error?.code || fallbackCode),
    message: String(
      error?.message ||
        body?.message ||
        response.statusText ||
        "Request failed",
    ),
    details: error?.details,
  });
}

function encodePath(value: string) {
  return encodeURIComponent(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
