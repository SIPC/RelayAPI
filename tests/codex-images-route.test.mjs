import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { after, test } from "node:test";

// All credentials, databases and upstream traffic in this file are synthetic.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-images-route-"));
process.env.DATA_DIR = dataDir;
process.env.RELAY_MAIN_DB_PATH = path.join(dataDir, "main.sqlite");
process.env.RELAY_LOG_DB_PATH = path.join(dataDir, "logs.sqlite");
process.env.RELAY_ENCRYPTION_KEY = "isolated-image-route-test-encryption-secret";
process.env.RELAY_IMPORT_LEGACY_CREDENTIALS = "0";
for (const name of ["RELAY_GLOBAL_SOCKS_PROXY", "RELAY_GLOBAL_PROXY", "CODEX_PROXY"]) {
  delete process.env[name];
}
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
const { handleImagesGenerations, handleImagesEdits } = await import("../src/server/http/relay.ts");
const { upsertCodexCredential } = await import("../src/server/repositories/codexCredentials.ts");
const { createChannel } = await import("../src/server/services/channels.ts");
const { createApiKey } = await import("../src/server/services/apiKeys.ts");
const { getMainDb, getLogDb } = await import("../src/server/db/sqlite.ts");
const models = [
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5",
  "gpt-image-2.6",
  "gpt-image-2.6-sunburst",
  "gpt-image-2.6-flare",
];
const calls = [];
function nativeJson(call, res) {
  res.writeHead(200, { "content-type": "application/json", "set-cookie": "private-upstream-cookie" });
  res.end(JSON.stringify({ created: 123, model: call.payload.model, data: [{ b64_json: "aW1hZ2U=" }], quality: "max" }));
}
let reply = nativeJson;
const upstream = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { path: req.url, headers: req.headers, payload: JSON.parse(Buffer.concat(chunks).toString()) };
    calls.push(call);
    reply(call, res);
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const baseUrl = "http://127.0.0.1:" + upstream.address().port + "/backend-api/codex";

after(async () => {
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  getMainDb().close();
  getLogDb().close();
  const resolved = path.resolve(dataDir);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith("relay-images-route-"));
  fs.rmSync(resolved, { recursive: true, force: true });
});

function setup({ model = models[0], planType = "plus", keyModels = [model], channelModels = [model] } = {}) {
  const id = "synthetic-" + randomUUID();
  upsertCodexCredential({
    id, email: "test@example.invalid", accountId: "synthetic-account", planType,
    tokens: { access_token: "synthetic-access-token", expired: "2099-01-01T00:00:00Z" },
    metadata: {
      upstream_transport: "websocket", user_agent: "codex_cli_rs/synthetic-test",
      fast_service_tier: true,
    },
  });
  const channel = createChannel({
    baseUrl, credentialId: id, modelAllowlist: channelModels,
  });
  const apiKey = createApiKey({
    channelAllowlist: [channel.id], modelAllowlist: keyModels,
  });
  return { channel, apiKey };
}
function request(apiKey, payload, operation = "generations") {
  return new Request("http://relay.invalid/v1/images/" + operation, {
    method: "POST",
    headers: {
      authorization: "Bearer " + apiKey.key,
      "content-type": "application/json",
      "user-agent": "downstream-user-agent",
      "chatgpt-account-id": "downstream-account-must-not-be-forwarded",
      "x-api-key": "downstream-private-key",
    },
    body: JSON.stringify(payload),
  });
}
function lastLog(channel) {
  return getLogDb().prepare("SELECT * FROM request_logs WHERE channel_id = ? ORDER BY rowid DESC LIMIT 1").get(channel.id);
}
function nativeSse(call, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "chatgpt-account-id": "private-account",
    "set-cookie": "private-cookie",
  });
  const prefix = call.path.endsWith("/edits") ? "image_edit" : "image_generation";
  const text = "event: " + prefix + ".partial_image\ndata: "
    + JSON.stringify({ type: prefix + ".partial_image", b64_json: "cGFydA==" }) + "\n\n"
    + "event: " + prefix + ".completed\ndata: "
    + JSON.stringify({ type: prefix + ".completed", b64_json: "aW1hZ2U=", model: call.payload.model }) + "\n\n";
  for (let offset = 0; offset < text.length; offset += 17) res.write(text.slice(offset, offset + 17));
  res.end();
}

