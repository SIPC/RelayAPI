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
import { claudeModelAllowlistCandidates, stripClaudeModelSuffixes } from "@/src/server/claude/modelSuffix";
import { claudeCacheTtlMs, claudeSessionId } from "@/src/server/claude/wire";
import { isClaudeModel } from "@/src/server/claude/chat";
import { isCodexImageModel } from "@/src/server/codex/imageModels";
import {
  ANTIGRAVITY_BASE_URL,
  antigravityModelName,
  antigravityStandardModel,
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
import { randomId, sha256 } from "@/src/server/services/crypto";
import {
  completeSessionBinding, failSessionBinding, reserveSessionBinding, type SessionBinding,
} from "@/src/server/repositories/sessionBindings";
import { HttpError } from "@/src/server/http/errors";
import { claudeQuotaFloorState, claudeQuotaRouting } from "@/src/server/services/claudeQuota";
import { codexQuotaFloorState } from "@/src/server/services/codexQuota";
import { getCredentialQuotaFloorPercent } from "@/src/server/services/settings";

// Only request-local completion state lives in memory; account bindings live in SQLite.
const claudeSessions = new WeakMap<ChannelRecord, {
  binding: SessionBinding; sessionId: string; ttlMs: number; startedAt: number; upstreamStarted: boolean;
}>();

export function claudeChannelSession(channel: ChannelRecord) {
  return claudeSessions.get(channel);
}

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
  quotaWeighted?: boolean;
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

// Quota disclosure requires explicit bindings, even though an empty channel
// allowlist permits OAuth generation. Do not select a route or mark it used.
export function listCodexQuotaCredentials(apiKey: RelayApiKeyContext) {
  const channels = listChannels().filter((channel) =>
    channel.provider === "codex" && channel.enabled && channel.status !== "disabled" &&
    channel.capabilities.length > 0 && apiKey.channelAllowlist.includes(channel.id) &&
    (apiKey.modelAllowlist.length === 0 || channel.modelAllowlist.length === 0 ||
      apiKey.modelAllowlist.some((model) => modelMatchesAllowlist(
        modelAllowlistCandidates("codex", model), channel.modelAllowlist,
      ))),
  );
  const now = Date.now();
  return listCodexCredentials().filter((credential) =>
    credential.enabled && channels.some((channel) => channel.credentialIds.includes(credential.id)),
  ).map((credential) => ({
    credential,
    routingState: (credential.cooldownUntil && Date.parse(credential.cooldownUntil) > now) ||
      channels.filter((channel) => channel.credentialIds.includes(credential.id))
        .every((channel) => channel.cooldownUntil && Date.parse(channel.cooldownUntil) > now)
      ? "cooldown" as const : "eligible" as const,
  })).sort((a, b) => a.credential.id.localeCompare(b.credential.id));
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
    quotaWeighted: provider === "claude" && input.quotaWeighted === true,
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
    ...(input.quotaWeighted !== undefined
      ? { quotaWeighted: existing.provider === "claude" && input.quotaWeighted === true }
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
  const floor = quotaFloorFilter(model, now);
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
      model,
      floor,
    );
    if (!credential) {
      return [];
    }
    const channelForRequest = { ...channel, credentialId: credential.id };
    return [{ channel: channelForRequest, credential }];
  });

  if (candidates.length === 0) {
    throw floor.skipped.size ? quotaFloorError(floor.percent)
      : new HttpError(
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
  request?: { payload: Record<string, unknown>; headers: Headers };
  // Antigravity failover reselects only Antigravity channels and skips credentials already tried.
  provider?: ChannelProvider;
  excludeCredentialIds?: string[];
}): SelectedChannel {
  if (!input.request || input.operation === "count_tokens" || !isClaudeModel(input.model) ||
    (input.provider && input.provider !== "claude")) return selectRequestChannel(input);
  const sessionId = claudeSessionId(input.request.payload, input.request.headers);
  // Include configured endpoints, but not health, priority or cooldown: recovery
  // must not silently move an established session back to its old account.
  const domain = listChannels().filter((channel) => channel.provider === "claude" &&
    (!input.apiKey.channelAllowlist.length || input.apiKey.channelAllowlist.includes(channel.id)))
    .map((channel) => [channel.id, channel.baseUrl]).sort((a, b) => a[0].localeCompare(b[0]));
  const key = sha256(JSON.stringify([input.apiKey.id, "claude", domain,
    stripClaudeModelSuffixes(input.model), sessionId]));
  const ttlMs = claudeCacheTtlMs(input.request.payload);
  const { selected, binding } = reserveSessionBinding(key, ttlMs,
    (previous) => selectRequestChannel(input, previous));
  if (binding) claudeSessions.set(selected.channel, {
    binding, sessionId, ttlMs, startedAt: Date.now(), upstreamStarted: false,
  });
  return selected;
}

