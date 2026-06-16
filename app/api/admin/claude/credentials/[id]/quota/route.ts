import { errorToResponse } from "@/src/server/http/errors";
import { getClaudeQuota } from "@/src/server/services/claudeCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Probe Claude with the saved OAuth credential and report real Anthropic
// rate-limit headers instead of estimating quota from local request logs.
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let id = "";
  try {
    requireWebRequest(request);
    ({ id } = await context.params);
    return Response.json(
      await getClaudeQuota(id, { sourceHeaders: request.headers }),
    );
  } catch (error) {
    return errorToResponse(error, {
      operation: "claude.quota.refresh",
      request,
      metadata: id ? { credentialId: id } : undefined,
    });
  }
}
