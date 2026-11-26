import "server-only";

import type { CredentialQuotaFloorState } from "@/src/shared/types/entities";

// Observations older than this are treated as unknown, never as below the floor.
export const QUOTA_FLOOR_MAX_AGE_MS = 60 * 60_000;

export interface QuotaFloorWindow {
  // Display name of the window, such as "7d 额度", reported as the trigger.
  label: string;
  remainingPercent: number | null;
  observedAt: number;
  resetAt: string | null;
  // Model family such as "opus"; null for windows shared by every model.
  scope: string | null;
}

// Callers pass only weekly windows: the 5h window is free to use up and is
// handled by the normal 429 cooldown. Without a scope matcher the account is
// evaluated for display: shared windows decide `skipped` and scoped windows are
// listed in `skipped_scopes`. With one, only the shared windows and the scoped
// windows of the requested model count.
export function evaluateQuotaFloor(
  windows: QuotaFloorWindow[], floor: number, now: number,
  matchesScope: ((scope: string) => boolean) | null,
): CredentialQuotaFloorState {
  // A window that has reset is unknown until a new observation arrives.
  const known = windows.filter((window) => window.remainingPercent !== null &&
    Number.isFinite(window.remainingPercent) && window.observedAt <= now &&
    now - window.observedAt < QUOTA_FLOOR_MAX_AGE_MS &&
    (!window.resetAt || Date.parse(window.resetAt) > now));
  const relevant = known.filter((window) => !window.scope || Boolean(matchesScope?.(window.scope)));
  const below = (window: QuotaFloorWindow) => floor > 0 && window.remainingPercent! <= floor;
  const triggers = (matchesScope === null ? known : relevant).filter(below);
  return {
    percent: floor,
    lowest_remaining_percent: relevant.length
      ? Math.min(...relevant.map((window) => window.remainingPercent!)) : null,
    skipped: relevant.some(below),
    skipped_scopes: matchesScope === null
      ? [...new Set(known.filter((window) => window.scope && below(window)).map((window) => window.scope!))]
      : [],
    triggered_by: triggers.map((window) => `${window.label} 剩余 ${Math.round(window.remainingPercent!)}%`),
  };
}
