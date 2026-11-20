import { errorToResponse } from "@/src/server/http/errors";
import { listPublicAntigravityCredentials } from "@/src/server/services/antigravityCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json(listPublicAntigravityCredentials());
  } catch (error) {
    return errorToResponse(error);
  }
}
