import { errorToResponse, HttpError } from "@/src/server/http/errors";
import { finishAntigravityOAuthCallback } from "@/src/server/services/antigravityCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    requireWebRequest(request);
    const body = await request.json().catch(() => null);
    if (!body || typeof body.callbackUrl !== "string") {
      throw new HttpError(400, "missing_callback_url", "Paste the Antigravity callback URL or query string");
    }
    return Response.json(await finishAntigravityOAuthCallback(body.callbackUrl));
  } catch (error) {
    return errorToResponse(error);
  }
}
