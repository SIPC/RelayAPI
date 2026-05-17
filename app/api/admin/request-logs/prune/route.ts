import { errorToResponse, HttpError } from "@/src/server/http/errors";
import { pruneRequestLogs } from "@/src/server/repositories/logs";
import { getRequestLogRetentionSettings } from "@/src/server/services/settings";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireWebRequest(request);
    const body = await request.json().catch(() => ({}));
    const settings = getRequestLogRetentionSettings();
    const summaryRetentionDays = normalizeRetentionDays(
      bodyValue(body, "summaryRetentionDays") ??
        bodyValue(body, "requestLogRetentionDays") ??
        settings.requestLogRetentionDays,
      "summaryRetentionDays",
    );
    const detailRetentionDays = normalizeRetentionDays(
      bodyValue(body, "detailRetentionDays") ??
        bodyValue(body, "requestLogDetailRetentionDays") ??
        settings.requestLogDetailRetentionDays,
      "detailRetentionDays",
    );
    const vacuum = Boolean(bodyValue(body, "vacuum"));

    return Response.json(
      pruneRequestLogs({ summaryRetentionDays, detailRetentionDays, vacuum }),
    );
  } catch (error) {
    return errorToResponse(error);
  }
}

function bodyValue(body: unknown, key: string) {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

function normalizeRetentionDays(value: unknown, fieldName: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(
      400,
      "invalid_log_retention_days",
      `${fieldName} must be a finite number`,
    );
  }
  const days = Math.floor(parsed);
  if (days < 1 || days > 3650) {
    throw new HttpError(
      400,
      "invalid_log_retention_days",
      `${fieldName} must be between 1 and 3650 days`,
    );
  }
  return days;
}
