import "server-only";

import { countAntigravityTokens, sendAntigravity, type AntigravityOutcome } from "@/src/server/antigravity/client";
import { claudeMessagesToResponses, responsesStreamToClaude, responsesToClaudeMessage } from "@/src/server/antigravity/messages";
import { antigravityStandardModels, isAntigravityModelId } from "@/src/server/antigravity/protocol";
import { copyAccountQuotaHeaders, withAccountQuotaHeaders } from "@/src/server/http/accountQuota";
import { forwardApiKeyRequest, type ApiKeyRelayResult } from "@/src/server/upstream/forward";
import { forwardedPayloadSnapshot, redactText, redactValue } from "@/src/server/upstream/client";

import { createClaudeNativeSseStream } from "@/src/server/claude/nativeStream";
import { claudePolicy } from "@/src/server/claude/wire";
import { extractUsageFromClaudeMessage } from "@/src/server/claude/chat";

import { createModelsResponse } from "@/src/server/codex/models";
import {
  buildImagesApiResponseFromJsonText,
  buildImagesEditsJsonRequest,
  buildImagesEditsMultipartRequest,
  buildImagesGenerationsRequest,
  createImagesSseStream,
  type CodexImagesRequest,
} from "@/src/server/codex/images";
import { CodexResponsesSseFramer } from "@/src/server/codex/sse";
import {
  chatCompletionsToCodex,
  codexFetch,
  codexJson,
  codexPromptCacheKeyForApiKey,
  codexResponseToChatCompletion,
  copyUpstreamHeaders,
  extractUsageFromCodexResponse,
  normalizeCompactPayload,
  normalizeRawCodexCompactPayload,
  normalizeRawCodexResponsesPayload,
  normalizeResponsesPayload,
  parseCodexSseResponse,
  restoreOriginalToolName,
} from "@/src/server/codex/client";
import { claudeCodePromptCacheKey, claudeMessagesToCodex, countCodexInputTokens } from "@/src/server/codex/messages";
import { createOpenAIChatSseStream } from "@/src/server/codex/chatStream";
import {
  chatCompletionsToClaude,
  claudeSseTextToOpenAIChatCompletion,
  claudeSseTextToOpenAIResponse,
  createOpenAIChatStreamFromClaude,
  createOpenAIResponsesStreamFromClaude,
  extractUsageFromClaudeSseText,
  isClaudeModel,
  responsesToClaude,
} from "@/src/server/claude/chat";
import {
  claudeFetch,
  claudeJson,
  copyClaudeUpstreamHeaders,
} from "@/src/server/claude/client";
import { serverConfig } from "@/src/server/config/env";
import { HttpError, errorToResponse } from "@/src/server/http/errors";
import {
  createStageTimer,
  type StageTimer,
} from "@/src/server/http/stageTimer";
import {
  appendRequestLog,
  appendRequestLogDetail,
  type RequestLogInput,
} from "@/src/server/repositories/logs";
import { authenticateRelayRequest } from "@/src/server/services/apiKeys";
import {
  credentialLogLabel,
  recordChannelFailure,
  recordChannelSuccess,
  selectChannel,
  selectChannelForRequest,
  listChannelRecords,
  apiChannelModel,
  apiKeyAllowsApiModel,
} from "@/src/server/services/channels";
import { listPublicCodexCredentials } from "@/src/server/services/codexCredentials";
import { listAntigravityCredentials } from "@/src/server/repositories/antigravityCredentials";

import { maybeAutoPruneRequestLogs } from "@/src/server/services/logRetention";
import { getFullRequestLoggingSetting } from "@/src/server/services/settings";
import type {
  ChannelRecord,
  RelayApiKeyContext,
  SelectedChannel,
  UpstreamCredentialWithSecret,
  UpstreamOperation,
  UsageSnapshot,
} from "@/src/shared/types/entities";

const DETAIL_TEXT_LIMIT = 512 * 1024;
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "openai-api-key",
  "proxy-authorization",
  "chatgpt-account-id",
]);

export async function handleModels(request: Request) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const timing = createStageTimer();
  try {
    const apiKey = timing.time("authenticate", "认证 API Key", () =>
      authenticateRelayRequest(request),
    );
    const credentials = await timing.timeAsync(
      "list_credentials",
      "读取凭据列表",
      () => listPublicCodexCredentials(),
    );
    const planType =
      new URL(request.url).searchParams.get("plan") ||
      credentials[0]?.planType ||
      "";
    const channels = listChannelRecords();
    const hasOAuthAccess = apiKey.channelAllowlist.length === 0 || channels.some((channel) =>
      (channel.provider === "codex" || channel.provider === "claude") &&
      apiKey.channelAllowlist.includes(channel.id),
    );
    const payload: { object: string; data: Array<{ id: string; object: string; created?: unknown; owned_by?: unknown }> } = hasOAuthAccess
      ? await timing.timeAsync("create_models", "生成模型列表", () =>
          createModelsResponse({ planType, openAICompatible: true, modelAllowlist: apiKey.modelAllowlist }),
        )
      : { object: "list", data: [] };
    const seen = new Set(payload.data.map((entry) => entry.id));
    const enabledAntigravity = new Map(listAntigravityCredentials()
      .filter(credential => credential.enabled).map(credential => [credential.id, credential]));
    for (const channel of channels) {
      const isAntigravity = channel.provider === "antigravity";
      if ((!isAntigravity && channel.provider !== "openai" && channel.provider !== "anthropic") ||
        (!(isAntigravity && apiKey.channelAllowlist.length === 0) && !apiKey.channelAllowlist.includes(channel.id)) || !channel.enabled ||
        channel.status === "disabled" || channel.capabilities.length === 0) continue;
      if (isAntigravity && !channel.credentialIds.some(id => enabledAntigravity.has(id))) continue;
      // An Antigravity channel without an allowlist offers the catalogs of its bound accounts.
      const channelModels = isAntigravity && channel.modelAllowlist.length === 0
        ? antigravityStandardModels(channel.credentialIds.flatMap(id => enabledAntigravity.get(id)?.models ?? []))
        : channel.modelAllowlist;
      for (const model of channelModels) {
        // Ignore non-Gemini entries left in channels configured before AGY became Gemini-only.
        if (isAntigravity && !isAntigravityModelId(model)) continue;
        if (seen.has(model) || (isAntigravity
          ? apiKey.modelAllowlist.length > 0 && !apiKey.modelAllowlist.includes(model)
          : !apiKeyAllowsApiModel(apiKey.modelAllowlist, model))) continue;
        seen.add(model);
        payload.data.push({ id: model, object: "model", owned_by: channel.provider });
      }
    }
    const logId = appendRequestLogWithAutoPrune({
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
    appendOptionalRequestDetail(logId, {
      request,
      full: getFullRequestLoggingSetting(),
      upstreamStatusCode: 200,
      upstreamBody: payload,
      timing,
    });
    return Response.json(payload);
  } catch (error) {
    appendErrorLog(
      request,
      startedAt,
      start,
      "models",
      error,
      null,
      null,
      null,
      timing,
    );
    return errorToResponse(error);
  }
}

export async function handleOpenAIResponses(request: Request) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const timing = createStageTimer();
  let apiKey: RelayApiKeyContext | null = null;
  let channel: ChannelRecord | null = null;
  let input: Record<string, unknown> | null = null;
  try {
    apiKey = timing.time("authenticate", "认证 API Key", () =>
      authenticateRelayRequest(request),
    );
    input = await timing.timeAsync("read_request_body", "读取请求 Body", () =>
      readJsonObject(request),
    );
    const model = stringValue(input.model) || serverConfig.codexDefaultModel;
    const selected = timing.time("select_channel", "选择通道", () =>
      selectChannelForRequest({ operation: "responses", model, apiKey: apiKey!,
        request: { payload: input!, headers: request.headers } }),
    );
    channel = selected.channel;
    if (selected.credential.provider === "antigravity") {
      const stream = input.stream === true;
      const outcome = await dispatchAntigravity({
        request, startedAt, start, timing, apiKey, selected, operation: "responses", model, payload: input,
        stream, includeThoughtsByDefault: true, requestType: "responses.antigravity",
      });
      if (outcome.type === "error") return antigravityErrorResponse(outcome);
      return outcome.type === "stream" ? sseResponse(outcome.body) : Response.json(outcome.value);
    }
    if (isApiCredential(selected.credential)) {
      return await forwardSelectedApiRequest({ request, startedAt, start, timing, apiKey,
        selected, operation: "responses", payload: input, requestType: "responses" });
    }
    if (selected.credential.provider === "claude") {
      return await handleClaudeResponsesWithContext({
        request, startedAt, start, timing, apiKey, input, selection: selected,
      });
    }
    const stream = Boolean(input.stream);
    const payload = timing.time("normalize_payload", "规范化请求 Payload", () =>
      normalizeResponsesPayload(input!, { stream: true }),
    );
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
        requestBody: input,
        forwardedBody: payload,
        timing,
      });
    }

    const result = await codexJson("/responses", payload, {
      stream: true,
      sourceHeaders: request.headers,
      channel,
      promptCacheKey: null,
      timing,
    });
    const raw = timing.time(
      "parse_upstream_response",
      "解析上游响应",
      () =>
        parseCodexSseResponse(result.text) ||
        result.json || { raw: result.text },
    );
    const usage = timing.time("extract_usage", "提取 Token 用量", () =>
      extractUsageFromCodexResponse(raw),
    );
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
      requestBody: input,
      forwardedBody: result.upstreamPayload,
      forwardedHeaders: result.upstreamRequestHeaders,
      upstreamHeaders: result.response.headers,
      upstreamBody: result.text,
      timing,
    });
    if (!result.response.ok) {
      return upstreamErrorResponse(result.response.status, result.response.headers);
    }
    return Response.json(raw, { status: result.response.status, headers: copyAccountQuotaHeaders(result.response.headers) });
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
      input,
      timing,
    );
    return errorToResponse(error);
  }
}