function selectRequestChannel(
  input: Parameters<typeof selectChannelForRequest>[0],
  binding?: SessionBinding | null,
): SelectedChannel {
  const model = cleanString(input.model);
  // Antigravity only serves Gemini, regardless of its catalog or persisted channel allowlist.
  const antigravityModel = antigravityModelName(model);
  const oauthProvider = isAntigravityModelId(antigravityModel) ? "antigravity" : isClaudeModel(model) ? "claude" : "codex";
  const oauthModelCandidates = modelAllowlistCandidates(oauthProvider, model);
  const keyAllowsOAuth = input.apiKey.modelAllowlist.length === 0 || !model ||
    modelMatchesAllowlist(oauthModelCandidates, input.apiKey.modelAllowlist);
  if (!keyAllowsOAuth && !apiKeyAllowsApiModel(input.apiKey.modelAllowlist, model)) {
    throw new HttpError(403, "model_not_allowed", `API key is not allowed to use model: ${model}`);
  }
  const now = Date.now();
  // All request constraints are applied before any weighted selection or secret lookup.
  const channels = listChannelRecords().filter((channel) => {
    if (!supportsOperation(channel, input.operation)) return false;
    if (input.provider && channel.provider !== input.provider) return false;
    const api = isApiProvider(channel.provider);
    if (api) {
      if (!input.apiKey.channelAllowlist.includes(channel.id) || !apiChannelModel(channel, model)) return false;
      if (!apiKeyAllowsApiModel(input.apiKey.modelAllowlist, model)) return false;
    } else if (!keyAllowsOAuth) {
      return false;
    } else if (channel.provider === "antigravity") {
      // An empty allowlist means every model in the bound accounts' catalogs, like empty OAuth allowlists.
      // Allowlists match by standard name, so "gemini-4-argon" and "gemini-4-argon-high" are one model.
      if (!isAntigravityModelId(antigravityModel) || (channel.modelAllowlist.length > 0 &&
        !channel.modelAllowlist.some(allowed => antigravityStandardModel(allowed) === antigravityStandardModel(model)))) return false;
    } else {
      if (channel.provider !== oauthProvider) return false;
      if ((input.operation === "images_generations" || input.operation === "images_edits") &&
        (channel.provider !== "codex" || !isCodexImageModel(model))) return false;
    }
    return isChannelAvailable(channel, input.apiKey, model,
      api ? [apiChannelModel(channel, model)!] : oauthModelCandidates, now);
  });
  const maps = new Map<ChannelProvider, Map<string, CredentialRoutingRecord>>();
  for (const provider of new Set(channels.map((channel) => channel.provider))) {
    maps.set(provider, credentialRoutingMap(provider,
      channels.filter((channel) => channel.provider === provider).flatMap((channel) => channel.credentialIds)));
  }
  const excluded = new Set(input.excludeCredentialIds ?? []);
  const quota = new Map<string, ReturnType<typeof claudeQuotaRouting>>();
  const floor = quotaFloorFilter(model, now);
  let candidates = channels.flatMap((channel) => {
    // The quota floor is a hard filter like cooldown: it applies to bound sessions
    // too, so a session on a low account moves on its next request.
    const credentials = availableCredentialsForChannel(channel, maps.get(channel.provider)!, now, floor)
      .filter((credential) => {
        if (excluded.has(credential.id) || !antigravityServesModel(credential, model, now)) return false;
        if (channel.provider !== "claude" || !channel.quotaWeighted) return true;
        const state = quota.get(credential.id) ?? claudeQuotaRouting(credential.id, model, now);
        quota.set(credential.id, state);
        return !state.blocked;
      });
    return credentials.length ? [{ channel, credentials }] : [];
  });
  if (!candidates.length) {
    // Low credentials are skipped across every channel first, so lower-priority
    // channels with headroom still serve. Only when none is left does this fail.
    if (floor.skipped.size) throw quotaFloorError(floor.percent);
    throw new HttpError(503, "no_available_channel", "No usable channel is available for this request");
  }
  const boundChannel = !binding?.failed && binding
    ? candidates.find((candidate) => candidate.channel.id === binding.channelId &&
      candidate.credentials.some((credential) => credential.id === binding.credentialId)) : undefined;
  if (binding?.failed) {
    const alternatives = candidates.flatMap((candidate) => {
      const credentials = candidate.credentials.filter((credential) => credential.id !== binding.credentialId);
      return credentials.length ? [{ ...candidate, credentials }] : [];
    });
    if (alternatives.length) candidates = alternatives;
  }
  const selected = boundChannel || selectRoutingItem(candidates,
    (candidate) => candidate.channel.priority,
    (candidate) => candidate.channel.weight,
    (candidate) => usageHealthScore(candidate.channel.usageHealth));
  const selectedCredential = (boundChannel && selected.credentials.find((credential) => credential.id === binding!.credentialId)) || selectRoutingItem(selected.credentials,
    (credential) => credential.priority, (credential) => credential.weight,
    (credential) => usageHealthScore(credential.usageHealth),
    (credential) => selected.channel.quotaWeighted ? quota.get(credential.id)?.multiplier ?? 1 : 1);
  const credential = getCredentialWithTokens(selected.channel.provider, selectedCredential.id);
  if (!credential) throw new HttpError(503, "upstream_credential_not_found", "Selected channel credential was not found");
  const channel = { ...selected.channel, credentialId: credential.id };
  markChannelUsed(channel.id);
  markCredentialUsed(channel.provider, credential.id);
  return { channel, credential };
}

