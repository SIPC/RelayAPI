import "server-only";

import crypto from "node:crypto";
import { serverConfig } from "@/src/server/config/env";
import { parseCodexSseFrames } from "@/src/server/codex/sse";
import { codexWebSocketResponse } from "@/src/server/codex/websocket";
import { proxiedFetch } from "@/src/server/net/proxy";
import {
  ensureFreshCredential,
  resolveCredentialProxy,
} from "@/src/server/services/codexCredentials";
import type { StageTimer } from "@/src/server/http/stageTimer";
import type {
  ChannelRecord,
  RelayApiKeyContext,
  UsageSnapshot,
} from "@/src/shared/types/entities";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const SENSITIVE_UPSTREAM_RESPONSE_HEADERS = new Set([
  "authorization",
  "chatgpt-account-id",
  "cookie",
  "openai-api-key",
  "session-id",
  "session_id",
  "set-cookie",
  "set-cookie2",
  "x-api-key",
]);

const THINKING_SUFFIX_LEVELS = new Set([
  "none",
  "auto",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const CODEX_REASONING_INCLUDE = ["reasoning.encrypted_content"];
const CODEX_IMAGE_GENERATION_TOOL = {
  type: "image_generation",
  output_format: "png",
};

export interface ToolNameMaps {
  originalToShort: Map<string, string>;
  shortToOriginal: Map<string, string>;
}

export function codexPromptCacheKeyForApiKey(
  apiKey: Pick<RelayApiKeyContext, "id"> | null | undefined,
) {
  const id = stringValue(apiKey?.id).trim();
  if (!id) {
    return "";
  }
  return deterministicUuid(`relay-api:codex:prompt-cache:${id}`);
}

function resolveCodexPromptCacheKey(
  payload: unknown,
  fallback: string | null | undefined,
) {
  const explicit = isRecord(payload)
    ? stringValue(payload.prompt_cache_key).trim()
    : "";
  return explicit || stringValue(fallback).trim();
}

export async function codexFetch(
  upstreamPath: "/responses" | "/responses/compact",
  payload: Record<string, unknown>,
  input: {
    stream: boolean;
    sourceHeaders: Headers;
    channel: ChannelRecord;
    promptCacheKey?: string | null;
    transport?: "http" | "websocket";
    timing?: StageTimer;
  },
) {
  const credential =
    (await input.timing?.timeAsync(
      "ensure_credential",
      "获取/刷新 Codex 凭据",
      () => ensureFreshCredential(input.channel.credentialId),
    )) ?? (await ensureFreshCredential(input.channel.credentialId));
  if (!credential.tokens.access_token) {
    throw new Error("Saved Codex credential does not contain access_token");
  }
  const promptCacheKey = resolveCodexPromptCacheKey(
    payload,
    input.promptCacheKey,
  );
  const useWebSocket =
    input.transport === "websocket" &&
    credential.upstreamTransport === "websocket" &&
    upstreamPath === "/responses";
  const upstreamPayload =
    input.timing?.time("prepare_upstream_payload", "构造上游 Payload", () =>
      prepareCodexPayloadForUpstream(payload, {
        fastServiceTier: shouldUsePriorityServiceTier(credential),
        promptCacheKey,
        planType: credential.planType,
        transport: useWebSocket ? "websocket" : "http",
      }),
    ) ??
    prepareCodexPayloadForUpstream(payload, {
      fastServiceTier: shouldUsePriorityServiceTier(credential),
      promptCacheKey,
      planType: credential.planType,
      transport: useWebSocket ? "websocket" : "http",
    });
  const proxy = resolveCredentialProxy({
    proxy: credential.proxy,
    proxyPoolId: credential.proxyPoolId,
    useGlobalProxy: credential.useGlobalProxy,
  });
  const url = toCodexUrl(input.channel.baseUrl, upstreamPath);
  const headers = buildCodexHeaders(credential, {
    stream: input.stream,
    sourceHeaders: input.sourceHeaders,
    promptCacheKey,
  });
  if (useWebSocket) {
    const response = await codexWebSocketResponse({
      httpUrl: url,
      headers,
      payload: upstreamPayload,
      proxy,
      timeoutMs: serverConfig.requestTimeoutMs,
    });
    if (response.status === 426) {
      const fallbackResponse =
        (await input.timing?.timeAsync("upstream_fetch", "上游 Fetch", () =>
          proxiedFetch(
            url,
            {
              method: "POST",
              headers,
              body: JSON.stringify(upstreamPayload),
              signal: AbortSignal.timeout(
                input.stream
                  ? serverConfig.streamRequestTimeoutMs
                  : serverConfig.requestTimeoutMs,
              ),
            },
            proxy,
          ),
        )) ??
        (await proxiedFetch(
          url,
          {
            method: "POST",
            headers,
            body: JSON.stringify(upstreamPayload),
            signal: AbortSignal.timeout(
              input.stream
                ? serverConfig.streamRequestTimeoutMs
                : serverConfig.requestTimeoutMs,
            ),
          },
          proxy,
        ));
      return { response: fallbackResponse, credential, upstreamPayload };
    }
    return { response, credential, upstreamPayload };
  }
  const response =
    (await input.timing?.timeAsync("upstream_fetch", "上游 Fetch", () =>
      proxiedFetch(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify(upstreamPayload),
          signal: AbortSignal.timeout(
            input.stream
              ? serverConfig.streamRequestTimeoutMs
              : serverConfig.requestTimeoutMs,
          ),
        },
        proxy,
      ),
    )) ??
    (await proxiedFetch(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamPayload),
        signal: AbortSignal.timeout(
          input.stream
            ? serverConfig.streamRequestTimeoutMs
            : serverConfig.requestTimeoutMs,
        ),
      },
      proxy,
    ));
  return { response, credential, upstreamPayload };
}

