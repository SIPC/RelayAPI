import { errorToResponse } from "@/src/server/http/errors";
import { getClaudeQuota } from "@/src/server/services/claudeQuota";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read OAuth usage without sending inference. Concurrent refreshes share a lease.
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let id = "";
  try {
    requireWebRequest(request);
    ({ id } = await context.params);
    return Response.json(
      await getClaudeQuota(id),
    );
  } catch (error) {
    return errorToResponse(error, {
      operation: "claude.quota.refresh",
      request,
      metadata: id ? { credentialId: id } : undefined,
    });
  }
}
