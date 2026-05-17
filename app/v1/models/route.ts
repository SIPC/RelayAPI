import { corsPreflightResponse, withCors } from "@/src/server/http/cors";
import { handleModels } from "@/src/server/http/relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Thin App Router adapter only; channel routing and credential selection happen
// automatically in the server service layer, not in UI or route modules.
export function OPTIONS() {
  return corsPreflightResponse();
}

export async function GET(request: Request) {
  return withCors(() => handleModels(request));
}
