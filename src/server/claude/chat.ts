import "server-only";

import { applyClaudeThinkingEffort } from "@/src/server/claude/wire";

import crypto from "node:crypto";
import { serverConfig } from "@/src/server/config/env";
import { parseClaudeModelSuffixes } from "@/src/server/claude/modelSuffix";
import {
  prepareClaudeOAuthToolNamesForUpstream,
  restoreClaudeToolName,
  type ClaudeToolNameReverseMap,
} from "@/src/server/claude/tools";
import type { UsageSnapshot } from "@/src/shared/types/entities";

const RESPONSE_OUTPUT_INDEX = 0;

export interface ClaudeChatConversion {
  payload: Record<string, unknown>;
  reverseToolNameMap: ClaudeToolNameReverseMap;
}

interface ClaudeStreamState {
  id: string;
  created: number;
  model: string;
  finishReason: string | null;
  usage: UsageSnapshot;
  toolCalls: Map<number, ToolCallState>;
  text: string;
  reasoning: string;
}

interface ToolCallState {
  id: string;
  name: string;
  arguments: string;
}

export function isClaudeModel(model: unknown) {
  return stringValue(model).toLowerCase().startsWith("claude-");
}

export function chatCompletionsToClaude(
  inputPayload: unknown,
  input: { stream: boolean; defaultModel?: string } = { stream: false },
): ClaudeChatConversion {
  const payload = cloneJsonObject(inputPayload);
  const requestedModel =
    stringValue(payload.model) ||
    input.defaultModel ||
    serverConfig.claudeDefaultModel;
  const parsedModel = parseClaudeModelSuffixes(requestedModel);
  const model = parsedModel.baseModel;
  const out: Record<string, unknown> = {
    model,
    max_tokens:
      integerValue(payload.max_tokens) ||
      integerValue(payload.max_completion_tokens) ||
      (model.includes("fable") ? 64000 : 32000),
    messages: [],
    stream: Boolean(input.stream),
  };

  for (const key of ["metadata", "thinking", "output_config", "context_management", "speed", "betas", "prompt_cache_options", "fallbacks"]) {
    if (payload[key] !== undefined) out[key] = structuredClone(payload[key]);
  }

  if (payload.temperature !== undefined) {
    out.temperature = numberValue(payload.temperature);
  } else if (payload.top_p !== undefined) {
    out.top_p = numberValue(payload.top_p);
  }
  if (payload.stop !== undefined) {
    out.stop_sequences = normalizeStopSequences(payload.stop);
  }
  applyReasoningEffort(
    out,
    parsedModel.thinkingEffort || payload.reasoning_effort ||
      objectValue(payload.reasoning)?.effort ||
      "",
  );

  if (parsedModel.hasContextSuffix) out.betas = ["context-1m-2025-08-07"];

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const rawMessage of messages) {
    const message = objectValue(rawMessage) || {};
    const role = stringValue(message.role).toLowerCase();
    if (role === "system" || role === "developer") {
      appendSystemContent(out, message.content);
      continue;
    }
    if (role === "tool") {
      (out.messages as unknown[]).push(openAIToolMessageToClaude(message));
      continue;
    }
    if (role === "user" || role === "assistant") {
      const content = openAIMessageContentToClaude(
        message,
        role === "assistant",
      );
      if (role === "assistant" && Array.isArray(message.tool_calls)) {
        for (const rawToolCall of message.tool_calls) {
          const toolUse = openAIToolCallToClaude(rawToolCall);
          if (toolUse) {
            content.push(toolUse);
          }
        }
      }
      if (content.length > 0 || role === "user") {
        (out.messages as unknown[]).push({ role, content });
      }
    }
  }

  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    out.tools = payload.tools.flatMap((rawTool) => {
      const tool = objectValue(rawTool) || {};
      const fn = objectValue(tool.function);
      if (tool.type !== "function" || !fn) {
        return [];
      }
      const name = stringValue(fn.name);
      if (!name) {
        return [];
      }
      return [
        {
          name,
          description: stringValue(fn.description),
          input_schema: objectValue(fn.parameters) || {
            type: "object",
            properties: {},
          },
        },
      ];
    });
  }

  if (payload.tool_choice !== undefined) {
    const toolChoice = normalizeToolChoice(payload.tool_choice);
    if (toolChoice) {
      out.tool_choice = toolChoice;
    }
  }

  if (payload.parallel_tool_calls === false) {
    const choice = objectValue(out.tool_choice);
    if (choice && choice.type !== "none") choice.disable_parallel_tool_use = true;
    else if (!choice && Array.isArray(out.tools) && out.tools.length > 0) {
      out.tool_choice = { type: "auto", disable_parallel_tool_use: true };
    }
  }
  const format = objectValue(payload.response_format);
  if (format && ["json_object", "json_schema"].includes(stringValue(format.type))) {
    const schema = objectValue(format.json_schema) || format;
    const jsonOnly = "You must format your entire response as a valid JSON object. Do not include any explanations, markdown code blocks (such as ```json), or any text outside of the JSON object.";
    const instruction = format.type === "json_schema" && schema.schema
      ? "You must format your entire response as valid JSON that conforms strictly to the following JSON schema:\n"
        + (schema.name ? `Schema Name: ${schema.name}\n` : "")
        + (schema.description ? `Schema Description: ${schema.description}\n` : "")
        + "JSON Schema:\n" + JSON.stringify(schema.schema)
        + "\nDo not include any explanations, markdown code blocks (such as ```json), or any text outside of the JSON object."
      : jsonOnly;
    appendSystemContent(out, instruction);
  }
  if ((out.messages as unknown[]).length === 0 && out.system) {
    out.messages = [{ role: "user", content: [{ type: "text", text: "" }] }];
  }

  stripUndefinedDeep(out);
  const prepared = prepareClaudeOAuthToolNamesForUpstream(out);
  return {
    payload: prepared.payload,
    reverseToolNameMap: prepared.reverseMap,
  };
}

