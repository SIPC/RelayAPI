import "server-only";

import type {
  ChannelRecord,
  RelayApiKeyContext,
} from "@/src/shared/types/entities";
import {
  deleteChannel,
  insertChannel,
  listChannels,
  markChannelUsed,
  updateChannel,
} from "@/src/server/repositories/channels";
import { getCodexCredentialWithTokens } from "@/src/server/repositories/codexCredentials";
import { appendChannelHealthEvent } from "@/src/server/repositories/logs";
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
  credentialId: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  modelAllowlist?: string[];
}

export function listChannelRecords() {
  return listChannels();
}

export function createChannel(input: CreateChannelInput) {
  const credential = getCodexCredentialWithTokens(
    cleanString(input.credentialId),
  );
  if (!credential) {
    throw new HttpError(
      400,
      "codex_credential_not_found",
      "Cannot create channel without a valid Codex credential",
    );
  }
  const channel = insertChannel({
    id: randomId("ch"),
    name:
      cleanString(input.name) ||
      (credential.email
        ? `Codex · ${credential.email}`
        : `Codex · ${credential.id}`),
    baseUrl: cleanString(input.baseUrl) || serverConfig.codexBaseUrl,
    credentialId: credential.id,
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
  if (input.credentialId !== undefined) {
    const credential = getCodexCredentialWithTokens(
      cleanString(input.credentialId),
    );
    if (!credential) {
      throw new HttpError(
        400,
        "codex_credential_not_found",
        "Cannot bind channel to a missing Codex credential",
      );
    }
  }
  const channel = updateChannel(id, {
    ...(input.name !== undefined ? { name: cleanString(input.name) } : {}),
    ...(input.baseUrl !== undefined
      ? { baseUrl: cleanString(input.baseUrl) || serverConfig.codexBaseUrl }
      : {}),
    ...(input.credentialId !== undefined
      ? { credentialId: cleanString(input.credentialId) }
      : {}),
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
  const now = Date.now();
  const candidates = listChannels().filter((channel) => {
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
      input.apiKey.channelAllowlist.length > 0 &&
      !input.apiKey.channelAllowlist.includes(channel.id)
    ) {
      return false;
    }
    return Boolean(getCodexCredentialWithTokens(channel.credentialId));
  });

  if (candidates.length === 0) {
    throw new HttpError(
      503,
      "no_available_channel",
      "No usable channel is available for this request",
    );
  }

  const maxPriority = Math.max(
    ...candidates.map((channel) => channel.priority),
  );
  const priorityCandidates = candidates.filter(
    (channel) => channel.priority === maxPriority,
  );
  const selected = weightedPick(priorityCandidates);
  const credential = getCodexCredentialWithTokens(selected.credentialId);
  if (!credential) {
    throw new HttpError(
      503,
      "codex_credential_not_found",
      "Selected channel credential was not found",
    );
  }
  markChannelUsed(selected.id);
  return { channel: selected, credential };
}

export function recordChannelSuccess(channel: ChannelRecord) {
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
  let penalty = 8;
  let cooldownMs = 0;
  if (statusCode === 401 || statusCode === 403) {
    penalty = 45;
    cooldownMs = 15 * 60 * 1000;
  } else if (statusCode === 429) {
    penalty = 25;
    cooldownMs = 5 * 60 * 1000;
  } else if (statusCode && statusCode >= 500) {
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

function weightedPick(channels: ChannelRecord[]) {
  const totalWeight = channels.reduce(
    (sum, channel) => sum + Math.max(1, channel.weight),
    0,
  );
  let cursor = Math.random() * totalWeight;
  for (const channel of channels) {
    cursor -= Math.max(1, channel.weight);
    if (cursor <= 0) {
      return channel;
    }
  }
  return channels[0];
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