export async function handleOpenAIResponsesCompact(request: Request) {
  return handleRawCodexProxy(request, {
    upstreamPath: "/responses/compact",
    requestType: "responses.compact",
    streamFromPayload: false,
    exposeUpstreamErrors: false,
    normalizePayload: normalizeCompactPayload,
  });
}

export async function handleRawCodexResponses(request: Request) {
  return handleRawCodexProxy(request, {
    upstreamPath: "/responses",
    requestType: "codex.responses.raw",
    streamFromPayload: true,
    exposeUpstreamErrors: true,
    normalizePayload: normalizeRawCodexResponsesPayload,
  });
}

export async function handleRawCodexCompact(request: Request) {
  return handleRawCodexProxy(request, {
    upstreamPath: "/responses/compact",
    requestType: "codex.responses.compact.raw",
    streamFromPayload: false,
    exposeUpstreamErrors: true,
    normalizePayload: normalizeRawCodexCompactPayload,
  });
}

export async function handleImagesGenerations(request: Request) {
  return handleImagesProxy(request, {
    requestType: "images.generations",
    operation: "images_generations",
    readRequest: (timing) => timing.timeAsync("read_request_body", "读取图片请求 Body", () => readJsonObject(request)),
  });
}

export async function handleImagesEdits(request: Request) {
  return handleImagesProxy(request, {
    requestType: "images.edits",
    operation: "images_edits",
    readRequest: async (timing) => {
      const contentType = request.headers.get("content-type") || "";
      if (contentType.toLowerCase().startsWith("application/json")) {
        return timing.timeAsync("read_request_body", "读取图片编辑 JSON Body", () => readJsonObject(request));
      }
      return timing.timeAsync(
        "read_request_body",
        "读取图片编辑 Multipart Body",
        async () => {
          try {
            return await request.formData();
          } catch {
            throw new HttpError(
              400,
              "invalid_multipart_form",
              "Request body must be valid multipart/form-data or JSON",
            );
          }
        },
      );
    },
  });
}

async function handleImagesProxy(
  request: Request,
  input: {
    requestType: string;
    operation: "images_generations" | "images_edits";
    readRequest: (timing: StageTimer) => Promise<Record<string, unknown> | FormData>;
  },
) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const timing = createStageTimer();
  let apiKey: RelayApiKeyContext | null = null;
  let channel: ChannelRecord | null = null;
  let imageRequest: CodexImagesRequest | null = null;
  let original: Record<string, unknown> | FormData | undefined;
  try {
    apiKey = timing.time("authenticate", "认证 API Key", () =>
      authenticateRelayRequest(request),
    );
    original = await input.readRequest(timing);
    const model = stringValue(original instanceof FormData ? original.get("model") : original.model) || "gpt-image-2";
    const selected = timing.time("select_channel", "选择通道", () =>
      selectChannelForRequest({ operation: input.operation, model, apiKey: apiKey! }),
    );
    channel = selected.channel;
    if (isApiCredential(selected.credential)) {
      return await forwardSelectedApiRequest({ request, startedAt, start, timing, apiKey,
        selected, operation: input.operation, payload: original, requestType: input.requestType });
    }
    if (selected.credential.provider !== "codex") {
      throw new HttpError(400, "unsupported_image_provider", "Selected channel does not support image requests");
    }
    const source = original;
    imageRequest = await timing.timeAsync("normalize_payload", "构造 Codex 图片 Payload", async () =>
      source instanceof FormData ? buildImagesEditsMultipartRequest(source)
        : input.operation === "images_edits" ? buildImagesEditsJsonRequest(source)
          : buildImagesGenerationsRequest(source),
    );
    if (isFreeCodexPlan(selected.credential.planType)) {
      throw new HttpError(
        403,
        "image_generation_not_available",
        "Image generation is not available for Free Codex credentials",
      );
    }

    if (imageRequest.stream) {
      return await forwardImagesStream({
        request,
        startedAt,
        start,
        apiKey,
        channel,
        imageRequest,
        requestType: input.requestType,
        timing,
      });
    }

    const result = await codexJson(imageRequest.upstreamPath, imageRequest.payload, {
      stream: false,
      sourceHeaders: request.headers,
      channel,
      promptCacheKey: null,
      transport: "http",
      timing,
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
        requestType: input.requestType,
        stream: false,
        model: imageRequest.model,
        statusCode: result.response.status,
        usage: emptyUsage(),
        errorCode: "upstream_error",
        errorMessage: result.text.slice(0, 500),
        requestBody: imageRequest.requestBody,
        forwardedBody: result.upstreamPayload,
        forwardedHeaders: result.upstreamRequestHeaders,
        upstreamHeaders: result.response.headers,
        upstreamBody: result.text,
        timing,
      });
      return upstreamErrorResponse(result.response.status, result.response.headers);
    }

    let responsePayload: Record<string, unknown>;
    try {
      responsePayload = timing.time("transform_response", "转换图片响应", () =>
        buildImagesApiResponseFromJsonText(
          result.text,
          imageRequest!.responseFormat,
          imageRequest!.model,
        ),
      );
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.status : 502;
      const errorCode =
        error instanceof HttpError ? error.code : "image_response_error";
      const message = error instanceof Error ? error.message : String(error);
      recordChannelFailure(channel, {
        statusCode,
        message,
      });
      appendSuccessLog({
        request,
        startedAt,
        start,
        apiKey,
        channel,
        credentialEmail: result.credential.email,
        requestType: input.requestType,
        stream: false,
        model: imageRequest.model,
        statusCode,
        usage: emptyUsage(),
        errorCode,
        errorMessage: message.slice(0, 500),
        requestBody: imageRequest.requestBody,
        forwardedBody: result.upstreamPayload,
        forwardedHeaders: result.upstreamRequestHeaders,
        upstreamHeaders: result.response.headers,
        upstreamBody: result.text,
        error,
        timing,
      });
      return errorToResponse(error);
    }
    recordChannelSuccess(channel);
    appendSuccessLog({
      request,
      startedAt,
      start,
      apiKey,
      channel,
      credentialEmail: result.credential.email,
      requestType: input.requestType,
      stream: false,
      model: imageRequest.model,
      statusCode: 200,
      usage: emptyUsage(),
      requestBody: imageRequest.requestBody,
      forwardedBody: result.upstreamPayload,
      forwardedHeaders: result.upstreamRequestHeaders,
      upstreamHeaders: result.response.headers,
      upstreamBody: result.text,
      timing,
    });
    return Response.json(responsePayload, { status: 200, headers: copyAccountQuotaHeaders(result.response.headers) });
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
      imageRequest?.requestBody ?? (original ? forwardedPayloadSnapshot(original) : undefined),
      timing,
    );
    return errorToResponse(error);
  }
}

async function forwardImagesStream(input: {
  request: Request;
  startedAt: string;
  start: number;
  apiKey: RelayApiKeyContext;
  channel: ChannelRecord;
  imageRequest: CodexImagesRequest;
  requestType: string;
  timing?: StageTimer;
}) {
  const { response, credential, upstreamPayload, upstreamRequestHeaders } =
    await codexFetch(input.imageRequest.upstreamPath, input.imageRequest.payload, {
      stream: true,
      sourceHeaders: input.request.headers,
      channel: input.channel,
      promptCacheKey: null,
      transport: "http",
      timing: input.timing,
    });
  const headers = withStreamingHeaders(
    withDefaultContentType(
      copyUpstreamHeaders(response.headers),
      "text/event-stream; charset=utf-8",
    ),
  );
  if (!response.ok) {
    const errorText = input.timing
      ? await input.timing.timeAsync(
          "read_upstream_error_body",
          "读取上游错误响应 Body",
          () => response.text(),
        )
      : await response.text();
    recordChannelFailure(input.channel, {
      statusCode: response.status,
      message: errorText.slice(0, 500) || response.statusText,
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
      model: input.imageRequest.model,
      statusCode: response.status,
      usage: emptyUsage(),
      errorCode: "upstream_error",
      errorMessage: (errorText || response.statusText).slice(0, 500),
      requestBody: input.imageRequest.requestBody,
      forwardedBody: upstreamPayload,
      forwardedHeaders: upstreamRequestHeaders,
      upstreamHeaders: response.headers,
      upstreamBody: errorText,
      timing: input.timing,
    });
    return upstreamErrorResponse(response.status, response.headers);
  }

  if (!response.body) {
    throw new HttpError(502, "image_generation_incomplete", "Upstream returned no image stream");
  }
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  const fullLog = getFullRequestLoggingSetting();
  const upstreamCapture = createTextCapture();
  const body = createImagesSseStream(
        tapStream(
          response.body,
          fullLog ? upstreamCapture : null,
          input.timing,
        ),
        {
          responseFormat: input.imageRequest.responseFormat,
          streamPrefix: input.imageRequest.streamPrefix,
          requestedModel: input.imageRequest.model,
          onFirstEvent: () => {
            input.timing?.mark("stream_first_token", "收到图片流首个事件");
          },
          onCompleted: () => {
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
              model: input.imageRequest.model,
              statusCode: response.status,
              usage: emptyUsage(),
              requestBody: input.imageRequest.requestBody,
              forwardedBody: upstreamPayload,
              forwardedHeaders: upstreamRequestHeaders,
              upstreamHeaders: response.headers,
              upstreamBody: upstreamCapture.text,
              timing: input.timing,
            });
          },
          onError: (error) => {
            const message =
              error instanceof Error ? error.message : String(error);
            recordChannelFailure(input.channel, {
              statusCode: 502,
              message,
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
              model: input.imageRequest.model,
              statusCode: 502,
              usage: emptyUsage(),
              errorCode: "stream_error",
              errorMessage: message.slice(0, 500),
              requestBody: input.imageRequest.requestBody,
              forwardedBody: upstreamPayload,
              forwardedHeaders: upstreamRequestHeaders,
              upstreamHeaders: response.headers,
              upstreamBody: upstreamCapture.text,
              error,
              timing: input.timing,
            });
          },
        },
      );
  return new Response(body, { status: response.status, headers });
}

