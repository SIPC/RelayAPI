import "server-only";

import { logServerError } from "@/src/server/http/errors";
import {
  listCodexCredentialsWithTokens,
  updateCodexCredential,
} from "@/src/server/repositories/codexCredentials";
import { refreshCodexCredentialForScheduler } from "@/src/server/services/codexCredentials";
import { getCodexAutoDisableRefreshExhaustedSetting } from "@/src/server/services/settings";
import type { CodexCredentialWithTokens } from "@/src/shared/types/entities";

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_LEAD_MS = 4 * DAY_MS;
const RETRY_DELAY_MS = DAY_MS;
const MAX_REFRESH_ATTEMPTS = 3;
const SCHEDULER_INTERVAL_MS = 60 * 60 * 1000;
const TOKEN_REFRESH_ERROR_PREFIX = "Codex token 自动刷新失败";

type SchedulerState = {
  running: boolean;
  timer?: ReturnType<typeof setInterval>;
  startedAt: string;
};

type GlobalWithScheduler = typeof globalThis & {
  __relayApiCodexCredentialRefreshScheduler?: SchedulerState;
};

export function startCodexCredentialRefreshScheduler() {
  const globalState = globalThis as GlobalWithScheduler;
  if (globalState.__relayApiCodexCredentialRefreshScheduler) {
    return;
  }

  const state: SchedulerState = {
    running: false,
    startedAt: new Date().toISOString(),
  };
  state.timer = setInterval(() => {
    void runSchedulerSafely(state);
  }, SCHEDULER_INTERVAL_MS);
  globalState.__relayApiCodexCredentialRefreshScheduler = state;

  void runSchedulerSafely(state);
}

export async function refreshExpiringCodexCredentials() {
  const now = Date.now();
  const autoDisable = getCodexAutoDisableRefreshExhaustedSetting();
  const credentials = listCodexCredentialsWithTokens();

  for (const credential of credentials) {
    if (credential.metadata.token_refresh_exhausted === true) {
      maybeAutoDisableExhaustedCredential(credential, autoDisable);
      continue;
    }
    if (!shouldAttemptScheduledRefresh(credential, now)) {
      continue;
    }
    try {
      await refreshCodexCredentialForScheduler(credential.id);
    } catch (error) {
      recordScheduledRefreshFailure(credential, error, { now, autoDisable });
    }
  }
}

async function runSchedulerSafely(state: SchedulerState) {
  if (state.running) {
    return;
  }
  state.running = true;
  try {
    await refreshExpiringCodexCredentials();
  } catch (error) {
    logServerError(error, {
      operation: "codex.refresh_scheduler",
      metadata: { startedAt: state.startedAt },
    });
  } finally {
    state.running = false;
  }
}

function shouldAttemptScheduledRefresh(
  credential: CodexCredentialWithTokens,
  now: number,
) {
  if (!credential.enabled) {
    return false;
  }
  const expiresAt = Date.parse(
    credential.expiresAt || credential.tokens.expired || "",
  );
  if (!Number.isFinite(expiresAt)) {
    return false;
  }
  if (expiresAt - now > REFRESH_LEAD_MS) {
    return false;
  }

  const nextAttemptAt = Date.parse(
    stringValue(credential.metadata.token_refresh_next_attempt_at),
  );
  return !Number.isFinite(nextAttemptAt) || nextAttemptAt <= now;
}

function maybeAutoDisableExhaustedCredential(
  credential: CodexCredentialWithTokens,
  autoDisable: boolean,
) {
  if (!autoDisable || !credential.enabled) {
    return;
  }
  updateCodexCredential(credential.id, {
    enabled: false,
    metadata: {
      ...credential.metadata,
      token_refresh_auto_disabled: true,
    },
  });
}

function recordScheduledRefreshFailure(
  credential: CodexCredentialWithTokens,
  error: unknown,
  input: { now: number; autoDisable: boolean },
) {
  const nowIso = new Date(input.now).toISOString();
  const nextAttemptAt = new Date(input.now + RETRY_DELAY_MS).toISOString();
  const previousAttemptCount = integerValue(
    credential.metadata.token_refresh_attempt_count,
  );
  const attemptCount = Math.min(MAX_REFRESH_ATTEMPTS, previousAttemptCount + 1);
  const exhausted = attemptCount >= MAX_REFRESH_ATTEMPTS;
  const message = errorMessage(error);
  const lastError = exhausted
    ? `${TOKEN_REFRESH_ERROR_PREFIX}超过 ${MAX_REFRESH_ATTEMPTS} 次：${message}`
    : credential.lastError;

  updateCodexCredential(credential.id, {
    enabled: exhausted && input.autoDisable ? false : credential.enabled,
    lastError,
    metadata: {
      ...credential.metadata,
      token_refresh_attempt_count: attemptCount,
      token_refresh_last_attempt_at: nowIso,
      token_refresh_last_failed_at: nowIso,
      token_refresh_last_error: message,
      token_refresh_next_attempt_at: exhausted ? undefined : nextAttemptAt,
      token_refresh_exhausted: exhausted ? true : undefined,
      token_refresh_exhausted_at: exhausted ? nowIso : undefined,
      token_refresh_auto_disabled:
        exhausted && input.autoDisable ? true : undefined,
    },
  });
}

function integerValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "Unknown refresh error";
}
