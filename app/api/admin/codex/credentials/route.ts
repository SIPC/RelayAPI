import { errorToResponse } from "@/src/server/http/errors";
import { listPublicCodexCredentials } from "@/src/server/services/codexCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// Codex credential responses use public records only; token plaintext is never returned.
export async function GET(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json(await listPublicCodexCredentials());
  } catch (error) {
    return errorToResponse(error);
  }
}
