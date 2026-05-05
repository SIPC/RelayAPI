import "server-only";

import crypto from "node:crypto";
import { serverConfig } from "@/src/server/config/env";
import { ensureFreshCredential } from "@/src/server/services/codexCredentials";
import type { ChannelRecord, UsageSnapshot } from "@/src/shared/types/entities";

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

const THINKING_SUFFIX_LEVELS = new Set([
  "none",
  "auto",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export interface ToolNameMaps {
  originalToShort: Map<string, string>;
  shortToOriginal: Map<string, string>;
}

export async function codexFetch(
  upstreamPath: "/responses" | "/responses/compact",
  payload: Record<string, unknown>,
  input: {
    stream: boolean;
    sourceHeaders: Headers;
    channel: ChannelRecord;
  },
) {
  const credential = await ensureFreshCredential(input.channel.credentialId);
  if (!credential.tokens.access_token) {
    throw new Error("Saved Codex credential does not contain access_token");
  }
  const response = await fetch(
    toCodexUrl(input.channel.baseUrl, upstreamPath),
    {
      method: "POST",
      headers: buildCodexHeaders(credential, {
        stream: input.stream,
        sourceHeaders: input.sourceHeaders,
      }),
      body: JSON.stringify(prepareCodexPayloadForUpstream(payload)),
      signal: AbortSignal.timeout(serverConfig.requestTimeoutMs),
    },
  );
  return { response, credential };
}

export async function codexJson(
  upstreamPath: "/responses" | "/responses/compact",
  payload: Record<string, unknown>,
  input: {
    stream: boolean;
    sourceHeaders: Headers;
    channel: ChannelRecord;
  },
) {
  const { response, credential } = await codexFetch(
    upstreamPath,
    payload,
    input,
  );
  const text = await response.text();
  return {
    response,
    credential,
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
  input: { stream: boolean; sourceHeaders: Headers },
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${credential.tokens.access_token}`,
    Accept: input.stream ? "text/event-stream" : "application/json",
    Connection: "Keep-Alive",
    "User-Agent":
      input.sourceHeaders.get("user-agent") || serverConfig.userAgent,
    Originator: input.sourceHeaders.get("originator") || "codex-tui",
  };
  for (const name of [
    "version",
    "x-codex-turn-metadata",
    "x-client-request-id",
    "x-codex-beta-features",
  ]) {
    const value = input.sourceHeaders.get(name);
    if (value) {
      headers[canonicalHeaderName(name)] = value;
    }
  }
  if (credential.accountId) {
    headers["Chatgpt-Account-Id"] = credential.accountId;
  }
  if (headers["User-Agent"].includes("Mac OS")) {
    headers.Session_id =
      input.sourceHeaders.get("session_id") ||
      input.sourceHeaders.get("session-id") ||
      crypto.randomUUID();
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

export function prepareCodexPayloadForUpstream(payload: unknown) {
  if (!isRecord(payload)) {
    return payload;
  }
  const upstreamPayload = cloneJsonObject(payload);
  applyModelThinkingSuffix(upstreamPayload);
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
        output: stringifyToolOutput(message.content),
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
    out.reasoning = { effort: payload.reasoning_effort };
  } else if (isRecord(payload.reasoning)) {
    out.reasoning = cloneJsonObject(payload.reasoning);
  }

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

function stringifyToolOutput(content: unknown) {
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
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
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    const event = parseMaybeJson<Record<string, unknown>>(data);
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
  return { promptTokens, completionTokens, totalTokens };
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
      if (
        !Object.hasOwn(parsed, "session_id") ||
        parsed.session_id === "" ||
        (typeof parsed.session_id === "string" &&
          parsed.session_id.trim() === "")
      ) {
        parsed.session_id = null;
      }
      return JSON.stringify(parsed);
    }
  } catch {
    return raw.replace(/"session_id"\s*:\s*"\s*"/g, '"session_id":null');
  }
  return raw;
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

function stripUnsupportedCodexFields(
  payload: Record<string, unknown>,
  input: { allowStore: boolean },
) {
  delete payload.user;
  delete payload.temperature;
  delete payload.top_p;
  delete payload.top_k;
  delete payload.max_tokens;
  delete payload.max_output_tokens;
  delete payload.max_completion_tokens;
  delete payload.stream_options;
  if (!input.allowStore) {
    delete payload.store;
  }
  delete payload.include;
  delete payload.parallel_tool_calls;
  delete payload.context_management;
  delete payload.truncation;
  delete payload.prompt_cache_retention;
  delete payload.safety_identifier;
  if (isRecord(payload.reasoning)) {
    delete payload.reasoning.summary;
    if (Object.keys(payload.reasoning).length === 0) {
      delete payload.reasoning;
    }
  }
  if (payload.service_tier && payload.service_tier !== "priority") {
    delete payload.service_tier;
  }
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