export function responsesToClaude(
  inputPayload: unknown,
  input: { stream: boolean; defaultModel?: string } = { stream: false },
): ClaudeChatConversion {
  const payload = cloneJsonObject(inputPayload);
  const chatPayload: Record<string, unknown> = {
    model:
      stringValue(payload.model) ||
      input.defaultModel ||
      serverConfig.claudeDefaultModel,
    messages: responsesInputToChatMessages(payload),
    stream: input.stream,
    max_tokens:
      integerValue(payload.max_output_tokens) ||
      integerValue(payload.max_tokens) ||
      integerValue(payload.max_completion_tokens) ||
      undefined,
    temperature: payload.temperature,
    top_p: payload.top_p,
    stop: payload.stop,
    reasoning: payload.reasoning,
    reasoning_effort: payload.reasoning_effort,
    tools: responsesToolsToChatTools(payload.tools),
    tool_choice: responsesToolChoiceToChatToolChoice(payload.tool_choice),
    parallel_tool_calls: payload.parallel_tool_calls,
    response_format: objectValue(payload.text)?.format
      ? { ...objectValue(objectValue(payload.text)?.format) }
      : payload.response_format,
  };
  for (const key of ["metadata", "thinking", "output_config", "context_management", "speed", "betas", "prompt_cache_options", "fallbacks"]) {
    if (payload[key] !== undefined) chatPayload[key] = structuredClone(payload[key]);
  }
  stripUndefinedDeep(chatPayload);
  return chatCompletionsToClaude(chatPayload, input);
}

export function createOpenAIChatStreamFromClaude(
  upstreamBody: ReadableStream<Uint8Array>,
  input: {
    model: string;
    reverseToolNameMap: ClaudeToolNameReverseMap;
    onFirstToken?: () => void;
    onCompleted?: (usage: UsageSnapshot) => void;
    onError?: (error: unknown, usage: UsageSnapshot) => void;
  },
) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const framer = new ClaudeSseFramer();
  const state = initialStreamState(input.model);
  let firstTokenReported = false;
  let completed = false;

  function reportFirstTokenOnce() {
    if (firstTokenReported) {
      return;
    }
    firstTokenReported = true;
    input.onFirstToken?.();
  }

  function reportCompletedOnce() {
    if (completed) {
      return;
    }
    completed = true;
    input.onCompleted?.(state.usage);
  }

  function reportErrorOnce(error: unknown) {
    if (completed) {
      return;
    }
    completed = true;
    input.onError?.(error, state.usage);
  }

  function processText(
    text: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) {
    for (const event of framer.push(text)) {
      for (const chunk of claudeEventToOpenAIChatChunks(
        event,
        state,
        input.reverseToolNameMap,
      )) {
        const delta = openAIChunkDelta(chunk);
        if (delta?.content || delta?.reasoning_content) {
          reportFirstTokenOnce();
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      }
      if (event.type === "message_stop") {
        reportCompletedOnce();
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
    }
  }

  return upstreamBody.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        processText(decoder.decode(chunk, { stream: true }), controller);
      },
      flush(controller) {
        const tail = decoder.decode();
        if (tail) {
          processText(tail, controller);
        }
        for (const event of framer.flush()) {
          for (const chunk of claudeEventToOpenAIChatChunks(
            event,
            state,
            input.reverseToolNameMap,
          )) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
            );
          }
          if (event.type === "message_stop") {
            reportCompletedOnce();
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }
        }
        if (!completed) {
          const error = new Error("Claude stream ended before message_stop");
          reportErrorOnce(error);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: { message: "Upstream stream ended before completion", type: "stream_error" } })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
      },
    }),
  );
}

