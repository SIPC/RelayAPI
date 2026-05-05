import "server-only";

import { getMainDb } from "@/src/server/db/sqlite";

type OAuthPendingStateRow = {
  state: string;
  provider: string;
  code_verifier: string;
  code_challenge: string;
  redirect_uri: string;
  created_at: string;
  expires_at: string;
};

export interface OAuthPendingStateRecord {
  state: string;
  provider: string;
  codeVerifier: string;
  codeChallenge: string;
  redirectUri: string;
  createdAt: string;
  expiresAt: string;
}

export function saveOAuthPendingState(input: OAuthPendingStateRecord) {
  pruneExpiredOAuthPendingStates();
  getMainDb()
    .prepare(
      `INSERT INTO oauth_pending_states (
        state, provider, code_verifier, code_challenge, redirect_uri,
        created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(state) DO UPDATE SET
        provider = excluded.provider,
        code_verifier = excluded.code_verifier,
        code_challenge = excluded.code_challenge,
        redirect_uri = excluded.redirect_uri,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at`,
    )
    .run(
      input.state,
      input.provider,
      input.codeVerifier,
      input.codeChallenge,
      input.redirectUri,
      input.createdAt,
      input.expiresAt,
    );
}

export function takeOAuthPendingState(
  state: string,
  provider = "codex",
): OAuthPendingStateRecord | null {
  pruneExpiredOAuthPendingStates();
  const row = getMainDb()
    .prepare(
      `SELECT * FROM oauth_pending_states
       WHERE state = ? AND lower(provider) = lower(?)`,
    )
    .get(state, provider) as OAuthPendingStateRow | undefined;
  if (!row) {
    return null;
  }
  getMainDb()
    .prepare("DELETE FROM oauth_pending_states WHERE state = ?")
    .run(state);
  return toOAuthPendingStateRecord(row);
}

export function pruneExpiredOAuthPendingStates(now = new Date()) {
  getMainDb()
    .prepare("DELETE FROM oauth_pending_states WHERE expires_at <= ?")
    .run(now.toISOString());
}

function toOAuthPendingStateRecord(
  row: OAuthPendingStateRow,
): OAuthPendingStateRecord {
  return {
    state: row.state,
    provider: row.provider,
    codeVerifier: row.code_verifier,
    codeChallenge: row.code_challenge,
    redirectUri: row.redirect_uri,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
