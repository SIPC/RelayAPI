import "server-only";

import { createHmac } from "node:crypto";
import { getEncryptionSecret } from "@/src/server/config/env";
import { errorToResponse } from "@/src/server/http/errors";
import { authenticateRelayRequest } from "@/src/server/services/apiKeys";
import { listCodexQuotaCredentials } from "@/src/server/services/channels";
import { CODEX_QUOTA_FRESH_MS, getCodexQuota } from "@/src/server/services/codexQuota";

const MAX_STALE_MS = 10 * 60_000;

export async function handleUsage(request: Request) {
  let response: Response;
  try {
    const key = authenticateRelayRequest(request, { usageQuery: true });
    const selected = listCodexQuotaCredentials(key);
    const reports = new Map<string, Awaited<ReturnType<typeof getCodexQuota>>>();
    // Await all work instead of relying on a detached request-lifetime task.
    // Shared SQLite leases cap refreshes at four, including other workers;
    // overflow credentials return snapshots and can refresh on the next poll.
    await Promise.all(selected.map(async ({ credential }) => {
      const report = await getCodexQuota({ credentialId: credential.id, refreshIfStale: true })
        .catch(() => getCodexQuota({ credentialId: credential.id }));
      reports.set(credential.id, report);
    }));
    // Bindings, enablement and Key validity may change while WHAM is awaited.
    const currentKey = authenticateRelayRequest(request, { usageQuery: true });
    const credentials = listCodexQuotaCredentials(currentKey).flatMap(({ credential, routingState }) => {
      const report = reports.get(credential.id);
      if (!report) return [];
      const now = Date.now();
      const retrievedMs = Date.parse(report.retrieved_at);
      const ageMs = now - retrievedMs;
      const hasSnapshot = Number.isFinite(ageMs) && ageMs >= 0;
      const state = !hasSnapshot ? "missing" : ageMs > MAX_STALE_MS ? "expired"
        : ageMs >= CODEX_QUOTA_FRESH_MS ? "stale" : "fresh";
      const ref = createHmac("sha256", getEncryptionSecret())
        .update(JSON.stringify([currentKey.id, credential.id])).digest("hex").slice(0, 20);
      return [{
        ref,
        label: `Codex ${ref.slice(0, 8)}`,
        routingState,
        cache: {
          state,
          retrievedAt: hasSnapshot ? report.retrieved_at : null,
          ageSeconds: hasSnapshot ? Math.floor(ageMs / 1000) : null,
        },
        windows: ([{ id: "5h", label: "5 小时", seconds: 18_000 },
          { id: "7d", label: "每周", seconds: 604_800 }] as const).map(({ id, label, seconds }) => {
          const window = report.windows.find((item) => item.id === `code-${id}` && item.window_seconds === seconds);
          const resetMs = Date.parse(window?.reset_at || "");
          const resetPending = Number.isFinite(resetMs) && resetMs <= now;
          const used = window?.used_percent;
          const known = hasSnapshot && ageMs <= MAX_STALE_MS && !resetPending &&
            typeof used === "number" && Number.isFinite(used) && used >= 0 && used <= 100;
          return {
            id, label,
            state: resetPending ? "reset_pending" : !known ? "unknown" : state,
            usedPercent: known ? used : null,
            remainingPercent: known ? 100 - used : null,
            resetAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
          };
        }),
      }];
    });
    response = Response.json({ schema: "relay.codex-quota.v1", selection: "bound_channels", credentials });
  } catch (error) {
    response = errorToResponse(error, { operation: "relay.usage" });
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
