import { handleOpenAIResponses } from "@/src/server/http/relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Thin App Router adapter only; channel routing and credential selection happen
// automatically in the server service layer, not in UI or route modules.
export async function POST(request: Request) {
  return handleOpenAIResponses(request);
}
