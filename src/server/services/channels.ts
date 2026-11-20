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
  SelectedChannel,
  UpstreamOperation,
} from "@/src/shared/types/entities";
import { claudeModelAllowlistCandidates } from "@/src/server/claude/modelSuffix";
import { isClaudeModel } from "@/src/server/claude/chat";
import { isCodexImageModel } from "@/src/server/codex/imageModels";
import {
  ANTIGRAVITY_BASE_URL,
  antigravityModelName,
  antigravityStandardModel,
  isAntigravityGeminiModel,
  isAntigravityModelId,
  resolveAntigravityModel,
} from "@/src/server/antigravity/protocol";
import {
  getAntigravityCredentialWithTokens,
  listAntigravityCredentials,
  markAntigravityCredentialUsed,
  updateAntigravityCredentialHealth,
} from "@/src/server/repositories/antigravityCredentials";
import {
  CHANNEL_SUPPORTED_CAPABILITIES,
  defaultChannelCapabilities,
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
  getUpstreamCredentialWithSecret,
  listUpstreamCredentials,
  markUpstreamCredentialUsed,
  updateUpstreamCredential,
} from "@/src/server/repositories/upstreamCredentials";
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
  capabilities?: UpstreamOperation[];
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
  const credentialLabel = "name" in primaryCredential ? primaryCredential.name : primaryCredential.email;
  const channel = insertChannel({
    id: randomId("ch"),
    name:
      cleanString(input.name) ||
      (credentialLabel
        ? `${providerLabel(provider)} · ${credentialLabel}`
        : `${providerLabel(provider)} · ${primaryCredential.id}`),
    provider,
    baseUrl: normalizeBaseUrl(input.baseUrl, provider),
    credentialIds: credentials.map((credential) => credential.id),
    enabled: input.enabled ?? !isApiProvider(provider),
    priority: normalizeInteger(input.priority, 100),
    weight: Math.max(1, normalizeInteger(input.weight, 1)),
    modelAllowlist: normalizeModelAllowlist(provider, input.modelAllowlist),
    capabilities: normalizeCapabilities(provider, input.capabilities),
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
          baseUrl: normalizeBaseUrl(input.baseUrl, existing.provider),
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
      ? { modelAllowlist: normalizeModelAllowlist(existing.provider, input.modelAllowlist) }
      : {}),
    ...(input.capabilities !== undefined
      ? { capabilities: normalizeCapabilities(existing.provider, input.capabilities) }
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
  // This legacy entry point intentionally remains OAuth-only, including raw Codex requests.
  const provider = input.provider === "claude" ? "claude" : "codex";
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

export function selectChannelForRequest(input: {
  operation: UpstreamOperation;
  model: string;
  apiKey: RelayApiKeyContext;
  // Antigravity failover reselects only Antigravity channels and skips credentials already tried.
  provider?: ChannelProvider;
  excludeCredentialIds?: string[];
}): SelectedChannel {
  const model = cleanString(input.model);
  // Antigravity serves Gemini, Claude and GPT-OSS IDs listed on its channels; Gemini IDs exist nowhere else.
  const antigravityModel = antigravityModelName(model);
  const oauthProvider = isAntigravityGeminiModel(antigravityModel) ? "antigravity" : isClaudeModel(model) ? "claude" : "codex";
  const oauthModelCandidates = modelAllowlistCandidates(oauthProvider, model);
  if (input.apiKey.modelAllowlist.length > 0 && model &&
    !modelMatchesAllowlist(oauthModelCandidates, input.apiKey.modelAllowlist)) {
    throw new HttpError(403, "model_not_allowed", `API key is not allowed to use model: ${model}`);
  }
  const now = Date.now();
  // All request constraints are applied before any weighted selection or secret lookup.
  const channels = listChannelRecords().filter((channel) => {
    if (!supportsOperation(channel, input.operation)) return false;
    if (input.provider && channel.provider !== input.provider) return false;
    const api = isApiProvider(channel.provider);
    if (api) {
      if (!input.apiKey.channelAllowlist.includes(channel.id) ||
        channel.modelAllowlist.length === 0 || !channel.modelAllowlist.includes(model)) return false;
      if (input.apiKey.modelAllowlist.length > 0 && !input.apiKey.modelAllowlist.includes(model)) return false;
    } else if (channel.provider === "antigravity") {
      // An empty allowlist means every model in the bound accounts' catalogs, like empty OAuth allowlists.
      // Allowlists match by standard name, so "claude-opus-5-5" and "claude-opus-5-5-high" are one model.
      if (!isAntigravityModelId(antigravityModel) || (channel.modelAllowlist.length > 0 &&
        !channel.modelAllowlist.some(allowed => antigravityStandardModel(allowed) === antigravityStandardModel(model)))) return false;
    } else {
      if (channel.provider !== oauthProvider) return false;
      if ((input.operation === "images_generations" || input.operation === "images_edits") &&
        (channel.provider !== "codex" || !isCodexImageModel(model))) return false;
    }
    return isChannelAvailable(channel, input.apiKey, model,
      api ? [model] : oauthModelCandidates, now);
  });
  const maps = new Map<ChannelProvider, Map<string, CredentialRoutingRecord>>();
  for (const provider of new Set(channels.map((channel) => channel.provider))) {
    maps.set(provider, credentialRoutingMap(provider,
      channels.filter((channel) => channel.provider === provider).flatMap((channel) => channel.credentialIds)));
  }
  const excluded = new Set(input.excludeCredentialIds ?? []);
  const candidates = channels.flatMap((channel) => {
    const credentials = availableCredentialsForChannel(channel, maps.get(channel.provider)!, now)
      .filter((credential) => !excluded.has(credential.id) && antigravityServesModel(credential, model, now,
        channel.modelAllowlist.length === 0 && !isAntigravityGeminiModel(antigravityModel)));
    return credentials.length ? [{ channel, credentials }] : [];
  });
  if (!candidates.length) {
    throw new HttpError(503, "no_available_channel", "No usable channel is available for this request");
  }
  const selected = selectRoutingItem(candidates,
    (candidate) => candidate.channel.priority,
    (candidate) => candidate.channel.weight,
    (candidate) => usageHealthScore(candidate.channel.usageHealth));
  const selectedCredential = selectRoutingItem(selected.credentials,
    (credential) => credential.priority, (credential) => credential.weight,
    (credential) => usageHealthScore(credential.usageHealth));
  const credential = getCredentialWithTokens(selected.channel.provider, selectedCredential.id);
  if (!credential) throw new HttpError(503, "upstream_credential_not_found", "Selected channel credential was not found");
  const channel = { ...selected.channel, credentialId: credential.id };
  markChannelUsed(channel.id);
  markCredentialUsed(channel.provider, credential.id);
  return { channel, credential };
}

// Antigravity cools a model per credential and skips credentials whose catalog lacks the model, as in CPA.
// Claude and GPT-OSS IDs also exist on other providers, so an empty allowlist only takes them when the catalog
// is known to include them.
function antigravityServesModel(credential: RoutableCredentialRecord, model: string, now: number, requireCatalog: boolean) {
  if (credential.provider !== "antigravity") return true;
  const cooldown = credential.modelCooldowns[antigravityStandardModel(model)];
  if (cooldown && Date.parse(cooldown.until) > now) return false;
  if (!credential.models) return !requireCatalog;
  return resolveAntigravityModel(credential.models, model) !== null;
}

// Protocol conversions ride on the native capability: Anthropic Messages also serves Chat / Responses, and
// Codex Responses also serves Claude Messages and local token counting (as CPA does for Claude Code).
function supportsOperation(channel: ChannelRecord, operation: UpstreamOperation) {
  return channel.capabilities.includes(operation) ||
    (channel.provider === "anthropic" && (operation === "chat" || operation === "responses") &&
      channel.capabilities.includes("messages")) ||
    (channel.provider === "codex" && (operation === "messages" || operation === "count_tokens") &&
      channel.capabilities.includes("responses"));
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
  // Antigravity rate limits cool only the requested model on the credential (see antigravity/client.ts).
  if (channel.provider === "antigravity" && statusCode === 429) {
    updateChannel(channel.id, { lastError: input.message || null });
    return;
  }
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
  const credentials = availableCredentialsForChannel(channel, credentialsById, now);
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

function availableCredentialsForChannel(
  channel: ChannelRecord,
  credentialsById: Map<string, CredentialRoutingRecord>,
  now: number,
) {
  return channel.credentialIds
    .map((credentialId) => credentialsById.get(credentialId))
    .filter((credential): credential is CredentialRoutingRecord =>
      Boolean(
        credential?.enabled && credential.provider === channel.provider &&
        (!("keySet" in credential) || credential.keySet) &&
        (!credential.cooldownUntil ||
          Date.parse(credential.cooldownUntil) <= now),
      ),
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
    model && channel.provider !== "antigravity" &&
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
  if (provider === "antigravity") {
    return [...new Set([model, antigravityModelName(model), antigravityStandardModel(model)])].filter(Boolean);
  }
  if (isApiProvider(provider)) return [model].filter(Boolean);
  if (provider === "claude") {
    return claudeModelAllowlistCandidates(model);
  }
  const unprefixed = cleanString(model).replace(/^openai\//i, "");
  const baseModel = stripCodexModelThinkingSuffix(unprefixed);
  return [...new Set([model, unprefixed, baseModel].map(cleanString).filter(Boolean))];
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
  switch (provider) {
    case "claude": return listClaudeCredentials();
    case "codex": return listCodexCredentials();
    case "antigravity": return listAntigravityCredentials();
    case "openai":
    case "anthropic": return listUpstreamCredentials(provider);
  }
}

// Account label for request logs when the failing path never loaded the credential (e.g. a refresh error).
export function credentialLogLabel(provider: ChannelProvider, id: string | null | undefined) {
  if (!id) return "";
  const credential = listCredentials(provider).find((item) => item.id === id);
  if (!credential) return "";
  return "email" in credential ? credential.email : credential.name;
}

function getCredentialWithTokens(
  provider: ChannelProvider,
  id: string,
): RoutableCredentialWithTokens | null {
  switch (provider) {
    case "claude": return getClaudeCredentialWithTokens(id);
    case "codex": return getCodexCredentialWithTokens(id);
    case "antigravity": return getAntigravityCredentialWithTokens(id);
    case "openai":
    case "anthropic": {
      const credential = getUpstreamCredentialWithSecret(id);
      return credential?.provider === provider ? credential : null;
    }
  }
}

function markCredentialUsed(provider: ChannelProvider, id: string) {
  switch (provider) {
    case "claude": markClaudeCredentialUsed(id); break;
    case "codex": markCodexCredentialUsed(id); break;
    case "antigravity": markAntigravityCredentialUsed(id); break;
    case "openai":
    case "anthropic": markUpstreamCredentialUsed(id); break;
  }
}

function updateCredential(
  provider: ChannelProvider,
  id: string,
  patch: { cooldownUntil: string | null; lastError: string | null },
) {
  switch (provider) {
    case "claude": updateClaudeCredential(id, patch); break;
    case "codex": updateCodexCredential(id, patch); break;
    case "antigravity": updateAntigravityCredentialHealth(id, patch); break;
    case "openai":
    case "anthropic": updateUpstreamCredential(id, patch); break;
  }
}

function normalizeChannelProvider(value: unknown): ChannelProvider {
  if (value === undefined) return "codex";
  if (value === "codex" || value === "claude" || value === "openai" || value === "anthropic" || value === "antigravity") return value;
  throw new HttpError(400, "invalid_channel_provider", "Unsupported channel provider");
}

function isApiProvider(provider: ChannelProvider) {
  return provider === "openai" || provider === "anthropic";
}

function normalizeCapabilities(provider: ChannelProvider, input: unknown): UpstreamOperation[] {
  if (input === undefined) return defaultChannelCapabilities(provider);
  const supported = CHANNEL_SUPPORTED_CAPABILITIES[provider];
  if (!Array.isArray(input) || input.some((value) => !supported.includes(value))) {
    throw new HttpError(400, "invalid_channel_capabilities", "Capabilities are not supported by the channel provider");
  }
  return [...new Set(input)] as UpstreamOperation[];
}

function normalizeModelAllowlist(provider: ChannelProvider, input: unknown) {
  const models = cleanStringArray(input);
  if (provider === "antigravity" && models.some(model => !isAntigravityModelId(model))) {
    throw new HttpError(400, "invalid_antigravity_models", "Antigravity channels accept exact Gemini, Claude or GPT-OSS model IDs");
  }
  if (isApiProvider(provider) && models.length === 0) {
    throw new HttpError(400, "missing_channel_models", "API upstream channels require a non-empty model allowlist");
  }
  return models;
}

function normalizeBaseUrl(input: unknown, provider: ChannelProvider) {
  const value = cleanString(input) || defaultBaseUrl(provider);
  if (provider === "antigravity" && value.replace(/\/+$/, "") !== ANTIGRAVITY_BASE_URL) {
    throw new HttpError(400, "invalid_antigravity_endpoint", "Antigravity credentials require the Google Antigravity endpoint");
  }
  let url: URL;
  try { url = new URL(value); } catch {
    throw new HttpError(400, "invalid_channel_base_url", "Base URL must be an HTTP(S) URL without credentials, query or fragment");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password ||
    value.includes("?") || value.includes("#")) {
    throw new HttpError(400, "invalid_channel_base_url", "Base URL must be an HTTP(S) URL without credentials, query or fragment");
  }
  // API bases already include the version path; executors append only the endpoint.
  return url.toString().replace(/\/+$/, "");
}

function defaultBaseUrl(provider: ChannelProvider) {
  switch (provider) {
    case "claude": return serverConfig.claudeBaseUrl;
    case "codex": return serverConfig.codexBaseUrl;
    case "antigravity": return ANTIGRAVITY_BASE_URL;
    case "openai": return "https://api.openai.com/v1";
    case "anthropic": return "https://api.anthropic.com/v1";
  }
}

function providerLabel(provider: ChannelProvider) {
  switch (provider) {
    case "claude": return "Claude";
    case "codex": return "Codex";
    case "antigravity": return "Antigravity";
    case "openai": return "OpenAI";
    case "anthropic": return "Anthropic";
  }
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
