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

type ByteStreamController = ReadableStreamDefaultController<Uint8Array>;

interface ToolCallStreamState {
  key: string;
  index: number;
  id: string;
  name: string;
  rawArguments: string;
  announced: boolean;
  argumentDeltasStreamed: boolean;
  argumentsFlushed: boolean;
  bufferArguments: boolean;
}

interface ChatStreamState {
  id: string;
  created: number;
  model: string;
  toolNameMaps: ToolNameMaps | null;
  nextToolCallIndex: number;
  toolCallsByKey: Map<string, ToolCallStreamState>;
  toolCallsByOutputIndex: Map<number, ToolCallStreamState>;
  lastToolCall: ToolCallStreamState | null;
  hasEmittedToolCall: boolean;
  upstreamCompleted: boolean;
  firstTokenReported: boolean;
  done: boolean;
  usage: UsageSnapshot;
  onFirstToken?: () => void;
}

export function createOpenAIChatSseStream(
  upstreamBody: ReadableStream<Uint8Array>,
  input: {
    fallbackModel: string;
    toolNameMaps: ToolNameMaps | null;
    onFirstToken?: () => void;
    onCompleted?: (usage: UsageSnapshot) => void;
    onError?: (error: unknown, usage: UsageSnapshot) => void;
  },
) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state: ChatStreamState = {
    id: `chatcmpl-${cryptoRandomId()}`,
    created: Math.floor(Date.now() / 1000),
    model: input.fallbackModel || serverConfig.codexDefaultModel,
    toolNameMaps: input.toolNameMaps,
    nextToolCallIndex: 0,
    toolCallsByKey: new Map(),
    toolCallsByOutputIndex: new Map(),
    lastToolCall: null,
    hasEmittedToolCall: false,
    upstreamCompleted: false,
    firstTokenReported: false,
    done: false,
    usage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
    },
    onFirstToken: input.onFirstToken,
  };
  let buffer = "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let canceled = false;
  let completionReported = false;

  function clearHeartbeat() {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function reportCompletedOnce() {
    if (!completionReported) {
      completionReported = true;
      input.onCompleted?.(state.usage);
    }
  }

  function reportErrorOnce(error: unknown) {
    if (!completionReported) {
      completionReported = true;
      input.onError?.(error, state.usage);
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      reader = upstreamBody.getReader();
      heartbeat = setInterval(() => {
        safeEnqueue(controller, encoder.encode(": relayapi ping\n\n"));
      }, 10_000);

      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader!.read();
            if (done) {
              break;
            }
            if (!value) {
              continue;
            }
            buffer = processCodexSseForOpenAIChat(
              buffer + decoder.decode(value, { stream: true }),
              controller,
              encoder,
              state,
            );
          }

          if (canceled) {
            return;
          }

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
            buffer = processCodexSseForOpenAIChat(
              `${buffer}\n\n`,
              controller,
              encoder,
              state,
            );
          }
          if (state.upstreamCompleted) {
            if (!state.done) {
              flushAllBufferedOpenAIChatToolArguments(
                controller,
                encoder,
                state,
              );
              writeOpenAIChatDone(
                controller,
                encoder,
                state,
                state.hasEmittedToolCall ? "tool_calls" : "stop",
              );
            }
            reportCompletedOnce();
          } else {
            const error = new Error(
              "Upstream stream ended before response.completed; refusing to synthesize a truncated Chat Completions response",
            );
            reportErrorOnce(error);
            writeOpenAIChatStreamError(controller, encoder, error);
          }
        } catch (error) {
          if (!canceled) {
            reportErrorOnce(error);
            writeOpenAIChatStreamError(controller, encoder, error);
          }
        } finally {
          clearHeartbeat();
          reader?.releaseLock();
          safeClose(controller);
        }
      })();
    },
    cancel() {
      canceled = true;
      clearHeartbeat();
      void reader?.cancel().catch(() => undefined);
    },
  });
}

