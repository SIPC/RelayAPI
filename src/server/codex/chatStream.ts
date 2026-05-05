import "server-only";

import { serverConfig } from "@/src/server/config/env";
import {
  isSpawnAgentTool,
  restoreOriginalToolName,
  sanitizeToolCallArguments,
  type ToolNameMaps,
  normalizeUsage,
} from "@/src/server/codex/client";
import type { UsageSnapshot } from "@/src/shared/types/entities";

interface ChatStreamState {
  id: string;
  created: number;
  model: string;
  toolNameMaps: ToolNameMaps | null;
  functionCallIndex: number;
  currentToolName: string;
  currentToolArguments: string;
  currentToolArgumentsFlushed: boolean;
  shouldBufferToolArguments: boolean;
  hasReceivedArgumentsDelta: boolean;
  hasToolCallAnnounced: boolean;
  done: boolean;
  usage: UsageSnapshot;
}

export function createOpenAIChatSseStream(
  upstreamBody: ReadableStream<Uint8Array>,
  input: {
    fallbackModel: string;
    toolNameMaps: ToolNameMaps | null;
    onCompleted?: (usage: UsageSnapshot) => void;
  },
) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state: ChatStreamState = {
    id: "",
    created: 0,
    model: input.fallbackModel || serverConfig.codexDefaultModel,
    toolNameMaps: input.toolNameMaps,
    functionCallIndex: -1,
    currentToolName: "",
    currentToolArguments: "",
    currentToolArgumentsFlushed: false,
    shouldBufferToolArguments: false,
    hasReceivedArgumentsDelta: false,
    hasToolCallAnnounced: false,
    done: false,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
  let buffer = "";

  return upstreamBody.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer = processCodexSseForOpenAIChat(
          buffer + decoder.decode(chunk, { stream: true }),
          controller,
          encoder,
          state,
        );
      },
      flush(controller) {
        const tail = decoder.decode();
        if (tail) {
          buffer = processCodexSseForOpenAIChat(
            buffer + tail,
            controller,
            encoder,
            state,
          );
        }
        if (buffer.trim()) {
          processCodexSseForOpenAIChat(
            `${buffer}\n`,
            controller,
            encoder,
            state,
          );
        }
        if (!state.done) {
          flushBufferedOpenAIChatToolArguments(controller, encoder, state);
          const finishReason =
            state.functionCallIndex !== -1 ? "tool_calls" : "stop";
          writeOpenAIChatDone(controller, encoder, state, finishReason);
        }
        input.onCompleted?.(state.usage);
      },
    }),
  );
}

function processCodexSseForOpenAIChat(
  text: string,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: ChatStreamState,
) {
  const lines = text.split(/\r?\n/);
  const rest = lines.pop() || "";
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    handleCodexEventAsOpenAIChat(event, controller, encoder, state);
  }
  return rest;
}