export async function handleChatCompletions(request: Request) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const timing = createStageTimer();
  let apiKey: RelayApiKeyContext | null = null;
  let channel: ChannelRecord | null = null;
  let input: Record<string, unknown> | null = null;
  try {
    apiKey = timing.time("authenticate", "认证 API Key", () =>
      authenticateRelayRequest(request),
    );
    input = await timing.timeAsync("read_request_body", "读取请求 Body", () =>
      readJsonObject(request),
    );
    const model = stringValue(input.model) || serverConfig.codexDefaultModel;
    const selected = timing.time("select_channel", "选择通道", () =>
      selectChannelForRequest({ operation: "chat", model, apiKey: apiKey!,
        request: { payload: input!, headers: request.headers } }),
    );
    channel = selected.channel;
    if (isApiCredential(selected.credential)) {
      return await forwardSelectedApiRequest({ request, startedAt, start, timing, apiKey,
        selected, operation: "chat", payload: input, requestType: "chat.completions" });
    }
    if (selected.credential.provider === "antigravity") {
      const stream = input.stream === true;
      const { payload: converted, toolNameMaps } = chatCompletionsToCodex(input, { stream });
      // Chat requests carry max_tokens; the Codex converter drops sampling fields Antigravity understands.
      const responsesPayload: Record<string, unknown> = { ...converted, temperature: input.temperature,
        top_p: input.top_p, max_output_tokens: input.max_completion_tokens ?? input.max_tokens };
      if (input.reasoning_effort === undefined && (!input.reasoning || typeof input.reasoning !== "object")) delete responsesPayload.reasoning;
      const outcome = await dispatchAntigravity({
        request, startedAt, start, timing, apiKey, selected, operation: "chat", model, payload: responsesPayload,
        stream, requestType: "chat.completions.antigravity", requestBody: input,
      });
      if (outcome.type === "error") return antigravityErrorResponse(outcome);
      if (outcome.type === "json") return Response.json(codexResponseToChatCompletion(outcome.value, model, toolNameMaps));
      return sseResponse(createOpenAIChatSseStream(outcome.body, { fallbackModel: model, toolNameMaps }));
    }
    if (selected.credential.provider === "claude") {
      return await handleClaudeChatCompletionsWithContext({
        request, startedAt, start, timing, apiKey, input, selection: selected,
      });
    }
    const stream = Boolean(input.stream);
    const { payload, toolNameMaps } = timing.time(
      "normalize_payload",
      "Chat 转换为 Codex Payload",
      () => chatCompletionsToCodex(input!, { stream: true }),
    );
    if (stream) {
      const { response, credential, upstreamPayload, upstreamRequestHeaders } =
        await codexFetch("/responses", payload, {
          stream: true,
          sourceHeaders: request.headers,
          channel,
          promptCacheKey: codexPromptCacheKeyForApiKey(apiKey),
          transport: "http",
          timing,
        });
      if (!response.ok) {
        const errorText = await timing.timeAsync(
          "read_upstream_error_body",
          "读取上游错误响应 Body",
          () => response.text(),
        );
        recordChannelFailure(channel, {
          statusCode: response.status,
          message: errorText.slice(0, 500) || response.statusText,
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
          errorMessage: (errorText || response.statusText).slice(0, 500),
          requestBody: input,
          forwardedBody: upstreamPayload,
          forwardedHeaders: upstreamRequestHeaders,
          upstreamHeaders: response.headers,
          upstreamBody: errorText,
          timing,
        });
        return upstreamErrorResponse(response.status, response.headers);
      }
      const headers = copyAccountQuotaHeaders(response.headers, new Headers({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      }));
      const fullLog = getFullRequestLoggingSetting();
      const upstreamCapture = createTextCapture();
      const body = response.body
        ? createOpenAIChatSseStream(
            tapStream(response.body, fullLog ? upstreamCapture : null, timing),
            {
              fallbackModel: model,
              toolNameMaps,
              onFirstToken: () => {
                timing.mark("stream_first_token", "收到首字输出");
              },
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
                  requestBody: input,
                  forwardedBody: upstreamPayload,
                  forwardedHeaders: upstreamRequestHeaders,
                  upstreamHeaders: response.headers,
                  upstreamBody: upstreamCapture.text,
                  timing,
                });
              },
              onError: (error, usage) => {
                const message =
                  error instanceof Error ? error.message : String(error);
                recordChannelFailure(channel!, {
                  statusCode: 502,
                  message,
                });
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
                  statusCode: 502,
                  usage,
                  errorCode: "stream_error",
                  errorMessage: message.slice(0, 500),
                  requestBody: input,
                  forwardedBody: upstreamPayload,
                  forwardedHeaders: upstreamRequestHeaders,
                  upstreamHeaders: response.headers,
                  upstreamBody: upstreamCapture.text,
                  error,
                  timing,
                });
              },
            },
          )
        : null;
      return new Response(body, { status: 200, headers });
    }

    const result = await codexJson("/responses", payload, {
      stream: true,
      sourceHeaders: request.headers,
      channel,
      promptCacheKey: codexPromptCacheKeyForApiKey(apiKey),
      timing,
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
        requestBody: input,
        forwardedBody: result.upstreamPayload,
        forwardedHeaders: result.upstreamRequestHeaders,
        upstreamHeaders: result.response.headers,
        upstreamBody: result.text,
        timing,
      });
      return upstreamErrorResponse(result.response.status, result.response.headers);
    }
    const raw = timing.time(
      "parse_upstream_response",
      "解析上游响应",
      () => parseCodexSseResponse(result.text) || result.json,
    );
    const usage = timing.time("extract_usage", "提取 Token 用量", () =>
      extractUsageFromCodexResponse(raw),
    );
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
      requestBody: input,
      forwardedBody: result.upstreamPayload,
      forwardedHeaders: result.upstreamRequestHeaders,
      upstreamHeaders: result.response.headers,
      upstreamBody: result.text,
      timing,
    });
    const responsePayload = timing.time(
      "transform_response",
      "转换为 OpenAI Chat 响应",
      () => codexResponseToChatCompletion(raw, model, toolNameMaps),
    );
    return Response.json(responsePayload, { status: 200, headers: copyAccountQuotaHeaders(result.response.headers) });
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
      input,
      timing,
    );
    return errorToResponse(error);
  }
}

// Shared Antigravity dispatch: one request builder, CPA 429 failover across credentials, and one log entry.
async function dispatchAntigravity(input: {
  request: Request;
  startedAt: string;
  start: number;
  timing: StageTimer;
  apiKey: RelayApiKeyContext;
  selected: SelectedChannel;
  operation: UpstreamOperation;
  model: string;
  payload: Record<string, unknown>;
  stream: boolean;
  includeThoughtsByDefault?: boolean;
  requestType: string;
  requestBody?: unknown;
}) {
  return sendAntigravity({
    request: input.request,
    model: input.model,
    payload: input.payload,
    stream: input.stream,
    includeThoughtsByDefault: input.includeThoughtsByDefault,
    timing: input.timing,
    selected: input.selected,
    reselect(exclude) {
      try {
        return selectChannelForRequest({ operation: input.operation, model: input.model, apiKey: input.apiKey,
          provider: "antigravity", excludeCredentialIds: exclude });
      } catch {
        return null;
      }
    },
    onFailover(selected, error) {
      recordChannelFailure(selected.channel, { statusCode: error.status, message: error.message });
    },
    onResult({ status, usage, error, selected }) {
      if (!error) recordChannelSuccess(selected.channel);
      else if (status !== 400 && status !== 499) recordChannelFailure(selected.channel, { statusCode: status, message: error.message });
      appendSuccessLog({
        request: input.request, startedAt: input.startedAt, start: input.start, timing: input.timing,
        apiKey: input.apiKey, channel: selected.channel, credentialId: selected.credential.id,
        credentialEmail: "email" in selected.credential ? selected.credential.email : undefined, requestType: input.requestType, stream: input.stream,
        model: input.model, statusCode: status, usage, errorCode: error?.code, errorMessage: error?.message,
        requestBody: input.requestBody ?? input.payload,
      });
    },
  });
}

