import { errorToResponse } from "@/src/server/http/errors";
import { importClaudeCredentialFromJson } from "@/src/server/services/claudeCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// Imported Claude token plaintext is encrypted server-side and never returned.
export async function POST(request: Request) {
  try {
    requireWebRequest(request);
    const body = await request.json();
    const { credential, filename } = getImportInput(body);
    return Response.json(
      importClaudeCredentialFromJson(credential, { filename }),
    );
  } catch (error) {
    return errorToResponse(error);
  }
}

function getImportInput(body: unknown) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const input = body as { credential?: unknown; filename?: unknown };
    return {
      credential: input.credential ?? body,
      filename: typeof input.filename === "string" ? input.filename : undefined,
    };
  }
  return { credential: body, filename: undefined };
}
