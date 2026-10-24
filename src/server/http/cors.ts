import "server-only";

import { isAccountQuotaHeader } from "@/src/server/http/accountQuota";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key, OpenAI-API-Key, X-Requested-With",
  "Access-Control-Max-Age": "86400",
} as const;

export function corsPreflightResponse() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export async function withCors(
  handler: () => Response | Promise<Response>,
): Promise<Response> {
  const response = await handler();
  return addCorsHeaders(response);
}

export function addCorsHeaders(response: Response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    headers.set(name, value);
  }
  const exposed = new Set((headers.get("Access-Control-Expose-Headers") || "")
    .split(",").map((name) => name.trim()).filter(Boolean));
  for (const name of headers.keys()) if (isAccountQuotaHeader(name)) exposed.add(name);
  if (exposed.size) headers.set("Access-Control-Expose-Headers", [...exposed].join(", "));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
