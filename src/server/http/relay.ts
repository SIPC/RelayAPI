import "server-only";

import { createModelsResponse } from "@/src/server/codex/models";
import {
  chatCompletionsToCodex,
  codexFetch,
  codexJson,
  codexResponseToChatCompletion,
  copyUpstreamHeaders,
  extractUsageFromCodexResponse,
  normalizeCompactPayload,
  normalizeResponsesPayload,
  parseCodexSseResponse,
} from "@/src/server/codex/client";
import { createOpenAIChatSseStream } from "@/src/server/codex/chatStream";
import { serverConfig } from "@/src/server/config/env";
import { HttpError, errorToResponse } from "@/src/server/http/errors";
import { appendRequestLog } from "@/src/server/repositories/logs";
import { authenticateRelayRequest } from "@/src/server/services/apiKeys";
import {
  recordChannelFailure,
  recordChannelSuccess,
  selectChannel,
} from "@/src/server/services/channels";
import { listPublicCodexCredentials } from "@/src/server/services/codexCredentials";
import type {
  ChannelRecord,
  RelayApiKeyContext,
  UsageSnapshot,
} from "@/src/shared/types/entities";

export async function handleModels(request: Request) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  try {
    const apiKey = authenticateRelayRequest(request);
    const credentials = await listPublicCodexCredentials();
    const planType =
      new URL(request.url).searchParams.get("plan") ||
      credentials[0]?.planType ||
      "";
    const payload = await createModelsResponse({
      planType,
      openAICompatible: true,
      modelAllowlist: apiKey.modelAllowlist,
    });
    appendRequestLog({
      startedAt,
      method: request.method,
      path: new URL(request.url).pathname,
      requestType: "models",
      stream: false,
      statusCode: 200,
      latencyMs: Date.now() - start,
      apiKeyId: apiKey.id,
      apiKeyPrefix: apiKey.prefix,
      apiKeyName: apiKey.name,
    });
    return Response.json(payload);
  } catch (error) {
    appendErrorLog(request, startedAt, start, "models", error);
    return errorToResponse(error);
  }
}

export async function handleOpenAIResponses(request: Request) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  let apiKey: RelayApiKeyContext | null = null;
  let channel: ChannelRecord | null = null;
  try {
    apiKey = authenticateRelayRequest(request);
    const input = await readJsonObject(request);
    const stream = input.stream !== false;
    const payload = normalizeResponsesPayload(input, { stream: true });
    const model = stringValue(payload.model) || serverConfig.codexDefaultModel;
    const selected = selectChannel({ model, apiKey });
    channel = selected.channel;

    if (stream) {
      return await forwardCodexStream({
        request,
        startedAt,
        start,
        apiKey,
        channel,
        payload,
        upstreamPath: "/responses",
        requestType: "responses",
        fallbackContentType: "text/event-stream; charset=utf-8",
      });
    }

    const result = await codexJson("/responses", payload, {
      stream: true,
      sourceHeaders: request.headers,
      channel,
    });
    const raw = parseCodexSseResponse(result.text) ||
      result.json || { raw: result.text };
    const usage = extractUsageFromCodexResponse(raw);
    if (result.response.ok) {
      recordChannelSuccess(channel);
    } else {
      recordChannelFailure(channel, {
        statusCode: result.response.status,
        message: result.text.slice(0, 500),
      });
    }
    appendSuccessLog({
      request,
      startedAt,
      start,
      apiKey,
      channel,
      credentialEmail: result.credential.email,
      requestType: "responses",
      stream: false,
      model,
      statusCode: result.response.status,
      usage,
    });
    return Response.json(raw, { status: result.response.status });
  } catch (error) {
    if (channel) {
      recordChannelFailure(channel, {
        message: error instanceof Error ? error.message : "request failed",
      });
    }
    appendErrorLog(
      request,
      startedAt,
      start,
      "responses",
      error,
      apiKey,
      channel,
    );
    return errorToResponse(error);
  }
}

