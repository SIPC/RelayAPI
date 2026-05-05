import { errorToResponse } from "@/src/server/http/errors";
import { latestRequestLogs } from "@/src/server/repositories/logs";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Web admin routes require the startup Web access key session.
// Request log rows include public API key prefixes and channel metadata only.
export async function GET(request: Request) {
  try {
    requireWebRequest(request);
    const searchParams = new URL(request.url).searchParams;
    const limit = normalizeLimit(searchParams.get("limit"));
    return Response.json({
      object: "list",
      data: latestRequestLogs(limit),
    });
  } catch (error) {
    return errorToResponse(error);
  }
}

function normalizeLimit(value: string | null) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
}
