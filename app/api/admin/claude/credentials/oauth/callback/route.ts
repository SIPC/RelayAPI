import { errorToResponse } from "@/src/server/http/errors";
import {
  finishClaudeOAuthCallback,
  parseClaudeOAuthCallbackInput,
} from "@/src/server/services/claudeCredentials";
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
    const searchParams = parseClaudeOAuthCallbackInput(callbackInput);
    return Response.json(await finishClaudeOAuthCallback(searchParams));
  } catch (error) {
    return errorToResponse(error, {
      operation: "claude.oauth.callback",
      request,
    });
  }
}

export async function GET(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json(
      await finishClaudeOAuthCallback(new URL(request.url).searchParams),
    );
  } catch (error) {
    return errorToResponse(error, {
      operation: "claude.oauth.callback",
      request,
    });
  }
}

function getCallbackInput(body: unknown) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const input = body as { callbackUrl?: unknown; callback_url?: unknown };
    return input.callbackUrl ?? input.callback_url;
  }
  return body;
}