export async function handleOpenAIResponsesCompact(request: Request) {
  return handleRawCodexProxy(request, {
    upstreamPath: "/responses/compact",
    requestType: "responses.compact",
    streamFromPayload: false,
    normalizePayload: normalizeCompactPayload,
  });
}

export async function handleRawCodexResponses(request: Request) {
  return handleRawCodexProxy(request, {
    upstreamPath: "/responses",
    requestType: "codex.responses.raw",
    streamFromPayload: true,
    normalizePayload: (payload) => payload,
  });
}

export async function handleRawCodexCompact(request: Request) {
  return handleRawCodexProxy(request, {
    upstreamPath: "/responses/compact",
    requestType: "codex.responses.compact.raw",
    streamFromPayload: false,
    normalizePayload: (payload) => payload,
  });
}

export async function handleChatCompletions(request: Request) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  let apiKey: RelayApiKeyContext | null = null;
  let channel: ChannelRecord | null = null;
  try {
    apiKey = authenticateRelayRequest(request);
    const input = await readJsonObject(request);
    const stream = Boolean(input.stream);
    const { payload, toolNameMaps } = chatCompletionsToCodex(input, {
      stream: true,
    });
    const model = stringValue(payload.model) || serverConfig.codexDefaultModel;
    const selected = selectChannel({ model, apiKey });
    channel = selected.channel;

    if (stream) {
      const { response, credential } = await codexFetch("/responses", payload, {
        stream: true,
        sourceHeaders: request.headers,
        channel,
      });
      if (!response.ok) {
        recordChannelFailure(channel, {
          statusCode: response.status,
          message: response.statusText,
        });
        appendSuccessLog({
          request,
          startedAt,
          start,
          apiKey,
          channel,
          credentialEmail: credential.email,
          requestType: "chat.completions",
          stream: true,
          model,
          statusCode: response.status,
          usage: emptyUsage(),
          errorCode: "upstream_error",
          errorMessage: response.statusText,
        });
        const headers = copyUpstreamHeaders(response.headers);
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      }
      const headers = new Headers({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      const body = response.body
        ? createOpenAIChatSseStream(response.body, {
            fallbackModel: model,
            toolNameMaps,
            onCompleted: (usage) => {
              recordChannelSuccess(channel!);
              appendSuccessLog({
                request,
                startedAt,
                start,
                apiKey: apiKey!,
                channel: channel!,
                credentialEmail: credential.email,
                requestType: "chat.completions",
                stream: true,
                model,
                statusCode: 200,
                usage,
              });
            },
          })
        : null;
      return new Response(body, { status: 200, headers });
    }

    const result = await codexJson("/responses", payload, {
      stream: true,
      sourceHeaders: request.headers,
      channel,
    });
    if (!result.response.ok) {
      recordChannelFailure(channel, {
        statusCode: result.response.status,
        message: result.text.slice(0, 500),
      });
      appendSuccessLog({
        request,
        startedAt,
        start,
        apiKey,
        channel,
        credentialEmail: result.credential.email,
        requestType: "chat.completions",
        stream: false,
        model,
        statusCode: result.response.status,
        usage: emptyUsage(),
        errorCode: "upstream_error",
        errorMessage: result.text.slice(0, 500),
      });
      return new Response(
        result.text || JSON.stringify({ error: { message: "Upstream error" } }),
        {
          status: result.response.status,
          headers: copyUpstreamHeaders(result.response.headers),
        },
      );
    }
    const raw = parseCodexSseResponse(result.text) || result.json;
    const usage = extractUsageFromCodexResponse(raw);
    recordChannelSuccess(channel);
    appendSuccessLog({
      request,
      startedAt,
      start,
      apiKey,
      channel,
      credentialEmail: result.credential.email,
      requestType: "chat.completions",
      stream: false,
      model,
      statusCode: 200,
      usage,
    });
    return Response.json(
      codexResponseToChatCompletion(raw, model, toolNameMaps),
      { status: 200 },
    );
  } catch (error) {
    if (channel) {
      recordChannelFailure(channel, {
        message: error instanceof Error ? error.message : "request failed",
      });
    }
    appendErrorLog(
      request,
      startedAt,
      start,
      "chat.completions",
      error,
      apiKey,
      channel,
    );
    return errorToResponse(error);
  }
}

async function handleRawCodexProxy(
  request: Request,
  input: {
    upstreamPath: "/responses" | "/responses/compact";
    requestType: string;
    streamFromPayload: boolean;
    normalizePayload: (
      payload: Record<string, unknown>,
    ) => Record<string, unknown>;
  },
) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  let apiKey: RelayApiKeyContext | null = null;
  let channel: ChannelRecord | null = null;
  try {
    apiKey = authenticateRelayRequest(request);
    const rawPayload = await readJsonObject(request);
    const payload = input.normalizePayload(rawPayload);
    const stream = input.streamFromPayload ? payload.stream !== false : false;
    const model = stringValue(payload.model) || serverConfig.codexDefaultModel;
    const selected = selectChannel({ model, apiKey });
    channel = selected.channel;
    if (stream) {
      return await forwardCodexStream({
        request,
        startedAt,
        start,
        apiKey,
        channel,
        payload,
        upstreamPath: input.upstreamPath,
        requestType: input.requestType,
        fallbackContentType: "text/event-stream; charset=utf-8",
      });
    }
    const result = await codexJson(input.upstreamPath, payload, {
      stream: false,
      sourceHeaders: request.headers,
      channel,
    });
    const usage = extractUsageFromCodexResponse(result.json);
    if (result.response.ok) {
      recordChannelSuccess(channel);
    } else {
      recordChannelFailure(channel, {
        statusCode: result.response.status,
        message: result.text.slice(0, 500),
      });
    }
    appendSuccessLog({
      request,
      startedAt,
      start,
      apiKey,
      channel,
      credentialEmail: result.credential.email,
      requestType: input.requestType,
      stream: false,
      model,
      statusCode: result.response.status,
      usage,
      ...(result.response.ok
        ? {}
        : {
            errorCode: "upstream_error",
            errorMessage: result.text.slice(0, 500),
          }),
    });
    return new Response(result.text, {
      status: result.response.status,
      headers: withDefaultContentType(
        copyUpstreamHeaders(result.response.headers),
        "application/json; charset=utf-8",
      ),
    });
  } catch (error) {
    if (channel) {
      recordChannelFailure(channel, {
        message: error instanceof Error ? error.message : "request failed",
      });
    }
    appendErrorLog(
      request,
      startedAt,
      start,
      input.requestType,
      error,
      apiKey,
      channel,
    );
    return errorToResponse(error);
  }
}

