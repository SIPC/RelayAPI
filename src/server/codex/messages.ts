import "server-only";

import { createHash } from "node:crypto";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { buildToolNameMaps, deterministicUuid } from "@/src/server/codex/client";
import { HttpError } from "@/src/server/http/errors";

// Claude Messages -> Codex Responses, following CLIProxyAPI's codex/claude translator: system text becomes a
// developer message, tool names and call IDs are shortened to the Responses limits, thinking budgets map to
// reasoning effort, and only GPT reasoning signatures are replayed.

type Json = Record<string, unknown>;

const CLAUDE_CODE_ATTRIBUTION_PREFIX = "x-anthropic-billing-header:";

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function string(value: unknown) {
  return typeof value === "string" ? value : "";
}

function blocks(content: unknown) {
  return typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.map(object) : [];
}

function invalid(message: string): never {
  throw new HttpError(400, "unsupported_codex_input", message);
}

// Responses call IDs are limited to 64 characters; long Claude IDs keep a stable hashed suffix.
function shortCallId(id: string) {
  if (id.length <= 64) return id;
  const suffix = "_" + createHash("sha256").update(id).digest("hex").slice(0, 16);
  return id.slice(0, 64 - suffix.length) + suffix;
}

function isWebSearchTool(tool: Json) {
  return tool.type === "web_search_20250305" || tool.type === "web_search_20260209";
}

// Same thresholds as CPA's thinking.ConvertBudgetToLevel; Codex has no "auto" level, so a dynamic budget is medium.
function budgetEffort(budget: number) {
  if (budget < 0) return "medium";
  if (budget === 0) return "none";
  if (budget <= 512) return "minimal";
  if (budget <= 1024) return "low";
  if (budget <= 8192) return "medium";
  if (budget <= 24576) return "high";
  return "xhigh";
}

