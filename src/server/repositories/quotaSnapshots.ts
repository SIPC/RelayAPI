import "server-only";

import { getLogDb } from "@/src/server/db/sqlite";

export type QuotaSnapshotProvider = "claude" | "codex";
export type QuotaSnapshotWindow = "5h" | "7d";

export interface QuotaSnapshotInput {
  windowId: QuotaSnapshotWindow;
  usedPercent: number | null | undefined;
  resetAt: string | number | null | undefined;
}

export interface QuotaSnapshotRow {
  reset_key: number;
  bucket: number;
  first_at: number;
  first_used: number;
  last_at: number;
  last_used: number;
  min_used: number;
  max_used: number;
  samples: number;
}

export const QUOTA_SNAPSHOT_BUCKET_MS = 5 * 60_000;
export const QUOTA_SNAPSHOT_RETENTION_MS = 30 * 86_400_000;
const MINUTE = 60_000;
// Providers report one reset with jitter: WHAM derives it from
// reset_after_seconds and OAuth usage carries milliseconds. Resets of
// different cycles of one window are at least 5 hours apart.
const RESET_JITTER_MINUTES = 15;
// Skip a write when the subject/window already reported this value in this
// bucket, so the cost is about one write per window per bucket or new value,
// not one per relayed request, even while upstream replicas flap between two
// values. A skipped flap can leave last_used one step off, which the burn
// error already allows for.
const seenInBucket = new Map<string, { bucket: string; values: Set<number> }>();

function resetMs(value: QuotaSnapshotInput["resetAt"]) {
  if (value === null || value === undefined || value === "") return NaN;
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  return Date.parse(value);
}

export function recordQuotaSnapshots(
  provider: QuotaSnapshotProvider, subject: string, windows: QuotaSnapshotInput[], observedAtInput = Date.now(),
) {
  // STRICT INTEGER columns reject fractional milliseconds.
  const observedAt = Math.floor(observedAtInput);
  try {
    for (const window of windows) {
      const used = window.usedPercent;
      const reset = resetMs(window.resetAt);
      // A window without a reset time (Claude 5h before its first request)
      // cannot be assigned to a cycle; one whose reset passed is stale.
      if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || !Number.isFinite(reset) ||
        reset <= observedAt || !Number.isFinite(observedAt)) continue;
      // 0.15 * 100 is 15.000000000000002; keep reported steps comparable.
      const value = Math.round(Math.min(100, used) * 10_000) / 10_000;
      const bucket = Math.floor(observedAt / QUOTA_SNAPSHOT_BUCKET_MS);
      const minute = Math.round(reset / MINUTE);
      const memoKey = `${provider}\n${subject}\n${window.windowId}`;
      const bucketKey = `${minute}:${bucket}`;
      const seen = seenInBucket.get(memoKey);
      if (seen?.bucket === bucketKey && seen.values.has(value)) continue;
      writeSnapshot(provider, subject, window.windowId, minute, bucket, observedAt, value);
      if (seen?.bucket === bucketKey) seen.values.add(value);
      else {
        seenInBucket.delete(memoKey);
        if (seenInBucket.size >= 4096) seenInBucket.delete(seenInBucket.keys().next().value!);
        seenInBucket.set(memoKey, { bucket: bucketKey, values: new Set([value]) });
      }
    }
  } catch (error) {
    // Quota history is diagnostics; it must never fail a relayed request.
    console.warn("Recording quota snapshot failed", error);
  }
}

function writeSnapshot(
  provider: string, subject: string, windowId: string, minute: number, bucket: number, at: number, used: number,
) {
  const db = getLogDb();
  const existing = db.prepare(`SELECT reset_key FROM quota_snapshots
    WHERE provider = ? AND subject = ? AND window_id = ? AND reset_key BETWEEN ? AND ?
    ORDER BY ABS(reset_key - ?) LIMIT 1`).get(provider, subject, windowId,
    minute - RESET_JITTER_MINUTES, minute + RESET_JITTER_MINUTES, minute) as { reset_key: number } | undefined;
  db.prepare(`INSERT INTO quota_snapshots (provider, subject, window_id, reset_key, bucket,
      first_at, first_used, last_at, last_used, min_used, max_used, samples)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(provider, subject, window_id, reset_key, bucket) DO UPDATE SET
      first_used = CASE WHEN excluded.first_at < first_at THEN excluded.first_used ELSE first_used END,
      first_at = MIN(first_at, excluded.first_at),
      last_used = CASE WHEN excluded.last_at >= last_at THEN excluded.last_used ELSE last_used END,
      last_at = MAX(last_at, excluded.last_at),
      min_used = MIN(min_used, excluded.min_used),
      max_used = MAX(max_used, excluded.max_used),
      samples = samples + 1`)
    .run(provider, subject, windowId, existing?.reset_key ?? minute, bucket, at, used, at, used, used, used);
}

export function listQuotaSnapshots(
  provider: QuotaSnapshotProvider, subject: string, windowId: QuotaSnapshotWindow, since: number,
) {
  return getLogDb().prepare(`SELECT reset_key, bucket, first_at, first_used, last_at, last_used,
      min_used, max_used, samples
    FROM quota_snapshots
    WHERE provider = ? AND subject = ? AND window_id = ? AND last_at >= ?
    ORDER BY reset_key, bucket`).all(provider, subject, windowId, since) as unknown as QuotaSnapshotRow[];
}
