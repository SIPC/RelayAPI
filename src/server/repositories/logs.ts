import "server-only";

import { getLogDb, getMainDb } from "@/src/server/db/sqlite";
import { jsonStringify, randomId } from "@/src/server/services/crypto";
import type { StageTimingEntry } from "@/src/server/http/stageTimer";
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

const ADMIN_OVERVIEW_CACHE_TTL_MS = 15_000;
const OVERVIEW_GROUP_LIMIT = 100;
const OVERVIEW_DAILY_WINDOW_DAYS = 30;
const LATENCY_SAMPLE_LIMIT = 1_000;
const FIRST_TOKEN_SAMPLE_LIMIT = 500;

let adminOverviewCache: {
  expiresAt: number;
  value: AdminOverviewStats;
} | null = null;

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

export interface PruneRequestLogsInput {
  summaryRetentionDays: number;
  detailRetentionDays: number;
  vacuum?: boolean;
}

export interface PruneRequestLogsResult {
  summaryRetentionDays: number;
  detailRetentionDays: number;
  summaryCutoff: string;
  detailCutoff: string;
  deletedRequestLogDetails: number;
  deletedRequestLogs: number;
  deletedUsageRecords: number;
  deletedUsageDailyBuckets: number;
  deletedChannelHealthEvents: number;
  vacuumed: boolean;
}

export interface RequestLogDetailInput {
  requestHeaders?: Record<string, string> | null;
  requestBodyText?: string | null;
  requestBodyTruncated?: boolean;
  requestBodyBytes?: number;
  forwardedBodyText?: string | null;
  forwardedBodyTruncated?: boolean;
  forwardedBodyBytes?: number;
  upstreamStatusCode?: number | null;
  upstreamHeaders?: Record<string, string> | null;
  upstreamBodyText?: string | null;
  upstreamBodyTruncated?: boolean;
  upstreamBodyBytes?: number;
  errorName?: string | null;
  errorMessage?: string | null;
  errorStack?: string | null;
  errorCause?: unknown;
  detail?: unknown;
  stageTimings?: StageTimingEntry[];
}