function processCodexSseForOpenAIChat(
  text: string,
  controller: ByteStreamController,
  encoder: TextEncoder,
  state: ChatStreamState,
) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() || "";

  for (const block of blocks) {
    const data = extractSseData(block);
    if (!data) {
      continue;
    }
    if (data === "[DONE]") {
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

function extractSseData(block: string) {
  const dataLines: string[] = [];
  const bareJsonLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("data:")) {
      let data = line.slice(5);
      if (data.startsWith(" ")) {
        data = data.slice(1);
      }
      dataLines.push(data);
      continue;
    }
    if (
      line.startsWith("event:") ||
      line.startsWith("id:") ||
      line.startsWith("retry:")
    ) {
      continue;
    }
    if (line.startsWith("{") || line.startsWith("[")) {
      bareJsonLines.push(line);
    }
  }
  return (dataLines.length > 0 ? dataLines : bareJsonLines).join("\n").trim();
}

function handleCodexEventAsOpenAIChat(
  event: Record<string, unknown>,
  controller: ByteStreamController,
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
        reportFirstTokenOnce(state);
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
        reportFirstTokenOnce(state);
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
      const toolCall = upsertToolCallFromCodexEvent(state, event, item);
      announceOpenAIChatToolCall(controller, encoder, state, toolCall);
      flushPendingNormalArguments(controller, encoder, state, toolCall);
      return;
    }
    case "response.function_call_arguments.delta": {
      const deltaValue = stringValue(event.delta);
      if (!deltaValue) {
        return;
      }
      const toolCall = getOrCreateToolCallForArgumentsEvent(state, event);
      if (!toolCall.announced || toolCall.bufferArguments) {
        toolCall.rawArguments += deltaValue;
        return;
      }
      writeOpenAIChatToolArguments(
        controller,
        encoder,
        state,
        toolCall,
        deltaValue,
      );
      toolCall.argumentDeltasStreamed = true;
      return;
    }
    case "response.function_call_arguments.done": {
      const toolCall = getOrCreateToolCallForArgumentsEvent(state, event);
      const fullArguments = stringValue(event.arguments);
      if (fullArguments && !toolCall.argumentDeltasStreamed) {
        toolCall.rawArguments = fullArguments;
      }
      flushCompletedToolArguments(controller, encoder, state, toolCall);
      return;
    }
    case "response.output_item.done": {
      const item = objectValue(event.item) || {};
      if (item.type !== "function_call") {
        return;
      }
      const toolCall = upsertToolCallFromCodexEvent(state, event, item);
      announceOpenAIChatToolCall(controller, encoder, state, toolCall);
      const fullArguments = stringValue(item.arguments);
      if (fullArguments && !toolCall.argumentDeltasStreamed) {
        toolCall.rawArguments = fullArguments;
      }
      flushCompletedToolArguments(controller, encoder, state, toolCall);
      return;
    }
    case "response.completed": {
      state.upstreamCompleted = true;
      const response = objectValue(event.response) || {};
      state.usage = normalizeUsage(response.usage);
      flushAllBufferedOpenAIChatToolArguments(controller, encoder, state);
      writeOpenAIChatDone(
        controller,
        encoder,
        state,
        state.hasEmittedToolCall ? "tool_calls" : "stop",
        state.usage,
      );
      return;
    }
    default:
      return;
  }
}

function reportFirstTokenOnce(state: ChatStreamState) {
  if (state.firstTokenReported) {
    return;
  }
  state.firstTokenReported = true;
  state.onFirstToken?.();
}

