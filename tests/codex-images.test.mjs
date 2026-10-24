import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Run server modules outside Next.js with Node 24's native TypeScript support.
const projectRoot = new URL("../", import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export {};", shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(specifier.slice(2) + ".ts", projectRoot).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const {
  buildImagesGenerationsRequest,
  buildImagesEditsJsonRequest,
  buildImagesEditsMultipartRequest,
  buildImagesApiResponseFromJsonText,
  createImagesSseStream,
} = await import("../src/server/codex/images.ts");
const imageModels = [
  "gpt-image-2",
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst-2026-09-08",
  "gpt-image-2.5-flare-2026-09-08",
];
const imageUrl = "data:image/png;base64,aW1hZ2U=";

for (const model of imageModels) {
  test(model + ": native generation and JSON edits preserve all options", () => {
    const options = {
      model, prompt: "Draw a cat", n: 2, quality: "max", size: "1536x864",
      output_format: "webp", output_compression: 85, partial_images: 2,
      background: "transparent", moderation: "low", stream: true,
    };
    const generated = buildImagesGenerationsRequest(options);
    assert.equal(generated.model, model);
    assert.equal(generated.upstreamPath, "/images/generations");
    assert.deepEqual(generated.payload, options);
    const editedInput = {
      ...options, images: [{ image_url: imageUrl }, { file_id: "file-test" }],
      mask: { file_id: "file-mask" },
    };
    const edited = buildImagesEditsJsonRequest(editedInput);
    assert.equal(edited.model, model);
    assert.equal(edited.upstreamPath, "/images/edits");
    assert.deepEqual(edited.payload, editedInput);
    assert.equal(edited.streamPrefix, "image_edit");
    assert.equal("tools" in edited.payload, false);
  });

  test(model + ": multipart edits use native JSON images and mask", async () => {
    const form = new FormData();
    for (const [key, value] of Object.entries({
      model, prompt: "Edit a cat", quality: "max", stream: "true",
      n: "2", output_compression: "85", partial_images: "2",
    })) form.set(key, value);
    form.append("image[]", new File(["image"], "cat.png", { type: "image/png" }));
    form.append("image[]", new File(["image"], "cat2.png", { type: "image/png" }));
    form.set("mask", new File(["image"], "mask.png", { type: "image/png" }));
    const edited = await buildImagesEditsMultipartRequest(form);
    assert.equal(edited.model, model);
    assert.equal(edited.upstreamPath, "/images/edits");
    assert.equal(edited.payload.model, model);
    assert.equal(edited.payload.n, 2);
    assert.equal(edited.payload.output_compression, 85);
    assert.equal(edited.payload.partial_images, 2);
    assert.deepEqual(edited.payload.images, [{ image_url: imageUrl }, { image_url: imageUrl }]);
    assert.deepEqual(edited.payload.mask, { image_url: imageUrl });
    assert.equal(edited.requestBody.image_count, 2);
    assert.equal(edited.stream, true);
  });
}

test("default, prefixed routing and non-stream payloads", () => {
  const generated = buildImagesGenerationsRequest({ prompt: "Draw", stream: false });
  assert.equal(generated.payload.model, "gpt-image-2");
  assert.equal("stream" in generated.payload, false);
  for (const model of imageModels) {
    const prefixed = buildImagesGenerationsRequest({ model: "channel/" + model, prompt: "Draw" });
    assert.equal(prefixed.model, "channel/" + model);
    assert.equal(prefixed.payload.model, model);
  }
});

test("invalid requests fail before contacting upstream", () => {
  for (const model of ["gpt-6.1-sol", "gpt-image-2.5-unknown", "gpt-image-2.5"]) {
    assert.throws(() => buildImagesGenerationsRequest({ model, prompt: "Draw" }),
      { status: 400, code: "unsupported_image_model" });
  }
  assert.throws(() => buildImagesGenerationsRequest({}), { code: "missing_image_prompt" });
  assert.throws(() => buildImagesGenerationsRequest({ prompt: "Draw", response_format: "bad" }),
    { code: "unsupported_response_format" });
  assert.throws(() => buildImagesEditsJsonRequest({ prompt: "Edit" }),
    { code: "missing_image_input" });
  assert.throws(() => buildImagesEditsJsonRequest({
    prompt: "Edit", images: [{ image_url: imageUrl }], mask: {},
  }), { code: "invalid_image_mask" });
});

test("native JSON preserves image metadata, multiple images and URL compatibility", () => {
  const payload = {
    created: 123, model: "gpt-image-2.5-sunburst-2026-09-08", output_format: "webp",
    data: [{ b64_json: "aW1hZ2U=", revised_prompt: "A cat" }, { b64_json: "c2Vjb25k" }],
    quality: "max", size: "1536x864", usage: { total_tokens: 42 },
  };
  const text = JSON.stringify(payload);
  assert.deepEqual(buildImagesApiResponseFromJsonText(text, "b64_json", imageModels[1]), payload);
  const url = buildImagesApiResponseFromJsonText(text, "url", imageModels[1]);
  assert.equal(url.data.length, 2);
  assert.equal(url.data[0].url, "data:image/webp;base64,aW1hZ2U=");
  assert.equal(url.data[0].b64_json, undefined);
  assert.equal(url.usage.total_tokens, 42);
  assert.throws(() => buildImagesApiResponseFromJsonText("not JSON", "b64_json", imageModels[1]),
    { status: 502, code: "invalid_image_response" });
  assert.throws(() => buildImagesApiResponseFromJsonText('{"data":[]}', "b64_json", imageModels[1]),
    { status: 502, code: "image_generation_incomplete" });
});

