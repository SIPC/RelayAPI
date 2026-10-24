import { corsPreflightResponse, withCors } from "@/src/server/http/cors";
import { handleClaudeMessages } from "@/src/server/http/relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;

export function OPTIONS() { return corsPreflightResponse(); }
export async function POST(request: Request) {
  return withCors(() => handleClaudeMessages(request));
}
