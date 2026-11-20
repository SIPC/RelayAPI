import "server-only";

import { HttpError } from "@/src/server/http/errors";
import {
  antigravityModelInfo,
  antigravityObject as object,
  antigravityRequestId,
  antigravitySessionId,
  antigravityString as string,
  isAntigravityClaudeModel,
  type AntigravityModelInfo,
} from "@/src/server/antigravity/protocol";
import { cleanAntigravityResponseSchema, cleanAntigravityToolSchema } from "@/src/server/antigravity/schema";

export const ANTIGRAVITY_SIGNATURE_PREFIX = "relay-antigravity:";
export const ANTIGRAVITY_CALL_ID_PREFIX = "call_relay_agy_";
// CPA replays function calls without a stored signature with Gemini's documented bypass value.
const SKIP_SIGNATURE = "skip_thought_signature_validator";
const CLAUDE_55 = /^claude-(opus|sonnet)-5-5(?:-(high|reasoning))?(?:-[0-9]{8})?(?:\[[^[\]]+\])?$/;
const LEVEL_BUDGETS: Record<string, number> = {
  none: 0, auto: -1, minimal: 512, low: 1024, medium: 8192, high: 24576, xhigh: 32768, max: 128000,
};
const LEVEL_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

type Part = Record<string, unknown>;
type Content = { role: "user" | "model"; parts: Part[] };
type Thinking = { mode: "none" | "auto" | "level" | "budget"; level?: string; budget?: number };

function invalid(message: string): never {
  throw new HttpError(400, "unsupported_antigravity_input", message);
}

