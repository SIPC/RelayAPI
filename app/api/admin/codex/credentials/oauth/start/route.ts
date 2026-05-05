import { errorToResponse } from "@/src/server/http/errors";
import { startOAuthLoginSession } from "@/src/server/services/codexCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// Starting OAuth returns no Codex token plaintext.
export async function POST(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json(startOAuthLoginSession());
  } catch (error) {
    return errorToResponse(error);
  }
}