export function appendRequestLog(input: RequestLogInput) {
  const usage = input.usage || {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  const completedAt = input.completedAt || new Date().toISOString();
  const id = randomId("reqlog");
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
      id,
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

  return id;
}

export function appendRequestLogDetail(
  requestLogId: string,
  input: RequestLogDetailInput,
) {
  const now = new Date().toISOString();
  getLogDb()
    .prepare(
      `INSERT INTO request_log_details (
        request_log_id, created_at, updated_at, request_headers_json,
        request_body_text, request_body_truncated, request_body_bytes,
        forwarded_body_text, forwarded_body_truncated, forwarded_body_bytes,
        upstream_status_code, upstream_headers_json, upstream_body_text,
        upstream_body_truncated, upstream_body_bytes, error_name,
        error_message, error_stack, error_cause_json, detail_json,
        stage_timings_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_log_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        request_headers_json = COALESCE(excluded.request_headers_json, request_log_details.request_headers_json),
        request_body_text = COALESCE(excluded.request_body_text, request_log_details.request_body_text),
        request_body_truncated = CASE WHEN excluded.request_body_text IS NULL THEN request_log_details.request_body_truncated ELSE excluded.request_body_truncated END,
        request_body_bytes = CASE WHEN excluded.request_body_text IS NULL THEN request_log_details.request_body_bytes ELSE excluded.request_body_bytes END,
        forwarded_body_text = COALESCE(excluded.forwarded_body_text, request_log_details.forwarded_body_text),
        forwarded_body_truncated = CASE WHEN excluded.forwarded_body_text IS NULL THEN request_log_details.forwarded_body_truncated ELSE excluded.forwarded_body_truncated END,
        forwarded_body_bytes = CASE WHEN excluded.forwarded_body_text IS NULL THEN request_log_details.forwarded_body_bytes ELSE excluded.forwarded_body_bytes END,
        upstream_status_code = COALESCE(excluded.upstream_status_code, request_log_details.upstream_status_code),
        upstream_headers_json = COALESCE(excluded.upstream_headers_json, request_log_details.upstream_headers_json),
        upstream_body_text = COALESCE(excluded.upstream_body_text, request_log_details.upstream_body_text),
        upstream_body_truncated = CASE WHEN excluded.upstream_body_text IS NULL THEN request_log_details.upstream_body_truncated ELSE excluded.upstream_body_truncated END,
        upstream_body_bytes = CASE WHEN excluded.upstream_body_text IS NULL THEN request_log_details.upstream_body_bytes ELSE excluded.upstream_body_bytes END,
        error_name = COALESCE(excluded.error_name, request_log_details.error_name),
        error_message = COALESCE(excluded.error_message, request_log_details.error_message),
        error_stack = COALESCE(excluded.error_stack, request_log_details.error_stack),
        error_cause_json = COALESCE(excluded.error_cause_json, request_log_details.error_cause_json),
        detail_json = COALESCE(excluded.detail_json, request_log_details.detail_json),
        stage_timings_json = COALESCE(excluded.stage_timings_json, request_log_details.stage_timings_json)`,
    )
    .run(
      requestLogId,
      now,
      now,
      input.requestHeaders ? jsonStringify(input.requestHeaders) : null,
      input.requestBodyText ?? null,
      input.requestBodyTruncated ? 1 : 0,
      Math.max(0, Math.floor(input.requestBodyBytes || 0)),
      input.forwardedBodyText ?? null,
      input.forwardedBodyTruncated ? 1 : 0,
      Math.max(0, Math.floor(input.forwardedBodyBytes || 0)),
      input.upstreamStatusCode ?? null,
      input.upstreamHeaders ? jsonStringify(input.upstreamHeaders) : null,
      input.upstreamBodyText ?? null,
      input.upstreamBodyTruncated ? 1 : 0,
      Math.max(0, Math.floor(input.upstreamBodyBytes || 0)),
      input.errorName || null,
      input.errorMessage || null,
      input.errorStack || null,
      input.errorCause === undefined ? null : safeDetailJson(input.errorCause),
      input.detail === undefined ? null : safeDetailJson(input.detail),
      input.stageTimings ? jsonStringify(input.stageTimings) : null,
    );
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

export function pruneRequestLogs(
  input: PruneRequestLogsInput,
): PruneRequestLogsResult {
  const summaryRetentionDays = normalizeRetentionDays(
    input.summaryRetentionDays,
  );
  const detailRetentionDays = normalizeRetentionDays(input.detailRetentionDays);
  const summaryCutoff = retentionCutoff(summaryRetentionDays);
  const detailCutoff = retentionCutoff(detailRetentionDays);
  const db = getLogDb();
  const deleted = {
    requestLogDetails: 0,
    requestLogs: 0,
    usageRecords: 0,
    usageDailyBuckets: 0,
    channelHealthEvents: 0,
  };

  db.exec("BEGIN");
  try {
    deleted.requestLogDetails += changedRows(
      db
        .prepare("DELETE FROM request_log_details WHERE created_at < ?")
        .run(detailCutoff),
    );
    deleted.requestLogDetails += changedRows(
      db
        .prepare(
          `DELETE FROM request_log_details
           WHERE request_log_id IN (
             SELECT id FROM request_logs WHERE started_at < ?
           )`,
        )
        .run(summaryCutoff),
    );
    deleted.requestLogs = changedRows(
      db
        .prepare("DELETE FROM request_logs WHERE started_at < ?")
        .run(summaryCutoff),
    );
    deleted.usageRecords = changedRows(
      db
        .prepare("DELETE FROM usage_records WHERE created_at < ?")
        .run(summaryCutoff),
    );
    deleted.usageDailyBuckets = changedRows(
      db
        .prepare("DELETE FROM usage_daily_buckets WHERE bucket_date < ?")
        .run(summaryCutoff.slice(0, 10)),
    );
    deleted.requestLogDetails += changedRows(
      db
        .prepare(
          `DELETE FROM request_log_details
           WHERE NOT EXISTS (
             SELECT 1 FROM request_logs
             WHERE request_logs.id = request_log_details.request_log_id
           )`,
        )
        .run(),
    );
    deleted.channelHealthEvents = changedRows(
      db
        .prepare("DELETE FROM channel_health_events WHERE created_at < ?")
        .run(summaryCutoff),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  if (input.vacuum) {
    db.exec("VACUUM");
  }

  adminOverviewCache = null;
  return {
    summaryRetentionDays,
    detailRetentionDays,
    summaryCutoff,
    detailCutoff,
    deletedRequestLogDetails: deleted.requestLogDetails,
    deletedRequestLogs: deleted.requestLogs,
    deletedUsageRecords: deleted.usageRecords,
    deletedUsageDailyBuckets: deleted.usageDailyBuckets,
    deletedChannelHealthEvents: deleted.channelHealthEvents,
    vacuumed: Boolean(input.vacuum),
  };
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

export interface PublicRequestLogDetail {
  log: PublicRequestLogRow & {
    completed_at: string;
    error_message: string | null;
  };
  detail: {
    request_headers: Record<string, string> | null;
    request_body_text: string | null;
    request_body_truncated: boolean;
    request_body_bytes: number;
    forwarded_body_text: string | null;
    forwarded_body_truncated: boolean;
    forwarded_body_bytes: number;
    upstream_status_code: number | null;
    upstream_headers: Record<string, string> | null;
    upstream_body_text: string | null;
    upstream_body_truncated: boolean;
    upstream_body_bytes: number;
    error_name: string | null;
    error_message: string | null;
    error_stack: string | null;
    error_cause: unknown;
    detail: unknown;
    stage_timings: StageTimingEntry[];
    created_at: string | null;
    updated_at: string | null;
  } | null;
}

export function latestRequestLogs(limit = 20): PublicRequestLogRow[] {
  return queryRequestLogs({ limit, offset: 0, skipTotal: true }).data;
}

export type RequestLogStatusFilter = "all" | "success" | "error" | "stream";

export interface RequestLogQueryInput {
  limit?: number;
  offset?: number;
  query?: string;
  status?: RequestLogStatusFilter;
  includeSummary?: boolean;
  skipTotal?: boolean;
}

export interface RequestLogQueryResult {
  data: PublicRequestLogRow[];
  limit: number;
  offset: number;
  total: number;
  errorCount: number;
  totalTokens: number;
  avgLatencyMs: number;
}

export function getRequestLogDetail(id: string): PublicRequestLogDetail | null {
  const row = getLogDb()
    .prepare(
      `SELECT
        id, started_at, completed_at, method, path, request_type, stream,
        model, status_code, latency_ms, api_key_id, api_key_prefix,
        api_key_name, channel_name, credential_email, prompt_tokens,
        completion_tokens, total_tokens, error_code, error_message
      FROM request_logs
      WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  const detailRow = getLogDb()
    .prepare(
      `SELECT
        created_at, updated_at, request_headers_json, request_body_text,
        request_body_truncated, request_body_bytes, forwarded_body_text,
        forwarded_body_truncated, forwarded_body_bytes, upstream_status_code,
        upstream_headers_json, upstream_body_text, upstream_body_truncated,
        upstream_body_bytes, error_name, error_message, error_stack,
        error_cause_json, detail_json, stage_timings_json
      FROM request_log_details
      WHERE request_log_id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;

  return {
    log: {
      ...toPublicRequestLogRow(attachApiKeyNames([row])[0] || row),
      completed_at: String(row.completed_at || ""),
      error_message: nullableString(row.error_message),
    },
    detail: detailRow ? toPublicRequestLogDetailRow(detailRow) : null,
  };
}

export function queryRequestLogs(
  input: RequestLogQueryInput = {},
): RequestLogQueryResult {
  const limit = Math.max(1, Math.floor(input.limit || 20));
  const offset = Math.max(0, Math.floor(input.offset || 0));
  const { where, params } = requestLogWhere(input);
  const rows = getLogDb()
    .prepare(
      `SELECT
        id, started_at, method, path, request_type, stream, model,
        status_code, latency_ms, api_key_id, api_key_prefix, api_key_name,
        channel_name, credential_email, prompt_tokens, completion_tokens,
        total_tokens, error_code
      FROM request_logs
      ${where}
      ORDER BY started_at DESC
      LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<Record<string, unknown>>;

  const publicRows = attachApiKeyNames(rows).map(toPublicRequestLogRow);
  const pageSummary = input.includeSummary
    ? summarizeRequestLogs(where, params)
    : summarizeRequestLogRows(publicRows);

  return {
    data: publicRows,
    limit,
    offset,
    total: input.skipTotal
      ? publicRows.length
      : countRequestLogs(where, params),
    errorCount: pageSummary.errorCount,
    totalTokens: pageSummary.totalTokens,
    avgLatencyMs: pageSummary.avgLatencyMs,
  };
}

function countRequestLogs(where: string, params: string[]) {
  const row = getLogDb()
    .prepare(`SELECT COUNT(*) AS total FROM request_logs ${where}`)
    .get(...params) as Record<string, unknown> | undefined;
  return numberValue(row?.total);
}

function summarizeRequestLogs(where: string, params: string[]) {
  const summary = getLogDb()
    .prepare(
      `SELECT
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms
      FROM request_logs
      ${where}`,
    )
    .get(...params) as Record<string, unknown> | undefined;
  return {
    errorCount: numberValue(summary?.error_count),
    totalTokens: numberValue(summary?.total_tokens),
    avgLatencyMs: Math.round(numberValue(summary?.avg_latency_ms)),
  };
}

function summarizeRequestLogRows(rows: PublicRequestLogRow[]) {
  const errorCount = rows.filter((row) => row.status_code >= 400).length;
  const totalTokens = rows.reduce((total, row) => total + row.total_tokens, 0);
  const totalLatencyMs = rows.reduce((total, row) => total + row.latency_ms, 0);
  return {
    errorCount,
    totalTokens,
    avgLatencyMs:
      rows.length > 0 ? Math.round(totalLatencyMs / rows.length) : 0,
  };
}

function requestLogWhere(input: RequestLogQueryInput) {
  const conditions: string[] = [];
  const params: string[] = [];
  if (input.status === "success") {
    conditions.push("status_code >= 200 AND status_code < 400");
  } else if (input.status === "error") {
    conditions.push("status_code >= 400");
  } else if (input.status === "stream") {
    conditions.push("stream = 1");
  }

  const query = String(input.query || "").trim();
  if (query) {
    const like = `%${query.toLowerCase()}%`;
    conditions.push(
      `(
        lower(method) LIKE ? OR
        lower(path) LIKE ? OR
        lower(request_type) LIKE ? OR
        lower(model) LIKE ? OR
        lower(api_key_prefix) LIKE ? OR
        lower(api_key_name) LIKE ? OR
        lower(channel_name) LIKE ? OR
        lower(credential_email) LIKE ? OR
        lower(error_code) LIKE ? OR
        CAST(status_code AS TEXT) LIKE ?
      )`,
    );
    params.push(like, like, like, like, like, like, like, like, like, like);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

export function getAdminOverviewStats(): AdminOverviewStats {
  const now = Date.now();
  if (adminOverviewCache && adminOverviewCache.expiresAt > now) {
    return adminOverviewCache.value;
  }

  const totals = getOverviewTotals();
  const value = {
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
  adminOverviewCache = {
    expiresAt: now + ADMIN_OVERVIEW_CACHE_TTL_MS,
    value,
  };
  return value;
}

const DEFAULT_CREDENTIAL_USAGE_WINDOW_SIZE = 50;
const DEFAULT_CHANNEL_USAGE_WINDOW_SIZE = 100;
const CREDENTIAL_USAGE_NORMAL_THRESHOLD = 80;
const CREDENTIAL_USAGE_WARNING_THRESHOLD = 50;

export function credentialUsageHealth(
  credentialIds: string[],
  windowSize = DEFAULT_CREDENTIAL_USAGE_WINDOW_SIZE,
): Record<string, CodexAccountUsageHealth> {
  return requestWindowUsageHealth(
    credentialIds,
    "credential_id",
    Math.max(1, Math.floor(windowSize)),
  );
}

export function channelUsageHealth(
  channelIds: string[],
  windowSize = DEFAULT_CHANNEL_USAGE_WINDOW_SIZE,
): Record<string, CodexAccountUsageHealth> {
  return requestWindowUsageHealth(
    channelIds,
    "channel_id",
    Math.max(1, Math.floor(windowSize)),
  );
}

function requestWindowUsageHealth(
  ids: string[],
  columnName: "credential_id" | "channel_id",
  windowSize: number,
): Record<string, CodexAccountUsageHealth> {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  const healthById: Record<string, CodexAccountUsageHealth> = {};

  for (const id of uniqueIds) {
    healthById[id] = unusedUsageHealth(windowSize);
  }
  if (uniqueIds.length === 0) {
    return healthById;
  }

  const statement = getLogDb().prepare(
    `SELECT ${columnName} AS target_id, started_at, status_code, error_code
     FROM request_logs INDEXED BY ${requestLogWindowIndex(columnName)}
     WHERE ${columnName} = ?
     ORDER BY started_at DESC
     LIMIT ?`,
  );

  for (const id of uniqueIds) {
    const rows = statement.all(id, windowSize) as Array<
      Record<string, unknown>
    >;
    healthById[id] = calculateUsageHealth(rows, windowSize);
  }

  return healthById;
}

function requestLogWindowIndex(columnName: "credential_id" | "channel_id") {
  return columnName === "credential_id"
    ? "idx_request_logs_credential"
    : "idx_request_logs_channel";
}

function unusedUsageHealth(windowSize: number): CodexAccountUsageHealth {
  return {
    status: "unused",
    score: 100,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    lastUsedAt: null,
    lastStatusCode: null,
    lastErrorCode: null,
    windowSize,
  };
}

function calculateUsageHealth(
  rows: Array<Record<string, unknown>>,
  windowSize: number,
): CodexAccountUsageHealth {
  if (rows.length === 0) {
    return unusedUsageHealth(windowSize);
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
  const firstTokenLatency = firstTokenLatencyStats();
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
    ...firstTokenLatency,
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
  const overviewWindowStart = overviewRecentStartedAt();
  const rows = getLogDb()
    .prepare(
      `${aggregateSelect("api_key_id", "api_key_prefix")}
       WHERE started_at >= ?
       GROUP BY COALESCE(api_key_id, ''), COALESCE(api_key_prefix, '')
       ORDER BY total_tokens DESC, request_count DESC
       LIMIT ?`,
    )
    .all(overviewWindowStart, OVERVIEW_GROUP_LIMIT) as Array<
    Record<string, unknown>
  >;
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
  const recentStartedAt = overviewRecentStartedAt();
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
      WHERE started_at >= ?
      GROUP BY COALESCE(api_key_id, ''), COALESCE(api_key_prefix, ''), COALESCE(model, '')
      ORDER BY total_tokens DESC, request_count DESC
      LIMIT ?`,
    )
    .all(recentStartedAt, OVERVIEW_GROUP_LIMIT) as Array<
    Record<string, unknown>
  >;
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
  const recentStartedAt = overviewRecentStartedAt();
  const rows = getLogDb()
    .prepare(
      `${aggregateSelect(keyColumn, labelColumn)}
       WHERE started_at >= ?
       GROUP BY COALESCE(${keyColumn}, ''), COALESCE(${labelColumn}, '')
       ORDER BY total_tokens DESC, request_count DESC
       LIMIT ?`,
    )
    .all(recentStartedAt, OVERVIEW_GROUP_LIMIT) as Array<
    Record<string, unknown>
  >;
  return rows.map((row) =>
    toUsageStatsRow(row, {
      emptyLabel: "未记录",
      groupColumn: keyColumn,
    }),
  );
}

function getDailyUsageStats(): DailyUsageStatsRow[] {
  const recentStartedAt = overviewRecentStartedAt();
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
      WHERE started_at >= ?
      GROUP BY substr(started_at, 1, 10)
      ORDER BY date DESC
      LIMIT ?`,
    )
    .all(recentStartedAt, OVERVIEW_DAILY_WINDOW_DAYS) as Array<
    Record<string, unknown>
  >;
  return rows.map((row) => {
    const requestCount = numberValue(row.request_count);
    const totalTokens = numberValue(row.total_tokens);
    const date = String(row.date || "");
    const firstTokenLatency = firstTokenLatencyStats({ day: date });
    return {
      date,
      requestCount,
      successCount: numberValue(row.success_count),
      errorCount: numberValue(row.error_count),
      streamCount: numberValue(row.stream_count),
      promptTokens: numberValue(row.prompt_tokens),
      completionTokens: numberValue(row.completion_tokens),
      totalTokens,
      avgLatencyMs: Math.round(numberValue(row.avg_latency_ms)),
      p95LatencyMs: percentileLatency({ day: date }),
      ...firstTokenLatency,
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
    avgFirstTokenLatencyMs: 0,
    p95FirstTokenLatencyMs: 0,
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
    ...firstTokenLatencyStats({
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
  const { where, params } = latencyWhereClause(input);
  const rows = getLogDb()
    .prepare(
      `SELECT latency_ms
       FROM (
         SELECT latency_ms
         FROM request_logs
         ${where}
         ORDER BY started_at DESC
         LIMIT ?
       )
       ORDER BY latency_ms ASC`,
    )
    .all(...params, LATENCY_SAMPLE_LIMIT) as Array<{ latency_ms: number }>;
  if (rows.length === 0) {
    return 0;
  }
  const index = Math.min(rows.length - 1, Math.ceil(rows.length * 0.95) - 1);
  return numberValue(rows[index]?.latency_ms);
}

function firstTokenLatencyStats(
  input: {
    day?: string;
    groupColumn?: string;
    groupKey?: string | null;
    filters?: Array<{ column: string; value: string }>;
  } = {},
) {
  const { where, params } = latencyWhereClause(input);
  const rows = getLogDb()
    .prepare(
      `WITH recent_requests AS (
         SELECT
           id, started_at, api_key_id, model, channel_id, credential_id,
           request_type
         FROM request_logs
         ${where}
         ORDER BY started_at DESC
         LIMIT ?
       )
       SELECT COALESCE(
         MAX(CASE WHEN json_extract(value, '$.name') = 'stream_first_token' THEN json_extract(value, '$.startedAtMs') END),
         MAX(CASE WHEN json_extract(value, '$.name') = 'stream_first_chunk' THEN json_extract(value, '$.startedAtMs') END)
       ) AS latency_ms
       FROM recent_requests
       INNER JOIN request_log_details ON request_log_details.request_log_id = recent_requests.id,
       json_each(request_log_details.stage_timings_json)
       GROUP BY recent_requests.id
       HAVING latency_ms IS NOT NULL`,
    )
    .all(...params, FIRST_TOKEN_SAMPLE_LIMIT) as Array<{ latency_ms: number }>;
  if (rows.length === 0) {
    return {
      avgFirstTokenLatencyMs: 0,
      p95FirstTokenLatencyMs: 0,
    };
  }
  const values = rows
    .map((row) => numberValue(row.latency_ms))
    .sort((left, right) => left - right);
  const index = Math.min(
    values.length - 1,
    Math.ceil(values.length * 0.95) - 1,
  );
  return {
    avgFirstTokenLatencyMs: Math.round(
      values.reduce((total, value) => total + value, 0) / values.length,
    ),
    p95FirstTokenLatencyMs: values[index] || 0,
  };
}

function latencyWhereClause(
  input: {
    day?: string;
    groupColumn?: string;
    groupKey?: string | null;
    filters?: Array<{ column: string; value: string }>;
    timingName?: string;
  } = {},
  tableAlias?: string,
) {
  const column = (name: string) => {
    const safeName = safeLatencyColumnName(name);
    return tableAlias ? `${tableAlias}.${safeName}` : safeName;
  };
  const conditions: string[] = [];
  const params: string[] = [];
  if (input.day) {
    conditions.push(`substr(${column("started_at")}, 1, 10) = ?`);
    params.push(input.day);
  } else {
    conditions.push(`${column("started_at")} >= ?`);
    params.push(overviewRecentStartedAt());
  }
  if (input.groupColumn) {
    conditions.push(`COALESCE(${column(input.groupColumn)}, '') = ?`);
    params.push(input.groupKey || "");
  }
  for (const filter of input.filters || []) {
    conditions.push(`COALESCE(${column(filter.column)}, '') = ?`);
    params.push(filter.value);
  }
  if (input.timingName) {
    conditions.push("json_extract(value, '$.name') = ?");
    params.push(input.timingName);
  }
  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function safeLatencyColumnName(name: string) {
  if (!/^[a-z_]+$/i.test(name)) {
    throw new Error("Invalid latency column name");
  }
  return name;
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

function changedRows(result: { changes: number | bigint }) {
  return Number(result.changes || 0);
}

function normalizeRetentionDays(days: number) {
  if (!Number.isFinite(days)) {
    throw new Error("Retention days must be finite");
  }
  return Math.max(1, Math.floor(days));
}

function retentionCutoff(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function overviewRecentStartedAt() {
  return new Date(Date.now() - OVERVIEW_DAILY_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
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

function toPublicRequestLogDetailRow(row: Record<string, unknown>) {
  return {
    request_headers: parseJsonObject(row.request_headers_json),
    request_body_text: nullableString(row.request_body_text),
    request_body_truncated: Boolean(row.request_body_truncated),
    request_body_bytes: numberValue(row.request_body_bytes),
    forwarded_body_text: nullableString(row.forwarded_body_text),
    forwarded_body_truncated: Boolean(row.forwarded_body_truncated),
    forwarded_body_bytes: numberValue(row.forwarded_body_bytes),
    upstream_status_code: numberValue(row.upstream_status_code) || null,
    upstream_headers: parseJsonObject(row.upstream_headers_json),
    upstream_body_text: nullableString(row.upstream_body_text),
    upstream_body_truncated: Boolean(row.upstream_body_truncated),
    upstream_body_bytes: numberValue(row.upstream_body_bytes),
    error_name: nullableString(row.error_name),
    error_message: nullableString(row.error_message),
    error_stack: nullableString(row.error_stack),
    error_cause: parseJsonValue(row.error_cause_json),
    detail: parseJsonValue(row.detail_json),
    stage_timings: parseStageTimings(row.stage_timings_json),
    created_at: nullableString(row.created_at),
    updated_at: nullableString(row.updated_at),
  };
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

function safeDetailJson(value: unknown) {
  try {
    return jsonStringify(value);
  } catch {
    return jsonStringify(String(value));
  }
}

function parseJsonObject(value: unknown): Record<string, string> | null {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, item]) => [
      key,
      String(item ?? ""),
    ]),
  );
}

function parseStageTimings(value: unknown): StageTimingEntry[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const row = item as Record<string, unknown>;
      return {
        name: String(row.name || ""),
        label: String(row.label || row.name || ""),
        startedAtMs: numberValue(row.startedAtMs),
        endedAtMs: numberValue(row.endedAtMs),
        durationMs: numberValue(row.durationMs),
      };
    })
    .filter((item): item is StageTimingEntry => Boolean(item?.name));
}

function parseJsonValue(value: unknown) {
  if (typeof value !== "string" || !value) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