test("explicit upstream downgrade is rejected instead of being labelled 2.5", () => {
  for (const payload of [
    { model: "gpt-image-2-codex", data: [{ b64_json: "aW1hZ2U=" }] },
    { data: [{ model: "gpt-image-2-codex", b64_json: "aW1hZ2U=" }] },
  ]) {
    assert.throws(() => buildImagesApiResponseFromJsonText(JSON.stringify(payload), "b64_json", imageModels[1]),
      { status: 502, code: "image_model_mismatch" });
  }
});

function chunked(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 17) {
      controller.enqueue(bytes.slice(offset, offset + 17));
    }
    controller.close();
  } });
}
function frame(prefix, kind, data) {
  return "event: " + prefix + "." + kind + "\r\ndata: "
    + JSON.stringify({ type: prefix + "." + kind, ...data }) + "\r\n\r\n";
}
for (const streamPrefix of ["image_generation", "image_edit"]) {
  for (const responseFormat of ["b64_json", "url"]) {
    test(streamPrefix + ": chunked native SSE, " + responseFormat, async () => {
      const upstream = frame(streamPrefix, "partial_image", { b64_json: "cGFydGlhbA==" })
        + frame(streamPrefix, "completed", { b64_json: "aW1hZ2U=", output_format: "webp" })
        + frame(streamPrefix, "completed", { b64_json: "c2Vjb25k", output_format: "webp" })
        + "data: [DONE]\r\n\r\n";
      let completed = 0;
      const text = await new Response(createImagesSseStream(chunked(upstream), {
        responseFormat, streamPrefix, requestedModel: imageModels[1],
        onCompleted() { completed++; }, onError(error) { assert.fail(error); },
      })).text();
      assert.equal(completed, 1);
      assert.equal((text.match(/event: .*\.completed/g) || []).length, 2);
      assert.ok(text.includes("[DONE]"));
      assert.ok(text.includes(responseFormat === "url"
        ? "data:image/webp;base64,aW1hZ2U=" : '"b64_json":"aW1hZ2U="'));
      assert.ok(!text.includes("response.completed"));
    });
  }
}
test("native errors, truncated streams and explicit downgrades never log success", async () => {
  const streams = [
    'event: error\ndata: {"type":"error","code":"denied","message":"No access"}\n\n',
    frame("image_generation", "partial_image", { b64_json: "cGFydA==" }),
    frame("image_generation", "completed", { model: "gpt-image-2-codex", b64_json: "aW1hZ2U=" }),
  ];
  for (const upstream of streams) {
    let errors = 0;
    let completed = 0;
    const text = await new Response(createImagesSseStream(chunked(upstream), {
      responseFormat: "b64_json", streamPrefix: "image_generation", requestedModel: imageModels[1],
      onCompleted() { completed++; }, onError() { errors++; },
    })).text();
    assert.equal(completed, 0);
    assert.equal(errors, 1);
    assert.ok(text.includes("event: error"));
  }
});
test("upstream body read failure becomes an image stream error", async () => {
  let errors = 0;
  const broken = new ReadableStream({ pull(controller) { controller.error(new Error("socket closed")); } });
  const text = await new Response(createImagesSseStream(broken, {
    responseFormat: "b64_json", streamPrefix: "image_generation", requestedModel: imageModels[1],
    onCompleted() { assert.fail("must not complete"); }, onError() { errors++; },
  })).text();
  assert.equal(errors, 1);
  assert.ok(text.includes("socket closed"));
});

for (const remote of [false, true]) {
  test(`model catalog exposes image models without thinking suffixes (${remote ? "remote" : "fallback"})`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      if (!remote) throw new Error("offline catalog test");
      return Response.json({ "codex-pro": [
        { id: "gpt-6.1-sol", object: "model", supported_parameters: ["tools"] },
      ] });
    });
    const { createModelsResponse } = await import(`../src/server/codex/models.ts?remote=${remote}`);
    for (const planType of ["free", "team", "plus", "pro"]) {
      for (const openAICompatible of [false, true]) {
        const response = await createModelsResponse({ planType, openAICompatible });
        const ids = response.data.map((entry) => entry.id);
        for (const model of imageModels) {
          assert.ok(ids.includes(model), `${planType} catalog missing ${model}`);
          assert.ok(!ids.some((id) => id.startsWith(`${model}(`)));
        }
        assert.equal(ids.length, new Set(ids).size);
      }
    }
    const allowed = await createModelsResponse({
      openAICompatible: true, modelAllowlist: ["gpt-image-2.5-flare"],
    });
    assert.deepEqual(allowed.data.map((entry) => entry.id), ["gpt-image-2.5-flare"]);
  });
}
