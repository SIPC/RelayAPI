import { errorToResponse, HttpError } from "@/src/server/http/errors";
import {
  patchUpstreamCredential,
  removeUpstreamCredential,
} from "@/src/server/services/upstreamCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireWebRequest(request);
    const { id } = await context.params;
    let body: unknown;
    try { body = await request.json(); } catch {
      throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
    }
    return Response.json(patchUpstreamCredential(id, body));
  } catch (error) {
    return errorToResponse(error, { operation: "upstream_credentials.patch", request });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    requireWebRequest(request);
    const { id } = await context.params;
    removeUpstreamCredential(id);
    return Response.json({ id, deleted: true });
  } catch (error) {
    return errorToResponse(error, { operation: "upstream_credentials.delete", request });
  }
}