export async function codexJson(
  upstreamPath: "/responses" | "/responses/compact",
  payload: Record<string, unknown>,
  input: {
    stream: boolean;
    sourceHeaders: Headers;
    channel: ChannelRecord;
    promptCacheKey?: string | null;
    transport?: "http" | "websocket";
    timing?: StageTimer;
  },
) {
  const { response, credential, upstreamPayload } = await codexFetch(
    upstreamPath,
    payload,
    input,
  );
  const text =
    (await input.timing?.timeAsync(
      "read_upstream_body",
      "读取上游响应 Body",
      () => response.text(),
    )) ?? (await response.text());
  return {
    response,
    credential,
    upstreamPayload,
    text,
    json: parseMaybeJson<unknown>(text),
  };
}

export function toCodexUrl(baseUrl: string, upstreamPath: string) {
  if (upstreamPath !== "/responses" && upstreamPath !== "/responses/compact") {
    throw new Error(`Unsupported Codex upstream path: ${upstreamPath}`);
  }
  return `${baseUrl.replace(/\/+$/, "")}${upstreamPath}`;
}

function buildCodexHeaders(
  credential: Awaited<ReturnType<typeof ensureFreshCredential>>,
  input: {
    stream: boolean;
    sourceHeaders: Headers;
    promptCacheKey?: string | null;
  },
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${credential.tokens.access_token}`,
    Accept: input.stream ? "text/event-stream" : "application/json",
    "User-Agent": serverConfig.userAgent,
    Originator: serverConfig.codexOriginator,
  };
  for (const name of [
    "version",
    "x-codex-turn-metadata",
    "x-codex-turn-state",
    "x-client-request-id",
    "x-codex-beta-features",
    "x-responsesapi-include-timing-metrics",
  ]) {
    const value = input.sourceHeaders.get(name);
    if (value) {
      headers[canonicalHeaderName(name)] = value;
    }
  }
  if (credential.accountId) {
    headers["Chatgpt-Account-Id"] = credential.accountId;
  }
  const promptCacheKey = stringValue(input.promptCacheKey).trim();
  const sessionId =
    promptCacheKey ||
    input.sourceHeaders.get("session_id") ||
    input.sourceHeaders.get("session-id") ||
    "";
  if (sessionId) {
    headers.Session_id = sessionId;
  } else if (headers["User-Agent"].includes("Mac OS")) {
    headers.Session_id = crypto.randomUUID();
  }
  if (promptCacheKey) {
    headers.Conversation_id = promptCacheKey;
  }
  return headers;
}

function canonicalHeaderName(name: string) {
  return name
    .split("-")
    .map((part) =>
      part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part,
    )
    .join("-");
}

export function prepareCodexPayloadForUpstream(
  payload: unknown,
  options: {
    fastServiceTier?: boolean;
    promptCacheKey?: string | null;
    planType?: string | null;
    transport?: "http" | "websocket";
  } = {},
): Record<string, unknown> {
  if (!isRecord(payload)) {
    return {};
  }
  const upstreamPayload = cloneJsonObject(payload);
  const promptCacheKey = resolveCodexPromptCacheKey(
    upstreamPayload,
    options.promptCacheKey,
  );
  if (promptCacheKey) {
    upstreamPayload.prompt_cache_key = promptCacheKey;
  }
  if (
    upstreamPayload.service_tier &&
    upstreamPayload.service_tier !== "priority"
  ) {
    delete upstreamPayload.service_tier;
  }
  if (options.fastServiceTier) {
    upstreamPayload.service_tier = "priority";
  }
  applyModelThinkingSuffix(upstreamPayload);
  normalizeRawCodexPayloadForUpstream(upstreamPayload, {
    preservePreviousResponseId: options.transport === "websocket",
  });
  normalizeCodexBuiltinTools(upstreamPayload);
  ensureImageGenerationTool(upstreamPayload, {
    planType: options.planType,
  });
  return upstreamPayload;
}

export function applyModelThinkingSuffix(payload: unknown) {
  if (!isRecord(payload)) {
    return payload;
  }

  const suffix = parseModelThinkingSuffix(payload.model);
  if (!suffix.hasSuffix) {
    return payload;
  }

  payload.model = suffix.model;
  const reasoning = isRecord(payload.reasoning) ? { ...payload.reasoning } : {};
  reasoning.effort = suffix.effort;
  payload.reasoning = reasoning;
  return payload;
}

export function parseModelThinkingSuffix(model: unknown) {
  const value = String(model || "").trim();
  const lastOpen = value.lastIndexOf("(");
  if (lastOpen <= 0 || !value.endsWith(")")) {
    return { model: value, hasSuffix: false, effort: "", rawSuffix: "" };
  }

  const baseModel = value.slice(0, lastOpen).trim();
  const rawSuffix = value.slice(lastOpen + 1, -1).trim();
  const effort = thinkingSuffixToCodexEffort(rawSuffix);
  if (!baseModel || !effort) {
    return { model: value, hasSuffix: false, effort: "", rawSuffix };
  }

  return {
    model: baseModel,
    hasSuffix: true,
    effort,
    rawSuffix,
  };
}

function thinkingSuffixToCodexEffort(rawSuffix: unknown) {
  const suffix = String(rawSuffix || "")
    .trim()
    .toLowerCase();
  if (!suffix) {
    return "";
  }

  if (THINKING_SUFFIX_LEVELS.has(suffix)) {
    return suffix;
  }

  if (!/^\d+$/.test(suffix)) {
    return "";
  }

  const budget = Number.parseInt(suffix, 10);
  if (!Number.isFinite(budget)) {
    return "xhigh";
  }
  return budgetToCodexEffort(budget);
}

function budgetToCodexEffort(budget: number) {
  if (budget <= 0) {
    return "none";
  }
  if (budget <= 512) {
    return "minimal";
  }
  if (budget <= 1024) {
    return "low";
  }
  if (budget <= 8192) {
    return "medium";
  }
  if (budget <= 24576) {
    return "high";
  }
  return "xhigh";
}

export function copyUpstreamHeaders(headers: Headers) {
  const output = new Headers();
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) {
      continue;
    }
    if (SENSITIVE_UPSTREAM_RESPONSE_HEADERS.has(lower)) {
      continue;
    }
    if (lower === "content-length" || lower === "content-encoding") {
      continue;
    }
    output.set(name, value);
  }
  return output;
}

export function normalizeResponsesPayload(
  inputPayload: unknown,
  input: { stream: boolean; defaultModel?: string } = { stream: true },
) {
  const payload = cloneJsonObject(inputPayload);
  payload.model =
    payload.model || input.defaultModel || serverConfig.codexDefaultModel;
  payload.instructions = payload.instructions ?? "";
  payload.stream = Boolean(input.stream);
  payload.store = false;
  payload.parallel_tool_calls = true;
  payload.include = [...CODEX_REASONING_INCLUDE];

  if (typeof payload.input === "string") {
    payload.input = [textMessage("user", payload.input, false)];
  }

  if (Array.isArray(payload.input)) {
    payload.input = payload.input.map((item) => {
      if (isRecord(item) && item.type === "message" && item.role === "system") {
        return { ...item, role: "developer" };
      }
      return item;
    });
  }

  stripUnsupportedCodexFields(payload, { allowStore: true });
  return payload;
}

export function normalizeCompactPayload(inputPayload: unknown) {
  const payload = normalizeResponsesPayload(inputPayload, { stream: false });
  delete payload.stream;
  delete payload.store;
  delete payload.include;
  delete payload.parallel_tool_calls;
  return payload;
}

export function normalizeRawCodexResponsesPayload(inputPayload: unknown) {
  const payload = cloneJsonObject(inputPayload);
  payload.store = false;
  payload.parallel_tool_calls = true;
  payload.include = [...CODEX_REASONING_INCLUDE];
  normalizeRawCodexPayloadForUpstream(payload);
  return payload;
}

export function normalizeRawCodexCompactPayload(inputPayload: unknown) {
  const payload = cloneJsonObject(inputPayload);
  normalizeRawCodexPayloadForUpstream(payload);
  delete payload.stream;
  delete payload.store;
  delete payload.include;
  delete payload.parallel_tool_calls;
  return payload;
}

export function chatCompletionsToCodex(
  inputPayload: unknown,
  input: { stream: boolean; defaultModel?: string } = { stream: false },
) {
  const payload = cloneJsonObject(inputPayload);
  const toolNameMaps = buildToolNameMaps(payload.tools);
  const out: Record<string, unknown> = {
    model:
      payload.model || input.defaultModel || serverConfig.codexDefaultModel,
    instructions: "",
    input: [],
    stream: Boolean(input.stream),
    store: false,
  };

  const outInput = out.input as Record<string, unknown>[];
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const rawMessage of messages) {
    const message = isRecord(rawMessage) ? rawMessage : {};
    const role = String(message.role || "");
    if (role === "tool") {
      outInput.push({
        type: "function_call_output",
        call_id: stringValue(message.tool_call_id),
        output: toolOutputToCodex(message.content),
      });
      continue;
    }

    const mappedRole = role === "system" ? "developer" : role || "user";
    const content = messageToCodexContent(message, mappedRole === "assistant");
    if (content.length > 0 || mappedRole !== "assistant") {
      outInput.push({ type: "message", role: mappedRole, content });
    }

    if (mappedRole === "assistant" && Array.isArray(message.tool_calls)) {
      for (const rawToolCall of message.tool_calls) {
        const toolCall = isRecord(rawToolCall) ? rawToolCall : {};
        const fn = isRecord(toolCall.function) ? toolCall.function : {};
        if (toolCall.type !== "function") {
          continue;
        }
        outInput.push({
          type: "function_call",
          call_id: stringValue(toolCall.id) || crypto.randomUUID(),
          name: toCodexToolName(stringValue(fn.name), toolNameMaps),
          arguments: stringValue(fn.arguments) || "{}",
        });
      }
    }
  }

  if (payload.reasoning_effort) {
    out.reasoning = { effort: payload.reasoning_effort, summary: "auto" };
  } else if (isRecord(payload.reasoning)) {
    out.reasoning = {
      ...cloneJsonObject(payload.reasoning),
      effort: payload.reasoning.effort ?? "medium",
      summary: payload.reasoning.summary ?? "auto",
    };
  } else {
    out.reasoning = { effort: "medium", summary: "auto" };
  }
  out.parallel_tool_calls = true;
  out.include = [...CODEX_REASONING_INCLUDE];

  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    out.tools = payload.tools.map((rawTool) => {
      const tool = isRecord(rawTool) ? rawTool : {};
      const fn = isRecord(tool.function) ? tool.function : null;
      if (tool.type === "function" && fn) {
        return {
          type: "function",
          name: toCodexToolName(stringValue(fn.name), toolNameMaps),
          description: fn.description,
          parameters: fn.parameters || { type: "object", properties: {} },
          strict: fn.strict,
        };
      }
      return tool;
    });
  }

  if (payload.tool_choice !== undefined) {
    out.tool_choice = normalizeToolChoice(payload.tool_choice, toolNameMaps);
  }
  if (payload.response_format) {
    out.text = responseFormatToText(payload.response_format, payload.text);
  } else if (payload.text) {
    out.text = payload.text;
  }

  stripUndefinedDeep(out);
  stripUnsupportedCodexFields(out, { allowStore: true });
  return { payload: out, toolNameMaps };
}

function messageToCodexContent(
  message: Record<string, unknown>,
  assistant: boolean,
) {
  const content = message.content;
  const textType = assistant ? "output_text" : "input_text";
  if (typeof content === "string") {
    return content ? [{ type: textType, text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: Record<string, unknown>[] = [];
  for (const rawItem of content) {
    const item = isRecord(rawItem) ? rawItem : {};
    if (item.type === "text") {
      parts.push({ type: textType, text: stringValue(item.text) });
    } else if (item.type === "image_url" && !assistant) {
      const imageUrl = isRecord(item.image_url)
        ? stringValue(item.image_url.url)
        : stringValue(item.image_url);
      parts.push({ type: "input_image", image_url: imageUrl });
    } else if (item.type === "file" && !assistant && isRecord(item.file)) {
      if (item.file.file_data) {
        parts.push({
          type: "input_file",
          file_data: item.file.file_data,
          filename: item.file.filename,
        });
      }
    }
  }
  return parts;
}

function textMessage(role: string, text: unknown, assistant: boolean) {
  return {
    type: "message",
    role,
    content: [
      {
        type: assistant ? "output_text" : "input_text",
        text: String(text || ""),
      },
    ],
  };
}

function toolOutputToCodex(content: unknown) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => toolOutputPartToCodex(item));
  }
  return JSON.stringify(content ?? "");
}

function toolOutputPartToCodex(rawItem: unknown) {
  const item = isRecord(rawItem) ? rawItem : {};
  switch (item.type) {
    case "text":
      return { type: "input_text", text: stringValue(item.text) };
    case "image_url": {
      const imageUrl = isRecord(item.image_url)
        ? stringValue(item.image_url.url)
        : stringValue(item.image_url);
      const fileId = isRecord(item.image_url)
        ? stringValue(item.image_url.file_id)
        : "";
      if (!imageUrl && !fileId) {
        return toolOutputFallbackPart(item);
      }
      const part: Record<string, unknown> = { type: "input_image" };
      if (imageUrl) {
        part.image_url = imageUrl;
      }
      if (fileId) {
        part.file_id = fileId;
      }
      if (isRecord(item.image_url) && item.image_url.detail) {
        part.detail = item.image_url.detail;
      }
      return part;
    }
    case "file": {
      const file = isRecord(item.file) ? item.file : {};
      const fileId = stringValue(file.file_id);
      const fileData = stringValue(file.file_data);
      const fileUrl = stringValue(file.file_url);
      if (!fileId && !fileData && !fileUrl) {
        return toolOutputFallbackPart(item);
      }
      const part: Record<string, unknown> = { type: "input_file" };
      if (fileId) {
        part.file_id = fileId;
      }
      if (fileData) {
        part.file_data = fileData;
      }
      if (fileUrl) {
        part.file_url = fileUrl;
      }
      if (file.filename) {
        part.filename = file.filename;
      }
      return part;
    }
    default:
      return toolOutputFallbackPart(rawItem);
  }
}

function toolOutputFallbackPart(item: unknown) {
  return {
    type: "input_text",
    text:
      isRecord(item) || Array.isArray(item)
        ? JSON.stringify(item)
        : String(item ?? ""),
  };
}

function normalizeToolChoice(toolChoice: unknown, toolNameMaps: ToolNameMaps) {
  if (!isRecord(toolChoice)) {
    return toolChoice;
  }
  const fn = isRecord(toolChoice.function) ? toolChoice.function : null;
  if (toolChoice.type === "function" && fn?.name) {
    return {
      type: "function",
      name: toCodexToolName(stringValue(fn.name), toolNameMaps),
    };
  }
  return toolChoice;
}

export function buildToolNameMaps(tools: unknown): ToolNameMaps {
  const names: string[] = [];
  if (Array.isArray(tools)) {
    for (const rawTool of tools) {
      const tool = isRecord(rawTool) ? rawTool : {};
      const fn = isRecord(tool.function) ? tool.function : null;
      if (tool.type === "function" && fn?.name) {
        names.push(stringValue(fn.name));
      }
    }
  }
  const originalToShort = new Map<string, string>();
  const shortToOriginal = new Map<string, string>();
  const used = new Set<string>();
  for (const name of names) {
    const shortName = makeUniqueToolName(shortenToolName(name), used);
    used.add(shortName);
    originalToShort.set(name, shortName);
    shortToOriginal.set(shortName, name);
  }
  return { originalToShort, shortToOriginal };
}

export function restoreOriginalToolName(
  toolName: string,
  toolNameMaps: ToolNameMaps | null,
) {
  return toolNameMaps?.shortToOriginal.get(toolName) || toolName;
}

function toCodexToolName(toolName: string, toolNameMaps: ToolNameMaps) {
  return (
    toolNameMaps.originalToShort.get(toolName) || shortenToolName(toolName)
  );
}

function shortenToolName(toolName: string) {
  const limit = 64;
  if (toolName.length <= limit) {
    return toolName;
  }
  if (toolName.startsWith("mcp__")) {
    const lastSeparator = toolName.lastIndexOf("__");
    if (lastSeparator > 0) {
      const candidate = `mcp__${toolName.slice(lastSeparator + 2)}`;
      return candidate.length > limit ? candidate.slice(0, limit) : candidate;
    }
  }
  return toolName.slice(0, limit);
}

function makeUniqueToolName(candidate: string, used: Set<string>) {
  const limit = 64;
  if (!used.has(candidate)) {
    return candidate;
  }
  for (let i = 1; ; i += 1) {
    const suffix = `_${i}`;
    const prefixLimit = Math.max(0, limit - suffix.length);
    const next = `${candidate.slice(0, prefixLimit)}${suffix}`;
    if (!used.has(next)) {
      return next;
    }
  }
}

function responseFormatToText(responseFormat: unknown, text: unknown = {}) {
  const format = isRecord(responseFormat) ? responseFormat : {};
  const out = isRecord(text) ? { ...text } : {};
  if (format.type === "text") {
    out.format = { type: "text" };
  } else if (format.type === "json_schema" && isRecord(format.json_schema)) {
    out.format = {
      type: "json_schema",
      name: format.json_schema.name,
      strict: format.json_schema.strict,
      schema: format.json_schema.schema,
    };
  }
  stripUndefinedDeep(out);
  return out;
}

export function parseCodexSseResponse(text: string) {
  const outputItemsByIndex = new Map<number, unknown>();
  const outputItemsFallback: unknown[] = [];
  let completed: Record<string, unknown> | null = null;

  for (const frame of parseCodexSseFrames(text)) {
    const event = frame.event;
    if (!event) {
      continue;
    }
    if (event.type === "response.output_item.done" && event.item) {
      if (Number.isInteger(event.output_index)) {
        outputItemsByIndex.set(Number(event.output_index), event.item);
      } else {
        outputItemsFallback.push(event.item);
      }
      continue;
    }
    if (event.type === "response.completed") {
      completed = isRecord(event.response) ? event.response : event;
    }
  }

  const output = orderedOutputItems(outputItemsByIndex, outputItemsFallback);
  if (!completed) {
    return output.length > 0 ? { object: "response", output } : null;
  }
  if (!Array.isArray(completed.output) || completed.output.length === 0) {
    if (output.length > 0) {
      completed = { ...completed, output };
    }
  }
  return completed;
}

function orderedOutputItems(
  byIndex: Map<number, unknown>,
  fallback: unknown[],
) {
  return [
    ...[...byIndex.entries()].sort(([a], [b]) => a - b).map(([, item]) => item),
    ...fallback,
  ];
}

export function extractUsageFromCodexResponse(raw: unknown): UsageSnapshot {
  const root = isRecord(raw) && isRecord(raw.response) ? raw.response : raw;
  const usage = isRecord(root) && isRecord(root.usage) ? root.usage : {};
  return normalizeUsage(usage);
}

export function normalizeUsage(usage: unknown): UsageSnapshot {
  const object = isRecord(usage) ? usage : {};
  const promptTokens = numberValue(object.input_tokens ?? object.prompt_tokens);
  const completionTokens = numberValue(
    object.output_tokens ?? object.completion_tokens,
  );
  const totalTokens =
    numberValue(object.total_tokens) || promptTokens + completionTokens;
  const cachedTokens = extractCachedTokens(object);
  return { promptTokens, completionTokens, totalTokens, cachedTokens };
}

function extractCachedTokens(usage: Record<string, unknown>) {
  return firstPositiveNumber(
    usage.cached_tokens,
    recordValue(usage.input_tokens_details)?.cached_tokens,
    recordValue(usage.prompt_tokens_details)?.cached_tokens,
    recordValue(usage.input_token_details)?.cached_tokens,
    recordValue(usage.prompt_token_details)?.cached_tokens,
    recordValue(usage.cache_read_input_tokens)?.cached_tokens,
    usage.cache_read_input_tokens,
    usage.cached_input_tokens,
    usage.prompt_cache_hit_tokens,
    usage.prompt_cache_read_tokens,
    usage.cache_read_tokens,
  );
}

function recordValue(value: unknown) {
  return isRecord(value) ? value : null;
}

function firstPositiveNumber(...values: unknown[]) {
  for (const value of values) {
    const number = numberValue(value);
    if (number > 0) {
      return number;
    }
  }
  return 0;
}

export function extractTextFromCodexResponse(raw: unknown): string {
  if (!raw) {
    return "";
  }
  if (typeof raw === "string") {
    const parsed = parseMaybeJson<unknown>(raw);
    return parsed ? extractTextFromCodexResponse(parsed) : raw;
  }
  const root = isRecord(raw) && isRecord(raw.response) ? raw.response : raw;
  if (isRecord(root) && root.object === "response.compaction") {
    return "";
  }
  const texts: string[] = [];
  if (isRecord(root)) {
    collectTexts(root.output, texts, { assistantOnly: true });
    collectTexts(root.content, texts, { assistantOnly: true });
    if (typeof root.output_text === "string") {
      texts.push(root.output_text);
    }
  }
  return texts.join("");
}

function collectTexts(
  value: unknown,
  texts: string[],
  options: { assistantOnly?: boolean; role?: string } = {},
) {
  if (!value) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTexts(item, texts, options);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const role = stringValue(value.role) || options.role || "";
  const shouldCollect =
    !options.assistantOnly || role === "assistant" || role === "";
  if (
    value.type === "output_text" &&
    typeof value.text === "string" &&
    shouldCollect
  ) {
    texts.push(value.text);
  }
  collectTexts(value.content, texts, { ...options, role });
  collectTexts(value.summary, texts, { ...options, role });
}

export function codexResponseToChatCompletion(
  raw: unknown,
  model: string,
  toolNameMaps: ToolNameMaps | null,
) {
  const root = isRecord(raw) && isRecord(raw.response) ? raw.response : raw;
  const rootObject = isRecord(root) ? root : {};
  const usage = extractUsageFromCodexResponse(raw);
  const toolCalls = extractToolCallsFromCodexResponse(rootObject, toolNameMaps);
  const message: Record<string, unknown> = {
    role: "assistant",
    content: toolCalls.length > 0 ? null : extractTextFromCodexResponse(raw),
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return {
    id: stringValue(rootObject.id) || `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created:
      numberValue(rootObject.created_at) || Math.floor(Date.now() / 1000),
    model:
      stringValue(rootObject.model) || model || serverConfig.codexDefaultModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason:
          toolCalls.length > 0
            ? "tool_calls"
            : rootObject.status === "completed" || !rootObject.status
              ? "stop"
              : String(rootObject.status),
      },
    ],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
      prompt_tokens_details: {
        cached_tokens: usage.cachedTokens,
      },
    },
  };
}

