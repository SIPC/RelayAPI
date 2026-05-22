import { errorToResponse } from "@/src/server/http/errors";
import {
  patchPublicProxyPoolItem,
  removePublicProxyPoolItem,
} from "@/src/server/services/proxyPool";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let id = "";
  try {
    requireWebRequest(request);
    ({ id } = await context.params);
    const body = await request.json();
    return Response.json(patchPublicProxyPoolItem(id, body));
  } catch (error) {
    return errorToResponse(error, {
      operation: "proxy_pool.update",
      request,
      metadata: id ? { proxyPoolId: id } : undefined,
    });
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let id = "";
  try {
    requireWebRequest(request);
    ({ id } = await context.params);
    removePublicProxyPoolItem(id);
    return Response.json({ id, deleted: true });
  } catch (error) {
    return errorToResponse(error, {
      operation: "proxy_pool.delete",
      request,
      metadata: id ? { proxyPoolId: id } : undefined,
    });
  }
}