async function forwardCodexStream(input: {
  request: Request;
  startedAt: string;
  start: number;
  apiKey: RelayApiKeyContext;
  channel: ChannelRecord;
  payload: Record<string, unknown>;
  upstreamPath: "/responses" | "/responses/compact";
  requestType: string;
  fallbackContentType: string;
}) {
  const model =
    stringValue(input.payload.model) || serverConfig.codexDefaultModel;
  const { response, credential } = await codexFetch(
    input.upstreamPath,
    input.payload,
    {
      stream: true,
      sourceHeaders: input.request.headers,
      channel: input.channel,
    },
  );
  const headers = withDefaultContentType(
    copyUpstreamHeaders(response.headers),
    input.fallbackContentType,
  );
  if (!response.ok) {
    recordChannelFailure(input.channel, {
      statusCode: response.status,
      message: response.statusText,
    });
    appendSuccessLog({
      request: input.request,
      startedAt: input.startedAt,
      start: input.start,
      apiKey: input.apiKey,
      channel: input.channel,
      credentialEmail: credential.email,
      requestType: input.requestType,
      stream: true,
      model,
      statusCode: response.status,
      usage: emptyUsage(),
      errorCode: "upstream_error",
      errorMessage: response.statusText,
    });
    return new Response(response.body, { status: response.status, headers });
  }
  const body = response.body
    ? createCodexUsageMeterStream(response.body, (usage) => {
        recordChannelSuccess(input.channel);
        appendSuccessLog({
          request: input.request,
          startedAt: input.startedAt,
          start: input.start,
          apiKey: input.apiKey,
          channel: input.channel,
          credentialEmail: credential.email,
          requestType: input.requestType,
          stream: true,
          model,
          statusCode: response.status,
          usage,
        });
      })
    : null;
  return new Response(body, { status: response.status, headers });
}