function extractToolCallsFromCodexResponse(
  root: Record<string, unknown>,
  toolNameMaps: ToolNameMaps | null,
) {
  if (!Array.isArray(root.output)) {
    return [];
  }
  return root.output.flatMap((rawItem) => {
    const item = isRecord(rawItem) ? rawItem : {};
    if (item.type !== "function_call") {
      return [];
    }
    const name = restoreOriginalToolName(stringValue(item.name), toolNameMaps);
    return {
      id:
        stringValue(item.call_id) ||
        stringValue(item.id) ||
        `call_${crypto.randomUUID()}`,
      type: "function",
      function: {
        name,
        arguments: sanitizeToolCallArguments(name, stringValue(item.arguments)),
      },
    };
  });
}

export function sanitizeToolCallArguments(
  toolName: string,
  argumentsText: string,
) {
  const raw =
    typeof argumentsText === "string"
      ? argumentsText
      : JSON.stringify(argumentsText ?? {});
  if (!isSpawnAgentTool(toolName)) {
    return raw;
  }
  try {
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (shouldNormalizeEmptySessionId(parsed.session_id)) {
        parsed.session_id = null;
      }
      return JSON.stringify(parsed);
    }
  } catch {
    return raw.replace(
      /"session_id"\s*:\s*"\s*(?:\/?null|\/?undefined|none)?\s*"/gi,
      '"session_id":null',
    );
  }
  return raw;
}

