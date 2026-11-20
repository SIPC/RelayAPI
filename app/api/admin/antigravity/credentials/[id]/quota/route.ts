import { errorToResponse } from "@/src/server/http/errors";
import { getAntigravityQuota } from "@/src/server/services/antigravityCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reads Google's per-group weekly and 5-hour quota for this Antigravity account.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWebRequest(request);
    return Response.json(await getAntigravityQuota((await params).id));
  } catch (error) {
    return errorToResponse(error);
  }
}
