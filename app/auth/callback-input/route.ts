import { errorToResponse } from "@/src/server/http/errors";
import {
  finishOAuthCallback,
  parseOAuthCallbackInput,
} from "@/src/server/services/codexCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Demo-compatible form endpoint for cases where the browser callback URL is pasted manually.
export async function POST(request: Request) {
  try {
    requireWebRequest(request);
    const form = await request.formData();
    const searchParams = parseOAuthCallbackInput(form.get("callback_url"));
    const credential = await finishOAuthCallback(searchParams);
    const label = credential.email || credential.accountId || credential.id;
    return Response.redirect(
      new URL(
        `/?message=${encodeURIComponent(`Codex OAuth 登录成功：${label}`)}`,
        request.url,
      ),
      303,
    );
  } catch (error) {
    return errorToResponse(error);
  }
}