// Antigravity cools a model per credential and skips credentials whose catalog lacks the model, as in CPA.
function antigravityServesModel(credential: RoutableCredentialRecord, model: string, now: number) {
  if (credential.provider !== "antigravity") return true;
  const cooldown = credential.modelCooldowns[antigravityStandardModel(model)];
  if (cooldown && Date.parse(cooldown.until) > now) return false;
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
  const session = claudeSessions.get(channel);
  // A late success must not undo a newer failure's cooldown or a rebind.
  if (session?.upstreamStarted &&
    !completeSessionBinding(session.binding, session.startedAt + session.ttlMs)) return;
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
  const session = claudeSessions.get(channel);
  if (session?.upstreamStarted && (statusCode === null || statusCode === 408 ||
    statusCode === 401 || statusCode === 403 || statusCode === 429 || statusCode >= 500)) {
    failSessionBinding(session.binding);
  }
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
  quotaMultiplier: number;
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
  model: string,
  floor: QuotaFloorFilter,
) {
  const quota = new Map<string, ReturnType<typeof claudeQuotaRouting>>();
  const credentials = availableCredentialsForChannel(channel, credentialsById, now, floor).filter((credential) => {
    if (channel.provider !== "claude" || !channel.quotaWeighted) return true;
    const state = claudeQuotaRouting(credential.id, model, now);
    quota.set(credential.id, state);
    return !state.blocked;
  });
  if (credentials.length === 0) {
    return null;
  }
  return selectRoutingItem(
    credentials,
    (credential) => credential.priority,
    (credential) => credential.weight,
    (credential) => usageHealthScore(credential.usageHealth),
    (credential) => quota.get(credential.id)?.multiplier ?? 1,
  );
}

