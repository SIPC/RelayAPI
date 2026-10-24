import "server-only";

import {
  CODEX_IMAGE_MODEL_IDS,
  isCodexImageModel,
} from "@/src/server/codex/imageModels";
import { HttpError } from "@/src/server/http/errors";

const DEFAULT_IMAGES_MODEL = "gpt-image-2";
type ImageStreamPrefix = "image_generation" | "image_edit";
type ImageResponseFormat = "b64_json" | "url";

export type CodexImagesRequest = {
  upstreamPath: "/images/generations" | "/images/edits";
  payload: Record<string, unknown>;
  responseFormat: ImageResponseFormat;
  stream: boolean;
  model: string;
  requestBody: unknown;
  streamPrefix: ImageStreamPrefix;
};

export function buildImagesGenerationsRequest(
  input: Record<string, unknown>,
): CodexImagesRequest {
  return buildImagesRequest(input, "/images/generations");
}

export function buildImagesEditsJsonRequest(
  input: Record<string, unknown>,
): CodexImagesRequest {
  const images = Array.isArray(input.images) ? input.images : [];
  if (images.length === 0 || images.some((image) => !isImageReference(image))) {
    throw new HttpError(
      400,
      "missing_image_input",
      "Invalid request: images must contain image_url or file_id references",
    );
  }
  if (input.mask !== undefined && !isImageReference(input.mask)) {
    throw new HttpError(
      400,
      "invalid_image_mask",
      "Invalid request: mask must contain image_url or file_id",
    );
  }
  return buildImagesRequest(input, "/images/edits");
}

export async function buildImagesEditsMultipartRequest(
  formData: FormData,
): Promise<CodexImagesRequest> {
  const input: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string" || key === "stream") continue;
    if (key === "mask[image_url]" || key === "mask[file_id]") {
      input.mask = {
        ...(isRecord(input.mask) ? input.mask : {}),
        [key === "mask[file_id]" ? "file_id" : "image_url"]: value.trim(),
      };
      continue;
    }
    const numeric = ["n", "output_compression", "partial_images"].includes(key);
    input[key] = numeric && /^-?\d+$/.test(value.trim())
      ? Number(value)
      : value;
  }
  input.stream = booleanFormValue(formData.get("stream"));
  const bracketFiles = formData.getAll("image[]").filter(isFileLike);
  const files = bracketFiles.length > 0
    ? bracketFiles
    : formData.getAll("image").filter(isFileLike);
  if (files.length === 0) {
    throw new HttpError(400, "missing_image_input", "Invalid request: image is required");
  }
  input.images = await Promise.all(files.map(async (file) => ({
    image_url: await fileToDataUrl(file),
  })));
  const mask = formData.get("mask");
  if (isFileLike(mask)) {
    input.mask = { image_url: await fileToDataUrl(mask) };
  }
  const request = buildImagesEditsJsonRequest(input);
  request.requestBody = {
    model: request.model,
    prompt: input.prompt,
    image_count: files.length,
    has_mask: input.mask !== undefined,
    response_format: request.responseFormat,
    stream: request.stream,
  };
  return request;
}

function buildImagesRequest(
  input: Record<string, unknown>,
  upstreamPath: CodexImagesRequest["upstreamPath"],
): CodexImagesRequest {
  const model = stringValue(input.model) || DEFAULT_IMAGES_MODEL;
  if (!isCodexImageModel(model)) {
    throw new HttpError(
      400,
      "unsupported_image_model",
      "Unsupported image model. Supported models: " + CODEX_IMAGE_MODEL_IDS.join(", "),
    );
  }
  if (!stringValue(input.prompt)) {
    throw new HttpError(400, "missing_image_prompt", "Invalid request: prompt is required");
  }
  const responseFormat = stringValue(input.response_format) || "b64_json";
  if (responseFormat !== "b64_json" && responseFormat !== "url") {
    throw new HttpError(400, "unsupported_response_format", "response_format must be b64_json or url");
  }
  // Native Images requests do not pass through Responses or a main text model.
  const payload = structuredClone(input);
  payload.model = unprefixedModel(model);
  const stream = Boolean(input.stream);
  if (stream) payload.stream = true;
  else delete payload.stream;
  return {
    upstreamPath,
    payload,
    responseFormat,
    stream,
    model,
    requestBody: input,
    streamPrefix: upstreamPath === "/images/edits" ? "image_edit" : "image_generation",
  };
}

export function buildImagesApiResponseFromJsonText(
  text: string,
  responseFormat: ImageResponseFormat,
  requestedModel: string,
): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new HttpError(502, "invalid_image_response", "Upstream did not return a valid Images JSON response");
  }
  if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length === 0
    || payload.data.some((image) => !hasImageResult(image))) {
    throw new HttpError(502, "image_generation_incomplete", "Upstream Images response contains no completed image");
  }
  assertReportedModel(payload, requestedModel);
  return formatImageResult(payload, responseFormat);
}

