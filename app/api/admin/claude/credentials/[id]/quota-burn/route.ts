import { errorToResponse } from "@/src/server/http/errors";
import { getQuotaBurnReport } from "@/src/server/services/quotaBurn";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tokens relayed per 1% of quota, from recorded quota snapshots. Read-only.
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let id = "";
  try {
    requireWebRequest(request);
    ({ id } = await context.params);
    return Response.json(getQuotaBurnReport("claude", id));
  } catch (error) {
    return errorToResponse(error, {
      operation: "claude.quota.burn",
      request,
      metadata: id ? { credentialId: id } : undefined,
    });
  }
}
