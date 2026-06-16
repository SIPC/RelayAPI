import { errorToResponse } from "@/src/server/http/errors";
import { resetCodexCredentialHealth } from "@/src/server/services/codexCredentials";
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
    return Response.json(await resetCodexCredentialHealth(id));
  } catch (error) {
    return errorToResponse(error, {
      operation: "codex.reset_credential_health",
      request,
      metadata: id ? { credentialId: id } : undefined,
    });
  }
}
