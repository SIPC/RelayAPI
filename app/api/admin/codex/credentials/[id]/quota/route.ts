import { errorToResponse } from "@/src/server/http/errors";
import { getCodexQuota } from "@/src/server/services/codexQuota";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// Quota cache stays in the main DB so future automatic channel routing can use it.
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    requireWebRequest(request);
    const { id } = await context.params;
    const searchParams = new URL(request.url).searchParams;
    return Response.json(
      await getCodexQuota({
        credentialId: id,
        forceRefresh:
          searchParams.get("refresh") === "1" ||
          searchParams.get("force") === "1",
        includeRaw: searchParams.get("raw") === "1",
      }),
    );
  } catch (error) {
    return errorToResponse(error);
  }
}