function imagePart(source: Json): Json | null {
  const data = string(source.data) || string(source.base64);
  if (data) return { type: "input_image", image_url: `data:${string(source.media_type) || "application/octet-stream"};base64,${data}` };
  if (source.type === "url" && /^https?:\/\//i.test(string(source.url))) return { type: "input_image", image_url: string(source.url).trim() };
  if (source.type === "file" && string(source.file_id)) return { type: "input_image", file_id: string(source.file_id) };
  return null;
}

function documentPart(block: Json): Json {
  const source = object(block.source);
  const filename = string(block.filename).trim() || string(block.title).trim();
  if (source.type === "text") return { type: "input_text", text: string(source.data) };
  if (source.type === "base64" && string(source.media_type).toLowerCase() === "application/pdf" && string(source.data)) {
    return { type: "input_file", file_data: `data:application/pdf;base64,${string(source.data)}`, filename: filename || "document.pdf" };
  }
  if (source.type === "url" && /^https?:\/\//i.test(string(source.url))) {
    return { type: "input_file", file_url: string(source.url).trim(), ...(filename ? { filename } : {}) };
  }
  return { type: "input_text", text: "[Unsupported document content]" };
}

// Strict json_schema output must list every property in required; otherwise CPA downgrades to non-strict.
function schemaMissesRequired(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(schemaMissesRequired);
  const node = object(schema);
  const properties = object(node.properties);
  if (node.properties && typeof node.properties === "object") {
    const required = new Set(Array.isArray(node.required) ? node.required.map(string) : []);
    if (Object.keys(properties).some(name => !required.has(name))) return true;
  }
  for (const key of ["properties", "$defs", "definitions", "patternProperties"]) {
    if (Object.values(object(node[key])).some(schemaMissesRequired)) return true;
  }
  return ["items", "anyOf", "oneOf", "allOf", "not", "additionalProperties", "prefixItems"]
    .some(key => node[key] !== undefined && typeof node[key] === "object" && schemaMissesRequired(node[key]));
}

function toolParameters(schema: unknown) {
  const parameters = structuredClone(object(schema));
  delete parameters.$schema;
  if (!parameters.type) parameters.type = "object";
  if (parameters.type === "object" && !parameters.properties) parameters.properties = {};
  return parameters;
}

export function claudeMessagesToCodex(payload: Json) {
  const tools = (Array.isArray(payload.tools) ? payload.tools : []).map(object);
  const functionTools = tools.filter(tool => !isWebSearchTool(tool));
  // buildToolNameMaps takes Chat-style tool declarations.
  const toolNameMaps = buildToolNameMaps(functionTools.map(tool => ({ type: "function", function: { name: string(tool.name) } })));
  const toolName = (name: string) => toolNameMaps.originalToShort.get(name) || name.slice(0, 64);
  const webSearchNames = new Set(tools.filter(isWebSearchTool).map(tool => string(tool.name)));

  const input: Json[] = [];
  const systemText = blocks(payload.system).filter(block => block.type === "text").map(block => string(block.text))
    .filter(text => text && !text.trimStart().startsWith(CLAUDE_CODE_ATTRIBUTION_PREFIX));
  if (systemText.length) {
    input.push({ type: "message", role: "developer", content: systemText.map(text => ({ type: "input_text", text })) });
  }

  for (const rawMessage of Array.isArray(payload.messages) ? payload.messages : []) {
    const message = object(rawMessage);
    const assistant = message.role === "assistant";
    if (!assistant && message.role !== "user") invalid("Claude messages require user or assistant roles");
    let parts: Json[] = [];
    const flush = () => {
      if (parts.length) input.push({ type: "message", role: assistant ? "assistant" : "user", content: parts });
      parts = [];
    };
    for (const block of blocks(message.content)) {
      switch (block.type) {
        case "text":
          parts.push({ type: assistant ? "output_text" : "input_text", text: string(block.text) });
          break;
        case "image": {
          const part = !assistant && imagePart(object(block.source));
          if (part) parts.push(part);
          break;
        }
        case "document":
          if (!assistant) parts.push(documentPart(block));
          break;
        case "thinking": {
          // Only Codex-issued signatures (Fernet tokens) can be replayed; Claude signatures are dropped.
          const signature = string(block.signature).trim();
          if (assistant && signature.startsWith("gAAAA")) {
            flush();
            input.push({ type: "reasoning", summary: [], content: null, encrypted_content: signature });
          }
          break;
        }
        case "tool_use":
          if (!assistant) break;
          flush();
          input.push({ type: "function_call", call_id: shortCallId(string(block.id)), name: toolName(string(block.name)),
            arguments: JSON.stringify(object(block.input)) });
          break;
        case "tool_result": {
          if (assistant) break;
          flush();
          const content = block.content;
          const output = typeof content === "string" ? content : blocks(content).flatMap(item => {
            if (item.type === "text") return [{ type: "input_text", text: string(item.text) }];
            if (item.type === "image") return [imagePart(object(item.source))].filter((part): part is Json => Boolean(part));
            if (item.type === "document") return [documentPart(item)];
            return [];
          });
          input.push({ type: "function_call_output", call_id: shortCallId(string(block.tool_use_id)), output });
          break;
        }
        // Server tool results and redacted thinking have no Codex replay form.
        default:
          break;
      }
    }
    flush();
  }

  const out: Json = {
    model: payload.model,
    instructions: "",
    input,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    parallel_tool_calls: object(payload.tool_choice).disable_parallel_tool_use !== true,
  };
  if (tools.length) {
    out.tools = tools.map(tool => isWebSearchTool(tool)
      ? { type: "web_search", ...(Array.isArray(tool.allowed_domains) ? { filters: { allowed_domains: tool.allowed_domains } } : {}),
        ...(tool.user_location ? { user_location: tool.user_location } : {}) }
      : { type: "function", name: toolName(string(tool.name)), description: tool.description,
        parameters: toolParameters(tool.input_schema), strict: tool.strict === true });
    if (webSearchNames.size) out.include = ["reasoning.encrypted_content", "web_search_call.action.sources"];
  }
  const choice = object(payload.tool_choice);
  out.tool_choice = choice.type === "any" ? "required" : choice.type === "none" ? "none"
    : choice.type === "tool" && string(choice.name)
      ? webSearchNames.has(string(choice.name)) ? { type: "web_search" } : { type: "function", name: toolName(string(choice.name)) }
      : "auto";

  const thinking = object(payload.thinking);
  const effort = string(object(payload.output_config).effort).trim().toLowerCase();
  let reasoningEffort = "medium";
  if (thinking.type === "enabled" && typeof thinking.budget_tokens === "number") reasoningEffort = budgetEffort(thinking.budget_tokens);
  else if (thinking.type === "adaptive" || thinking.type === "auto") reasoningEffort = effort || "xhigh";
  else if (thinking.type === "disabled") reasoningEffort = "none";
  else if (!payload.thinking && effort) reasoningEffort = effort;
  out.reasoning = { effort: reasoningEffort };

  const format = object(object(payload.output_config).format);
  if (format.type === "json_schema" && format.schema && typeof format.schema === "object") {
    out.text = { format: { type: "json_schema", name: string(format.name) || "cli_proxy_structured_output",
      strict: format.strict !== false && !schemaMissesRequired(format.schema), schema: format.schema } };
  }
  if (payload.speed === "fast") out.service_tier = "priority";
  return { payload: out, toolNameMaps };
}

// CPA keys Codex prompt caching to one Claude Code session and agent, so every turn of a conversation reuses
// the cache while separate sessions and subagents do not share it. Returns "" without a Claude Code session.
export function claudeCodePromptCacheKey(headers: Headers, payload: Json, model: string) {
  let session = headers.get("x-claude-code-session-id")?.trim() || "";
  if (!session) {
    const userId = string(object(payload.metadata).user_id);
    session = /_session_([a-f0-9-]+)$/.exec(userId)?.[1] || "";
    if (!session && userId.startsWith("{")) {
      try { session = string(object(JSON.parse(userId)).session_id).trim(); } catch { session = ""; }
    }
  }
  if (!session) return "";
  const agent = headers.get("x-claude-code-agent-id")?.trim() || "main";
  return deterministicUuid(["cli-proxy-api:codex:claude-code", model, `claude:${session}:agent:${agent}`].join("\u0000"));
}

// Codex has no token-count endpoint; CPA counts the translated request locally with the model's tokenizer.
export function countCodexInputTokens(payload: Json) {
  const segments: string[] = [];
  const push = (value: unknown) => {
    const text = (typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value)).trim();
    if (text) segments.push(text);
  };
  push(payload.instructions);
  for (const rawItem of Array.isArray(payload.input) ? payload.input : []) {
    const item = object(rawItem);
    if (item.type === "message") for (const part of blocks(item.content)) push(part.text);
    else if (item.type === "function_call") { push(item.name); push(item.arguments); }
    else if (item.type === "function_call_output") {
      if (typeof item.output === "string") push(item.output);
      else for (const part of blocks(item.output)) push(part.text);
    } else push(item.text);
  }
  for (const rawTool of Array.isArray(payload.tools) ? payload.tools : []) {
    const tool = object(rawTool);
    push(tool.name);
    push(tool.description);
    if (tool.parameters !== undefined) push(tool.parameters);
  }
  const format = object(object(payload.text).format);
  push(format.name);
  if (format.schema !== undefined) push(format.schema);
  return segments.length ? countTokens(segments.join("\n")) : 0;
}
