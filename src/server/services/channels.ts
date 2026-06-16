import "server-only";

import type {
  ChannelProvider,
  ChannelRecord,
  ClaudeCredentialWithTokens,
  CodexAccountUsageHealth,
  CodexCredentialWithTokens,
  RelayApiKeyContext,
  RoutableCredentialRecord,
  RoutableCredentialWithTokens,
} from "@/src/shared/types/entities";
import { claudeModelAllowlistCandidates } from "@/src/server/claude/modelSuffix";
import {
  deleteChannel,
  getChannelById,
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
  getClaudeCredentialWithTokens,
  listClaudeCredentials,
  markClaudeCredentialUsed,
  updateClaudeCredential,
} from "@/src/server/repositories/claudeCredentials";
import {
  appendChannelHealthEvent,
  channelUsageHealth,
  credentialUsageHealth,
} from "@/src/server/repositories/logs";
import { serverConfig } from "@/src/server/config/env";
import { randomId } from "@/src/server/services/crypto";
import { HttpError } from "@/src/server/http/errors";

const CODEX_THINKING_SUFFIX_LEVELS = new Set([
  "none",
  "auto",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export interface CreateChannelInput {
  provider?: ChannelProvider;
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
  const provider = normalizeChannelProvider(input.provider);
  const credentials = assertChannelCredentials(provider, input);
  const primaryCredential = credentials[0];
  const channel = insertChannel({
    id: randomId("ch"),
    name:
      cleanString(input.name) ||
      (primaryCredential.email
        ? `${providerLabel(provider)} · ${primaryCredential.email}`
        : `${providerLabel(provider)} · ${primaryCredential.id}`),
    provider,
    baseUrl: cleanString(input.baseUrl) || defaultBaseUrl(provider),
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
  const existing = getChannelById(id);
  if (!existing) {
    throw new HttpError(404, "channel_not_found", "Channel not found");
  }
  if (input.provider !== undefined && input.provider !== existing.provider) {
    throw new HttpError(
      400,
      "channel_provider_immutable",
      "Channel provider cannot be changed after creation",
    );
  }
  const credentialPatch =
    input.credentialIds !== undefined || input.credentialId !== undefined
      ? {
          credentialIds: assertChannelCredentials(existing.provider, input).map(
            (credential) => credential.id,
          ),
        }
      : {};
  const channel = updateChannel(id, {
    ...(input.name !== undefined ? { name: cleanString(input.name) } : {}),
    ...(input.baseUrl !== undefined
      ? {
          baseUrl:
            cleanString(input.baseUrl) || defaultBaseUrl(existing.provider),
        }
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
  provider: "claude";
  model: string;
  apiKey: RelayApiKeyContext;
}): { channel: ChannelRecord; credential: ClaudeCredentialWithTokens };
export function selectChannel(input: {
  provider?: "codex";
  model: string;
  apiKey: RelayApiKeyContext;
}): { channel: ChannelRecord; credential: CodexCredentialWithTokens };
export function selectChannel(input: {
  provider?: ChannelProvider;
  model: string;
  apiKey: RelayApiKeyContext;
}) {
  const provider = normalizeChannelProvider(input.provider);
  const model = cleanString(input.model);
  const modelCandidates = modelAllowlistCandidates(provider, model);
  if (
    input.apiKey.modelAllowlist.length > 0 &&
    model &&
    !modelMatchesAllowlist(modelCandidates, input.apiKey.modelAllowlist)
  ) {
    throw new HttpError(
      403,
      "model_not_allowed",
      `API key is not allowed to use model: ${model}`,
    );
  }

  const channels = listChannelRecords().filter(
    (channel) => channel.provider === provider,
  );
  const credentialIds = channels.flatMap((channel) => channel.credentialIds);
  const credentialsById = credentialRoutingMap(provider, credentialIds);
  const now = Date.now();
  const candidates = channels.flatMap((channel) => {
    if (
      !isChannelAvailable(channel, input.apiKey, model, modelCandidates, now)
    ) {
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
      `No usable ${providerLabel(provider)} channel is available for this request`,
    );
  }

  const selected = selectRoutingItem(
    candidates,
    (candidate) => candidate.channel.priority,
    (candidate) => candidate.channel.weight,
    (candidate) => usageHealthScore(candidate.channel.usageHealth),
  );
  const credential = getCredentialWithTokens(provider, selected.credential.id);
  if (!credential) {
    throw new HttpError(
      503,
      `${provider}_credential_not_found`,
      `Selected ${providerLabel(provider)} channel credential was not found`,
    );
  }
  const channel = { ...selected.channel, credentialId: credential.id };
  markChannelUsed(channel.id);
  markCredentialUsed(provider, credential.id);
  return { channel, credential };
}

export function recordChannelSuccess(channel: ChannelRecord) {
  clearCredentialCooldown(channel.provider, channel.credentialId);
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
    const cooldownUntil = recordCredentialFailure(
      channel.provider,
      channel.credentialId,
      input,
    );
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

  const penalty = statusCode && statusCode >= 500 ? 15 : 8;
  const nextScore = clamp(channel.healthScore - penalty, 0, 100);
  const next = updateChannel(channel.id, {
    status: nextScore >= 60 ? "healthy" : "degraded",
    healthScore: nextScore,
    cooldownUntil: null,
    lastError: input.message || null,
  });
  appendChannelHealthEvent({
    channelId: channel.id,
    channelName: channel.name,
    credentialId: channel.credentialId,
    eventType: "failure",
    statusCode,
    healthScore: next?.healthScore ?? nextScore,
    cooldownUntil: null,
    message: input.message || null,
  });
}

function isCredentialScopedFailure(statusCode: number | null) {
  return statusCode === 401 || statusCode === 403 || statusCode === 429;
}

function recordCredentialFailure(
  provider: ChannelProvider,
  credentialId: string,
  input: { statusCode?: number | null; message?: string | null },
) {
  const statusCode = input.statusCode ?? null;
  const cooldownMs = statusCode === 429 ? 5 * 60 * 1000 : 15 * 60 * 1000;
  const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
  updateCredential(provider, credentialId, {
    cooldownUntil,
    lastError: input.message || null,
  });
  return cooldownUntil;
}

function clearCredentialCooldown(
  provider: ChannelProvider,
  credentialId: string,
) {
  updateCredential(provider, credentialId, {
    cooldownUntil: null,
    lastError: null,
  });
}

type CredentialRoutingRecord = RoutableCredentialRecord & {
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

function credentialRoutingMap(
  provider: ChannelProvider,
  credentialIds: string[],
) {
  const requestedIds = new Set(cleanStringArray(credentialIds));
  const credentials = listCredentials(provider).filter((credential) =>
    requestedIds.has(credential.id),
  );
  const healthByCredentialId = credentialUsageHealth(
    credentials.map((credential) => credential.id),
    { resetSinceById: credentialUsageHealthResetMap(credentials) },
  );
  return new Map(
    credentials.map((credential) => [
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
  modelCandidates: string[],
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
    !modelMatchesAllowlist(modelCandidates, channel.modelAllowlist)
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

function assertChannelCredentials(
  provider: ChannelProvider,
  input: Pick<CreateChannelInput, "credentialId" | "credentialIds">,
) {
  const credentialIds = cleanStringArray([
    ...(Array.isArray(input.credentialIds) ? input.credentialIds : []),
    ...(input.credentialId ? [input.credentialId] : []),
  ]);
  if (credentialIds.length === 0) {
    throw new HttpError(
      400,
      "missing_channel_credentials",
      `Channel must include at least one ${providerLabel(provider)} credential`,
    );
  }
  return credentialIds.map((credentialId) => {
    const credential = getCredentialWithTokens(provider, credentialId);
    if (!credential) {
      throw new HttpError(
        400,
        `${provider}_credential_not_found`,
        `Cannot bind channel to a missing ${providerLabel(provider)} credential`,
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

function credentialUsageHealthResetMap(
  credentials: Array<Pick<RoutableCredentialRecord, "id" | "metadata">>,
) {
  return Object.fromEntries(
    credentials.map((credential) => [
      credential.id,
      cleanString(credential.metadata.usage_health_reset_at) || null,
    ]),
  );
}

function modelAllowlistCandidates(provider: ChannelProvider, model: string) {
  if (provider === "claude") {
    return claudeModelAllowlistCandidates(model);
  }
  const baseModel = stripCodexModelThinkingSuffix(model);
  return [...new Set([model, baseModel].map(cleanString).filter(Boolean))];
}

function modelMatchesAllowlist(candidates: string[], allowlist: string[]) {
  const candidateSet = new Set(candidates.map(cleanString).filter(Boolean));
  return allowlist.some((allowed) => candidateSet.has(cleanString(allowed)));
}

function stripCodexModelThinkingSuffix(model: string) {
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
  if (!baseModel || !isCodexThinkingSuffix(suffix)) {
    return value;
  }
  return baseModel;
}

function isCodexThinkingSuffix(suffix: string) {
  return CODEX_THINKING_SUFFIX_LEVELS.has(suffix) || /^\d+$/.test(suffix);
}

function listCredentials(
  provider: ChannelProvider,
): RoutableCredentialRecord[] {
  return provider === "claude"
    ? listClaudeCredentials()
    : listCodexCredentials();
}

function getCredentialWithTokens(
  provider: ChannelProvider,
  id: string,
): RoutableCredentialWithTokens | null {
  return provider === "claude"
    ? getClaudeCredentialWithTokens(id)
    : getCodexCredentialWithTokens(id);
}

function markCredentialUsed(provider: ChannelProvider, id: string) {
  if (provider === "claude") {
    markClaudeCredentialUsed(id);
    return;
  }
  markCodexCredentialUsed(id);
}

function updateCredential(
  provider: ChannelProvider,
  id: string,
  patch: { cooldownUntil: string | null; lastError: string | null },
) {
  if (provider === "claude") {
    updateClaudeCredential(id, patch);
    return;
  }
  updateCodexCredential(id, patch);
}

function normalizeChannelProvider(value: unknown): ChannelProvider {
  return value === "claude" ? "claude" : "codex";
}

function defaultBaseUrl(provider: ChannelProvider) {
  return provider === "claude"
    ? serverConfig.claudeBaseUrl
    : serverConfig.codexBaseUrl;
}

function providerLabel(provider: ChannelProvider) {
  return provider === "claude" ? "Claude" : "Codex";
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