function shouldNormalizeEmptySessionId(value: unknown) {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "null" ||
    normalized === "/null" ||
    normalized === "undefined" ||
    normalized === "/undefined" ||
    normalized === "none" ||
    normalized === "/none"
  );
}

export function isSpawnAgentTool(toolName: string) {
  const normalized = String(toolName || "")
    .trim()
    .toLowerCase();
  return (
    normalized === "spawn_agent" ||
    normalized.endsWith(".spawn_agent") ||
    normalized.endsWith("__spawn_agent") ||
    normalized.endsWith("/spawn_agent") ||
    normalized.endsWith("-spawn_agent")
  );
}

function shouldUsePriorityServiceTier(credential: {
  fastEnabled?: boolean;
  planType?: string;
}) {
  return Boolean(
    credential.fastEnabled && isFastServiceTierPlan(credential.planType || ""),
  );
}

function isFastServiceTierPlan(planType: string) {
  const normalized = planType
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  return (
    normalized === "pro" || normalized === "pro20" || normalized === "pro20x"
  );
}

function normalizeRawCodexPayloadForUpstream(
  payload: Record<string, unknown>,
  options: { preservePreviousResponseId?: boolean } = {},
) {
  if (payload.instructions === undefined || payload.instructions === null) {
    payload.instructions = "";
  }

  // Match CLIProxyAPI's Codex upstream compatibility cleanup.
  if (!options.preservePreviousResponseId) {
    delete payload.previous_response_id;
  }
  delete payload.user;
  delete payload.temperature;
  delete payload.top_p;
  delete payload.max_output_tokens;
  delete payload.max_completion_tokens;
  delete payload.stream_options;
  delete payload.context_management;
  delete payload.truncation;
  delete payload.prompt_cache_retention;
  delete payload.safety_identifier;

  normalizeReasoningForCodex(payload);
}

