import "server-only";

import type {
  ChannelRecord,
  CodexAccountUsageHealth,
  CodexCredentialRecord,
  RelayApiKeyContext,
} from "@/src/shared/types/entities";
import {
  deleteChannel,
  insertChannel,
  listChannels,
  markChannelUsed,
  updateChannel,
} from "@/src/server/repositories/channels";
import {
  getCodexCredentialWithTokens,
  listCodexCredentials,
  markCodexCredentialUsed,
  updateCodexCredential,
} from "@/src/server/repositories/codexCredentials";
import {
  appendChannelHealthEvent,
  channelUsageHealth,
  credentialUsageHealth,
} from "@/src/server/repositories/logs";
import { serverConfig } from "@/src/server/config/env";
import { randomId } from "@/src/server/services/crypto";
import { HttpError } from "@/src/server/http/errors";

const THINKING_SUFFIX_LEVELS = new Set([
  "none",
  "auto",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export interface CreateChannelInput {
  name?: string;
  baseUrl?: string;
  credentialId?: string;
  credentialIds?: string[];
  enabled?: boolean;
  priority?: number;
  weight?: number;
  modelAllowlist?: string[];
}

export function listChannelRecords() {
  const channels = listChannels();
  const healthByChannelId = channelUsageHealth(
    channels.map((channel) => channel.id),
  );
  return channels.map((channel) =>
    attachChannelUsageHealth(channel, healthByChannelId[channel.id]),
  );
}

export function createChannel(input: CreateChannelInput) {
  const credentials = assertChannelCredentials(input);
  const primaryCredential = credentials[0];
  const channel = insertChannel({
    id: randomId("ch"),
    name:
      cleanString(input.name) ||
      (primaryCredential.email
        ? `Codex · ${primaryCredential.email}`
        : `Codex · ${primaryCredential.id}`),
    baseUrl: cleanString(input.baseUrl) || serverConfig.codexBaseUrl,
    credentialIds: credentials.map((credential) => credential.id),
    enabled: input.enabled ?? true,
    priority: normalizeInteger(input.priority, 100),
    weight: Math.max(1, normalizeInteger(input.weight, 1)),
    modelAllowlist: cleanStringArray(input.modelAllowlist),
    status: "healthy",
  });
  if (!channel) {
    throw new Error("Failed to create channel");
  }
  return channel;
}

export function patchChannel(
  id: string,
  input: Partial<CreateChannelInput> & {
    status?: ChannelRecord["status"];
    healthScore?: number;
    cooldownUntil?: string | null;
  },
) {
  const credentialPatch =
    input.credentialIds !== undefined || input.credentialId !== undefined
      ? {
          credentialIds: assertChannelCredentials(input).map(
            (credential) => credential.id,
          ),
        }
      : {};
  const channel = updateChannel(id, {
    ...(input.name !== undefined ? { name: cleanString(input.name) } : {}),
    ...(input.baseUrl !== undefined
      ? { baseUrl: cleanString(input.baseUrl) || serverConfig.codexBaseUrl }
      : {}),
    ...credentialPatch,
    ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
    ...(input.priority !== undefined
      ? { priority: normalizeInteger(input.priority, 100) }
      : {}),
    ...(input.weight !== undefined
      ? { weight: Math.max(1, normalizeInteger(input.weight, 1)) }
      : {}),
    ...(input.modelAllowlist !== undefined
      ? { modelAllowlist: cleanStringArray(input.modelAllowlist) }
      : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.healthScore !== undefined
      ? { healthScore: clamp(Number(input.healthScore), 0, 100) }
      : {}),
    ...(input.cooldownUntil !== undefined
      ? { cooldownUntil: cleanString(input.cooldownUntil) || null }
      : {}),
  });
  if (!channel) {
    throw new HttpError(404, "channel_not_found", "Channel not found");
  }
  return channel;
}

export function removeChannel(id: string) {
  if (!deleteChannel(id)) {
    throw new HttpError(404, "channel_not_found", "Channel not found");
  }
}

export function selectChannel(input: {
  model: string;
  apiKey: RelayApiKeyContext;
}) {
  const model = cleanString(input.model);
  const baseModel = stripModelThinkingSuffix(model);
  if (
    input.apiKey.modelAllowlist.length > 0 &&
    model &&
    !modelMatchesAllowlist(model, baseModel, input.apiKey.modelAllowlist)
  ) {
    throw new HttpError(
      403,
      "model_not_allowed",
      `API key is not allowed to use model: ${model}`,
    );
  }

  const channels = listChannelRecords();
  const credentialIds = channels.flatMap((channel) => channel.credentialIds);
  const credentialsById = credentialRoutingMap(credentialIds);
  const now = Date.now();
  const candidates = channels.flatMap((channel) => {
    if (!isChannelAvailable(channel, input.apiKey, model, baseModel, now)) {
      return [];
    }
    const credential = selectCredentialForChannel(
      channel,
      credentialsById,
      now,
    );
    if (!credential) {
      return [];
    }
    const channelForRequest = { ...channel, credentialId: credential.id };
    return [{ channel: channelForRequest, credential }];
  });

  if (candidates.length === 0) {
    throw new HttpError(
      503,
      "no_available_channel",
      "No usable channel is available for this request",
    );
  }

  const selected = selectRoutingItem(
    candidates,
    (candidate) => candidate.channel.priority,
    (candidate) => candidate.channel.weight,
    (candidate) => usageHealthScore(candidate.channel.usageHealth),
  );
  const credential = getCodexCredentialWithTokens(selected.credential.id);
  if (!credential) {
    throw new HttpError(
      503,
      "codex_credential_not_found",
      "Selected channel credential was not found",
    );
  }
  const channel = { ...selected.channel, credentialId: credential.id };
  markChannelUsed(channel.id);
  markCodexCredentialUsed(credential.id);
  return { channel, credential };
}

export function recordChannelSuccess(channel: ChannelRecord) {
  clearCredentialCooldown(channel.credentialId);
  const nextScore = clamp(channel.healthScore + 2, 0, 100);
  const next = updateChannel(channel.id, {
    status: nextScore >= 60 ? "healthy" : "degraded",
    healthScore: nextScore,
    cooldownUntil: null,
    lastError: null,
  });
  appendChannelHealthEvent({
    channelId: channel.id,
    channelName: channel.name,
    credentialId: channel.credentialId,
    eventType: "success",
    healthScore: next?.healthScore ?? nextScore,
  });
}

export function recordChannelFailure(
  channel: ChannelRecord,
  input: { statusCode?: number | null; message?: string | null },
) {
  const statusCode = input.statusCode ?? null;
  if (isCredentialScopedFailure(statusCode)) {
    const cooldownUntil = recordCredentialFailure(channel.credentialId, input);
    updateChannel(channel.id, { lastError: input.message || null });
    appendChannelHealthEvent({
      channelId: channel.id,
      channelName: channel.name,
      credentialId: channel.credentialId,
      eventType: "credential_failure",
      statusCode,
      healthScore: channel.healthScore,
      cooldownUntil,
      message: input.message || null,
    });
    return;
  }

  let penalty = 8;
  let cooldownMs = 0;
  if (statusCode && statusCode >= 500) {
    penalty = 15;
    cooldownMs = 60 * 1000;
  }
  const nextScore = clamp(channel.healthScore - penalty, 0, 100);
  const cooldownUntil = cooldownMs
    ? new Date(Date.now() + cooldownMs).toISOString()
    : null;
  const next = updateChannel(channel.id, {
    status: cooldownUntil
      ? "cooling_down"
      : nextScore >= 40
        ? "degraded"
        : "cooling_down",
    healthScore: nextScore,
    cooldownUntil,
    lastError: input.message || null,
  });
  appendChannelHealthEvent({
    channelId: channel.id,
    channelName: channel.name,
    credentialId: channel.credentialId,
    eventType: "failure",
    statusCode,
    healthScore: next?.healthScore ?? nextScore,
    cooldownUntil,
    message: input.message || null,
  });
}

function isCredentialScopedFailure(statusCode: number | null) {
  return statusCode === 401 || statusCode === 403 || statusCode === 429;
}

function recordCredentialFailure(
  credentialId: string,
  input: { statusCode?: number | null; message?: string | null },
) {
  const statusCode = input.statusCode ?? null;
  const cooldownMs = statusCode === 429 ? 5 * 60 * 1000 : 15 * 60 * 1000;
  const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
  updateCodexCredential(credentialId, {
    cooldownUntil,
    lastError: input.message || null,
  });
  return cooldownUntil;
}

function clearCredentialCooldown(credentialId: string) {
  updateCodexCredential(credentialId, {
    cooldownUntil: null,
    lastError: null,
  });
}

type CredentialRoutingRecord = CodexCredentialRecord & {
  usageHealth: CodexAccountUsageHealth;
};

type RoutingCandidate<T> = {
  item: T;
  priority: number;
  weight: number;
  healthScore: number;
};

function attachChannelUsageHealth(
  channel: ChannelRecord,
  usageHealth?: CodexAccountUsageHealth,
): ChannelRecord {
  const health = usageHealth || unusedUsageHealth(100);
  return { ...channel, usageHealth: health, healthScore: health.score };
}

function credentialRoutingMap(credentialIds: string[]) {
  const requestedIds = new Set(cleanStringArray(credentialIds));
  const healthByCredentialId = credentialUsageHealth([...requestedIds]);
  return new Map(
    listCodexCredentials()
      .filter((credential) => requestedIds.has(credential.id))
      .map((credential) => [
        credential.id,
        {
          ...credential,
          usageHealth:
            healthByCredentialId[credential.id] || unusedUsageHealth(50),
        },
      ]),
  );
}

function selectCredentialForChannel(
  channel: ChannelRecord,
  credentialsById: Map<string, CredentialRoutingRecord>,
  now: number,
) {
  const credentials = channel.credentialIds
    .map((credentialId) => credentialsById.get(credentialId))
    .filter((credential): credential is CredentialRoutingRecord =>
      Boolean(
        credential?.enabled &&
        (!credential.cooldownUntil ||
          Date.parse(credential.cooldownUntil) <= now),
      ),
    );
  if (credentials.length === 0) {
    return null;
  }
  return selectRoutingItem(
    credentials,
    (credential) => credential.priority,
    (credential) => credential.weight,
    (credential) => usageHealthScore(credential.usageHealth),
  );
}

function isChannelAvailable(
  channel: ChannelRecord,
  apiKey: RelayApiKeyContext,
  model: string,
  baseModel: string,
  now: number,
) {
  if (!channel.enabled || channel.status === "disabled") {
    return false;
  }
  if (channel.cooldownUntil && Date.parse(channel.cooldownUntil) > now) {
    return false;
  }
  if (
    channel.modelAllowlist.length > 0 &&
    model &&
    !modelMatchesAllowlist(model, baseModel, channel.modelAllowlist)
  ) {
    return false;
  }
  if (
    apiKey.channelAllowlist.length > 0 &&
    !apiKey.channelAllowlist.includes(channel.id)
  ) {
    return false;
  }
  return channel.credentialIds.length > 0;
}

function assertChannelCredentials(input: CreateChannelInput) {
  const credentialIds = cleanStringArray([
    ...(Array.isArray(input.credentialIds) ? input.credentialIds : []),
    ...(input.credentialId ? [input.credentialId] : []),
  ]);
  if (credentialIds.length === 0) {
    throw new HttpError(
      400,
      "missing_channel_credentials",
      "Channel must include at least one Codex credential",
    );
  }
  return credentialIds.map((credentialId) => {
    const credential = getCodexCredentialWithTokens(credentialId);
    if (!credential) {
      throw new HttpError(
        400,
        "codex_credential_not_found",
        "Cannot bind channel to a missing Codex credential",
      );
    }
    return credential;
  });
}

function selectRoutingItem<T>(
  items: T[],
  getPriority: (item: T) => number,
  getWeight: (item: T) => number,
  getHealthScore: (item: T) => number,
) {
  const candidates = items.map((item) => ({
    item,
    priority: getPriority(item),
    weight: getWeight(item),
    healthScore: getHealthScore(item),
  }));
  const healthTiers = [80, 50, 1];
  for (const tier of healthTiers) {
    const tierCandidates = candidates.filter(
      (candidate) => candidate.healthScore >= tier,
    );
    if (tierCandidates.length > 0) {
      return weightedPickHighestPriority(tierCandidates).item;
    }
  }
  return weightedPickHighestPriority(candidates).item;
}

function weightedPickHighestPriority<T>(candidates: RoutingCandidate<T>[]) {
  const maxPriority = Math.max(
    ...candidates.map((candidate) => candidate.priority),
  );
  const priorityCandidates = candidates.filter(
    (candidate) => candidate.priority === maxPriority,
  );
  const totalWeight = priorityCandidates.reduce(
    (sum, candidate) => sum + routingWeight(candidate),
    0,
  );
  let cursor = Math.random() * totalWeight;
  for (const candidate of priorityCandidates) {
    cursor -= routingWeight(candidate);
    if (cursor <= 0) {
      return candidate;
    }
  }
  return priorityCandidates[0];
}

function routingWeight(candidate: { weight: number; healthScore: number }) {
  return Math.max(1, candidate.weight) * Math.max(1, candidate.healthScore);
}

function usageHealthScore(health: CodexAccountUsageHealth | undefined) {
  return clamp(health?.score ?? 100, 0, 100);
}

function unusedUsageHealth(windowSize: number): CodexAccountUsageHealth {
  return {
    status: "unused",
    score: 100,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    lastUsedAt: null,
    lastStatusCode: null,
    lastErrorCode: null,
    windowSize,
  };
}

function modelMatchesAllowlist(
  model: string,
  baseModel: string,
  allowlist: string[],
) {
  return allowlist.some((allowed) => {
    const cleanAllowed = cleanString(allowed);
    return cleanAllowed === model || cleanAllowed === baseModel;
  });
}

function stripModelThinkingSuffix(model: string) {
  const value = cleanString(model);
  const lastOpen = value.lastIndexOf("(");
  if (lastOpen <= 0 || !value.endsWith(")")) {
    return value;
  }
  const baseModel = value.slice(0, lastOpen).trim();
  const suffix = value
    .slice(lastOpen + 1, -1)
    .trim()
    .toLowerCase();
  if (!baseModel || !isThinkingSuffix(suffix)) {
    return value;
  }
  return baseModel;
}

function isThinkingSuffix(suffix: string) {
  return THINKING_SUFFIX_LEVELS.has(suffix) || /^\d+$/.test(suffix);
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map(cleanString).filter(Boolean))];
}

function normalizeInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}
