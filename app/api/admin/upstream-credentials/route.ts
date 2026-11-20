import { errorToResponse, HttpError } from "@/src/server/http/errors";
import {
  createUpstreamCredential,
  listPublicUpstreamCredentials,
} from "@/src/server/services/upstreamCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json({ object: "list", data: listPublicUpstreamCredentials() });
  } catch (error) {
    return errorToResponse(error, { operation: "upstream_credentials.list", request });
  }
}

export async function POST(request: Request) {
  try {
    requireWebRequest(request);
    let body: unknown;
    try { body = await request.json(); } catch {
      throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
    }
    return Response.json(createUpstreamCredential(body), { status: 201 });
  } catch (error) {
    return errorToResponse(error, { operation: "upstream_credentials.create", request });
  }
}
