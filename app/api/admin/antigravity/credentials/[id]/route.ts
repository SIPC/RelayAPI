import { errorToResponse } from "@/src/server/http/errors";
import {
  patchAntigravityCredential,
  refreshAntigravityCredential,
  removeAntigravityCredential,
} from "@/src/server/services/antigravityCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

// Renews the token and refreshes the account's model catalog.
export async function POST(request: Request, { params }: Context) {
  try {
    requireWebRequest(request);
    return Response.json(await refreshAntigravityCredential((await params).id));
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    requireWebRequest(request);
    return Response.json(patchAntigravityCredential((await params).id, await request.json()));
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    requireWebRequest(request);
    const { id } = await params;
    removeAntigravityCredential(id);
    return Response.json({ id, deleted: true });
  } catch (error) {
    return errorToResponse(error);
  }
}