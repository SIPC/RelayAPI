export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ChannelStatus =
  | "healthy"
  | "degraded"
  | "cooling_down"
  | "disabled";

export type ChannelProvider = "codex" | "claude" | "antigravity" | "openai" | "anthropic";

export type ApiUpstreamProvider = "openai" | "anthropic";

export type UpstreamOperation =
  | "chat"
  | "responses"
  | "messages"
  | "count_tokens"
  | "images_generations"
  | "images_edits";

export type CodexAccountUsageStatus = "normal" | "warning" | "error" | "unused";

export interface CodexAccountUsageHealth {
  status: CodexAccountUsageStatus;
  score: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
  lastUsedAt: string | null;
  lastStatusCode: number | null;
  lastErrorCode: string | null;
  windowSize: number;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  keyHash: string;
  scopes: string[];
  modelAllowlist: string[];
  channelAllowlist: string[];
  enabled: boolean;
  tokenLimitDaily: number | null;
  rateLimitPerMinute: number | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface PublicApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  modelAllowlist: string[];
  channelAllowlist: string[];
  enabled: boolean;
  tokenLimitDaily: number | null;
  rateLimitPerMinute: number | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface CreatedApiKey extends PublicApiKey {
  key: string;
}

export type CredentialProxyType = "socks5" | "socks5h";

export interface CredentialProxyConfig {
  enabled: boolean;
  type: CredentialProxyType;
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface PublicCredentialProxyConfig {
  enabled: boolean;
  type: CredentialProxyType;
  host: string;
  port: number;
  username: string;
  passwordSet?: boolean;
}

export interface ProxyPoolRecord {
  id: string;
  name: string;
  enabled: boolean;
  type: CredentialProxyType;
  host: string;
  port: number;
  username: string;
  passwordSet: boolean;
  notes: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface ProxyPoolRecordWithSecret extends Omit<
  ProxyPoolRecord,
  "passwordSet"
> {
  password: string;
}

export type CodexUpstreamTransport = "http" | "websocket";

export interface CodexTokenBundle {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expired: string;
  last_refresh: string;
}

export interface CodexCredentialRecord {
  id: string;
  provider: "codex";
  email: string;
  accountId: string;
  planType: string;
  enabled: boolean;
  priority: number;
  weight: number;
  fastEnabled: boolean;
  upstreamTransport: CodexUpstreamTransport;
  userAgent: string | null;
  useGlobalProxy: boolean;
  proxyPoolId: string | null;
  proxy: PublicCredentialProxyConfig | null;
  usageHealth?: CodexAccountUsageHealth;
  expiresAt: string | null;
  lastRefreshAt: string | null;
  lastUsedAt: string | null;
  cooldownUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export type CodexCredentialWithTokens = Omit<CodexCredentialRecord, "proxy"> & {
  proxy: CredentialProxyConfig | null;
  tokens: CodexTokenBundle;
};

export interface ClaudeTokenBundle {
  access_token: string;
  refresh_token: string;
  expired: string;
  last_refresh: string;
}

export interface ClaudeCredentialRecord {
  id: string;
  provider: "claude";
  email: string;
  accountId: string;
  enabled: boolean;
  priority: number;
  weight: number;
  userAgent: string | null;
  useGlobalProxy: boolean;
  proxyPoolId: string | null;
  proxy: PublicCredentialProxyConfig | null;
  usageHealth?: CodexAccountUsageHealth;
  expiresAt: string | null;
  lastRefreshAt: string | null;
  lastUsedAt: string | null;
  cooldownUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export type ClaudeCredentialWithTokens = Omit<
  ClaudeCredentialRecord,
  "proxy"
> & {
  proxy: CredentialProxyConfig | null;
  tokens: ClaudeTokenBundle;
};

export type AntigravityCredentialRecord = Omit<ClaudeCredentialRecord, "provider" | "userAgent"> & {
  provider: "antigravity";
  // Lower-case model IDs from fetchAvailableModels; null means the catalog is unknown.
  models: string[] | null;
  modelCooldowns: Record<string, { until: string; level: number }>;
};

export type AntigravityCredentialWithTokens = AntigravityCredentialRecord & {
  projectId: string;
  tokens: AntigravityTokenBundle;
  tokenEnvelope: string;
};

export type AntigravityTokenBundle = {
  access_token: string;
  refresh_token: string;
  expired: string;
  last_refresh: string;
};

export interface UpstreamCredentialRecord {
  id: string;
  provider: ApiUpstreamProvider;
  name: string;
  keyPrefix: string;
  keySet: boolean;
  enabled: boolean;
  priority: number;
  weight: number;
  useGlobalProxy: boolean;
  proxyPoolId: string | null;
  proxy: PublicCredentialProxyConfig | null;
  usageHealth?: CodexAccountUsageHealth;
  lastUsedAt: string | null;
  cooldownUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export type UpstreamCredentialWithSecret = Omit<
  UpstreamCredentialRecord,
  "proxy"
> & {
  proxy: CredentialProxyConfig | null;
  apiKey: string;
};

export type RoutableCredentialRecord =
  | CodexCredentialRecord
  | ClaudeCredentialRecord
  | AntigravityCredentialRecord
  | UpstreamCredentialRecord;

export type RoutableCredentialWithTokens =
  | CodexCredentialWithTokens
  | ClaudeCredentialWithTokens
  | AntigravityCredentialWithTokens
  | UpstreamCredentialWithSecret;

export interface GlobalSettingsRecord {
  proxy: PublicCredentialProxyConfig | null;
  proxySource: "database" | "environment" | "none";
  userAgent: string;
  userAgentSource: "database" | "environment" | "default";
  fullRequestLoggingEnabled: boolean;
  codexAutoDisableRefreshExhausted: boolean;
  credentialQuotaFloorPercent: number;
  requestLogRetentionDays: number | null;
  requestLogDetailRetentionDays: number | null;
  updatedAt: string | null;
}

export interface ChannelRecord {
  id: string;
  name: string;
  provider: ChannelProvider;
  baseUrl: string;
  credentialId: string;
  credentialIds: string[];
  enabled: boolean;
  priority: number;
  weight: number;
  quotaWeighted: boolean;
  modelAllowlist: string[];
  capabilities: UpstreamOperation[];
  status: ChannelStatus;
  healthScore: number;
  usageHealth?: CodexAccountUsageHealth;
  cooldownUntil: string | null;
  lastError: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RelayApiKeyContext {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  modelAllowlist: string[];
  channelAllowlist: string[];
  tokenLimitDaily: number | null;
}

export interface RelayRequestContext {
  apiKey: RelayApiKeyContext;
  model: string;
  requestType: string;
  stream: boolean;
  method: string;
  path: string;
}

export interface SelectedChannel {
  channel: ChannelRecord;
  credential: RoutableCredentialWithTokens;
}

export interface UsageSnapshot {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
}

export interface CredentialUsageWindow {
  id: string;
  label: string;
  since: string;
  until: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  streamCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
  avgLatencyMs: number;
  firstRequestAt: string | null;
  lastRequestAt: string | null;
}

export type ClaudeQuotaStatus =
  | "unknown"
  | "exhausted"
  | "low"
  | "medium"
  | "high"
  | "full"
  | "cooling_down"
  | "error";

export interface ClaudeQuotaWindow {
  id: string;
  label: string;
  limit: number | null;
  remaining: number | null;
  used: number | null;
  used_percent: number | null;
  remaining_percent: number | null;
  reset_label: string;
  reset_at: string | null;
  exhausted: boolean;
}

export interface ClaudeQuotaReport {
  provider: "claude";
  source: "anthropic_headers" | "oauth_usage" | "unavailable";
  cache_state: "fresh" | "stale" | "missing";
  next_attempt_at: string | null;
  credential_id: string;
  account_id: string;
  email: string;
  status: ClaudeQuotaStatus;
  windows: ClaudeQuotaWindow[];
  local_windows: CredentialUsageWindow[];
  retrieved_at: string;
  cooldown_until: string | null;
  last_error: string | null;
  message: string;
  quota_floor: CredentialQuotaFloorState;
}

// Routing skips a credential whose fresh remaining weekly quota is at or below the
// floor; the 5h window is not part of it. skipped_scopes lists model families
// (e.g. "opus") skipped only for matching models; triggered_by names the windows.
export interface CredentialQuotaFloorState {
  percent: number;
  lowest_remaining_percent: number | null;
  skipped: boolean;
  skipped_scopes: string[];
  triggered_by: string[];
}

// Antigravity quota mirrors retrieveUserQuotaSummary: groups of models sharing weekly and 5-hour buckets.
export interface AntigravityQuotaBucket {
  id: string;
  label: string;
  window: string;
  remaining_percent: number | null;
  reset_at: string | null;
}

export interface AntigravityQuotaGroup {
  label: string;
  description: string;
  buckets: AntigravityQuotaBucket[];
}

export interface AntigravityQuotaReport {
  provider: "antigravity";
  credential_id: string;
  status: ClaudeQuotaStatus;
  groups: AntigravityQuotaGroup[];
  retrieved_at: string;
  message: string;
}

export interface UsageStatsRow {
  key: string;
  label: string;
  subLabel: string | null;
  requestCount: number;
  successCount: number;
  errorCount: number;
  streamCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgFirstTokenLatencyMs: number;
  p95FirstTokenLatencyMs: number;
  avgTokensPerRequest: number;
  tokensPerSecond: number;
  firstRequestAt: string | null;
  lastRequestAt: string | null;
}

export interface ApiKeyUsageStatsRow extends UsageStatsRow {
  apiKeyId: string | null;
  apiKeyPrefix: string | null;
  apiKeyName: string;
  enabled: boolean | null;
  tokenLimitDaily: number | null;
  todayTokens: number;
  tokenLimitUtilization: number | null;
}

export interface ApiKeyModelUsageStatsRow extends UsageStatsRow {
  apiKeyId: string | null;
  apiKeyPrefix: string | null;
  apiKeyName: string;
  model: string;
}

export interface DailyUsageStatsRow {
  date: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  streamCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgFirstTokenLatencyMs: number;
  p95FirstTokenLatencyMs: number;
  avgTokensPerRequest: number;
  tokensPerSecond: number;
}

export interface AdminOverviewTotals {
  requestCount: number;
  successCount: number;
  errorCount: number;
  streamCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgFirstTokenLatencyMs: number;
  p95FirstTokenLatencyMs: number;
  avgTokensPerRequest: number;
  tokensPerSecond: number;
  distinctApiKeyCount: number;
  distinctModelCount: number;
  distinctChannelCount: number;
  firstRequestAt: string | null;
  lastRequestAt: string | null;
}

export interface AdminOverviewStats {
  generatedAt: string;
  totals: AdminOverviewTotals;
  byApiKey: ApiKeyUsageStatsRow[];
  byApiKeyModel: ApiKeyModelUsageStatsRow[];
  byModel: UsageStatsRow[];
  byChannel: UsageStatsRow[];
  byCredential: UsageStatsRow[];
  byRequestType: UsageStatsRow[];
  byDay: DailyUsageStatsRow[];
}
