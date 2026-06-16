import { errorToResponse } from "@/src/server/http/errors";
import { listPublicClaudeCredentials } from "@/src/server/services/claudeCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// Claude credential responses use public records only; token plaintext is never returned.
export async function GET(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json(await listPublicClaudeCredentials());
  } catch (error) {
    return errorToResponse(error);
  }
}