function stripUnsupportedCodexFields(
  payload: Record<string, unknown>,
  input: { allowStore: boolean },
) {
  delete payload.user;
  delete payload.temperature;
  delete payload.top_p;
  delete payload.max_output_tokens;
  delete payload.max_completion_tokens;
  delete payload.stream_options;
  if (!input.allowStore) {
    delete payload.store;
  }
  delete payload.context_management;
  delete payload.truncation;
  delete payload.prompt_cache_retention;
  delete payload.safety_identifier;
  normalizeReasoningForCodex(payload);
  if (payload.service_tier && payload.service_tier !== "priority") {
    delete payload.service_tier;
  }
}

function normalizeReasoningForCodex(payload: Record<string, unknown>) {
  if (payload.reasoning === true) {
    payload.reasoning = { effort: "medium" };
    return;
  }
  if (payload.reasoning === false) {
    payload.reasoning = { effort: "none" };
    return;
  }
  if (!isRecord(payload.reasoning)) {
    delete payload.reasoning;
    return;
  }

  const reasoning = payload.reasoning;
  const effort = normalizeReasoningEffort(reasoning.effort);
  const enabledEffort = reasoningEnabledToEffort(reasoning.enabled);
  const normalizedEffort = effort || enabledEffort;
  const next = cloneJsonObject(reasoning);
  delete next.enabled;

  if (normalizedEffort) {
    next.effort = normalizedEffort;
  } else {
    delete next.effort;
  }
  stripUndefinedDeep(next);
  if (Object.keys(next).length > 0) {
    payload.reasoning = next;
  } else {
    delete payload.reasoning;
  }
}