function upsertToolCallFromCodexEvent(
  state: ChatStreamState,
  event: Record<string, unknown>,
  item: Record<string, unknown>,
) {
  const key =
    toolCallKeyFromCodexEvent(event, item) || `seq:${state.nextToolCallIndex}`;
  let toolCall = state.toolCallsByKey.get(key);
  const outputIndex = integerValue(event.output_index);
  if (!toolCall && outputIndex !== null) {
    toolCall = state.toolCallsByOutputIndex.get(outputIndex);
  }
  if (!toolCall) {
    toolCall = {
      key,
      index: state.nextToolCallIndex,
      id: "",
      name: "",
      rawArguments: "",
      announced: false,
      argumentDeltasStreamed: false,
      argumentsFlushed: false,
      bufferArguments: true,
    };
    state.nextToolCallIndex += 1;
  }

  const restoredName = restoreOriginalToolName(
    stringValue(item.name) || toolCall.name,
    state.toolNameMaps,
  );
  toolCall.key = key;
  toolCall.id =
    stringValue(item.call_id) ||
    stringValue(item.id) ||
    toolCall.id ||
    `call_${cryptoRandomId()}`;
  toolCall.name = restoredName || toolCall.name;
  toolCall.bufferArguments = !toolCall.name || isSpawnAgentTool(toolCall.name);

  state.toolCallsByKey.set(key, toolCall);
  if (outputIndex !== null) {
    state.toolCallsByOutputIndex.set(outputIndex, toolCall);
  }
  state.lastToolCall = toolCall;
  return toolCall;
}

function getOrCreateToolCallForArgumentsEvent(
  state: ChatStreamState,
  event: Record<string, unknown>,
) {
  const key = toolCallKeyFromCodexEvent(event, null);
  if (key) {
    const existing = state.toolCallsByKey.get(key);
    if (existing) {
      state.lastToolCall = existing;
      return existing;
    }
  }

  const outputIndex = integerValue(event.output_index);
  if (outputIndex !== null) {
    const existing = state.toolCallsByOutputIndex.get(outputIndex);
    if (existing) {
      state.lastToolCall = existing;
      return existing;
    }
  }

  if (!key && outputIndex === null && state.lastToolCall) {
    return state.lastToolCall;
  }

  const fallbackKey =
    key ||
    (outputIndex !== null
      ? `idx:${outputIndex}`
      : `seq:${state.nextToolCallIndex}`);
  const toolCall: ToolCallStreamState = {
    key: fallbackKey,
    index: state.nextToolCallIndex,
    id: `call_${cryptoRandomId()}`,
    name: "",
    rawArguments: "",
    announced: false,
    argumentDeltasStreamed: false,
    argumentsFlushed: false,
    bufferArguments: true,
  };
  state.nextToolCallIndex += 1;
  state.toolCallsByKey.set(fallbackKey, toolCall);
  if (outputIndex !== null) {
    state.toolCallsByOutputIndex.set(outputIndex, toolCall);
  }
  state.lastToolCall = toolCall;
  return toolCall;
}

function toolCallKeyFromCodexEvent(
  event: Record<string, unknown>,
  item: Record<string, unknown> | null,
) {
  const itemId = stringValue(event.item_id) || stringValue(item?.id);
  if (itemId) {
    return `item:${itemId}`;
  }
  const callId = stringValue(event.call_id) || stringValue(item?.call_id);
  if (callId) {
    return `call:${callId}`;
  }
  const outputIndex = integerValue(event.output_index);
  if (outputIndex !== null) {
    return `idx:${outputIndex}`;
  }
  return "";
}

function announceOpenAIChatToolCall(
  controller: ByteStreamController,
  encoder: TextEncoder,
  state: ChatStreamState,
  toolCall: ToolCallStreamState,
) {
  if (toolCall.announced || !toolCall.name) {
    return;
  }
  writeOpenAIChatChunk(controller, encoder, state, {
    role: "assistant",
    tool_calls: [
      {
        index: toolCall.index,
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: "",
        },
      },
    ],
  });
  toolCall.announced = true;
  state.hasEmittedToolCall = true;
}

function flushPendingNormalArguments(
  controller: ByteStreamController,
  encoder: TextEncoder,
  state: ChatStreamState,
  toolCall: ToolCallStreamState,
) {
  if (
    !toolCall.announced ||
    toolCall.bufferArguments ||
    toolCall.argumentDeltasStreamed ||
    !toolCall.rawArguments
  ) {
    return;
  }
  writeOpenAIChatToolArguments(
    controller,
    encoder,
    state,
    toolCall,
    toolCall.rawArguments,
  );
  toolCall.argumentDeltasStreamed = true;
  toolCall.rawArguments = "";
}