function availableCredentialsForChannel(
  channel: ChannelRecord,
  credentialsById: Map<string, CredentialRoutingRecord>,
  now: number,
  floor: QuotaFloorFilter,
) {
  return channel.credentialIds
    .map((credentialId) => credentialsById.get(credentialId))
    .filter((credential): credential is CredentialRoutingRecord =>
      Boolean(
        credential?.enabled && credential.provider === channel.provider &&
        (!("keySet" in credential) || credential.keySet) &&
        (credential.provider !== "claude" || !credential.expiresAt ||
          !(Date.parse(credential.expiresAt) <= now)) &&
        (!credential.cooldownUntil ||
          Date.parse(credential.cooldownUntil) <= now) &&
        !floor.blocks(credential),
      ),
    );
}

type QuotaFloorFilter = ReturnType<typeof quotaFloorFilter>;

// Claude and Codex have persisted quota data. Antigravity quota is only read on
// demand by the dashboard, and API Key upstreams have no subscription windows.
// Unknown, stale or reset windows never count as below the floor.
function quotaFloorFilter(model: string, now: number) {
  const percent = getCredentialQuotaFloorPercent();
  const results = new Map<string, boolean>();
  const skipped = new Set<string>();
  return {
    percent,
    skipped,
    blocks(credential: CredentialRoutingRecord) {
      if (percent <= 0 || (credential.provider !== "claude" && credential.provider !== "codex")) return false;
      const key = credential.provider + ":" + credential.id;
      let blocked = results.get(key);
      if (blocked === undefined) {
        blocked = credential.provider === "claude"
          ? claudeQuotaFloorState(credential.id, model, now, percent).skipped
          : codexQuotaFloorState(credential.id, { now, floor: percent, recheck: true }).skipped;
        results.set(key, blocked);
      }
      if (blocked) skipped.add(key);
      return blocked;
    },
  };
}

function quotaFloorError(percent: number) {
  return new HttpError(503, "credential_quota_floor",
    `Every credential that can serve this request has ${percent}% or less of its weekly quota left`);
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
  getQuotaMultiplier: (item: T) => number = () => 1,
) {
  const candidates = items.map((item) => ({
    item,
    priority: getPriority(item),
    weight: getWeight(item),
    healthScore: getHealthScore(item),
    quotaMultiplier: getQuotaMultiplier(item),
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

function routingWeight(candidate: { weight: number; healthScore: number; quotaMultiplier: number }) {
  return Math.max(1, candidate.weight) * Math.max(1, candidate.healthScore) * candidate.quotaMultiplier;
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

// API channels accept the vendor prefixes other channels accept: openai/gpt-5.4 and gpt-5.4 are one model, but
// two different vendors are not. Other namespaces such as meta-llama/ stay part of the name.
function splitModelVendor(model: string) {
  const value = cleanString(model);
  const match = /^(openai|anthropic|google)\/(.+)$/i.exec(value);
  return match ? { vendor: match[1].toLowerCase(), name: match[2] } : { vendor: "", name: value };
}

function sameStandardModel(a: string, b: string) {
  const left = splitModelVendor(a);
  const right = splitModelVendor(b);
  return left.name === right.name && (!left.vendor || !right.vendor || left.vendor === right.vendor);
}

// The allowlisted name an API channel serves for a requested model, sent upstream in place of the requested
// name: the exact entry first, so prefixed entries such as OpenRouter's openai/gpt-5.4 are kept as configured.
export function apiChannelModel(channel: Pick<ChannelRecord, "modelAllowlist">, model: string) {
  const value = cleanString(model);
  if (!value) return undefined;
  return channel.modelAllowlist.find((allowed) => cleanString(allowed) === value) ??
    channel.modelAllowlist.find((allowed) => sameStandardModel(allowed, value));
}

export function apiKeyAllowsApiModel(modelAllowlist: string[], model: string) {
  return modelAllowlist.length === 0 || modelAllowlist.some((allowed) => sameStandardModel(allowed, model));
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
    throw new HttpError(400, "invalid_antigravity_models", "Antigravity channels only accept Gemini model IDs");
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
