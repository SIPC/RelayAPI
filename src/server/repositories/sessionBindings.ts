import "server-only";

import { getMainDb } from "@/src/server/db/sqlite";
import { randomId } from "@/src/server/services/crypto";
import type { SelectedChannel } from "@/src/shared/types/entities";

type SessionBindingRow = {
  binding_key: string;
  channel_id: string;
  credential_id: string;
  generation: string;
  expires_at: number;
  cache_until: number;
  failed: number;
};

export interface SessionBinding {
  key: string;
  channelId: string;
  credentialId: string;
  generation: string;
  failed: boolean;
}

// Selection runs under the write lock, so different Node processes cannot
// independently reserve two accounts for the first requests of one session.
export function reserveSessionBinding(
  key: string,
  ttlMs: number,
  select: (binding: SessionBinding | null) => SelectedChannel,
) {
  const db = getMainDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const now = Date.now();
    db.prepare("DELETE FROM session_bindings WHERE expires_at <= ?").run(now);
    const row = db.prepare("SELECT * FROM session_bindings WHERE binding_key = ?")
      .get(key) as SessionBindingRow | undefined;
    const previous: SessionBinding | null = row ? {
      key, channelId: row.channel_id, credentialId: row.credential_id,
      generation: row.generation, failed: Boolean(row.failed),
    } : null;
    const selected = select(previous);
    if (selected.channel.provider !== "claude") {
      db.exec("COMMIT");
      return { selected, binding: null };
    }
    const binding: SessionBinding = previous && !previous.failed &&
      previous.channelId === selected.channel.id && previous.credentialId === selected.credential.id
      ? previous : { key, channelId: selected.channel.id, credentialId: selected.credential.id,
        generation: randomId("aff"), failed: false };
    if (binding !== previous) {
      // Bound the table even when callers keep supplying unique session IDs.
      db.prepare(`DELETE FROM session_bindings WHERE binding_key IN (
        SELECT binding_key FROM session_bindings ORDER BY expires_at DESC LIMIT -1 OFFSET 65535
      )`).run();
      db.prepare(`INSERT INTO session_bindings
        (binding_key, channel_id, credential_id, generation, expires_at, cache_until, failed)
        VALUES (?, ?, ?, ?, ?, 0, 0)
        ON CONFLICT(binding_key) DO UPDATE SET channel_id = excluded.channel_id,
          credential_id = excluded.credential_id, generation = excluded.generation,
          expires_at = excluded.expires_at, cache_until = 0, failed = 0`)
        .run(key, binding.channelId, binding.credentialId, binding.generation, now + ttlMs);
    }
    db.exec("COMMIT");
    return { selected, binding };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function completeSessionBinding(binding: SessionBinding, cacheUntil: number) {
  // A shorter helper request must not shrink a still-warm one-hour binding.
  // Selection alone, errors, and token counting never refresh confirmed TTLs.
  return getMainDb().prepare(`UPDATE session_bindings
    SET expires_at = MAX(cache_until, ?), cache_until = MAX(cache_until, ?)
    WHERE binding_key = ? AND generation = ? AND failed = 0`)
    .run(cacheUntil, cacheUntil, binding.key, binding.generation).changes > 0;
}

export function failSessionBinding(binding: SessionBinding) {
  // Keep the failed account as a hint to avoid on the next cold selection.
  // A late result from an old generation cannot invalidate a rebound session.
  getMainDb().prepare(`UPDATE session_bindings SET failed = 1
    WHERE binding_key = ? AND generation = ?`).run(binding.key, binding.generation);
}
