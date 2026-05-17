import { errorToResponse } from "@/src/server/http/errors";
import { exportCodexCredential } from "@/src/server/services/codexCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// Credential exports intentionally include Codex token plaintext for backup/migration.
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    requireWebRequest(request);
    const { id } = await context.params;
    return jsonDownloadResponse(
      await exportCodexCredential(id),
      `relayapi-codex-credential-${safeFilenamePart(id)}.json`,
    );
  } catch (error) {
    return errorToResponse(error);
  }
}

function jsonDownloadResponse(value: unknown, filename: string) {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function safeFilenamePart(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "credential";
}