// Builds the Antigravity request from a Responses-shaped body. Chat and Claude Messages are converted
// to this shape first, so every entry point gets the same CPA request cleanup.
export function antigravityResponsesPayload(
  input: Record<string, unknown>,
  model: string,
  options: { includeThoughtsByDefault?: boolean; countTokens?: boolean } = {},
) {
  if (input.previous_response_id || input.conversation || input.background === true) {
    invalid("Antigravity Responses requires the full input history and foreground execution");
  }
  const claude = isAntigravityClaudeModel(model);
  const system: Part[] = typeof input.instructions === "string" && input.instructions ? [{ text: input.instructions }] : [];
  let contents: Content[] = [];
  const callNames = new Map<string, { name: string; upstreamId?: string }>();
  let signature = "";

  function append(role: Content["role"], parts: Part[]) {
    if (!parts.length) return;
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  }

  const entries = Array.isArray(input.input) ? input.input
    : typeof input.input === "string" ? [{ role: "user", content: input.input }] : [];
  for (const entry of entries) {
    const item = object(entry);
    const type = string(item.type) || "message";
    if (type === "reasoning") {
      const encrypted = string(item.encrypted_content);
      if (encrypted.startsWith(ANTIGRAVITY_SIGNATURE_PREFIX)) {
        const encoded = encrypted.slice(ANTIGRAVITY_SIGNATURE_PREFIX.length);
        if (encoded.startsWith("thought:")) {
          const summary = Array.isArray(item.summary)
            ? item.summary.map(value => string(object(value).text)).join("") : "";
          append("model", [{ text: summary, thought: true, thoughtSignature: encoded.slice("thought:".length) }]);
        } else {
          signature = encoded;
        }
      }
      continue;
    }
    if (type === "message") {
      const parts = contentParts(item.content);
      if (item.role === "developer" || item.role === "system") {
        system.push(...parts);
      } else if (item.role === "assistant") {
        if (signature && parts[0]) {
          parts[0].thoughtSignature = signature;
          signature = "";
        }
        append("model", parts);
      } else if (item.role === "user") {
        signature = "";
        append("user", parts);
      } else {
        invalid("Antigravity received an unsupported message role");
      }
      continue;
    }
    if (type === "function_call" || type === "custom_tool_call") {
      const name = string(item.name);
      const id = string(item.call_id);
      if (!name || !id) invalid("Tool calls require a name and call_id");
      const upstreamId = id.startsWith(ANTIGRAVITY_CALL_ID_PREFIX) ? undefined : id;
      const args = type === "custom_tool_call" ? { input: string(item.input) } : jsonArguments(string(item.arguments));
      callNames.set(id, { name, upstreamId });
      const callSignature = signature || (claude ? "" : SKIP_SIGNATURE);
      append("model", [{ functionCall: { name, args, id: upstreamId }, ...(callSignature && { thoughtSignature: callSignature }) }]);
      signature = "";
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const call = callNames.get(string(item.call_id));
      if (!call) invalid("Tool outputs require the corresponding assistant call in input history");
      const output = item.output;
      const result = typeof output === "string" || (output && typeof output === "object")
        ? output : invalid("Antigravity requires a string or JSON tool result");
      append("user", [{ functionResponse: { name: call.name, id: call.upstreamId, response: { output: result } } }]);
      continue;
    }
    invalid("Antigravity does not support Responses input type " + type);
  }
  if (!contents.length) invalid("Antigravity requires a message in input");

  // CPA cleans tool schemas in the Antigravity subset; VALIDATED models also need placeholder properties.
  const validated = claude || /gemini-3(\.1)?-pro/.test(model);
  const tools = Array.isArray(input.tools) ? input.tools : [];
  const functionDeclarations = tools.map(value => {
    const tool = object(value);
    const name = string(tool.name);
    if (!name || (tool.type !== "function" && tool.type !== "custom")) {
      invalid("Antigravity Responses supports function and custom tools");
    }
    const schema = tool.type === "custom"
      ? { type: "object", properties: { input: { type: "string" } }, required: ["input"] }
      : tool.parameters;
    return {
      name,
      description: string(tool.description) || undefined,
      parameters: cleanAntigravityToolSchema(schema, { claude, validated }),
    };
  });
  const choice = object(input.tool_choice);
  let mode = input.tool_choice === "none" ? "NONE"
    : input.tool_choice === "required" || choice.type === "function" || choice.type === "custom" ? "ANY" : "AUTO";
  let allowedFunctionNames = string(choice.name) ? [string(choice.name)] : undefined;

  const generationConfig: Part = {};
  for (const [source, destination] of [
    ["max_output_tokens", "maxOutputTokens"], ["temperature", "temperature"], ["top_p", "topP"], ["top_k", "topK"],
  ]) {
    if (typeof input[source] === "number") generationConfig[destination] = input[source];
  }
  if (Array.isArray(input.stop_sequences) && input.stop_sequences.length) generationConfig.stopSequences = input.stop_sequences;
  const format = object(object(input.text).format);
  if (format.type === "json_object" || format.type === "json_schema") {
    generationConfig.responseMimeType = "application/json";
    if (format.type === "json_schema" && format.schema && typeof format.schema === "object") {
      generationConfig.responseJsonSchema = cleanAntigravityResponseSchema(format.schema);
    }
  }
  applyThinking(generationConfig, input, model, options.includeThoughtsByDefault === true);

  // Claude 5.5 rejects forced tool use with native output schemas, so CPA moves the schema into the prompt.
  let promptStructuredOutput = false;
  if (CLAUDE_55.test(model.toLowerCase()) && format.type === "json_schema" && format.schema && typeof format.schema === "object") {
    system.push({ text: structuredOutputInstruction(format) });
    delete generationConfig.responseMimeType;
    delete generationConfig.responseJsonSchema;
    if (mode === "ANY") {
      mode = "AUTO";
      allowedFunctionNames = undefined;
    }
    promptStructuredOutput = true;
  }
  if (claude) {
    const limit = antigravityModelInfo(model)?.maxTokens;
    const max = generationConfig.maxOutputTokens;
    if (limit && typeof max === "number" && max > limit) generationConfig.maxOutputTokens = limit;
  } else {
    delete generationConfig.maxOutputTokens;
  }

  if (!claude) contents = boundaryUserTurns(contents, !options.countTokens);
  const request: Record<string, unknown> = {
    contents,
    systemInstruction: system.length ? { role: "user", parts: system } : undefined,
    tools: functionDeclarations.length ? [{ functionDeclarations }] : undefined,
    generationConfig: Object.keys(generationConfig).length ? generationConfig : undefined,
  };
  if (options.countTokens) return { request };

  const functionCallingConfig = claude && !promptStructuredOutput
    ? { mode: "VALIDATED", allowedFunctionNames }
    : functionDeclarations.length ? { mode, allowedFunctionNames } : undefined;
  request.toolConfig = functionCallingConfig ? { functionCallingConfig } : undefined;
  const image = model.includes("image");
  if (!image) request.sessionId = antigravitySessionId(contents);
  return {
    model,
    userAgent: "antigravity",
    requestType: image ? "image_gen" : "agent",
    project: "",
    requestId: antigravityRequestId(model),
    request,
  };
}