function antigravityErrorResponse(outcome: Extract<AntigravityOutcome, { type: "error" }>) {
  const headers = new Headers();
  if (outcome.retryAfter) headers.set("retry-after", outcome.retryAfter);
  return Response.json({ error: { code: outcome.error.code, message: outcome.error.message } },
    { status: outcome.error.status, headers });
}

function sseResponse(body: ReadableStream<Uint8Array>) {
  return new Response(body, { headers: withStreamingHeaders(new Headers({ "Content-Type": "text/event-stream; charset=utf-8" })) });
}
function isApiCredential(credential: SelectedChannel["credential"]): credential is UpstreamCredentialWithSecret {
  return credential.provider === "openai" || credential.provider === "anthropic";
}

async function forwardSelectedApiRequest(input: {
  request: Request;
  startedAt: string;
  start: number;
  timing: StageTimer;
  apiKey: RelayApiKeyContext;
  selected: SelectedChannel;
  operation: UpstreamOperation;
  payload: Record<string, unknown> | FormData;
  requestType: string;
}) {
  const { channel, credential } = input.selected;
  if (!isApiCredential(credential)) {
    throw new HttpError(500, "invalid_api_channel", "Selected credential is not an API Key credential");
  }
  const stream = input.operation !== "count_tokens" && (input.payload instanceof FormData
    ? input.payload.get("stream") === "true" : input.payload.stream === true);
  let reported = false;
  const report = (result: ApiKeyRelayResult) => {
    if (reported) return;
    reported = true;
    if (result.errorCode || result.statusCode >= 400) {
      recordChannelFailure(channel, { statusCode: result.statusCode, message: result.errorMessage });
    } else {
      recordChannelSuccess(channel);
    }
    appendSuccessLog({
      request: input.request,
      startedAt: input.startedAt,
      start: input.start,
      apiKey: input.apiKey,
      channel,
      credentialId: credential.id,
      credentialEmail: credential.name,
      requestType: input.requestType + "." + credential.provider,
      stream,
      model: stringValue(input.payload instanceof FormData ? input.payload.get("model") : input.payload.model),
      requestBody: redactValue(forwardedPayloadSnapshot(input.payload), credential.apiKey),
      ...result,
      timing: input.timing,
    });
  };
  // Send the name the channel lists, so openai/gpt-5.4 reaches a gpt-5.4 upstream and the reverse.
  const requested = stringValue(input.payload instanceof FormData ? input.payload.get("model") : input.payload.model);
  const upstreamModel = apiChannelModel(channel, requested) ?? requested;
  let payload = input.payload;
  if (upstreamModel !== requested) {
    if (payload instanceof FormData) {
      payload = new FormData();
      for (const [name, value] of input.payload as FormData) payload.append(name, value);
      payload.set("model", upstreamModel);
    } else {
      payload = { ...payload, model: upstreamModel };
    }
  }
  let response: Response;
  try {
    response = await forwardApiKeyRequest({
      request: input.request, channel, credential,
      operation: input.operation, payload, timing: input.timing,
      captureBody: getFullRequestLoggingSetting(), onResult: report,
    });
  } catch (error) {
    const safe = new HttpError(error instanceof HttpError ? error.status : 502,
      error instanceof HttpError ? error.code : "upstream_request_failed",
      redactText(error instanceof Error ? error.message : "API upstream request failed", credential.apiKey));
    report({ statusCode: safe.status, usage: emptyUsage(), errorCode: safe.code,
      errorMessage: safe.message, error: safe, upstreamHeaders: new Headers() });
    response = credential.provider === "anthropic" && (input.operation === "messages" || input.operation === "count_tokens")
      ? Response.json({ type: "error", error: {
          type: safe.status < 500 ? "invalid_request_error" : "api_error", message: safe.message,
        } }, { status: safe.status })
      : errorToResponse(safe);
  }
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    return withAccountQuotaHeaders(new Response(response.body, {
      status: response.status, headers: withStreamingHeaders(new Headers(response.headers)),
    }), credential.provider, credential.id);
  }
  return withAccountQuotaHeaders(response, credential.provider, credential.id);
}

async function handleClaudeChatCompletionsWithContext(input: {
  request: Request;
  startedAt: string;
  start: number;
  timing: StageTimer;
  apiKey: RelayApiKeyContext;
  input: Record<string, unknown>;
  selection?: SelectedChannel;
}) {
  const stream = Boolean(input.input.stream);
  const conversion = input.timing.time(
    "normalize_payload",
    "Chat 转换为 Claude Payload",
    () => chatCompletionsToClaude(input.input, { stream: true }),
  );
  const model =
    stringValue(input.input.model) || serverConfig.claudeDefaultModel;
  const selected = input.selection ?? input.timing.time("select_channel", "选择 Claude 通道", () =>
    selectChannelForRequest({ provider: "claude", operation: "chat", model, apiKey: input.apiKey,
      request: { payload: input.input, headers: input.request.headers } }),
  );
  const channel = selected.channel;

  if (stream) {
    const { response, credential, upstreamPayload, upstreamRequestHeaders } =
      await claudeFetch(conversion.payload, {
        stream: true,
        sourceHeaders: input.request.headers,
        credentialId: selected.credential.id,
        channel,
        baseUrl: channel.baseUrl,
        timing: input.timing,
      });
    const headers = withStreamingHeaders(
      withDefaultContentType(
        copyClaudeUpstreamHeaders(response.headers),
        "text/event-stream; charset=utf-8",
      ),
    );
    if (!response.ok) {
      const errorText = await input.timing.timeAsync(
        "read_upstream_error_body",
        "读取 Claude 上游错误响应 Body",
        () => response.text(),
      );
      recordChannelFailure(channel, {
        statusCode: response.status,
        message: errorText.slice(0, 500) || response.statusText,
      });
      appendSuccessLog({
        request: input.request,
        startedAt: input.startedAt,
        start: input.start,
        apiKey: input.apiKey,
        channel,
        credentialId: credential.id,
        credentialEmail: credential.email,
        requestType: "chat.completions.claude",
        stream: true,
        model,
        statusCode: response.status,
        usage: emptyUsage(),
        errorCode: "upstream_error",
        errorMessage: (errorText || response.statusText).slice(0, 500),
        requestBody: input.input,
        forwardedBody: upstreamPayload,
        forwardedHeaders: upstreamRequestHeaders,
        upstreamHeaders: response.headers,
        upstreamBody: errorText,
        timing: input.timing,
      });
      return upstreamErrorResponse(response.status, response.headers);
    }

    const fullLog = getFullRequestLoggingSetting();
    const upstreamCapture = createTextCapture();
    const body = response.body
      ? createOpenAIChatStreamFromClaude(
          tapStream(
            response.body,
            fullLog ? upstreamCapture : null,
            input.timing,
          ),
          {
            model,
            reverseToolNameMap: conversion.reverseToolNameMap,
            onFirstToken: () => {
              input.timing.mark("stream_first_token", "收到首字输出");
            },
            onCompleted: (usage) => {
              recordChannelSuccess(channel);
              appendSuccessLog({
                request: input.request,
                startedAt: input.startedAt,
                start: input.start,
                apiKey: input.apiKey,
                channel,
                credentialId: credential.id,
                credentialEmail: credential.email,
                requestType: "chat.completions.claude",
                stream: true,
                model,
                statusCode: response.status,
                usage,
                requestBody: input.input,
                forwardedBody: upstreamPayload,
                forwardedHeaders: upstreamRequestHeaders,
                upstreamHeaders: response.headers,
                upstreamBody: upstreamCapture.text,
                timing: input.timing,
              });
            },
            onError: (error, usage) => {
              const message =
                error instanceof Error ? error.message : String(error);
              recordChannelFailure(channel, {
                statusCode: 502,
                message,
              });
              appendSuccessLog({
                request: input.request,
                startedAt: input.startedAt,
                start: input.start,
                apiKey: input.apiKey,
                channel,
                credentialId: credential.id,
                credentialEmail: credential.email,
                requestType: "chat.completions.claude",
                stream: true,
                model,
                statusCode: 502,
                usage,
                errorCode: "stream_error",
                errorMessage: message.slice(0, 500),
                requestBody: input.input,
                forwardedBody: upstreamPayload,
                forwardedHeaders: upstreamRequestHeaders,
                upstreamHeaders: response.headers,
                upstreamBody: upstreamCapture.text,
                error,
                timing: input.timing,
              });
            },
          },
        )
      : null;
    return new Response(body, { status: response.status, headers });
  }

  const result = await claudeJson(conversion.payload, {
    stream: true,
    sourceHeaders: input.request.headers,
    credentialId: selected.credential.id,
    channel,
    baseUrl: channel.baseUrl,
    timing: input.timing,
  });
  const usage = input.timing.time(
    "extract_usage",
    "提取 Claude Token 用量",
    () => extractUsageFromClaudeSseText(result.text),
  );
  if (!result.response.ok) {
    recordChannelFailure(channel, {
      statusCode: result.response.status,
      message: result.text.slice(0, 500),
    });
    appendSuccessLog({
      request: input.request,
      startedAt: input.startedAt,
      start: input.start,
      apiKey: input.apiKey,
      channel,
      credentialId: result.credential.id,
      credentialEmail: result.credential.email,
      requestType: "chat.completions.claude",
      stream: false,
      model,
      statusCode: result.response.status,
      usage: emptyUsage(),
      errorCode: "upstream_error",
      errorMessage: result.text.slice(0, 500),
      requestBody: input.input,
      forwardedBody: result.upstreamPayload,
      forwardedHeaders: result.upstreamRequestHeaders,
      upstreamHeaders: result.response.headers,
      upstreamBody: result.text,
      timing: input.timing,
    });
    return upstreamErrorResponse(result.response.status, result.response.headers);
  }
  const responsePayload = input.timing.time(
    "transform_response",
    "转换为 OpenAI Chat 响应",
    () =>
      claudeSseTextToOpenAIChatCompletion(result.text, {
        model,
        reverseToolNameMap: conversion.reverseToolNameMap,
      }),
  );
  recordChannelSuccess(channel);
  appendSuccessLog({
    request: input.request,
    startedAt: input.startedAt,
    start: input.start,
    apiKey: input.apiKey,
    channel,
    credentialId: result.credential.id,
    credentialEmail: result.credential.email,
    requestType: "chat.completions.claude",
    stream: false,
    model,
    statusCode: 200,
    usage,
    requestBody: input.input,
    forwardedBody: result.upstreamPayload,
    forwardedHeaders: result.upstreamRequestHeaders,
    upstreamHeaders: result.response.headers,
    upstreamBody: result.text,
    timing: input.timing,
  });
  return Response.json(responsePayload, { status: 200, headers: copyAccountQuotaHeaders(result.response.headers) });
}