function createCodexUsageMeterStream(
  upstreamBody: ReadableStream<Uint8Array>,
  onCompleted: (usage: UsageSnapshot) => void,
) {
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = emptyUsage();
  return upstreamBody.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer = collectUsageFromSseText(
          buffer + decoder.decode(chunk, { stream: true }),
          (nextUsage) => {
            usage = nextUsage;
          },
        );
      },
      flush() {
        const tail = decoder.decode();
        if (tail) {
          buffer = collectUsageFromSseText(buffer + tail, (nextUsage) => {
            usage = nextUsage;
          });
        }
        onCompleted(usage);
      },
    }),
  );
}

function collectUsageFromSseText(
  text: string,
  onUsage: (usage: UsageSnapshot) => void,
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
    try {
      const event = JSON.parse(data) as Record<string, unknown>;
      if (event.type === "response.completed") {
        onUsage(extractUsageFromCodexResponse(event.response || event));
      }
    } catch {
      // Ignore non-JSON SSE lines.
    }
  }
  return rest;
}

function appendSuccessLog(input: {
  request: Request;
  startedAt: string;
  start: number;
  apiKey: RelayApiKeyContext;
  channel: ChannelRecord;
  credentialEmail?: string;
  requestType: string;
  stream: boolean;
  model: string;
  statusCode: number;
  usage: UsageSnapshot;
  errorCode?: string;
  errorMessage?: string;
}) {
  appendRequestLog({
    startedAt: input.startedAt,
    method: input.request.method,
    path: new URL(input.request.url).pathname,
    requestType: input.requestType,
    stream: input.stream,
    model: input.model,
    statusCode: input.statusCode,
    latencyMs: Date.now() - input.start,
    apiKeyId: input.apiKey.id,
    apiKeyPrefix: input.apiKey.prefix,
    apiKeyName: input.apiKey.name,
    channelId: input.channel.id,
    channelName: input.channel.name,
    credentialId: input.channel.credentialId,
    credentialEmail: input.credentialEmail || "",
    usage: input.usage,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
  });
}

function appendErrorLog(
  request: Request,
  startedAt: string,
  start: number,
  requestType: string,
  error: unknown,
  apiKey?: RelayApiKeyContext | null,
  channel?: ChannelRecord | null,
) {
  const statusCode = error instanceof HttpError ? error.status : 500;
  appendRequestLog({
    startedAt,
    method: request.method,
    path: new URL(request.url).pathname,
    requestType,
    stream: false,
    statusCode,
    latencyMs: Date.now() - start,
    apiKeyId: apiKey?.id,
    apiKeyPrefix: apiKey?.prefix,
    apiKeyName: apiKey?.name,
    channelId: channel?.id,
    channelName: channel?.name,
    credentialId: channel?.credentialId,
    errorCode: error instanceof HttpError ? error.code : "internal_error",
    errorMessage: error instanceof Error ? error.message : String(error),
  });
}

async function readJsonObject(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 25 * 1024 * 1024) {
    throw new HttpError(413, "body_too_large", "Request body is too large");
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(
      400,
      "invalid_json_object",
      "Request body must be a JSON object",
    );
  }
  return parsed as Record<string, unknown>;
}

function withDefaultContentType(headers: Headers, contentType: string) {
  if (!headers.get("content-type")) {
    headers.set("Content-Type", contentType);
  }
  return headers;
}

function stringValue(value: unknown) {
  return typeof value === "string"
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : "";
}

function emptyUsage(): UsageSnapshot {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}
