import { errorToResponse } from "@/src/server/http/errors";
import { startClaudeOAuthLoginSession } from "@/src/server/services/claudeCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// Starting OAuth returns no Claude token plaintext.
export async function POST(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json(startClaudeOAuthLoginSession());
  } catch (error) {
    return errorToResponse(error, {
      operation: "claude.oauth.start",
      request,
    });
  }
}
