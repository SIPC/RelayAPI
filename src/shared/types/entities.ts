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

export interface GlobalSettingsRecord {
  proxy: PublicCredentialProxyConfig | null;
  proxySource: "database" | "environment" | "none";
  fullRequestLoggingEnabled: boolean;
  requestLogRetentionDays: number | null;
  requestLogDetailRetentionDays: number | null;
  updatedAt: string | null;
}

export interface ChannelRecord {
  id: string;
  name: string;
  provider: "codex";
  baseUrl: string;
  credentialId: string;
  credentialIds: string[];
  enabled: boolean;
  priority: number;
  weight: number;
  modelAllowlist: string[];
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
  credential: CodexCredentialWithTokens;
}

export interface UsageSnapshot {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
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
