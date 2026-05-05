import "server-only";

import { getLogDb, getMainDb } from "@/src/server/db/sqlite";
import { jsonStringify, randomId } from "@/src/server/services/crypto";
import type {
  AdminOverviewStats,
  AdminOverviewTotals,
  ApiKeyModelUsageStatsRow,
  ApiKeyUsageStatsRow,
  CodexAccountUsageHealth,
  DailyUsageStatsRow,
  UsageSnapshot,
  UsageStatsRow,
} from "@/src/shared/types/entities";

export interface RequestLogInput {
  startedAt: string;
  completedAt?: string;
  method: string;
  path: string;
  requestType: string;
  stream: boolean;
  model?: string;
  statusCode: number;
  latencyMs: number;
  apiKeyId?: string | null;
  apiKeyPrefix?: string | null;
  apiKeyName?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  credentialId?: string | null;
  credentialEmail?: string | null;
  usage?: UsageSnapshot;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export function appendRequestLog(input: RequestLogInput) {
  const usage = input.usage || {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  const completedAt = input.completedAt || new Date().toISOString();
  getLogDb()
    .prepare(
      `INSERT INTO request_logs (
        id, started_at, completed_at, method, path, request_type, stream,
        model, status_code, latency_ms, api_key_id, api_key_prefix,
        api_key_name, channel_id, channel_name, credential_id, credential_email,
        prompt_tokens, completion_tokens, total_tokens, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomId("reqlog"),
      input.startedAt,
      completedAt,
      input.method,
      input.path,
      input.requestType,
      input.stream ? 1 : 0,
      input.model || "",
      input.statusCode,
      input.latencyMs,
      input.apiKeyId || null,
      input.apiKeyPrefix || null,
      input.apiKeyName || null,
      input.channelId || null,
      input.channelName || null,
      input.credentialId || null,
      input.credentialEmail || null,
      usage.promptTokens,
      usage.completionTokens,
      usage.totalTokens,
      input.errorCode || null,
      input.errorMessage || null,
    );

  if (usage.totalTokens > 0) {
    appendUsageRecord({
      createdAt: completedAt,
      apiKeyId: input.apiKeyId,
      apiKeyPrefix: input.apiKeyPrefix,
      apiKeyName: input.apiKeyName,
      channelId: input.channelId,
      channelName: input.channelName,
      credentialId: input.credentialId,
      credentialEmail: input.credentialEmail,
      model: input.model || "",
      usage,
    });
  }
}

export function appendUsageRecord(input: {
  createdAt: string;
  apiKeyId?: string | null;
  apiKeyPrefix?: string | null;
  apiKeyName?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  credentialId?: string | null;
  credentialEmail?: string | null;
  model: string;
  usage: UsageSnapshot;
}) {
  getLogDb()
    .prepare(
      `INSERT INTO usage_records (
        id, created_at, api_key_id, api_key_prefix, api_key_name,
        channel_id, channel_name, credential_id, credential_email, model,
        prompt_tokens, completion_tokens, total_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomId("usage"),
      input.createdAt,
      input.apiKeyId || null,
      input.apiKeyPrefix || null,
      input.apiKeyName || null,
      input.channelId || null,
      input.channelName || null,
      input.credentialId || null,
      input.credentialEmail || null,
      input.model,
      input.usage.promptTokens,
      input.usage.completionTokens,
      input.usage.totalTokens,
    );

  const day = input.createdAt.slice(0, 10);
  getLogDb()
    .prepare(
      `INSERT INTO usage_daily_buckets (
        bucket_date, api_key_id, channel_id, credential_id, model,
        prompt_tokens, completion_tokens, total_tokens, request_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(bucket_date, api_key_id, channel_id, credential_id, model)
      DO UPDATE SET
        prompt_tokens = prompt_tokens + excluded.prompt_tokens,
        completion_tokens = completion_tokens + excluded.completion_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        request_count = request_count + 1,
        updated_at = excluded.updated_at`,
    )
    .run(
      day,
      input.apiKeyId || "",
      input.channelId || "",
      input.credentialId || "",
      input.model,
      input.usage.promptTokens,
      input.usage.completionTokens,
      input.usage.totalTokens,
      input.createdAt,
    );
}

export function appendChannelHealthEvent(input: {
  channelId: string;
  channelName?: string;
  credentialId?: string | null;
  eventType: string;
  statusCode?: number | null;
  healthScore?: number | null;
  cooldownUntil?: string | null;
  message?: string | null;
}) {
  getLogDb()
    .prepare(
      `INSERT INTO channel_health_events (
        id, created_at, channel_id, channel_name, credential_id, event_type,
        status_code, health_score, cooldown_until, message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomId("chevt"),
      new Date().toISOString(),
      input.channelId,
      input.channelName || "",
      input.credentialId || null,
      input.eventType,
      input.statusCode ?? null,
      input.healthScore ?? null,
      input.cooldownUntil || null,
      input.message || null,
    );
}

export function appendAuditLog(input: {
  action: string;
  actorType?: string;
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  detail?: Record<string, unknown>;
}) {
  getLogDb()
    .prepare(
      `INSERT INTO audit_logs (
        id, created_at, actor_type, actor_id, action, target_type,
        target_id, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomId("audit"),
      new Date().toISOString(),
      input.actorType || "system",
      input.actorId || null,
      input.action,
      input.targetType || null,
      input.targetId || null,
      jsonStringify(input.detail || {}),
    );
}

export function getApiKeyDailyUsage(apiKeyId: string, day = new Date()) {
  const bucketDate = day.toISOString().slice(0, 10);
  const row = getLogDb()
    .prepare(
      `SELECT COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM usage_daily_buckets
       WHERE bucket_date = ? AND api_key_id = ?`,
    )
    .get(bucketDate, apiKeyId) as { total_tokens: number } | undefined;
  return Number(row?.total_tokens || 0);
}

export interface PublicRequestLogRow {
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
}

export function latestRequestLogs(limit = 20): PublicRequestLogRow[] {
  const rows = getLogDb()
    .prepare(
      `SELECT
        id, started_at, method, path, request_type, stream, model,
        status_code, latency_ms, api_key_id, api_key_prefix, api_key_name,
        channel_name, credential_email, prompt_tokens, completion_tokens,
        total_tokens, error_code
      FROM request_logs
      ORDER BY started_at DESC
      LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;

  return attachApiKeyNames(rows).map(toPublicRequestLogRow);
}

export function getAdminOverviewStats(): AdminOverviewStats {
  const totals = getOverviewTotals();
  return {
    generatedAt: new Date().toISOString(),
    totals,
    byApiKey: getApiKeyUsageStats(),
    byApiKeyModel: getApiKeyModelUsageStats(),
    byModel: getGroupedUsageStats("model", "model"),
    byChannel: getGroupedUsageStats("channel_id", "channel_name"),
    byCredential: getGroupedUsageStats("credential_id", "credential_email"),
    byRequestType: getGroupedUsageStats("request_type", "request_type"),
    byDay: getDailyUsageStats(),
  };
}

const DEFAULT_CREDENTIAL_USAGE_WINDOW_SIZE = 50;
const CREDENTIAL_USAGE_NORMAL_THRESHOLD = 80;
const CREDENTIAL_USAGE_WARNING_THRESHOLD = 50;

export function credentialUsageHealth(
  credentialIds: string[],
  windowSize = DEFAULT_CREDENTIAL_USAGE_WINDOW_SIZE,
): Record<string, CodexAccountUsageHealth> {
  const uniqueIds = [
    ...new Set(credentialIds.map((id) => id.trim()).filter(Boolean)),
  ];
  const normalizedWindowSize = Math.max(1, Math.floor(windowSize));
  const healthByCredentialId: Record<string, CodexAccountUsageHealth> = {};

  for (const id of uniqueIds) {
    healthByCredentialId[id] =
      unusedCredentialUsageHealth(normalizedWindowSize);
  }
  if (uniqueIds.length === 0) {
    return healthByCredentialId;
  }

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = getLogDb()
    .prepare(
      `WITH ranked AS (
        SELECT
          credential_id,
          started_at,
          status_code,
          error_code,
          ROW_NUMBER() OVER (
            PARTITION BY credential_id
            ORDER BY started_at DESC
          ) AS row_number
        FROM request_logs
        WHERE credential_id IN (${placeholders})
      )
      SELECT credential_id, started_at, status_code, error_code
      FROM ranked
      WHERE row_number <= ?
      ORDER BY credential_id, started_at DESC`,
    )
    .all(...uniqueIds, normalizedWindowSize) as Array<Record<string, unknown>>;

  const rowsByCredentialId = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const credentialId = String(row.credential_id || "");
    if (!credentialId) {
      continue;
    }
    const currentRows = rowsByCredentialId.get(credentialId) || [];
    currentRows.push(row);
    rowsByCredentialId.set(credentialId, currentRows);
  }

  for (const id of uniqueIds) {
    healthByCredentialId[id] = calculateCredentialUsageHealth(
      rowsByCredentialId.get(id) || [],
      normalizedWindowSize,
    );
  }

  return healthByCredentialId;
}

function unusedCredentialUsageHealth(
  windowSize: number,
): CodexAccountUsageHealth {
  return {
    status: "unused",
    score: 0,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    lastUsedAt: null,
    lastStatusCode: null,
    lastErrorCode: null,
    windowSize,
  };
}

function calculateCredentialUsageHealth(
  rows: Array<Record<string, unknown>>,
  windowSize: number,
): CodexAccountUsageHealth {
  if (rows.length === 0) {
    return unusedCredentialUsageHealth(windowSize);
  }
  const requestCount = rows.length;
  const successCount = rows.filter((row) =>
    isSuccessfulStatusCode(row.status_code),
  ).length;
  const errorCount = requestCount - successCount;
  const score = Math.round((successCount / requestCount) * 100);
  const lastRow = rows[0] || {};
  const lastStatusCode = Number(lastRow.status_code || 0) || null;
  return {
    status:
      score >= CREDENTIAL_USAGE_NORMAL_THRESHOLD
        ? "normal"
        : score >= CREDENTIAL_USAGE_WARNING_THRESHOLD
          ? "warning"
          : "error",
    score,
    requestCount,
    successCount,
    errorCount,
    lastUsedAt: nullableString(lastRow.started_at),
    lastStatusCode,
    lastErrorCode: nullableString(lastRow.error_code),
    windowSize,
  };
}

function isSuccessfulStatusCode(value: unknown) {
  const statusCode = Number(value || 0);
  return statusCode >= 200 && statusCode < 400;
}

function getOverviewTotals(): AdminOverviewTotals {
  const row = getLogDb()
    .prepare(
      `SELECT
        COUNT(*) AS request_count,
        SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
        SUM(stream) AS stream_count,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
        COALESCE(SUM(latency_ms), 0) AS total_latency_ms,
        COUNT(DISTINCT NULLIF(api_key_id, '')) AS distinct_api_key_count,
        COUNT(DISTINCT NULLIF(model, '')) AS distinct_model_count,
        COUNT(DISTINCT NULLIF(channel_id, '')) AS distinct_channel_count,
        MIN(started_at) AS first_request_at,
        MAX(started_at) AS last_request_at
      FROM request_logs`,
    )
    .get() as Record<string, unknown> | undefined;
  const requestCount = numberValue(row?.request_count);
  const totalTokens = numberValue(row?.total_tokens);
  return {
    requestCount,
    successCount: numberValue(row?.success_count),
    errorCount: numberValue(row?.error_count),
    streamCount: numberValue(row?.stream_count),
    promptTokens: numberValue(row?.prompt_tokens),
    completionTokens: numberValue(row?.completion_tokens),
    totalTokens,
    avgLatencyMs: Math.round(numberValue(row?.avg_latency_ms)),
    p95LatencyMs: percentileLatency(),
    avgTokensPerRequest: average(totalTokens, requestCount),
    tokensPerSecond: throughput(totalTokens, row?.total_latency_ms),
    distinctApiKeyCount: numberValue(row?.distinct_api_key_count),
    distinctModelCount: numberValue(row?.distinct_model_count),
    distinctChannelCount: numberValue(row?.distinct_channel_count),
    firstRequestAt: nullableString(row?.first_request_at),
    lastRequestAt: nullableString(row?.last_request_at),
  };
}

function getApiKeyUsageStats(): ApiKeyUsageStatsRow[] {
  const rows = getLogDb()
    .prepare(
      `${aggregateSelect("api_key_id", "api_key_prefix")}
       GROUP BY COALESCE(api_key_id, ''), COALESCE(api_key_prefix, '')
       ORDER BY total_tokens DESC, request_count DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  const keysById = apiKeysById();
  const todayTokensByKey = todayTokensByApiKey();
  const stats = rows.map((row) => {
    const apiKeyId = nullableString(row.group_key);
    const keyRecord = apiKeyId ? keysById.get(apiKeyId) : undefined;
    const base = toUsageStatsRow(row, {
      label:
        keyRecord?.name ||
        nullableString(row.api_key_name) ||
        nullableString(row.group_label) ||
        "未知 Key",
      subLabel: keyRecord?.prefix || nullableString(row.group_label),
      emptyLabel: "未知 Key",
      groupColumn: "api_key_id",
    });
    const tokenLimitDaily = keyRecord?.token_limit_daily ?? null;
    const todayTokens = apiKeyId ? todayTokensByKey.get(apiKeyId) || 0 : 0;
    return {
      ...base,
      apiKeyId,
      apiKeyPrefix: keyRecord?.prefix || nullableString(row.group_label),
      apiKeyName:
        keyRecord?.name || nullableString(row.api_key_name) || base.label,
      enabled:
        typeof keyRecord?.enabled === "number" ? keyRecord.enabled === 1 : null,
      tokenLimitDaily,
      todayTokens,
      tokenLimitUtilization:
        tokenLimitDaily && tokenLimitDaily > 0
          ? Math.round((todayTokens / tokenLimitDaily) * 100)
          : null,
    };
  });

  const seenKeyIds = new Set(stats.map((row) => row.apiKeyId).filter(Boolean));
  for (const keyRecord of keysById.values()) {
    if (seenKeyIds.has(keyRecord.id)) {
      continue;
    }
    const todayTokens = todayTokensByKey.get(keyRecord.id) || 0;
    const tokenLimitDaily = keyRecord.token_limit_daily;
    stats.push({
      ...emptyUsageStatsRow({
        key: keyRecord.id,
        label: keyRecord.name,
        subLabel: keyRecord.prefix,
      }),
      apiKeyId: keyRecord.id,
      apiKeyPrefix: keyRecord.prefix,
      apiKeyName: keyRecord.name,
      enabled: keyRecord.enabled === 1,
      tokenLimitDaily,
      todayTokens,
      tokenLimitUtilization:
        tokenLimitDaily && tokenLimitDaily > 0
          ? Math.round((todayTokens / tokenLimitDaily) * 100)
          : null,
    });
  }

  return stats;
}

function getApiKeyModelUsageStats(): ApiKeyModelUsageStatsRow[] {
  const rows = getLogDb()
    .prepare(
      `SELECT
        COALESCE(api_key_id, '') AS api_key_id,
        COALESCE(api_key_prefix, '') AS api_key_prefix,
        MAX(NULLIF(api_key_name, '')) AS api_key_name,
        COALESCE(model, '') AS model,
        COUNT(*) AS request_count,
        SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
        SUM(stream) AS stream_count,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
        COALESCE(SUM(latency_ms), 0) AS total_latency_ms,
        MIN(started_at) AS first_request_at,
        MAX(started_at) AS last_request_at
      FROM request_logs
      GROUP BY COALESCE(api_key_id, ''), COALESCE(api_key_prefix, ''), COALESCE(model, '')
      ORDER BY total_tokens DESC, request_count DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  const keysById = apiKeysById();
  return rows.map((row) => {
    const apiKeyId = nullableString(row.api_key_id);
    const keyRecord = apiKeyId ? keysById.get(apiKeyId) : undefined;
    const model = nullableString(row.model) || "未知模型";
    const base = toUsageStatsRow(
      {
        ...row,
        group_key: `${apiKeyId || "unknown"}:${model}`,
        group_label: model,
      },
      {
        label: model,
        subLabel:
          keyRecord?.name ||
          nullableString(row.api_key_name) ||
          nullableString(row.api_key_prefix),
        emptyLabel: "未知模型",
        filters: [
          { column: "api_key_id", value: apiKeyId || "" },
          { column: "model", value: nullableString(row.model) || "" },
        ],
      },
    );
    return {
      ...base,
      apiKeyId,
      apiKeyPrefix: keyRecord?.prefix || nullableString(row.api_key_prefix),
      apiKeyName:
        keyRecord?.name ||
        nullableString(row.api_key_name) ||
        nullableString(row.api_key_prefix) ||
        "未知 Key",
      model,
    };
  });
}

function getGroupedUsageStats(
  keyColumn: string,
  labelColumn: string,
): UsageStatsRow[] {
  const rows = getLogDb()
    .prepare(
      `${aggregateSelect(keyColumn, labelColumn)}
       GROUP BY COALESCE(${keyColumn}, ''), COALESCE(${labelColumn}, '')
       ORDER BY total_tokens DESC, request_count DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) =>
    toUsageStatsRow(row, {
      emptyLabel: "未记录",
      groupColumn: keyColumn,
    }),
  );
}

function getDailyUsageStats(): DailyUsageStatsRow[] {
  const rows = getLogDb()
    .prepare(
      `SELECT
        substr(started_at, 1, 10) AS date,
        COUNT(*) AS request_count,
        SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
        SUM(stream) AS stream_count,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
        COALESCE(SUM(latency_ms), 0) AS total_latency_ms,
        MIN(started_at) AS first_request_at,
        MAX(started_at) AS last_request_at
      FROM request_logs
      GROUP BY substr(started_at, 1, 10)
      ORDER BY date DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const requestCount = numberValue(row.request_count);
    const totalTokens = numberValue(row.total_tokens);
    return {
      date: String(row.date || ""),
      requestCount,
      successCount: numberValue(row.success_count),
      errorCount: numberValue(row.error_count),
      streamCount: numberValue(row.stream_count),
      promptTokens: numberValue(row.prompt_tokens),
      completionTokens: numberValue(row.completion_tokens),
      totalTokens,
      avgLatencyMs: Math.round(numberValue(row.avg_latency_ms)),
      p95LatencyMs: percentileLatency({ day: String(row.date || "") }),
      avgTokensPerRequest: average(totalTokens, requestCount),
      tokensPerSecond: throughput(totalTokens, row.total_latency_ms),
    };
  });
}

function aggregateSelect(keyColumn: string, labelColumn: string) {
  return `SELECT
    COALESCE(${keyColumn}, '') AS group_key,
    COALESCE(${labelColumn}, '') AS group_label,
    MAX(NULLIF(api_key_name, '')) AS api_key_name,
    COUNT(*) AS request_count,
    SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END) AS success_count,
    SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
    SUM(stream) AS stream_count,
    COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
    COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
    COALESCE(SUM(total_tokens), 0) AS total_tokens,
    COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
    COALESCE(SUM(latency_ms), 0) AS total_latency_ms,
    MIN(started_at) AS first_request_at,
    MAX(started_at) AS last_request_at
  FROM request_logs`;
}

function emptyUsageStatsRow(input: {
  key: string;
  label: string;
  subLabel?: string | null;
}): UsageStatsRow {
  return {
    key: input.key,
    label: input.label,
    subLabel: input.subLabel ?? null,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    streamCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    avgTokensPerRequest: 0,
    tokensPerSecond: 0,
    firstRequestAt: null,
    lastRequestAt: null,
  };
}

function toUsageStatsRow(
  row: Record<string, unknown>,
  options: {
    label?: string;
    subLabel?: string | null;
    emptyLabel: string;
    groupColumn?: string;
    filters?: Array<{ column: string; value: string }>;
  },
): UsageStatsRow {
  const requestCount = numberValue(row.request_count);
  const totalTokens = numberValue(row.total_tokens);
  const firstRequestAt = nullableString(row.first_request_at);
  const lastRequestAt = nullableString(row.last_request_at);
  return {
    key: nullableString(row.group_key) || options.emptyLabel,
    label:
      options.label || nullableString(row.group_label) || options.emptyLabel,
    subLabel:
      options.subLabel === undefined
        ? nullableString(row.group_key)
        : options.subLabel,
    requestCount,
    successCount: numberValue(row.success_count),
    errorCount: numberValue(row.error_count),
    streamCount: numberValue(row.stream_count),
    promptTokens: numberValue(row.prompt_tokens),
    completionTokens: numberValue(row.completion_tokens),
    totalTokens,
    avgLatencyMs: Math.round(numberValue(row.avg_latency_ms)),
    p95LatencyMs: percentileLatency({
      groupKey: nullableString(row.group_key),
      groupColumn: options.groupColumn,
      filters: options.filters,
    }),
    avgTokensPerRequest: average(totalTokens, requestCount),
    tokensPerSecond: throughput(totalTokens, row.total_latency_ms),
    firstRequestAt,
    lastRequestAt,
  };
}

function percentileLatency(
  input: {
    day?: string;
    groupColumn?: string;
    groupKey?: string | null;
    filters?: Array<{ column: string; value: string }>;
  } = {},
) {
  const conditions: string[] = [];
  const params: string[] = [];
  if (input.day) {
    conditions.push("substr(started_at, 1, 10) = ?");
    params.push(input.day);
  }
  if (input.groupColumn) {
    conditions.push(`COALESCE(${input.groupColumn}, '') = ?`);
    params.push(input.groupKey || "");
  }
  for (const filter of input.filters || []) {
    conditions.push(`COALESCE(${filter.column}, '') = ?`);
    params.push(filter.value);
  }
  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getLogDb()
    .prepare(
      `SELECT latency_ms FROM request_logs ${where} ORDER BY latency_ms ASC`,
    )
    .all(...params) as Array<{ latency_ms: number }>;
  if (rows.length === 0) {
    return 0;
  }
  const index = Math.min(rows.length - 1, Math.ceil(rows.length * 0.95) - 1);
  return numberValue(rows[index]?.latency_ms);
}

function apiKeysById() {
  const rows = getMainDb()
    .prepare(
      "SELECT id, name, prefix, enabled, token_limit_daily FROM api_keys",
    )
    .all() as Array<{
    id: string;
    name: string;
    prefix: string;
    enabled: number;
    token_limit_daily: number | null;
  }>;
  return new Map(rows.map((row) => [String(row.id), row]));
}

function todayTokensByApiKey() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = getLogDb()
    .prepare(
      `SELECT api_key_id, COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM usage_daily_buckets
       WHERE bucket_date = ?
       GROUP BY api_key_id`,
    )
    .all(today) as Array<{ api_key_id: string; total_tokens: number }>;
  return new Map(
    rows.map((row) => [String(row.api_key_id), numberValue(row.total_tokens)]),
  );
}

function average(total: number, count: number) {
  return count > 0 ? Math.round((total / count) * 100) / 100 : 0;
}

function throughput(totalTokens: number, totalLatencyMs: unknown) {
  const latencySeconds = numberValue(totalLatencyMs) / 1000;
  if (latencySeconds <= 0) {
    return 0;
  }
  return Math.round((totalTokens / latencySeconds) * 100) / 100;
}

function numberValue(value: unknown) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function toPublicRequestLogRow(
  row: Record<string, unknown>,
): PublicRequestLogRow {
  return {
    id: String(row.id || ""),
    started_at: String(row.started_at || ""),
    method: String(row.method || ""),
    path: String(row.path || ""),
    request_type: String(row.request_type || ""),
    stream: Number(row.stream || 0),
    model: String(row.model || ""),
    status_code: Number(row.status_code || 0),
    latency_ms: Number(row.latency_ms || 0),
    api_key_prefix: nullableString(row.api_key_prefix),
    api_key_name: nullableString(row.api_key_name),
    channel_name: nullableString(row.channel_name),
    credential_email: nullableString(row.credential_email),
    prompt_tokens: Number(row.prompt_tokens || 0),
    completion_tokens: Number(row.completion_tokens || 0),
    total_tokens: Number(row.total_tokens || 0),
    error_code: nullableString(row.error_code),
  };
}

function attachApiKeyNames(rows: Array<Record<string, unknown>>) {
  const apiKeyIds = [
    ...new Set(
      rows.map((row) => nullableString(row.api_key_id)).filter(Boolean),
    ),
  ];
  if (apiKeyIds.length === 0) {
    return rows;
  }

  const placeholders = apiKeyIds.map(() => "?").join(", ");
  const apiKeyRows = getMainDb()
    .prepare(`SELECT id, name FROM api_keys WHERE id IN (${placeholders})`)
    .all(...apiKeyIds) as Array<{ id: string; name: string }>;
  const namesById = new Map(
    apiKeyRows.map((row) => [String(row.id), String(row.name || "")]),
  );

  return rows.map((row) => {
    const apiKeyId = nullableString(row.api_key_id);
    return {
      ...row,
      api_key_name: apiKeyId
        ? namesById.get(apiKeyId) || nullableString(row.api_key_name)
        : nullableString(row.api_key_name),
    };
  });
}

function nullableString(value: unknown) {
  return value === null || value === undefined ? null : String(value);
}
