import { errorToResponse } from "@/src/server/http/errors";
import { refreshClaudeCredential } from "@/src/server/services/claudeCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// Refreshing replaces encrypted token storage and returns only public credential fields.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    requireWebRequest(request);
    const { id } = await context.params;
    return Response.json(await refreshClaudeCredential(id));
  } catch (error) {
    return errorToResponse(error, {
      operation: "claude.refresh_credential",
      request,
    });
  }
}