function handleCodexEventAsOpenAIChat(
  event: Record<string, unknown>,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: ChatStreamState,
) {
  switch (event.type) {
    case "response.created": {
      const response = objectValue(event.response);
      state.id = stringValue(response?.id) || state.id;
      state.created = numberValue(response?.created_at) || state.created;
      state.model = stringValue(response?.model) || state.model;
      return;
    }
    case "response.reasoning_summary_text.delta":
      if (typeof event.delta === "string") {
        writeOpenAIChatChunk(controller, encoder, state, {
          role: "assistant",
          reasoning_content: event.delta,
        });
      }
      return;
    case "response.reasoning_summary_text.done":
      writeOpenAIChatChunk(controller, encoder, state, {
        role: "assistant",
        reasoning_content: "\n\n",
      });
      return;
    case "response.output_text.delta":
      if (typeof event.delta === "string") {
        writeOpenAIChatChunk(controller, encoder, state, {
          role: "assistant",
          content: event.delta,
        });
      }
      return;
    case "response.output_item.added": {
      const item = objectValue(event.item) || {};
      if (item.type !== "function_call") {
        return;
      }
      state.functionCallIndex += 1;
      state.currentToolName = restoreOriginalToolName(
        stringValue(item.name),
        state.toolNameMaps,
      );
      state.currentToolArguments = "";
      state.currentToolArgumentsFlushed = false;
      state.shouldBufferToolArguments = isSpawnAgentTool(state.currentToolName);
      state.hasReceivedArgumentsDelta = false;
      state.hasToolCallAnnounced = true;
      writeOpenAIChatToolCall(controller, encoder, state, item, "");
      return;
    }
    case "response.function_call_arguments.delta": {
      state.hasReceivedArgumentsDelta = true;
      const deltaValue = stringValue(event.delta);
      if (state.shouldBufferToolArguments) {
        state.currentToolArguments += deltaValue;
      } else {
        writeOpenAIChatToolArguments(controller, encoder, state, deltaValue);
      }
      return;
    }
    case "response.function_call_arguments.done":
      if (!state.hasReceivedArgumentsDelta && event.arguments) {
        state.currentToolArguments = stringValue(event.arguments);
      }
      flushBufferedOpenAIChatToolArguments(controller, encoder, state);
      return;
    case "response.output_item.done": {
      const item = objectValue(event.item) || {};
      if (item.type !== "function_call") {
        return;
      }
      if (state.hasToolCallAnnounced) {
        state.hasToolCallAnnounced = false;
        return;
      }
      state.functionCallIndex += 1;
      state.currentToolName = restoreOriginalToolName(
        stringValue(item.name),
        state.toolNameMaps,
      );
      state.currentToolArguments = stringValue(item.arguments);
      state.currentToolArgumentsFlushed = false;
      state.shouldBufferToolArguments = isSpawnAgentTool(state.currentToolName);
      writeOpenAIChatToolCall(controller, encoder, state, item, "");
      flushBufferedOpenAIChatToolArguments(controller, encoder, state);
      return;
    }
    case "response.completed": {
      const response = objectValue(event.response) || {};
      state.usage = normalizeUsage(response.usage);
      flushBufferedOpenAIChatToolArguments(controller, encoder, state);
      const finishReason =
        state.functionCallIndex !== -1 ? "tool_calls" : "stop";
      writeOpenAIChatDone(
        controller,
        encoder,
        state,
        finishReason,
        state.usage,
      );
      return;
    }
    default:
      return;
  }
}

function writeOpenAIChatToolCall(
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: ChatStreamState,
  item: Record<string, unknown>,
  argumentsText: string,
) {
  writeOpenAIChatChunk(controller, encoder, state, {
    role: "assistant",
    tool_calls: [
      {
        index: state.functionCallIndex,
        id: stringValue(item.call_id),
        type: "function",
        function: {
          name:
            state.currentToolName ||
            restoreOriginalToolName(stringValue(item.name), state.toolNameMaps),
          arguments: argumentsText,
        },
      },
    ],
  });
}

function writeOpenAIChatToolArguments(
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: ChatStreamState,
  argumentsText: string,
) {
  if (state.functionCallIndex < 0 || !argumentsText) {
    return;
  }
  writeOpenAIChatChunk(controller, encoder, state, {
    tool_calls: [
      {
        index: state.functionCallIndex,
        function: { arguments: argumentsText },
      },
    ],
  });
}

function flushBufferedOpenAIChatToolArguments(
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: ChatStreamState,
) {
  if (
    state.functionCallIndex < 0 ||
    state.currentToolArgumentsFlushed ||
    (!state.currentToolArguments && !state.shouldBufferToolArguments)
  ) {
    return;
  }
  const rawArguments =
    state.currentToolArguments || (state.shouldBufferToolArguments ? "{}" : "");
  const argumentsText = sanitizeToolCallArguments(
    state.currentToolName,
    rawArguments,
  );
  writeOpenAIChatToolArguments(controller, encoder, state, argumentsText);
  state.currentToolArguments = "";
  state.currentToolArgumentsFlushed = true;
  state.shouldBufferToolArguments = false;
}

function writeOpenAIChatChunk(
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: ChatStreamState,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage: UsageSnapshot | null = null,
) {
  const chunk = {
    id: state.id || `chatcmpl-${cryptoRandomId()}`,
    object: "chat.completion.chunk",
    created: state.created || Math.floor(Date.now() / 1000),
    model: state.model || serverConfig.codexDefaultModel,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.totalTokens,
          },
        }
      : {}),
  };
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
}

function writeOpenAIChatDone(
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: ChatStreamState,
  finishReason: string,
  usage: UsageSnapshot | null = null,
) {
  if (state.done) {
    return;
  }
  writeOpenAIChatChunk(controller, encoder, state, {}, finishReason, usage);
  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  state.done = true;
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2);
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : "";
}

function numberValue(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.floor(value) : 0;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