function normalizeCodexBuiltinTools(payload: Record<string, unknown>) {
  if (Array.isArray(payload.tools)) {
    payload.tools = payload.tools.map((tool) =>
      normalizeCodexBuiltinTool(tool),
    );
  }
  if (isRecord(payload.tool_choice)) {
    payload.tool_choice = normalizeCodexBuiltinToolChoice(payload.tool_choice);
  }
}

function normalizeCodexBuiltinToolChoice(toolChoice: Record<string, unknown>) {
  const next = cloneJsonObject(toolChoice);
  const normalizedType = normalizeCodexBuiltinToolType(next.type);
  if (normalizedType) {
    next.type = normalizedType;
  }
  if (Array.isArray(next.tools)) {
    next.tools = next.tools.map((tool: unknown) =>
      normalizeCodexBuiltinTool(tool),
    );
  }
  return next;
}

function normalizeCodexBuiltinTool(rawTool: unknown) {
  if (!isRecord(rawTool)) {
    return rawTool;
  }
  const tool = cloneJsonObject(rawTool);
  const normalizedType = normalizeCodexBuiltinToolType(tool.type);
  if (normalizedType) {
    tool.type = normalizedType;
  }
  return tool;
}

function normalizeCodexBuiltinToolType(type: unknown) {
  switch (stringValue(type)) {
    case "web_search_preview":
    case "web_search_preview_2025_03_11":
      return "web_search";
    default:
      return "";
  }
}

