import { errorToResponse } from "@/src/server/http/errors";
import {
  patchCodexCredentialRouting,
  removeCodexCredential,
} from "@/src/server/services/codexCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// Credential routing edits never return Codex token plaintext.
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    requireWebRequest(request);
    const { id } = await context.params;
    const body = await request.json();
    return Response.json(patchCodexCredentialRouting(id, body));
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    requireWebRequest(request);
    const { id } = await context.params;
    await removeCodexCredential(id);
    return Response.json({ id, deleted: true });
  } catch (error) {
    return errorToResponse(error);
  }
}
