import { errorToResponse } from "@/src/server/http/errors";
import { getAdminOverviewStats } from "@/src/server/repositories/logs";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// Overview returns aggregate request, token, cost, and performance metadata.
export async function GET(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json(getAdminOverviewStats());
  } catch (error) {
    return errorToResponse(error);
  }
}