async function handleClaudeResponsesWithContext(input: {
  request: Request;
  startedAt: string;
  start: number;
  timing: StageTimer;
  apiKey: RelayApiKeyContext;
  input: Record<string, unknown>;
  selection?: SelectedChannel;
}) {
  const stream = Boolean(input.input.stream);
  const conversion = input.timing.time(
    "normalize_payload",
    "Responses 转换为 Claude Payload",
    () => responsesToClaude(input.input, { stream: true }),
  );
  const model =
    stringValue(input.input.model) || serverConfig.claudeDefaultModel;
  const selected = input.selection ?? input.timing.time("select_channel", "选择 Claude 通道", () =>
    selectChannelForRequest({ provider: "claude", operation: "responses", model, apiKey: input.apiKey,
      request: { payload: input.input, headers: input.request.headers } }),
  );
  const channel = selected.channel;

  if (stream) {
    const { response, credential, upstreamPayload, upstreamRequestHeaders } =
      await claudeFetch(conversion.payload, {
        stream: true,
        sourceHeaders: input.request.headers,
        credentialId: selected.credential.id,
        channel,
        baseUrl: channel.baseUrl,
        timing: input.timing,
      });
    const headers = withStreamingHeaders(
      withDefaultContentType(
        copyClaudeUpstreamHeaders(response.headers),
        "text/event-stream; charset=utf-8",
      ),
    );
    if (!response.ok) {
      const errorText = await input.timing.timeAsync(
        "read_upstream_error_body",
        "读取 Claude 上游错误响应 Body",
        () => response.text(),
      );
      recordChannelFailure(channel, {
        statusCode: response.status,
        message: errorText.slice(0, 500) || response.statusText,
      });
      appendSuccessLog({
        request: input.request,
        startedAt: input.startedAt,
        start: input.start,
        apiKey: input.apiKey,
        channel,
        credentialId: credential.id,
        credentialEmail: credential.email,
        requestType: "responses.claude",
        stream: true,
        model,
        statusCode: response.status,
        usage: emptyUsage(),
        errorCode: "upstream_error",
        errorMessage: (errorText || response.statusText).slice(0, 500),
        requestBody: input.input,
        forwardedBody: upstreamPayload,
        forwardedHeaders: upstreamRequestHeaders,
        upstreamHeaders: response.headers,
        upstreamBody: errorText,
        timing: input.timing,
      });
      return upstreamErrorResponse(response.status, response.headers);
    }

    const fullLog = getFullRequestLoggingSetting();
    const upstreamCapture = createTextCapture();
    const body = response.body
      ? createOpenAIResponsesStreamFromClaude(
          tapStream(
            response.body,
            fullLog ? upstreamCapture : null,
            input.timing,
          ),
          {
            model,
            reverseToolNameMap: conversion.reverseToolNameMap,
            onFirstToken: () => {
              input.timing.mark("stream_first_token", "收到首字输出");
            },
            onCompleted: (usage) => {
              recordChannelSuccess(channel);
              appendSuccessLog({
                request: input.request,
                startedAt: input.startedAt,
                start: input.start,
                apiKey: input.apiKey,
                channel,
                credentialId: credential.id,
                credentialEmail: credential.email,
                requestType: "responses.claude",
                stream: true,
                model,
                statusCode: response.status,
                usage,
                requestBody: input.input,
                forwardedBody: upstreamPayload,
                forwardedHeaders: upstreamRequestHeaders,
                upstreamHeaders: response.headers,
                upstreamBody: upstreamCapture.text,
                timing: input.timing,
              });
            },
            onError: (error, usage) => {
              const message =
                error instanceof Error ? error.message : String(error);
              recordChannelFailure(channel, {
                statusCode: 502,
                message,
              });
              appendSuccessLog({
                request: input.request,
                startedAt: input.startedAt,
                start: input.start,
                apiKey: input.apiKey,
                channel,
                credentialId: credential.id,
                credentialEmail: credential.email,
                requestType: "responses.claude",
                stream: true,
                model,
                statusCode: 502,
                usage,
                errorCode: "stream_error",
                errorMessage: message.slice(0, 500),
                requestBody: input.input,
                forwardedBody: upstreamPayload,
                forwardedHeaders: upstreamRequestHeaders,
                upstreamHeaders: response.headers,
                upstreamBody: upstreamCapture.text,
                error,
                timing: input.timing,
              });
            },
          },
        )
      : null;
    return new Response(body, { status: response.status, headers });
  }

  const result = await claudeJson(conversion.payload, {
    stream: true,
    sourceHeaders: input.request.headers,
    credentialId: selected.credential.id,
    channel,
    baseUrl: channel.baseUrl,
    timing: input.timing,
  });
  const usage = input.timing.time(
    "extract_usage",
    "提取 Claude Token 用量",
    () => extractUsageFromClaudeSseText(result.text),
  );
  if (!result.response.ok) {
    recordChannelFailure(channel, {
      statusCode: result.response.status,
      message: result.text.slice(0, 500),
    });
    appendSuccessLog({
      request: input.request,
      startedAt: input.startedAt,
      start: input.start,
      apiKey: input.apiKey,
      channel,
      credentialId: result.credential.id,
      credentialEmail: result.credential.email,
      requestType: "responses.claude",
      stream: false,
      model,
      statusCode: result.response.status,
      usage: emptyUsage(),
      errorCode: "upstream_error",
      errorMessage: result.text.slice(0, 500),
      requestBody: input.input,
      forwardedBody: result.upstreamPayload,
      forwardedHeaders: result.upstreamRequestHeaders,
      upstreamHeaders: result.response.headers,
      upstreamBody: result.text,
      timing: input.timing,
    });
    return upstreamErrorResponse(result.response.status, result.response.headers);
  }
  const responsePayload = input.timing.time(
    "transform_response",
    "转换为 OpenAI Responses 响应",
    () =>
      claudeSseTextToOpenAIResponse(result.text, {
        model,
        reverseToolNameMap: conversion.reverseToolNameMap,
      }),
  );
  recordChannelSuccess(channel);
  appendSuccessLog({
    request: input.request,
    startedAt: input.startedAt,
    start: input.start,
    apiKey: input.apiKey,
    channel,
    credentialId: result.credential.id,
    credentialEmail: result.credential.email,
    requestType: "responses.claude",
    stream: false,
    model,
    statusCode: 200,
    usage,
    requestBody: input.input,
    forwardedBody: result.upstreamPayload,
    forwardedHeaders: result.upstreamRequestHeaders,
    upstreamHeaders: result.response.headers,
    upstreamBody: result.text,
    timing: input.timing,
  });
  return Response.json(responsePayload, { status: 200, headers: copyAccountQuotaHeaders(result.response.headers) });
}

