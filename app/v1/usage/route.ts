import { handleUsage } from "@/src/server/http/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleUsage(request);
}
