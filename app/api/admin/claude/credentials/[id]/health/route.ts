import { errorToResponse } from "@/src/server/http/errors";
import { resetClaudeCredentialHealth } from "@/src/server/services/claudeCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// Resetting health only moves the local health window and clears cooldown state.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let id = "";
  try {
    requireWebRequest(request);
    ({ id } = await context.params);
    return Response.json(await resetClaudeCredentialHealth(id));
  } catch (error) {
    return errorToResponse(error, {
      operation: "claude.reset_credential_health",
      request,
      metadata: id ? { credentialId: id } : undefined,
    });
  }
}
