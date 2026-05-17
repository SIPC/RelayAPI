import { errorToResponse } from "@/src/server/http/errors";
import { pruneRequestLogs } from "@/src/server/repositories/logs";
import { getRequestLogRetentionSettings } from "@/src/server/services/settings";
import {
  queryRequestLogs,
  type RequestLogStatusFilter,
} from "@/src/server/repositories/logs";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const AUTO_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

let lastAutoPruneAttemptAt = 0;

// Web admin routes require the startup Web access key session.
// Request log rows include public API key prefixes and channel metadata only.
export async function GET(request: Request) {
  try {
    requireWebRequest(request);
    maybeAutoPruneRequestLogs();
    const searchParams = new URL(request.url).searchParams;
    const limit = normalizeLimit(searchParams.get("limit"));
    const page = normalizePage(searchParams.get("page"));
    const query = searchParams.get("query") || searchParams.get("q") || "";
    const status = normalizeStatus(searchParams.get("status"));
    const result = queryRequestLogs({
      limit,
      offset: (page - 1) * limit,
      query,
      status,
      includeSummary: searchParams.get("summary") === "full",
    });
    return Response.json({
      object: "list",
      data: result.data,
      limit: result.limit,
      page,
      offset: result.offset,
      total: result.total,
      totalPages: Math.max(1, Math.ceil(result.total / result.limit)),
      summary: {
        errorCount: result.errorCount,
        totalTokens: result.totalTokens,
        cachedTokens: result.cachedTokens,
        cacheHitRate: result.cacheHitRate,
        avgLatencyMs: result.avgLatencyMs,
      },
    });
  } catch (error) {
    return errorToResponse(error);
  }
}

function maybeAutoPruneRequestLogs() {
  const now = Date.now();
  if (now - lastAutoPruneAttemptAt < AUTO_PRUNE_INTERVAL_MS) {
    return;
  }
  lastAutoPruneAttemptAt = now;
  const settings = getRequestLogRetentionSettings();
  pruneRequestLogs({
    summaryRetentionDays: settings.requestLogRetentionDays ?? 90,
    detailRetentionDays: settings.requestLogDetailRetentionDays ?? 14,
  });
}

function normalizeLimit(value: string | null) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
}

function normalizePage(value: string | null) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeStatus(value: string | null): RequestLogStatusFilter {
  if (
    value === "success" ||
    value === "error" ||
    value === "stream" ||
    value === "all"
  ) {
    return value;
  }
  return "all";
}