async function handleRawCodexProxy(
  request: Request,
  input: {
    upstreamPath: "/responses" | "/responses/compact";
    requestType: string;
    streamFromPayload: boolean;
    exposeUpstreamErrors: boolean;
    normalizePayload: (
      payload: Record<string, unknown>,
    ) => Record<string, unknown>;
  },
) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const timing = createStageTimer();
  let apiKey: RelayApiKeyContext | null = null;
  let channel: ChannelRecord | null = null;
  let rawPayload: Record<string, unknown> | null = null;
  try {
    apiKey = timing.time("authenticate", "认证 API Key", () =>
      authenticateRelayRequest(request),
    );
    rawPayload = await timing.timeAsync(
      "read_request_body",
      "读取请求 Body",
      () => readJsonObject(request),
    );
    const payload = timing.time("normalize_payload", "规范化请求 Payload", () =>
      input.normalizePayload(rawPayload!),
    );
    const stream = input.streamFromPayload ? payload.stream !== false : false;
    const model = stringValue(payload.model) || serverConfig.codexDefaultModel;
    const selected = timing.time("select_channel", "选择通道", () =>
      selectChannel({ model, apiKey: apiKey! }),
    );
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
        requestBody: rawPayload,
        forwardedBody: payload,
        exposeUpstreamErrors: input.exposeUpstreamErrors,
        timing,
      });
    }
    const result = await codexJson(input.upstreamPath, payload, {
      stream: false,
      sourceHeaders: request.headers,
      channel,
      promptCacheKey: null,
      timing,
    });
    const usage = timing.time("extract_usage", "提取 Token 用量", () =>
      extractUsageFromCodexResponse(result.json),
    );
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
      requestBody: rawPayload,
      forwardedBody: result.upstreamPayload,
      forwardedHeaders: result.upstreamRequestHeaders,
      upstreamHeaders: result.response.headers,
      upstreamBody: result.text,
      timing,
    });
    if (!result.response.ok && !input.exposeUpstreamErrors) {
      return upstreamErrorResponse(result.response.status, result.response.headers);
    }
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
      rawPayload,
      timing,
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
  requestBody?: unknown;
  forwardedBody?: unknown;
  exposeUpstreamErrors?: boolean;
  promptCacheKey?: string | null;
  timing?: StageTimer;
}) {
  const model =
    stringValue(input.payload.model) || serverConfig.codexDefaultModel;
  const { response, credential, upstreamPayload, upstreamRequestHeaders } =
    await codexFetch(input.upstreamPath, input.payload, {
      stream: true,
      sourceHeaders: input.request.headers,
      channel: input.channel,
      promptCacheKey: input.promptCacheKey,
      transport: "http",
      timing: input.timing,
    });
  const headers = withStreamingHeaders(
    withDefaultContentType(
      copyUpstreamHeaders(response.headers),
      input.fallbackContentType,
    ),
  );
  if (!response.ok) {
    const errorText = input.timing
      ? await input.timing.timeAsync(
          "read_upstream_error_body",
          "读取上游错误响应 Body",
          () => response.text(),
        )
      : await response.text();
    recordChannelFailure(input.channel, {
      statusCode: response.status,
      message: errorText.slice(0, 500) || response.statusText,
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
      errorMessage: (errorText || response.statusText).slice(0, 500),
      requestBody: input.requestBody,
      forwardedBody: upstreamPayload,
      forwardedHeaders: upstreamRequestHeaders,
      upstreamHeaders: response.headers,
      upstreamBody: errorText,
      timing: input.timing,
    });
    if (input.exposeUpstreamErrors) {
      return new Response(errorText, { status: response.status, headers });
    }
    return upstreamErrorResponse(response.status, response.headers);
  }
  const fullLog = getFullRequestLoggingSetting();
  const upstreamCapture = createTextCapture();
  const body = response.body
    ? createCodexUsageMeterStream(
        tapStream(
          response.body,
          fullLog ? upstreamCapture : null,
          input.timing,
        ),
        {
          onCompleted: (usage) => {
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
              requestBody: input.requestBody,
              forwardedBody: upstreamPayload,
              forwardedHeaders: upstreamRequestHeaders,
              upstreamHeaders: response.headers,
              upstreamBody: upstreamCapture.text,
              timing: input.timing,
            });
          },
          onError: (error, usage) => {
            const message =
              error instanceof Error ? error.message : String(error);
            recordChannelFailure(input.channel, {
              statusCode: 502,
              message,
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
              statusCode: 502,
              usage,
              errorCode: "stream_error",
              errorMessage: message.slice(0, 500),
              requestBody: input.requestBody,
              forwardedBody: upstreamPayload,
              forwardedHeaders: upstreamRequestHeaders,
              upstreamHeaders: response.headers,
              upstreamBody: upstreamCapture.text,
              error,
              timing: input.timing,
            });
          },
          onFirstToken: () => {
            input.timing?.mark("stream_first_token", "收到首字输出");
          },
        },
      )
    : null;
  return new Response(body, { status: response.status, headers });
}

