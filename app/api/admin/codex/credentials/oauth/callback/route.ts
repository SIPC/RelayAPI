import { errorToResponse } from "@/src/server/http/errors";
import {
  finishOAuthCallback,
  parseOAuthCallbackInput,
} from "@/src/server/services/codexCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// OAuth completion returns a public credential record; token plaintext is never returned.
export async function POST(request: Request) {
  try {
    requireWebRequest(request);
    const body = await request.json();
    const callbackInput = getCallbackInput(body);
    const searchParams = parseOAuthCallbackInput(callbackInput);
    return Response.json(await finishOAuthCallback(searchParams));
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json(
      await finishOAuthCallback(new URL(request.url).searchParams),
    );
  } catch (error) {
    return errorToResponse(error);
  }
}

function getCallbackInput(body: unknown) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const input = body as { callbackUrl?: unknown; callback_url?: unknown };
    return input.callbackUrl ?? input.callback_url;
  }
  return body;
}
