import { errorToResponse } from "@/src/server/http/errors";
import { refreshCodexCredential } from "@/src/server/services/codexCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// Refresh returns a public credential record; token plaintext is never returned.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    requireWebRequest(request);
    const { id } = await context.params;
    return Response.json(await refreshCodexCredential(id));
  } catch (error) {
    return errorToResponse(error);
  }
}