export function claudeSseTextToOpenAIChatCompletion(
  text: string,
  input: {
    model: string;
    reverseToolNameMap: ClaudeToolNameReverseMap;
  },
) {
  const state = parseClaudeSseText(text, input);
  const message: Record<string, unknown> = {
    role: "assistant",
    content: state.text,
  };
  if (state.reasoning) {
    message.reasoning_content = state.reasoning;
  }
  const toolCalls = stateToolCallsAsOpenAIChat(state, input.reverseToolNameMap);
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return {
    id: state.id,
    object: "chat.completion",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: state.finishReason || "stop",
      },
    ],
    usage: openAIUsage(state.usage),
  };
}

export function claudeSseTextToOpenAIResponse(
  text: string,
  input: {
    model: string;
    reverseToolNameMap: ClaudeToolNameReverseMap;
  },
) {
  const state = parseClaudeSseText(text, input);
  return completedOpenAIResponse(state, input.reverseToolNameMap);
}

export function createOpenAIResponsesStreamFromClaude(
  upstreamBody: ReadableStream<Uint8Array>,
  input: {
    model: string;
    reverseToolNameMap: ClaudeToolNameReverseMap;
    onFirstToken?: () => void;
    onCompleted?: (usage: UsageSnapshot) => void;
    onError?: (error: unknown, usage: UsageSnapshot) => void;
  },
) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const framer = new ClaudeSseFramer();
  const state = initialStreamState(input.model);
  let firstTokenReported = false;
  let completed = false;
  const startedItems = new Set<number>();

  function reportFirstTokenOnce() {
    if (firstTokenReported) {
      return;
    }
    firstTokenReported = true;
    input.onFirstToken?.();
  }

  function reportCompletedOnce() {
    if (completed) {
      return;
    }
    completed = true;
    input.onCompleted?.(state.usage);
  }

  function reportErrorOnce(error: unknown) {
    if (completed) {
      return;
    }
    completed = true;
    input.onError?.(error, state.usage);
  }

  function writeEvent(
    controller: TransformStreamDefaultController<Uint8Array>,
    event: Record<string, unknown>,
  ) {
    const type = stringValue(event.type);
    controller.enqueue(
      encoder.encode(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`),
    );
  }

  function processText(
    text: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) {
    for (const event of framer.push(text)) {
      for (const outEvent of claudeEventToOpenAIResponseEvents(
        event,
        state,
        input.reverseToolNameMap,
        startedItems,
      )) {
        if (
          (outEvent.type === "response.output_text.delta" ||
            outEvent.type === "response.reasoning_summary_text.delta") &&
          textValue(outEvent.delta)
        ) {
          reportFirstTokenOnce();
        }
        writeEvent(controller, outEvent);
      }
      if (event.type === "message_stop") {
        reportCompletedOnce();
      }
    }
  }

  return upstreamBody.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        processText(decoder.decode(chunk, { stream: true }), controller);
      },
      flush(controller) {
        const tail = decoder.decode();
        if (tail) {
          processText(tail, controller);
        }
        for (const event of framer.flush()) {
          for (const outEvent of claudeEventToOpenAIResponseEvents(
            event,
            state,
            input.reverseToolNameMap,
            startedItems,
          )) {
            writeEvent(controller, outEvent);
          }
          if (event.type === "message_stop") {
            reportCompletedOnce();
          }
        }
        if (!completed) {
          const error = new Error("Claude stream ended before message_stop");
          reportErrorOnce(error);
          writeEvent(controller, {
            type: "error",
            error: {
              message: "Upstream stream ended before completion",
              type: "stream_error",
            },
          });
        }
      },
    }),
  );
}

export function extractUsageFromClaudeSseText(text: string) {
  const framer = new ClaudeSseFramer();
  const usage = emptyUsage();
  for (const event of [...framer.push(text), ...framer.flush()]) {
    mergeClaudeUsage(usage, objectValue(event.message)?.usage);
    mergeClaudeUsage(usage, event.usage);
  }
  return usage;
}

export function extractUsageFromClaudeMessage(value: unknown) {
  const usage = emptyUsage();
  mergeClaudeUsage(usage, objectValue(value)?.usage);
  return usage;
}

class ClaudeSseFramer {
  private pending = "";

  push(text: string) {
    if (!text) {
      return [] as Record<string, unknown>[];
    }
    this.pending += text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const blocks = this.pending.split("\n\n");
    this.pending = blocks.pop() || "";
    return blocks.flatMap((block) => parseClaudeSseBlock(block));
  }

  flush() {
    const pending = this.pending.trim();
    this.pending = "";
    return pending ? parseClaudeSseBlock(pending) : [];
  }
}

function parseClaudeSseBlock(block: string) {
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.startsWith("data:")) {
      continue;
    }
    let data = line.slice(5);
    if (data.startsWith(" ")) {
      data = data.slice(1);
    }
    dataLines.push(data);
  }
  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") {
    return [];
  }
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    return [parsed];
  } catch {
    return [];
  }
}

function parseClaudeSseText(
  text: string,
  input: {
    model: string;
    reverseToolNameMap: ClaudeToolNameReverseMap;
  },
) {
  const framer = new ClaudeSseFramer();
  const state = initialStreamState(input.model);
  const events = [...framer.push(text), ...framer.flush()];
  for (const event of events) {
    consumeClaudeEvent(event, state, input.reverseToolNameMap);
  }
  return state;
}

function claudeEventToOpenAIChatChunks(
  event: Record<string, unknown>,
  state: ClaudeStreamState,
  reverseMap: ClaudeToolNameReverseMap,
): Record<string, unknown>[] {
  consumeClaudeEvent(event, state, reverseMap);
  const eventType = stringValue(event.type);
  const chunk = baseChatChunk(state);

  switch (eventType) {
    case "message_start": {
      chunk.choices[0].delta = { role: "assistant" };
      return [chunk];
    }
    case "content_block_start": {
      const block = objectValue(event.content_block);
      if (block?.type !== "tool_use") {
        return [];
      }
      const index = integerValue(event.index) ?? 0;
      const toolCall = state.toolCalls.get(index);
      if (!toolCall) {
        return [];
      }
      chunk.choices[0].delta = {
        tool_calls: [
          {
            index,
            id: toolCall.id,
            type: "function",
            function: {
              name: restoreClaudeToolName(toolCall.name, reverseMap),
              arguments: "",
            },
          },
        ],
      };
      return [chunk];
    }
    case "content_block_delta": {
      const delta = objectValue(event.delta);
      if (delta?.type === "text_delta") {
        const text = textValue(delta.text);
        chunk.choices[0].delta = { content: text };
        return text ? [chunk] : [];
      }
      if (delta?.type === "thinking_delta") {
        const thinking = textValue(delta.thinking);
        chunk.choices[0].delta = {
          reasoning_content: thinking,
        };
        return thinking ? [chunk] : [];
      }
      if (delta?.type === "input_json_delta") {
        const index = integerValue(event.index) ?? 0;
        const partialJson = textValue(delta.partial_json);
        chunk.choices[0].delta = {
          tool_calls: [
            {
              index,
              function: {
                arguments: partialJson,
              },
            },
          ],
        };
        return partialJson ? [chunk] : [];
      }
      return [];
    }
    case "message_delta": {
      chunk.choices[0].finish_reason = state.finishReason;
      chunk.choices[0].delta = {};
      chunk.usage = openAIUsage(state.usage);
      return [chunk];
    }
    case "error": {
      const error = objectValue(event.error);
      return [
        {
          error: {
            message: stringValue(error?.message) || "Claude upstream error",
            type: stringValue(error?.type) || "upstream_error",
          },
        },
      ];
    }
    default:
      return [];
  }
}

function claudeEventToOpenAIResponseEvents(
  event: Record<string, unknown>,
  state: ClaudeStreamState,
  reverseMap: ClaudeToolNameReverseMap,
  startedItems: Set<number>,
): Record<string, unknown>[] {
  consumeClaudeEvent(event, state, reverseMap);
  const eventType = stringValue(event.type);
  switch (eventType) {
    case "message_start":
      return [
        {
          type: "response.created",
          response: baseOpenAIResponse(state, "in_progress"),
        },
      ];
    case "content_block_start": {
      const block = objectValue(event.content_block);
      const index = integerValue(event.index) ?? RESPONSE_OUTPUT_INDEX;
      if (block?.type === "text") {
        startedItems.add(index);
        return [
          {
            type: "response.output_item.added",
            output_index: RESPONSE_OUTPUT_INDEX,
            item: openAIResponseMessageItem(state, "in_progress"),
          },
          {
            type: "response.content_part.added",
            output_index: RESPONSE_OUTPUT_INDEX,
            content_index: 0,
            item_id: openAIResponseMessageId(state),
            part: { type: "output_text", text: "", annotations: [] },
          },
        ];
      }
      if (block?.type !== "tool_use") {
        return [];
      }
      const toolCall = state.toolCalls.get(index);
      if (!toolCall) {
        return [];
      }
      startedItems.add(index);
      const item = openAIResponseFunctionCallItem(
        toolCall,
        reverseMap,
        "in_progress",
      );
      return [
        {
          type: "response.output_item.added",
          output_index: index,
          item,
        },
      ];
    }
    case "content_block_delta": {
      const delta = objectValue(event.delta);
      if (delta?.type === "text_delta") {
        const text = textValue(delta.text);
        return text
          ? [
              {
                type: "response.output_text.delta",
                output_index: RESPONSE_OUTPUT_INDEX,
                content_index: 0,
                item_id: openAIResponseMessageId(state),
                delta: text,
              },
            ]
          : [];
      }
      if (delta?.type === "thinking_delta") {
        const thinking = textValue(delta.thinking);
        return thinking
          ? [
              {
                type: "response.reasoning_summary_text.delta",
                output_index: RESPONSE_OUTPUT_INDEX,
                summary_index: 0,
                delta: thinking,
              },
            ]
          : [];
      }
      if (delta?.type === "input_json_delta") {
        const index = integerValue(event.index) ?? 0;
        const partialJson = textValue(delta.partial_json);
        return partialJson
          ? [
              {
                type: "response.function_call_arguments.delta",
                output_index: index,
                item_id: state.toolCalls.get(index)?.id,
                delta: partialJson,
              },
            ]
          : [];
      }
      return [];
    }
    case "content_block_stop": {
      const index = integerValue(event.index) ?? RESPONSE_OUTPUT_INDEX;
      if (!startedItems.has(index)) {
        return [];
      }
      const toolCall = state.toolCalls.get(index);
      if (toolCall) {
        const item = openAIResponseFunctionCallItem(
          toolCall,
          reverseMap,
          "completed",
        );
        return [
          {
            type: "response.function_call_arguments.done",
            output_index: index,
            item_id: toolCall.id,
            arguments: toolCall.arguments || "{}",
          },
          {
            type: "response.output_item.done",
            output_index: index,
            item,
          },
        ];
      }
      return [
        {
          type: "response.output_text.done",
          output_index: RESPONSE_OUTPUT_INDEX,
          content_index: 0,
          item_id: openAIResponseMessageId(state),
          text: state.text,
        },
        {
          type: "response.content_part.done",
          output_index: RESPONSE_OUTPUT_INDEX,
          content_index: 0,
          item_id: openAIResponseMessageId(state),
          part: { type: "output_text", text: state.text, annotations: [] },
        },
        {
          type: "response.output_item.done",
          output_index: RESPONSE_OUTPUT_INDEX,
          item: openAIResponseMessageItem(state, "completed"),
        },
      ];
    }
    case "message_delta":
      return [
        {
          type: "response.in_progress",
          response: baseOpenAIResponse(state, "in_progress"),
        },
      ];
    case "message_stop":
      return [
        {
          type: "response.completed",
          response: completedOpenAIResponse(state, reverseMap),
        },
      ];
    case "error": {
      const error = objectValue(event.error);
      return [
        {
          type: "error",
          error: {
            message: stringValue(error?.message) || "Claude upstream error",
            type: stringValue(error?.type) || "upstream_error",
          },
        },
      ];
    }
    default:
      return [];
  }
}

function consumeClaudeEvent(
  event: Record<string, unknown>,
  state: ClaudeStreamState,
  reverseMap: ClaudeToolNameReverseMap,
) {
  const eventType = stringValue(event.type);
  switch (eventType) {
    case "message_start": {
      const message = objectValue(event.message);
      state.id = stringValue(message?.id) || state.id;
      state.model = stringValue(message?.model) || state.model;
      mergeClaudeUsage(state.usage, message?.usage);
      return;
    }
    case "content_block_start": {
      const block = objectValue(event.content_block);
      if (block?.type === "tool_use") {
        const index = integerValue(event.index) ?? state.toolCalls.size;
        const inputObject = objectValue(block.input);
        state.toolCalls.set(index, {
          id: stringValue(block.id) || `call_${crypto.randomUUID()}`,
          name: String(
            restoreClaudeToolName(stringValue(block.name), reverseMap),
          ),
          arguments:
            inputObject && Object.keys(inputObject).length > 0
              ? JSON.stringify(inputObject)
              : stringValue(block.input),
        });
      }
      return;
    }
    case "content_block_delta": {
      const delta = objectValue(event.delta);
      if (delta?.type === "text_delta") {
        state.text += textValue(delta.text);
        return;
      }
      if (delta?.type === "thinking_delta") {
        state.reasoning += textValue(delta.thinking);
        return;
      }
      if (delta?.type === "input_json_delta") {
        const index = integerValue(event.index) ?? 0;
        const existing = state.toolCalls.get(index) || {
          id: `call_${crypto.randomUUID()}`,
          name: "",
          arguments: "",
        };
        existing.arguments += textValue(delta.partial_json);
        state.toolCalls.set(index, existing);
      }
      return;
    }
    case "message_delta": {
      const delta = objectValue(event.delta);
      const stopReason = stringValue(delta?.stop_reason);
      if (stopReason) {
        state.finishReason = mapClaudeStopReason(stopReason);
      }
      mergeClaudeUsage(state.usage, event.usage);
      return;
    }
  }
}

function initialStreamState(model: string): ClaudeStreamState {
  return {
    id: `chatcmpl-${crypto.randomBytes(12).toString("base64url")}`,
    created: Math.floor(Date.now() / 1000),
    model,
    finishReason: null,
    usage: emptyUsage(),
    toolCalls: new Map(),
    text: "",
    reasoning: "",
  };
}

function baseChatChunk(state: ClaudeStreamState): {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
  usage?: ReturnType<typeof openAIUsage>;
} {
  return {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta: {} as Record<string, unknown>,
        finish_reason: null as string | null,
      },
    ],
  };
}

function openAIChunkDelta(chunk: Record<string, unknown>) {
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const firstChoice = objectValue(choices[0]);
  return objectValue(firstChoice?.delta);
}

function baseOpenAIResponse(
  state: ClaudeStreamState,
  status: "in_progress" | "completed",
) {
  return {
    id: state.id,
    object: "response",
    created_at: state.created,
    status,
    model: state.model,
    output: status === "completed" ? openAIResponseOutput(state, {}) : [],
    usage: openAIResponsesUsage(state.usage),
  };
}

function completedOpenAIResponse(
  state: ClaudeStreamState,
  reverseMap: ClaudeToolNameReverseMap,
) {
  return {
    ...baseOpenAIResponse(state, "completed"),
    output: openAIResponseOutput(state, reverseMap),
    output_text: state.text,
  };
}

function openAIResponseOutput(
  state: ClaudeStreamState,
  reverseMap: ClaudeToolNameReverseMap,
) {
  const output: Record<string, unknown>[] = [];
  if (state.text || state.reasoning || state.toolCalls.size === 0) {
    output.push(openAIResponseMessageItem(state, "completed"));
  }
  for (const [, toolCall] of [...state.toolCalls.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    output.push(
      openAIResponseFunctionCallItem(toolCall, reverseMap, "completed"),
    );
  }
  return output;
}

function openAIResponseMessageItem(
  state: ClaudeStreamState,
  status: "in_progress" | "completed",
) {
  const content: Record<string, unknown>[] = [];
  if (state.text || status === "in_progress") {
    content.push({ type: "output_text", text: state.text, annotations: [] });
  }
  if (state.reasoning) {
    content.push({ type: "reasoning_summary_text", text: state.reasoning });
  }
  return {
    id: openAIResponseMessageId(state),
    type: "message",
    status,
    role: "assistant",
    content,
  };
}

function openAIResponseMessageId(state: ClaudeStreamState) {
  return state.id.startsWith("msg_") ? state.id : `msg_${state.id}`;
}

function openAIResponseFunctionCallItem(
  toolCall: ToolCallState,
  reverseMap: ClaudeToolNameReverseMap,
  status: "in_progress" | "completed",
) {
  return {
    id: toolCall.id,
    type: "function_call",
    status,
    call_id: toolCall.id,
    name: restoreClaudeToolName(toolCall.name, reverseMap),
    arguments: toolCall.arguments || "{}",
  };
}

function stateToolCallsAsOpenAIChat(
  state: ClaudeStreamState,
  reverseMap: ClaudeToolNameReverseMap,
) {
  return [...state.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, toolCall]) => ({
      index,
      id: toolCall.id,
      type: "function",
      function: {
        name: restoreClaudeToolName(toolCall.name, reverseMap),
        arguments: toolCall.arguments || "{}",
      },
    }));
}

function openAIResponsesUsage(usage: UsageSnapshot) {
  return {
    input_tokens: usage.promptTokens,
    output_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    input_tokens_details: {
      cached_tokens: usage.cachedTokens,
    },
  };
}

function mergeClaudeUsage(usage: UsageSnapshot, rawUsage: unknown) {
  const data = objectValue(rawUsage);
  if (!data) {
    return;
  }
  const inputTokens = integerValue(data.input_tokens);
  const outputTokens = integerValue(data.output_tokens);
  const cacheCreationTokens = integerValue(data.cache_creation_input_tokens);
  const cacheReadTokens = integerValue(data.cache_read_input_tokens);
  if (inputTokens !== null) {
    usage.promptTokens =
      inputTokens + (cacheCreationTokens ?? 0) + (cacheReadTokens ?? 0);
  }
  if (outputTokens !== null) {
    usage.completionTokens = outputTokens;
  }
  if (cacheReadTokens !== null) {
    usage.cachedTokens = cacheReadTokens;
  }
  usage.totalTokens = usage.promptTokens + usage.completionTokens;
}

function openAIUsage(usage: UsageSnapshot) {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: {
      cached_tokens: usage.cachedTokens,
    },
  };
}

function emptyUsage(): UsageSnapshot {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
  };
}

function appendSystemContent(out: Record<string, unknown>, content: unknown) {
  const parts = openAIContentPartsToClaude(content, false).filter(
    (part) => part.type === "text",
  );
  if (parts.length === 0) {
    return;
  }
  const system = Array.isArray(out.system) ? out.system : [];
  out.system = [...system, ...parts];
}

function openAIMessageContentToClaude(
  message: Record<string, unknown>,
  assistant: boolean,
) {
  return openAIContentPartsToClaude(message.content, assistant);
}

function responsesInputToChatMessages(payload: Record<string, unknown>) {
  const messages: Record<string, unknown>[] = [];
  const instructions = textValue(payload.instructions);
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  const input = payload.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) {
    return messages;
  }

  for (const rawItem of input) {
    const item = objectValue(rawItem) || {};
    const type = stringValue(item.type);
    if (
      type === "message" ||
      (item.role !== undefined && item.content !== undefined)
    ) {
      const role = stringValue(item.role) || "user";
      messages.push({
        role: role === "developer" ? "system" : role,
        content: responsesContentToChatContent(
          item.content,
          role === "assistant",
        ),
      });
      continue;
    }
    if (type === "function_call") {
      const callId =
        stringValue(item.call_id || item.id) || crypto.randomUUID();
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: {
              name: stringValue(item.name),
              arguments: textValue(item.arguments) || "{}",
            },
          },
        ],
      });
      continue;
    }
    if (type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: stringValue(item.call_id || item.id),
        content: responsesToolOutputToChatContent(item.output),
      });
    }
  }
  return messages;
}

function responsesContentToChatContent(content: unknown, assistant: boolean) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: Record<string, unknown>[] = [];
  for (const rawPart of content) {
    const part = objectValue(rawPart) || {};
    const type = stringValue(part.type);
    if (type === "input_text" || type === "output_text" || type === "text") {
      parts.push({ type: "text", text: textValue(part.text) });
      continue;
    }
    if (type === "input_image" && !assistant) {
      const imageUrl = stringValue(part.image_url || part.url);
      if (imageUrl) {
        parts.push({ type: "image_url", image_url: { url: imageUrl } });
      }
      continue;
    }
    if (type === "input_file" && !assistant) {
      const fileData = stringValue(part.file_data);
      if (fileData) {
        parts.push({
          type: "file",
          file: {
            file_data: fileData,
            filename: stringValue(part.filename),
          },
        });
      }
    }
  }
  return parts.length > 0 ? parts : "";
}

function responsesToolOutputToChatContent(output: unknown) {
  if (typeof output === "string") {
    return output;
  }
  if (Array.isArray(output)) {
    return output.map((rawPart) => {
      const part = objectValue(rawPart) || {};
      const type = stringValue(part.type);
      if (type === "input_text" || type === "output_text" || type === "text") {
        return { type: "text", text: textValue(part.text) };
      }
      if (type === "input_image") {
        const imageUrl = stringValue(part.image_url || part.url);
        return imageUrl
          ? { type: "image_url", image_url: { url: imageUrl } }
          : { type: "text", text: JSON.stringify(part) };
      }
      return { type: "text", text: JSON.stringify(part) };
    });
  }
  return JSON.stringify(output ?? "");
}

function responsesToolsToChatTools(tools: unknown) {
  if (!Array.isArray(tools)) {
    return undefined;
  }
  const converted = tools.flatMap((rawTool) => {
    const tool = objectValue(rawTool) || {};
    if (tool.type !== "function") {
      return [];
    }
    const fn = objectValue(tool.function);
    if (fn) {
      return [tool];
    }
    const name = stringValue(tool.name);
    if (!name) {
      return [];
    }
    return [
      {
        type: "function",
        function: {
          name,
          description: stringValue(tool.description),
          parameters: objectValue(tool.parameters) || {
            type: "object",
            properties: {},
          },
          strict: tool.strict,
        },
      },
    ];
  });
  return converted.length > 0 ? converted : undefined;
}

function responsesToolChoiceToChatToolChoice(toolChoice: unknown) {
  if (toolChoice === "auto" || toolChoice === "none") {
    return toolChoice;
  }
  if (toolChoice === "required") {
    return "any";
  }
  const object = objectValue(toolChoice);
  if (!object) {
    return undefined;
  }
  if (object.type === "function") {
    const name = stringValue(objectValue(object.function)?.name || object.name);
    return name ? { type: "function", function: { name } } : undefined;
  }
  return undefined;
}

function openAIContentPartsToClaude(content: unknown, assistant: boolean) {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [] as Record<string, unknown>[];
  }
  const parts: Record<string, unknown>[] = [];
  for (const rawPart of content) {
    const part = objectValue(rawPart) || {};
    if (part.type === "text") {
      parts.push({ type: "text", text: textValue(part.text) });
    } else if (part.type === "image_url" && !assistant) {
      const imageUrl = objectValue(part.image_url)
        ? stringValue(objectValue(part.image_url)?.url)
        : stringValue(part.image_url);
      const image = imageUrlToClaudePart(imageUrl);
      if (image) {
        parts.push(image);
      }
    } else if (part.type === "file" && !assistant) {
      const file = objectValue(part.file);
      const document = fileToClaudePart(file);
      if (document) {
        parts.push(document);
      }
    }
  }
  return parts;
}

function imageUrlToClaudePart(imageUrl: string) {
  if (!imageUrl) {
    return null;
  }
  if (imageUrl.startsWith("data:")) {
    const parsed = parseDataUrl(imageUrl);
    if (!parsed) {
      return null;
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: parsed.mediaType,
        data: parsed.data,
      },
    };
  }
  return {
    type: "image",
    source: {
      type: "url",
      url: imageUrl,
    },
  };
}

function fileToClaudePart(file: Record<string, unknown> | null) {
  if (!file) {
    return null;
  }
  const fileData = stringValue(file.file_data);
  if (!fileData) {
    return null;
  }
  const parsed = parseDataUrl(fileData);
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: parsed?.mediaType || "application/octet-stream",
      data: parsed?.data || fileData,
    },
  };
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)?;base64,([\s\S]*)$/);
  if (!match) {
    return null;
  }
  return {
    mediaType: match[1] || "application/octet-stream",
    data: match[2] || "",
  };
}

function openAIToolCallToClaude(rawToolCall: unknown) {
  const toolCall = objectValue(rawToolCall) || {};
  if (toolCall.type !== "function") {
    return null;
  }
  const fn = objectValue(toolCall.function) || {};
  const name = stringValue(fn.name);
  if (!name) {
    return null;
  }
  const args = textValue(fn.arguments);
  return {
    type: "tool_use",
    id:
      stringValue(toolCall.id) ||
      `toolu_${crypto.randomBytes(18).toString("base64url")}`,
    name,
    input: parseJsonObject(args) || {},
  };
}

function openAIToolMessageToClaude(message: Record<string, unknown>) {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: stringValue(message.tool_call_id),
        content: toolResultContent(message.content),
      },
    ],
  };
}

function toolResultContent(content: unknown) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      const object = objectValue(part) || {};
      if (object.type === "text") {
        return { type: "text", text: textValue(object.text) };
      }
      const image =
        object.type === "image_url"
          ? imageUrlToClaudePart(
              stringValue(
                objectValue(object.image_url)?.url || object.image_url,
              ),
            )
          : null;
      return image || { type: "text", text: JSON.stringify(part ?? "") };
    });
  }
  return JSON.stringify(content ?? "");
}

function normalizeToolChoice(toolChoice: unknown) {
  if (toolChoice === "required") return { type: "any" };
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "any") {
    return { type: toolChoice === "any" ? "any" : toolChoice };
  }
  const object = objectValue(toolChoice);
  if (!object) {
    return null;
  }
  if (object.type === "function") {
    const fn = objectValue(object.function);
    const name = stringValue(fn?.name || object.name);
    return name ? { type: "tool", name } : null;
  }
  return null;
}

function normalizeStopSequences(stop: unknown) {
  if (Array.isArray(stop)) {
    return stop.map(stringValue).filter(Boolean);
  }
  const value = stringValue(stop);
  return value ? [value] : undefined;
}

function applyReasoningEffort(out: Record<string, unknown>, rawEffort: unknown) {
  applyClaudeThinkingEffort(out, rawEffort);
}

function mapClaudeStopReason(reason: string) {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "stop_sequence":
    case "end_turn":
    default:
      return "stop";
  }
}

function cloneJsonObject(value: unknown) {
  if (!isRecord(value)) {
    return {} as Record<string, unknown>;
  }
  return structuredClone(value) as Record<string, unknown>;
}

function parseJsonObject(value: string) {
  try {
    const parsed = value ? JSON.parse(value) : {};
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      if (value[index] === undefined) {
        value.splice(index, 1);
      } else {
        stripUndefinedDeep(value[index]);
      }
    }
    return value;
  }
  if (!isRecord(value)) {
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

function objectValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string"
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : "";
}

function textValue(value: unknown) {
  return typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : "";
}

function integerValue(value: unknown) {
  const numberValue =
    typeof value === "number" ? value : Number.parseInt(stringValue(value), 10);
  return Number.isFinite(numberValue) ? Math.floor(numberValue) : null;
}

function numberValue(value: unknown) {
  const numberValue =
    typeof value === "number" ? value : Number(stringValue(value));
  return Number.isFinite(numberValue) ? numberValue : undefined;
}
