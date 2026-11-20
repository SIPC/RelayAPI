import { errorToResponse } from "@/src/server/http/errors";
import { resetAntigravityCredentialHealth } from "@/src/server/services/antigravityCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Moves the local health window and clears credential and per-model cooldowns.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWebRequest(request);
    return Response.json(resetAntigravityCredentialHealth((await params).id));
  } catch (error) {
    return errorToResponse(error);
  }
}
