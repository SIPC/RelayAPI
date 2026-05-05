import { cookies } from "next/headers";

import { errorToResponse, HttpError } from "@/src/server/http/errors";
import {
  createWebSessionToken,
  verifyWebAccessKey,
  WEB_SESSION_COOKIE,
  webSessionCookieOptions,
} from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const accessKey = getAccessKey(body);
    if (!verifyWebAccessKey(accessKey)) {
      throw new HttpError(
        401,
        "invalid_web_access_key",
        "管理台访问密钥不正确",
      );
    }

    const cookieStore = await cookies();
    cookieStore.set(
      WEB_SESSION_COOKIE,
      createWebSessionToken(),
      webSessionCookieOptions(request.url),
    );

    return Response.json({ authenticated: true });
  } catch (error) {
    return errorToResponse(error);
  }
}

function getAccessKey(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "";
  }
  const input = body as { accessKey?: unknown; key?: unknown };
  return input.accessKey ?? input.key;
}