// Mirrors CPA's Antigravity thinking applier: levels for models that list them, budgets otherwise.
function applyThinking(config: Part, input: Record<string, unknown>, model: string, includeByDefault: boolean) {
  const reasoning = object(input.reasoning);
  const effort = string(reasoning.effort).trim().toLowerCase();
  const budget = typeof reasoning.budget_tokens === "number" ? Math.trunc(reasoning.budget_tokens) : undefined;
  let thinking: Thinking | null = budget !== undefined
    ? { mode: budget === 0 ? "none" : budget === -1 ? "auto" : "budget", budget }
    : effort === "none" ? { mode: "none" }
      : effort === "auto" ? { mode: "auto", budget: -1 }
        : Object.hasOwn(LEVEL_BUDGETS, effort) ? { mode: "level", level: effort } : null;
  const summary = reasoning.summary;
  let include: boolean | undefined;
  if (summary === "none" || summary === null) include = false;
  else if (typeof summary === "string" && summary) include = true;
  else if (includeByDefault && thinking && thinking.mode !== "none") include = true;
  if (!thinking) {
    if (include !== undefined) config.thinkingConfig = { includeThoughts: include };
    return;
  }

  const info = antigravityModelInfo(model);
  if (info && !info.thinking) return;
  const support = info?.thinking;
  const levels = support?.levels ?? [];
  const claude = isAntigravityClaudeModel(model);
  if (support && !levels.length && thinking.mode === "level") {
    thinking = { mode: "budget", budget: LEVEL_BUDGETS[thinking.level!] };
  }
  if (thinking.mode === "level" && levels.length) thinking.level = clampLevel(thinking.level!, levels);
  if (thinking.mode === "budget" && support) thinking.budget = clampBudget(thinking.budget!, support);
  const withInclude = (value: Part) => {
    if (include !== undefined) value.includeThoughts = include;
    config.thinkingConfig = value;
  };
  if (thinking.mode === "none") {
    // Level models drop thinkingConfig; Claude drops it below its minimum budget.
    if (!levels.length && !claude) withInclude({ thinkingBudget: support && !support.zero ? support.min : 0 });
    return;
  }
  if (thinking.mode === "level") {
    withInclude({ thinkingLevel: thinking.level });
    return;
  }
  let value = thinking.mode === "auto" ? -1 : thinking.budget!;
  if (claude && info) {
    const requested = typeof config.maxOutputTokens === "number" && config.maxOutputTokens > 0 ? config.maxOutputTokens : 0;
    const max = requested || info.maxTokens || 0;
    if (max > 0 && value >= max) value = max - 1;
    if (support && support.min > 0 && value >= 0 && value < support.min) return;
    if (!requested && max > 0) config.maxOutputTokens = max;
  }
  withInclude({ thinkingBudget: value });
}

function clampLevel(level: string, supported: string[]) {
  if (supported.includes(level)) return level;
  const position = LEVEL_ORDER.indexOf(level);
  if (position < 0) return level;
  let best = level;
  let distance = Infinity;
  for (const candidate of supported) {
    const index = LEVEL_ORDER.indexOf(candidate);
    if (index < 0) continue;
    const next = Math.abs(index - position);
    if (next < distance || (next === distance && index < LEVEL_ORDER.indexOf(best))) {
      best = candidate;
      distance = next;
    }
  }
  return best;
}

function clampBudget(value: number, support: NonNullable<AntigravityModelInfo["thinking"]>) {
  if (value === -1) return value;
  if (value === 0) return support.zero ? 0 : support.min;
  return Math.min(Math.max(value, support.min), support.max);
}

// Gemini rejects requests that begin or end with a model turn; CPA adds empty user turns and first drops a
// trailing reasoning-only model turn. countTokens only needs the leading turn.
function boundaryUserTurns(contents: Content[], trailing: boolean) {
  const result = [...contents];
  if (trailing) {
    while (result.length > 1 && result.at(-1)!.role === "model" &&
      result.at(-1)!.parts.every(part => part.thought === true && !part.functionCall && !part.functionResponse)) {
      result.pop();
    }
  }
  if (result[0]?.role === "model") result.unshift({ role: "user", parts: [{ text: "" }] });
  if (trailing && result.at(-1)?.role === "model") result.push({ role: "user", parts: [{ text: "" }] });
  return result;
}

function structuredOutputInstruction(format: Record<string, unknown>) {
  const lines = ["You must format your entire response as valid JSON that conforms strictly to the following JSON schema:"];
  if (string(format.name).trim()) lines.push("Schema Name: " + string(format.name).trim());
  if (string(format.description).trim()) lines.push("Schema Description: " + string(format.description).trim());
  lines.push("JSON Schema:", JSON.stringify(format.schema));
  return lines.join("\n") +
    "\nDo not include any explanations, markdown code blocks (such as ```json), or any text outside of the JSON object.";
}

function contentParts(content: unknown): Part[] {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [];
  return content.map(value => {
    const part = object(value);
    if (part.type === "input_text" || part.type === "output_text") return { text: string(part.text) };
    if (part.type === "input_image") {
      const image = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(string(part.image_url));
      if (!image) invalid("Antigravity input images require an inline base64 image URL");
      return { inlineData: { mimeType: image[1], data: image[2] } };
    }
    return invalid("Antigravity does not support this Responses content part");
  });
}

function jsonArguments(raw: string) {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // The error below does not include untrusted tool arguments.
  }
  return invalid("Function call arguments must be a JSON object");
}