function createCodexUsageMeterStream(
  upstreamBody: ReadableStream<Uint8Array>,
  handlers: {
    onCompleted: (usage: UsageSnapshot) => void;
    onError: (error: unknown, usage: UsageSnapshot) => void;
    onFirstToken?: () => void;
  },
) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const framer = new CodexResponsesSseFramer();
  const reader = upstreamBody.getReader();
  let canceled = false;
  let usage = emptyUsage();
  let firstTokenReported = false;
  let upstreamCompleted = false;
  let completionReported = false;

  function reportFirstTokenOnce() {
    if (firstTokenReported) {
      return;
    }
    firstTokenReported = true;
    handlers.onFirstToken?.();
  }

  function reportCompletedOnce() {
    if (completionReported) {
      return;
    }
    completionReported = true;
    handlers.onCompleted(usage);
  }

  function reportErrorOnce(error: unknown) {
    if (completionReported) {
      return;
    }
    completionReported = true;
    handlers.onError(error, usage);
  }

  function processText(
    text: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) {
    for (const frame of framer.push(text)) {
      handleCodexStreamFrame(
        frame.event,
        (nextUsage) => {
          usage = nextUsage;
        },
        reportFirstTokenOnce,
        () => {
          upstreamCompleted = true;
        },
      );
      controller.enqueue(encoder.encode(frame.frame));
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (canceled) return;
        if (!done) {
          processText(decoder.decode(value, { stream: true }), controller);
          return;
        }
        const tail = decoder.decode();
        if (tail) {
          processText(tail, controller);
        }
        for (const frame of framer.flush()) {
          handleCodexStreamFrame(
            frame.event,
            (nextUsage) => {
              usage = nextUsage;
            },
            reportFirstTokenOnce,
            () => {
              upstreamCompleted = true;
            },
          );
          controller.enqueue(encoder.encode(frame.frame));
        }
        if (upstreamCompleted) {
          reportCompletedOnce();
        } else {
          throw new Error(
            "Upstream stream ended before response.completed; refusing to mark a truncated Codex stream as successful",
          );
        }
      } catch (error) {
        if (canceled) return;
        reportErrorOnce(error);
        controller.enqueue(encoder.encode(codexStreamErrorFrame(error)));
        await reader.cancel().catch(() => undefined);
      }
      if (canceled) return;
      reader.releaseLock();
      controller.close();
    },
    async cancel(reason) {
      canceled = true;
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

function handleCodexStreamFrame(
  event: Record<string, unknown> | null,
  onUsage: (usage: UsageSnapshot) => void,
  onFirstToken: () => void,
  onCompleted: () => void,
) {
  if (!event) {
    return;
  }
  if (
    (event.type === "response.output_text.delta" ||
      event.type === "response.reasoning_summary_text.delta") &&
    typeof event.delta === "string" &&
    event.delta.length > 0
  ) {
    onFirstToken();
  }
  if (event.type === "response.completed") {
    onUsage(extractUsageFromCodexResponse(event.response || event));
    onCompleted();
  }
}

function codexStreamErrorFrame(error: unknown) {
  const payload = {
    error: {
      message: publicCodexStreamErrorMessage(error),
      type: "stream_error",
      code: "upstream_stream_incomplete",
    },
  };
  return `\nevent: error\ndata: ${JSON.stringify(payload)}\n\n`;
}

function publicCodexStreamErrorMessage(error: unknown) {
  if (
    error instanceof Error &&
    error.message.includes("Upstream stream ended before response.completed")
  ) {
    return "Upstream stream ended before completion";
  }
  return "Upstream stream error";
}

function appendSuccessLog(input: {
  request: Request;
  startedAt: string;
  start: number;
  apiKey: RelayApiKeyContext;
  channel?: ChannelRecord | null;
  credentialId?: string | null;
  credentialEmail?: string;
  requestType: string;
  stream: boolean;
  model: string;
  statusCode: number;
  usage: UsageSnapshot;
  errorCode?: string;
  errorMessage?: string;
  requestBody?: unknown;
  forwardedBody?: unknown;
  forwardedHeaders?: Headers | Record<string, string>;
  upstreamHeaders?: Headers;
  upstreamBody?: unknown;
  error?: unknown;
  timing?: StageTimer;
}) {
  const logPayload = {
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
    channelId: input.channel?.id,
    channelName: input.channel?.name,
    credentialId: input.credentialId ?? input.channel?.credentialId,
    credentialEmail: input.credentialEmail || (input.channel
      ? credentialLogLabel(input.channel.provider, input.credentialId ?? input.channel.credentialId) : ""),
    usage: input.usage,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
  };
  const logId = input.timing
    ? input.timing.time("append_summary_log", "写入概要日志", () =>
        appendRequestLogWithAutoPrune(logPayload),
      )
    : appendRequestLogWithAutoPrune(logPayload);
  appendOptionalRequestDetail(logId, {
    request: input.request,
    full: getFullRequestLoggingSetting(),
    requestBody: input.requestBody,
    forwardedBody: input.forwardedBody,
    forwardedHeaders: input.forwardedHeaders,
    upstreamStatusCode: input.statusCode,
    upstreamHeaders: input.upstreamHeaders,
    upstreamBody: input.upstreamBody,
    error: input.error,
    forceError: Boolean(input.errorCode || input.statusCode >= 400),
    timing: input.timing,
  });
  return logId;
}

function appendErrorLog(
  request: Request,
  startedAt: string,
  start: number,
  requestType: string,
  error: unknown,
  apiKey?: RelayApiKeyContext | null,
  channel?: ChannelRecord | null,
  requestBody?: unknown,
  timing?: StageTimer,
) {
  const statusCode = error instanceof HttpError ? error.status : 500;
  const logPayload = {
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
    // Errors thrown after routing (token refresh, transport, conversion) still name the selected account.
    credentialEmail: channel ? credentialLogLabel(channel.provider, channel.credentialId) : "",
    errorCode: error instanceof HttpError ? error.code : "internal_error",
    errorMessage: error instanceof Error ? error.message : String(error),
  };
  const logId = timing
    ? timing.time("append_summary_log", "写入概要日志", () =>
        appendRequestLogWithAutoPrune(logPayload),
      )
    : appendRequestLogWithAutoPrune(logPayload);
  appendOptionalRequestDetail(logId, {
    request,
    full: getFullRequestLoggingSetting(),
    requestBody,
    error,
    forceError: true,
    timing,
  });
  return logId;
}

function appendRequestLogWithAutoPrune(input: RequestLogInput) {
  const logId = appendRequestLog(input);
  maybeAutoPruneRequestLogs();
  return logId;
}

function appendOptionalRequestDetail(
  logId: string,
  input: {
    request: Request;
    full: boolean;
    requestBody?: unknown;
    forwardedBody?: unknown;
    forwardedHeaders?: Headers | Record<string, string>;
    upstreamStatusCode?: number | null;
    upstreamHeaders?: Headers;
    upstreamBody?: unknown;
    error?: unknown;
    forceError?: boolean;
    timing?: StageTimer;
  },
) {
  const shouldWrite =
    input.full || input.forceError || input.error || Boolean(input.timing);
  if (!shouldWrite) {
    return;
  }
  const requestBody = input.full
    ? serializeDetailText(input.requestBody)
    : emptySerializedText();
  const forwardedBody = input.full
    ? serializeDetailText(input.forwardedBody)
    : emptySerializedText();
  const upstreamBody =
    input.full || input.forceError
      ? serializeDetailText(input.upstreamBody)
      : emptySerializedText();
  const errorDetail = input.error ? errorLogDetail(input.error) : null;
  appendRequestLogDetail(logId, {
    requestHeaders: sanitizeHeaders(input.request.headers),
    forwardedHeaders: input.forwardedHeaders
      ? sanitizeHeaders(input.forwardedHeaders)
      : null,
    requestBodyText: requestBody.text,
    requestBodyTruncated: requestBody.truncated,
    requestBodyBytes: requestBody.bytes,
    forwardedBodyText: forwardedBody.text,
    forwardedBodyTruncated: forwardedBody.truncated,
    forwardedBodyBytes: forwardedBody.bytes,
    upstreamStatusCode: input.upstreamStatusCode ?? null,
    upstreamHeaders: input.upstreamHeaders
      ? sanitizeHeaders(input.upstreamHeaders)
      : null,
    upstreamBodyText: upstreamBody.text,
    upstreamBodyTruncated: upstreamBody.truncated,
    upstreamBodyBytes: upstreamBody.bytes,
    errorName: errorDetail?.name,
    errorMessage: errorDetail?.message,
    errorStack: errorDetail?.stack,
    errorCause: errorDetail?.cause,
    detail: errorDetail?.detail,
    stageTimings: input.timing?.snapshot(),
  });
}

function serializeDetailText(value: unknown) {
  if (value === undefined || value === null) {
    return emptySerializedText();
  }
  const text = typeof value === "string" ? value : safeJsonStringify(value);
  const bytes = new TextEncoder().encode(text).byteLength;
  if (text.length <= DETAIL_TEXT_LIMIT) {
    return { text, truncated: false, bytes };
  }
  return {
    text: `${text.slice(0, DETAIL_TEXT_LIMIT)}\n...[truncated]`,
    truncated: true,
    bytes,
  };
}

function emptySerializedText() {
  return { text: null as string | null, truncated: false, bytes: 0 };
}

function sanitizeHeaders(headers: Headers | Record<string, string>) {
  const result: Record<string, string> = {};
  const append = (key: string, value: string) => {
    result[key] = SENSITIVE_HEADER_NAMES.has(key.toLowerCase())
      ? "[REDACTED]"
      : value;
  };

  if (headers instanceof Headers) {
    headers.forEach((value, key) => append(key, value));
    return result;
  }

  for (const [key, value] of Object.entries(headers)) {
    append(key, value);
  }
  return result;
}

function errorLogDetail(error: unknown) {
  if (error instanceof Error) {
    const withCause = error as Error & { cause?: unknown; details?: unknown };
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || null,
      cause: withCause.cause,
      detail:
        error instanceof HttpError
          ? { status: error.status, code: error.code, details: error.details }
          : withCause.details,
    };
  }
  return {
    name: typeof error,
    message: String(error),
    stack: null,
    cause: null,
    detail: error,
  };
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function createTextCapture() {
  return {
    text: "",
    truncated: false,
    append(chunk: string) {
      if (this.truncated) {
        return;
      }
      if (this.text.length + chunk.length > DETAIL_TEXT_LIMIT) {
        this.text = `${this.text}${chunk}`.slice(0, DETAIL_TEXT_LIMIT);
        this.text += "\n...[truncated]";
        this.truncated = true;
        return;
      }
      this.text += chunk;
    },
  };
}

function tapStream(
  body: ReadableStream<Uint8Array>,
  capture: ReturnType<typeof createTextCapture> | null,
  timing?: StageTimer,
) {
  const decoder = new TextDecoder();
  const transfer = timing?.start("stream_transfer", "流式传输");
  let sawFirstChunk = false;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!sawFirstChunk) {
          sawFirstChunk = true;
          timing?.mark("stream_first_chunk", "收到上游首包");
        }
        capture?.append(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
      flush() {
        const tail = decoder.decode();
        if (tail) {
          capture?.append(tail);
        }
        transfer?.finish();
      },
    }),
  );
}