function flushCompletedToolArguments(
  controller: ByteStreamController,
  encoder: TextEncoder,
  state: ChatStreamState,
  toolCall: ToolCallStreamState,
) {
  if (toolCall.argumentsFlushed || !toolCall.announced) {
    return;
  }

  if (toolCall.bufferArguments) {
    const argumentsText = sanitizeToolCallArguments(
      toolCall.name,
      toolCall.rawArguments || "{}",
    );
    writeOpenAIChatToolArguments(
      controller,
      encoder,
      state,
      toolCall,
      argumentsText,
    );
    toolCall.rawArguments = "";
    toolCall.argumentsFlushed = true;
    return;
  }

  if (!toolCall.argumentDeltasStreamed && toolCall.rawArguments) {
    writeOpenAIChatToolArguments(
      controller,
      encoder,
      state,
      toolCall,
      toolCall.rawArguments,
    );
    toolCall.argumentDeltasStreamed = true;
    toolCall.rawArguments = "";
  }
  toolCall.argumentsFlushed = true;
}

function flushAllBufferedOpenAIChatToolArguments(
  controller: ByteStreamController,
  encoder: TextEncoder,
  state: ChatStreamState,
) {
  for (const toolCall of state.toolCallsByKey.values()) {
    flushCompletedToolArguments(controller, encoder, state, toolCall);
  }
}

function writeOpenAIChatToolArguments(
  controller: ByteStreamController,
  encoder: TextEncoder,
  state: ChatStreamState,
  toolCall: ToolCallStreamState,
  argumentsText: string,
) {
  if (!toolCall.announced || !argumentsText) {
    return;
  }
  writeOpenAIChatChunk(controller, encoder, state, {
    tool_calls: [
      {
        index: toolCall.index,
        function: { arguments: argumentsText },
      },
    ],
  });
}

function writeOpenAIChatChunk(
  controller: ByteStreamController,
  encoder: TextEncoder,
  state: ChatStreamState,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage: UsageSnapshot | null = null,
) {
  const chunk = {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
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
            prompt_tokens_details: {
              cached_tokens: usage.cachedTokens,
            },
          },
        }
      : {}),
  };
  safeEnqueue(controller, encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
}

function writeOpenAIChatStreamError(
  controller: ByteStreamController,
  encoder: TextEncoder,
  error: unknown,
) {
  const payload = {
    error: {
      message: publicStreamErrorMessage(error),
      type: "stream_error",
      code: "upstream_stream_incomplete",
    },
  };
  safeEnqueue(
    controller,
    encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
  );
  safeEnqueue(controller, encoder.encode("data: [DONE]\n\n"));
}

function publicStreamErrorMessage(error: unknown) {
  if (
    error instanceof Error &&
    error.message.includes("Upstream stream ended before response.completed")
  ) {
    return "Upstream stream ended before completion";
  }
  return "Upstream stream error";
}

function writeOpenAIChatDone(
  controller: ByteStreamController,
  encoder: TextEncoder,
  state: ChatStreamState,
  finishReason: string,
  usage: UsageSnapshot | null = null,
) {
  if (state.done) {
    return;
  }
  writeOpenAIChatChunk(controller, encoder, state, {}, finishReason, usage);
  safeEnqueue(controller, encoder.encode("data: [DONE]\n\n"));
  state.done = true;
}

function safeEnqueue(controller: ByteStreamController, chunk: Uint8Array) {
  try {
    controller.enqueue(chunk);
    return true;
  } catch {
    return false;
  }
}

function safeClose(controller: ByteStreamController) {
  try {
    controller.close();
  } catch {
    // Stream was already closed or canceled by the client.
  }
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

function integerValue(value: unknown) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}
