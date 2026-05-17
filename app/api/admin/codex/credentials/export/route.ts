import { errorToResponse } from "@/src/server/http/errors";
import { exportCodexCredentials } from "@/src/server/services/codexCredentials";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// Credential exports intentionally include Codex token plaintext for backup/migration.
export async function GET(request: Request) {
  try {
    requireWebRequest(request);
    return jsonDownloadResponse(
      await exportCodexCredentials(),
      `relayapi-codex-credentials-${fileTimestamp()}.json`,
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

function fileTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
