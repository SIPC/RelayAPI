import { errorToResponse } from "@/src/server/http/errors";
import {
  createApiKey,
  listApiKeyPublicRecords,
} from "@/src/server/services/apiKeys";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// API key plaintext is returned only once when a key is created.
export async function GET(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json({
      object: "list",
      data: listApiKeyPublicRecords(),
    });
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireWebRequest(request);
    const body = await request.json();
    return Response.json(createApiKey(body), { status: 201 });
  } catch (error) {
    return errorToResponse(error);
  }
}
