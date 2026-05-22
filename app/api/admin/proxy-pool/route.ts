import { errorToResponse } from "@/src/server/http/errors";
import {
  createPublicProxyPoolItem,
  listPublicProxyPoolItems,
} from "@/src/server/services/proxyPool";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json({ object: "list", data: listPublicProxyPoolItems() });
  } catch (error) {
    return errorToResponse(error, { operation: "proxy_pool.list", request });
  }
}

export async function POST(request: Request) {
  try {
    requireWebRequest(request);
    const body = await request.json();
    return Response.json(createPublicProxyPoolItem(body), { status: 201 });
  } catch (error) {
    return errorToResponse(error, { operation: "proxy_pool.create", request });
  }
}