function ensureImageGenerationTool(
  payload: Record<string, unknown>,
  input: { planType?: string | null } = {},
) {
  const model = stringValue(payload.model).trim();
  if (model.endsWith("spark") || isFreeCodexPlan(input.planType)) {
    return;
  }
  if (!Array.isArray(payload.tools)) {
    payload.tools = [{ ...CODEX_IMAGE_GENERATION_TOOL }];
    return;
  }
  if (
    payload.tools.some(
      (tool) => isRecord(tool) && tool.type === "image_generation",
    )
  ) {
    return;
  }
  payload.tools = [...payload.tools, { ...CODEX_IMAGE_GENERATION_TOOL }];
}

function isFreeCodexPlan(planType: unknown) {
  return stringValue(planType).trim().toLowerCase() === "free";
}

function normalizeReasoningEffort(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return budgetToCodexEffort(value);
  }
  const raw = stringValue(value).toLowerCase();
  if (!raw) {
    return "";
  }
  if (THINKING_SUFFIX_LEVELS.has(raw)) {
    return raw;
  }
  if (/^\d+$/.test(raw)) {
    const budget = Number.parseInt(raw, 10);
    return Number.isFinite(budget) ? budgetToCodexEffort(budget) : "";
  }
  return "";
}

function reasoningEnabledToEffort(value: unknown) {
  if (value === true) {
    return "medium";
  }
  if (value === false) {
    return "none";
  }
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return "medium";
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return "none";
  }
  return "";
}

function deterministicUuid(seed: string) {
  const hash = crypto.createHash("sha1").update(seed).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function cloneJsonObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  return structuredClone(value) as Record<string, unknown>;
}

function stripUndefinedDeep(value: unknown): unknown {
  if (!isRecord(value) && !Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      stripUndefinedDeep(item);
    }
    return value;
  }
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    } else {
      stripUndefinedDeep(value[key]);
    }
  }
  return value;
}

function parseMaybeJson<T>(text: string) {
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "";
}

function numberValue(value: unknown) {
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return Math.floor(value);
    }
    return 0;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}
