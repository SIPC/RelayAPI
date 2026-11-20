import { errorToResponse } from "@/src/server/http/errors";
import { startAntigravityOAuthLoginSession } from "@/src/server/services/antigravityCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";

export function POST(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json(startAntigravityOAuthLoginSession());
  } catch (error) {
    return errorToResponse(error);
  }
}