// The upstream reply is shared, so keep these scenarios sequential.
for (const model of models) {
  test(model + ": HTTP generation uses native endpoint, requested model and Codex auth without Responses injection", async () => {
    reply = nativeJson;
    const { channel, apiKey } = setup({ model });
    const before = calls.length;
    const payload = {
      model, prompt: "Draw a cat", quality: "max", size: "1536x864",
      n: 2, output_format: "webp", output_compression: 85,
    };
    const response = await handleImagesGenerations(request(apiKey, payload));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.model, model);
    assert.equal(result.data[0].b64_json, "aW1hZ2U=");
    assert.equal(calls.length, before + 1);
    const call = calls.at(-1);
    assert.equal(call.path, "/backend-api/codex/images/generations");
    assert.deepEqual(call.payload, payload);
    assert.equal(call.headers.authorization, "Bearer synthetic-access-token");
    assert.equal(call.headers["chatgpt-account-id"], "synthetic-account");
    assert.equal(call.headers["user-agent"], "codex_cli_rs/synthetic-test");
    assert.equal(call.headers.accept, "application/json");
    assert.equal(call.headers["x-api-key"], undefined);
    assert.equal(lastLog(channel).model, model);
    assert.equal(lastLog(channel).status_code, 200);
  });

  test(model + ": JSON edit forwards image URLs, file references and mask to native edit endpoint", async () => {
    reply = nativeJson;
    const { channel, apiKey } = setup({ model });
    const before = calls.length;
    const payload = {
      model, prompt: "Edit a cat", images: [{ image_url: "https://example.invalid/cat.png" }, { file_id: "file-image" }],
      mask: { file_id: "file-mask" }, input_fidelity: "high",
    };
    const response = await handleImagesEdits(request(apiKey, payload, "edits"));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.model, model);
    assert.equal(result.data[0].b64_json, "aW1hZ2U=");
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1).path, "/backend-api/codex/images/edits");
    assert.deepEqual(calls.at(-1).payload, payload);
    assert.equal(lastLog(channel).model, model);
    assert.equal(lastLog(channel).status_code, 200);
  });

  test(model + ": multipart edit converts files to native JSON and retains typed options", async () => {
    reply = nativeJson;
    const { channel, apiKey } = setup({ model });
    const before = calls.length;
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", "Edit a cat");
    form.set("n", "2");
    form.set("output_compression", "85");
    form.set("quality", "max");
    form.append("image", new File(["image"], "cat.png", { type: "image/png" }));
    form.set("mask", new File(["mask"], "mask.png", { type: "image/png" }));
    const response = await handleImagesEdits(new Request("http://relay.invalid/v1/images/edits", {
      method: "POST", headers: { authorization: "Bearer " + apiKey.key }, body: form,
    }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.model, model);
    assert.equal(result.data[0].b64_json, "aW1hZ2U=");
    assert.equal(calls.length, before + 1);
    const call = calls.at(-1);
    assert.equal(call.path, "/backend-api/codex/images/edits");
    assert.equal(call.headers["content-type"], "application/json");
    assert.deepEqual(call.payload, {
      model, prompt: "Edit a cat", n: 2, output_compression: 85, quality: "max",
      images: [{ image_url: "data:image/png;base64,aW1hZ2U=" }],
      mask: { image_url: "data:image/png;base64,bWFzaw==" },
    });
    assert.equal(lastLog(channel).model, model);
    assert.equal(lastLog(channel).status_code, 200);
  });

  for (const operation of ["generations", "edits"]) {
    test(model + ": " + operation + ": native SSE stays on HTTP even for a WebSocket credential", async () => {
      reply = nativeSse;
      const { channel, apiKey } = setup({ model });
      const before = calls.length;
      const payload = { model, prompt: "Draw a cat", stream: true };
      if (operation === "edits") payload.images = [{ file_id: "file-image" }];
      const response = await (operation === "edits" ? handleImagesEdits : handleImagesGenerations)(
        request(apiKey, payload, operation),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("chatgpt-account-id"), null);
      const text = await response.text();
      const type = operation === "edits" ? "image_edit.completed" : "image_generation.completed";
      const completed = text.split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
        .find((event) => event.type === type);
      assert.equal(completed?.model, model);
      assert.equal(completed?.b64_json, "aW1hZ2U=");
      assert.equal(calls.length, before + 1);
      assert.equal(calls.at(-1).path, "/backend-api/codex/images/" + operation);
      assert.equal(calls.at(-1).headers.accept, "text/event-stream");
      assert.deepEqual(calls.at(-1).payload, payload);
      assert.equal(lastLog(channel).model, model);
      assert.equal(lastLog(channel).status_code, 200);
    });

    test(model + ": " + operation + ": native upstream rejection is returned once without hosted fallback", async () => {
      reply = (_call, res) => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"error":{"message":"Native image model unavailable","code":"model_not_found"}}');
      };
      const { channel, apiKey } = setup({ model });
      const before = calls.length;
      const payload = { model, prompt: "Draw" };
      if (operation === "edits") payload.images = [{ file_id: "file-image" }];
      const response = await (operation === "edits" ? handleImagesEdits : handleImagesGenerations)(
        request(apiKey, payload, operation),
      );
      assert.equal(response.status, 404);
      assert.equal(calls.length, before + 1);
      assert.equal(calls.at(-1).path, "/backend-api/codex/images/" + operation);
      assert.deepEqual(calls.at(-1).payload, payload);
      assert.equal(lastLog(channel).model, model);
      assert.equal(lastLog(channel).status_code, 404);
      assert.equal(lastLog(channel).error_code, "upstream_error");
    });
  }

  test(model + ": a truncated native stream is reported as an error and logged as 502", async () => {
    reply = (_call, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('event: image_generation.partial_image\ndata: {"b64_json":"cGFydA=="}\n\n');
    };
    const { channel, apiKey } = setup({ model });
    const before = calls.length;
    const response = await handleImagesGenerations(request(apiKey, { model, prompt: "Draw", stream: true }));
    const text = await response.text();
    assert.ok(text.includes("image_generation_incomplete"));
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1).payload.model, model);
    assert.equal(lastLog(channel).model, model);
    assert.equal(lastLog(channel).status_code, 502);
    assert.equal(lastLog(channel).error_code, "stream_error");
  });

  test(model + ": explicit model downgrade fails rather than returning a success image", async (t) => {
    t.mock.method(console, "error", () => {});
    reply = (_call, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        model: model.startsWith("gpt-image-2.6") ? "gpt-image-2.5" : "gpt-image-2-codex",
        data: [{ b64_json: "aW1hZ2U=" }],
      }));
    };
    const { channel, apiKey } = setup({ model });
    const before = calls.length;
    const response = await handleImagesGenerations(request(apiKey, { model, prompt: "Draw" }));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "image_model_mismatch");
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1).payload.model, model);
    assert.equal(lastLog(channel).model, model);
    assert.equal(lastLog(channel).status_code, 502);
    assert.equal(lastLog(channel).error_code, "image_model_mismatch");
  });

  test(model + ": Free plan and text-only key allowlist cannot send an image upstream", async (t) => {
    t.mock.method(console, "error", () => {});
    reply = nativeJson;
    const before = calls.length;
    for (const options of [{ planType: "free" }, { keyModels: ["gpt-6.1-sol"] }]) {
      const { apiKey } = setup({ model, ...options });
      const response = await handleImagesGenerations(request(apiKey, { model, prompt: "Draw" }));
      assert.equal(response.status, 403);
    }
    assert.equal(calls.length, before);
  });
}