async function readJsonObject(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 100 * 1024 * 1024) {
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

function upstreamErrorResponse(status: number, upstreamHeaders?: Headers) {
  const safeStatus = status >= 400 && status <= 599 ? status : 502;
  return Response.json(
    {
      error: {
        code: "upstream_error",
        message: "Upstream request failed",
      },
    },
    { status: safeStatus, headers: upstreamHeaders ? copyAccountQuotaHeaders(upstreamHeaders) : undefined },
  );
}

function withDefaultContentType(headers: Headers, contentType: string) {
  if (!headers.get("content-type")) {
    headers.set("Content-Type", contentType);
  }
  return headers;
}

function withStreamingHeaders(headers: Headers) {
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("Connection", "keep-alive");
  headers.set("X-Accel-Buffering", "no");
  return headers;
}

export async function handleClaudeMessages(request: Request) {
  return handleClaudeNativeRequest(request, false);
}
export async function handleClaudeCountTokens(request: Request) {
  return handleClaudeNativeRequest(request, true);
}
async function handleClaudeNativeRequest(request: Request, countTokens: boolean) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const timing = createStageTimer();
  const requestType = countTokens ? "claude.messages.count_tokens" : "claude.messages";
  let apiKey: RelayApiKeyContext | null = null;
  let channel: ChannelRecord | null = null;
  let payload: Record<string, unknown> | undefined;
  try {
    apiKey = authenticateRelayRequest(request);
    payload = await timing.timeAsync("read_request_body", "读取请求 Body", () => readJsonObject(request));
    const model = stringValue(payload.model);
    if (!model) throw new HttpError(400, "missing_model", "A model is required");
    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
      throw new HttpError(400, "invalid_messages", "messages must be a non-empty array");
    }
    const operation = countTokens ? "count_tokens" : "messages";
    const selected = selectChannelForRequest({ operation, model, apiKey,
      request: { payload, headers: request.headers } });
    channel = selected.channel;
    if (isApiCredential(selected.credential)) {
      return await forwardSelectedApiRequest({ request, startedAt, start, timing, apiKey,
        selected, operation, payload, requestType });
    }
    if (selected.credential.provider === "antigravity") {
      const converted = claudeMessagesToResponses(payload);
      if (countTokens) {
        const inputTokens = await countAntigravityTokens({ request, model, payload: converted, credentialId: selected.credential.id });
        recordChannelSuccess(channel);
        appendSuccessLog({ request, startedAt, start, timing, apiKey, channel, credentialEmail: selected.credential.email,
          requestType: requestType + ".antigravity", stream: false, model, statusCode: 200, usage: emptyUsage(), requestBody: payload });
        return Response.json({ input_tokens: inputTokens });
      }
      const stream = payload.stream === true;
      const outcome = await dispatchAntigravity({
        request, startedAt, start, timing, apiKey, selected, operation, model, payload: converted,
        stream, requestType: requestType + ".antigravity", requestBody: payload,
      });
      if (outcome.type === "error") {
        return Response.json({ type: "error", error: {
          type: outcome.error.status === 429 ? "rate_limit_error" : outcome.error.status < 500 ? "invalid_request_error" : "api_error",
          message: outcome.error.message,
        } }, { status: outcome.error.status, headers: outcome.retryAfter ? { "retry-after": outcome.retryAfter } : undefined });
      }
      if (outcome.type === "json") return Response.json(responsesToClaudeMessage(outcome.value, model));
      return sseResponse(responsesStreamToClaude(outcome.body, model));
    }
    if (selected.credential.provider === "codex") {
      return await handleCodexClaudeMessages({ request, startedAt, start, timing, apiKey, channel, payload,
        model, countTokens, requestType: requestType + ".codex" });
    }
    if (!isClaudeModel(model) || selected.credential.provider !== "claude") {
      throw new HttpError(400, "unsupported_claude_model", "A Claude model is required for an OAuth channel");
    }
    const stream = !countTokens && payload.stream === true;
    const forwarded = structuredClone(payload);
    if (!countTokens && !forwarded.max_tokens) forwarded.max_tokens = claudePolicy(model)?.max_completion_tokens || 32000;
    const result = await claudeFetch(forwarded, {
      stream, sourceHeaders: request.headers, credentialId: channel.credentialId, channel,
      baseUrl: channel.baseUrl, upstreamPath: countTokens ? "/v1/messages/count_tokens" : "/v1/messages", timing,
    });
    const context = {
      request, startedAt, start, apiKey, channel, requestType, model, stream,
      credentialEmail: result.credential.email, requestBody: payload,
      forwardedBody: result.upstreamPayload, forwardedHeaders: result.upstreamRequestHeaders,
      upstreamHeaders: result.response.headers, timing,
    };
    if (!result.response.ok) {
      const body = await result.response.text();
      recordChannelFailure(channel, { statusCode: result.response.status, message: body.slice(0, 500) });
      appendSuccessLog({ ...context, statusCode: result.response.status, usage: emptyUsage(),
        errorCode: "upstream_error", errorMessage: body.slice(0, 500), upstreamBody: body });
      let errorPayload;
      try { errorPayload = JSON.parse(body); } catch { errorPayload = { type: "error", error: { type: "api_error", message: "Upstream request failed" } }; }
      return Response.json(errorPayload, { status: result.response.status, headers: copyAccountQuotaHeaders(result.response.headers) });
    }
    if (!stream) {
      const body = await result.response.text();
      let parsed;
      try { parsed = JSON.parse(body); } catch { throw new HttpError(502, "invalid_claude_response", "Upstream returned invalid Claude JSON"); }
      recordChannelSuccess(channel);
      appendSuccessLog({ ...context, statusCode: result.response.status,
        usage: countTokens ? emptyUsage() : extractUsageFromClaudeMessage(parsed), upstreamBody: body });
      return Response.json(parsed, { status: result.response.status, headers: copyClaudeUpstreamHeaders(result.response.headers) });
    }
    if (!result.response.body) throw new HttpError(502, "claude_stream_incomplete", "Upstream returned no Claude stream");
    const capture = createTextCapture();
    const body = createClaudeNativeSseStream(tapStream(result.response.body,
      getFullRequestLoggingSetting() ? capture : null, timing), {
      onCompleted(usage) {
        recordChannelSuccess(channel!);
        appendSuccessLog({ ...context, statusCode: 200, usage, upstreamBody: capture.text });
      },
      onError(error) {
        const message = error instanceof Error ? error.message : String(error);
        recordChannelFailure(channel!, { statusCode: 502, message });
        appendSuccessLog({ ...context, statusCode: 502, usage: emptyUsage(), errorCode: "stream_error",
          errorMessage: message, upstreamBody: capture.text, error });
      },
    });
    const headers = withStreamingHeaders(copyClaudeUpstreamHeaders(result.response.headers));
    headers.set("Content-Type", "text/event-stream; charset=utf-8");
    return new Response(body, { status: result.response.status, headers });
  } catch (error) {
    appendErrorLog(request, startedAt, start, requestType, error, apiKey, channel, payload, timing);
    const status = error instanceof HttpError ? error.status : 500;
    if (channel && status >= 500) recordChannelFailure(channel, {
      statusCode: status, message: error instanceof Error ? error.message : "Claude request failed",
    });
    return Response.json({ type: "error", error: {
      type: status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status < 500 ? "invalid_request_error" : "api_error",
      message: error instanceof HttpError ? error.message : "Internal Server Error",
    } }, { status });
  }
}

// Claude Messages over a Codex OAuth channel, as CPA does for Claude Code: the request becomes a Codex Responses
// call and the Responses SSE is re-framed as Claude SSE. count_tokens is computed locally like CPA's executor.
async function handleCodexClaudeMessages(input: {
  request: Request;
  startedAt: string;
  start: number;
  timing: StageTimer;
  apiKey: RelayApiKeyContext;
  channel: ChannelRecord;
  payload: Record<string, unknown>;
  model: string;
  countTokens: boolean;
  requestType: string;
}) {
  const { request, startedAt, start, timing, apiKey, channel, payload, model, requestType } = input;
  const { payload: converted, toolNameMaps } = timing.time("normalize_payload", "Messages 转换为 Codex Payload", () =>
    claudeMessagesToCodex(payload));
  if (input.countTokens) {
    const inputTokens = countCodexInputTokens(converted);
    recordChannelSuccess(channel);
    appendSuccessLog({ request, startedAt, start, timing, apiKey, channel, credentialEmail: "", requestType,
      stream: false, model, statusCode: 200, usage: emptyUsage(), requestBody: payload });
    return Response.json({ input_tokens: inputTokens });
  }
  const restoreName = (name: string) => restoreOriginalToolName(name, toolNameMaps);
  const stream = payload.stream === true;
  const promptCacheKey = claudeCodePromptCacheKey(request.headers, payload, model) || codexPromptCacheKeyForApiKey(apiKey);
  if (stream) {
    const response = await forwardCodexStream({
      request, startedAt, start, apiKey, channel, payload: converted, upstreamPath: "/responses", requestType,
      fallbackContentType: "text/event-stream; charset=utf-8", requestBody: payload, promptCacheKey, timing,
    });
    if (!response.ok || !response.body) {
      const status = response.ok ? 502 : response.status;
      return Response.json({ type: "error", error: {
        type: status === 429 ? "rate_limit_error" : status < 500 ? "invalid_request_error" : "api_error",
        message: "Upstream request failed",
      } }, { status, headers: copyAccountQuotaHeaders(response.headers) });
    }
    const headers = withStreamingHeaders(copyAccountQuotaHeaders(response.headers));
    headers.set("Content-Type", "text/event-stream; charset=utf-8");
    return new Response(responsesStreamToClaude(response.body, model, restoreName), { status: 200, headers });
  }
  const result = await codexJson("/responses", converted, {
    stream: true, sourceHeaders: request.headers, channel, promptCacheKey, timing,
  });
  const raw = parseCodexSseResponse(result.text) || result.json;
  const context = {
    request, startedAt, start, apiKey, channel, requestType, model, stream: false,
    credentialEmail: result.credential.email, requestBody: payload, forwardedBody: result.upstreamPayload,
    forwardedHeaders: result.upstreamRequestHeaders, upstreamHeaders: result.response.headers,
    upstreamBody: result.text, timing,
  };
  if (!result.response.ok) {
    recordChannelFailure(channel, { statusCode: result.response.status, message: result.text.slice(0, 500) });
    appendSuccessLog({ ...context, statusCode: result.response.status, usage: emptyUsage(),
      errorCode: "upstream_error", errorMessage: result.text.slice(0, 500) });
    const status = result.response.status;
    return Response.json({ type: "error", error: {
      type: status === 429 ? "rate_limit_error" : status < 500 ? "invalid_request_error" : "api_error",
      message: "Upstream request failed",
    } }, { status, headers: copyAccountQuotaHeaders(result.response.headers) });
  }
  recordChannelSuccess(channel);
  appendSuccessLog({ ...context, statusCode: 200, usage: extractUsageFromCodexResponse(raw) });
  return Response.json(responsesToClaudeMessage(raw && typeof raw === "object" ? raw as Record<string, unknown> : {},
    model, restoreName), { headers: copyAccountQuotaHeaders(result.response.headers) });
}

function isFreeCodexPlan(planType: string) {
  return planType.trim().toLowerCase() === "free";
}

function stringValue(value: unknown) {
  return typeof value === "string"
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : "";
}

function emptyUsage(): UsageSnapshot {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
  };
}