export function createImagesSseStream(
  upstreamBody: ReadableStream<Uint8Array>,
  input: {
    responseFormat: ImageResponseFormat;
    streamPrefix: ImageStreamPrefix;
    requestedModel: string;
    onCompleted: () => void;
    onError: (error: unknown) => void;
    onFirstEvent?: () => void;
  },
) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let completed = false;
  let failed = false;
  let sawEvent = false;

  function processFrame(frame: string) {
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return frame + "\n\n";
    let event: unknown;
    try { event = JSON.parse(data); } catch { return frame + "\n\n"; }
    if (!isRecord(event)) return frame + "\n\n";
    if (!sawEvent) {
      sawEvent = true;
      input.onFirstEvent?.();
    }
    const eventName = frame.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim();
    const type = stringValue(event.type) || eventName;
    if (type === "error" || event.error) {
      failed = true;
      const error = isRecord(event.error) ? event.error : event;
      input.onError(new Error(stringValue(error.message) || "Upstream image stream failed"));
      return frame + "\n\n";
    }
    assertReportedModel(event, input.requestedModel);
    if (type === input.streamPrefix + ".completed") {
      if (!hasImageResult(event) && !(Array.isArray(event.data) && event.data.length > 0
        && event.data.every(hasImageResult))) {
        throw new HttpError(502, "image_generation_incomplete", "Upstream completed event contains no image");
      }
      completed = true;
    }
    if (input.responseFormat !== "url") return frame + "\n\n";
    const formatted = formatImageResult(event, input.responseFormat);
    const fields = frame.split(/\r?\n/).filter((line) => !line.startsWith("data:"));
    return fields.join("\n") + "\ndata: " + JSON.stringify(formatted) + "\n\n";
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          let emitted = false;
          let match: RegExpExecArray | null;
          while ((match = /\r?\n\r?\n/.exec(buffer)) !== null) {
            const frame = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            controller.enqueue(encoder.encode(processFrame(frame)));
            emitted = true;
            if (failed) break;
          }
          if (failed) {
            await reader.cancel();
            reader.releaseLock();
            controller.close();
            return;
          }
          if (done) {
            if (buffer.trim()) controller.enqueue(encoder.encode(processFrame(buffer)));
            if (!failed) {
              if (!completed) {
                throw new HttpError(502, "image_generation_incomplete", "Upstream stream ended before image generation completed");
              }
              input.onCompleted();
            }
            reader.releaseLock();
            controller.close();
            return;
          }
          if (emitted) return;
        }
      } catch (error) {
        if (!failed) {
          failed = true;
          input.onError(error);
          controller.enqueue(encoder.encode("event: error\ndata: " + JSON.stringify({
            error: {
              message: error instanceof Error ? error.message : String(error),
              type: "stream_error",
              code: error instanceof HttpError ? error.code : "upstream_image_stream_error",
            },
          }) + "\n\n"));
        }
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        controller.close();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      reader.releaseLock();
    },
  });
}

function assertReportedModel(payload: Record<string, unknown>, requestedModel: string) {
  const reported = stringValue(payload.model);
  if (reported) {
    const expected = unprefixedModel(requestedModel);
    const actual = unprefixedModel(reported);
    if (actual !== expected && !actual.startsWith(expected + "-")) {
      throw new HttpError(502, "image_model_mismatch", "Requested " + expected + ", but upstream reported " + actual);
    }
  }
  if (Array.isArray(payload.data)) {
    for (const image of payload.data) {
      if (isRecord(image)) assertReportedModel(image, requestedModel);
    }
  }
}

function formatImageResult(
  payload: Record<string, unknown>,
  responseFormat: ImageResponseFormat,
  inheritedFormat = "png",
): Record<string, unknown> {
  if (responseFormat !== "url") return payload;
  const result = { ...payload };
  const format = stringValue(payload.output_format) || inheritedFormat;
  if (stringValue(payload.b64_json)) {
    result.url = "data:image/" + (format === "jpg" ? "jpeg" : format) + ";base64," + payload.b64_json;
    delete result.b64_json;
  }
  if (Array.isArray(payload.data)) {
    result.data = payload.data.map((image) => isRecord(image)
      ? formatImageResult(image, responseFormat, format) : image);
  }
  return result;
}

function unprefixedModel(model: string) {
  return model.slice(model.lastIndexOf("/") + 1).toLowerCase();
}

function hasImageResult(value: unknown) {
  return isRecord(value) && Boolean(stringValue(value.b64_json) || stringValue(value.url));
}

function isImageReference(value: unknown) {
  return isRecord(value) && Boolean(stringValue(value.image_url) || stringValue(value.file_id));
}

function isFileLike(value: FormDataEntryValue | null): value is File {
  return value !== null && typeof value !== "string" && typeof value.arrayBuffer === "function";
}

async function fileToDataUrl(file: File) {
  return "data:" + (file.type || "application/octet-stream") + ";base64," + Buffer.from(await file.arrayBuffer()).toString("base64");
}

function booleanFormValue(value: FormDataEntryValue | null) {
  return typeof value === "string" && ["true", "1"].includes(value.toLowerCase());
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
