import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-antigravity-test-"));
process.env.DATA_DIR = dataDir;
process.env.RELAY_MAIN_DB_PATH = path.join(dataDir, "main.sqlite");
process.env.RELAY_LOG_DB_PATH = path.join(dataDir, "logs.sqlite");
process.env.RELAY_ENCRYPTION_KEY = "synthetic-antigravity-encryption";
process.env.RELAY_WEB_ACCESS_KEY = "synthetic-antigravity-admin";
process.env.RELAY_IMPORT_LEGACY_CREDENTIALS = "0";
process.env.RELAY_ANTIGRAVITY_ONBOARD_POLL_MS = "0";
delete process.env.RELAY_ANTIGRAVITY_OAUTH_CLIENT_ID;
delete process.env.RELAY_ANTIGRAVITY_OAUTH_CLIENT_SECRET;

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  if (specifier.startsWith("@/")) return nextResolve(new URL("../" + specifier.slice(2) + ".ts", import.meta.url).href, context);
  return nextResolve(specifier, context);
} });

const { POST: start } = await import("../app/api/admin/antigravity/credentials/oauth/start/route.ts");
const { POST: callback } = await import("../app/api/admin/antigravity/credentials/oauth/callback/route.ts");
const { POST: refresh, PATCH: patchCredential, DELETE: deleteCredential } =
  await import("../app/api/admin/antigravity/credentials/[id]/route.ts");
const { POST: resetHealth } = await import("../app/api/admin/antigravity/credentials/[id]/health/route.ts");
const { GET: getQuota } = await import("../app/api/admin/antigravity/credentials/[id]/quota/route.ts");
const { GET: list } = await import("../app/api/admin/antigravity/credentials/route.ts");
const { POST: createChannel, GET: listChannels } = await import("../app/api/admin/channels/route.ts");
const { POST: postResponses } = await import("../app/v1/responses/route.ts");
const { POST: postChat } = await import("../app/v1/chat/completions/route.ts");
const { POST: postMessages } = await import("../app/v1/messages/route.ts");
const { POST: postCountTokens } = await import("../app/v1/messages/count_tokens/route.ts");
const { GET: getModels } = await import("../app/v1/models/route.ts");
const { createApiKey } = await import("../src/server/services/apiKeys.ts");
const { getMainDb, getLogDb } = await import("../src/server/db/sqlite.ts");
const { getAntigravityCredentialWithTokens, replaceAntigravityModels, replaceAntigravityTokens, saveAntigravityCredential } =
  await import("../src/server/repositories/antigravityCredentials.ts");
const { upsertClaudeCredential } = await import("../src/server/repositories/claudeCredentials.ts");
const { updateChannel } = await import("../src/server/repositories/channels.ts");
const { selectChannelForRequest } = await import("../src/server/services/channels.ts");
const { ANTIGRAVITY_DEFAULT_CLIENT_ID, ANTIGRAVITY_DEFAULT_CLIENT_SECRET } =
  await import("../src/server/antigravity/oauthClient.ts");
const { createWebSessionToken, WEB_SESSION_COOKIE } = await import("../src/server/services/webAccess.ts");

const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  getMainDb().close();
  getLogDb().close();
  const resolved = path.resolve(dataDir);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith("relay-antigravity-test-"));
  fs.rmSync(resolved, { recursive: true, force: true });
});

const model = "gemini-fixture";
const otherModel = "gemini-3-pro-fixture";
const usage = { promptTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 17, cachedContentTokenCount: 4 };
const toolSignature = "dGVzdC1zaWduYXR1cmU=";
const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: { q: { type: "string", minLength: 2 } } } }];
const userAgent = /^antigravity\/hub\/[\d.]+ \(aidev_client; os_type=darwin; arch=arm64; cl=\d+\)( google-api-nodejs-client\/[\d.]+)?$/;

function responseFrame(parts, finishReason, usageMetadata) {
  return { response: { candidates: [{ content: { parts }, finishReason }], usageMetadata } };
}

function sse(...frames) {
  const bytes = new TextEncoder().encode(frames.map(value => "data: " + JSON.stringify(value) + "\r\n\r\n").join(""));
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) controller.close();
      else {
        controller.enqueue(bytes.slice(offset, offset + 3));
        offset += 3;
      }
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

function rateLimit(reason, retryDelay, token) {
  return Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "limited " + token, details: [
    { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
  ] } }, { status: 429 });
}

function request(pathname, body, headers = {}) {
  return new Request("http://relay.invalid" + pathname, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("Antigravity OAuth, CPA request shape, 429 failover and every relay protocol", async () => {
  const admin = { cookie: WEB_SESSION_COOKIE + "=" + createWebSessionToken(), "content-type": "application/json" };
  assert.equal(start(request("/oauth/start", {})).status, 401);
  const accounts = { a: { refreshes: 0 }, b: { refreshes: 0 } };
  const onboardBodies = [];
  const inference = [];
  const upstreamCalls = [];
  const quotaHosts = [];
  const accountOf = token => token.startsWith("token-a") ? "a" : "b";

  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    assert.equal(init.redirect, "error");
    if (url.hostname === "oauth2.googleapis.com") {
      const form = new URLSearchParams(init.body);
      // The built-in Antigravity desktop client is used without PKCE, as in CPA.
      assert.equal(form.get("client_id"), ANTIGRAVITY_DEFAULT_CLIENT_ID);
      assert.equal(form.get("client_secret"), ANTIGRAVITY_DEFAULT_CLIENT_SECRET);
      assert.equal(form.get("code_verifier"), null);
      if (form.get("grant_type") === "authorization_code") {
        const id = form.get("code") === "code-a" ? "a" : "b";
        return Response.json({ access_token: "token-" + id + "-0", refresh_token: "refresh-" + id, expires_in: 3600 });
      }
      const id = form.get("refresh_token") === "refresh-a" ? "a" : "b";
      accounts[id].refreshes++;
      return Response.json({ access_token: "token-" + id + "-" + accounts[id].refreshes, expires_in: 3600 });
    }
    const token = headers.get("authorization").replace(/^Bearer /, "");
    const account = accountOf(token);
    if (url.hostname === "www.googleapis.com") return Response.json({ id: "fixture-" + account, email: account + "@example.invalid" });
    if (url.pathname.endsWith(":retrieveUserQuotaSummary")) {
      assert.deepEqual(JSON.parse(init.body), { project: "project-" + account });
      quotaHosts.push(url.hostname);
      const bucket = (bucketId, window, remainingFraction) => ({ bucketId, window, remainingFraction, resetTime: "2099-01-01T00:00:00Z" });
      const claudeGroup = { displayName: "Claude and GPT models", buckets: [bucket("3p-5h", "5h", 0.9), bucket("3p-weekly", "weekly", 0.25)] };
      // The daily endpoint answers with only the Claude/GPT group; production also has Gemini.
      if (url.hostname === "daily-cloudcode-pa.googleapis.com") return Response.json({ groups: [claudeGroup] });
      if (url.hostname.includes("sandbox")) return Response.json({ error: { code: 500 } }, { status: 500 });
      return Response.json({ groups: [
        { ...claudeGroup, buckets: [bucket("3p-5h", "5h", 0)] },
        { displayName: "Gemini Models", buckets: [{ bucketId: "gemini-weekly", window: "weekly" }, bucket("gemini-5h", "5h", 1)] },
      ] });
    }
    assert.equal(url.hostname, "daily-cloudcode-pa.googleapis.com");
    assert.match(headers.get("user-agent"), userAgent);
    const payload = JSON.parse(init.body);
    if (url.pathname.endsWith(":loadCodeAssist")) {
      assert.deepEqual(payload, { metadata: { ideType: "ANTIGRAVITY" } });
      return Response.json(account === "a"
        ? { allowedTiers: [{ id: "legacy-tier" }, { id: "standard-tier", isDefault: true }], currentTier: { id: "free-tier" } }
        : { cloudaicompanionProject: "project-b" });
    }
    if (url.pathname.endsWith(":onboardUser")) {
      assert.equal(headers.get("x-goog-api-client"), "gl-node/22.21.1");
      onboardBodies.push(payload);
      return Response.json(onboardBodies.length < 2 ? { done: false }
        : { done: true, response: { cloudaicompanionProject: { id: "project-a" } } });
    }
    if (url.pathname.endsWith(":fetchAvailableModels")) {
      assert.equal(payload.project, "project-" + account);
      return Response.json({ models: { [model]: {}, [otherModel]: {}, "claude-opus-5-5-high": {}, "gpt-oss-120b-medium": {} } });
    }
    upstreamCalls.push({ account, pathname: url.pathname, payload });
    const next = inference.shift();
    assert.ok(next, "unexpected inference call to " + url.pathname);
    return next({ account, token, url, payload });
  };

  async function login(code) {
    const response = start(request("/oauth/start", {}, admin));
    assert.equal(response.status, 200);
    const { authUrl, redirectUri, state } = await response.json();
    const auth = new URL(authUrl);
    assert.equal(auth.searchParams.get("client_id"), ANTIGRAVITY_DEFAULT_CLIENT_ID);
    assert.equal(auth.searchParams.get("code_challenge"), null);
    assert.equal(auth.searchParams.get("scope").split(" ").length, 6);
    const callbackRequest = () => request("/oauth/callback", { callbackUrl: redirectUri + "?code=" + code + "&state=" + state }, admin);
    const result = await callback(callbackRequest());
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await callback(callbackRequest())).status, 400);
    return result.json();
  }

  const credentialA = await login("code-a");
  // Accounts without a project are provisioned through onboardUser with the default tier.
  assert.equal(onboardBodies.length, 2);
  assert.deepEqual(onboardBodies[0], { tier_id: "standard-tier", metadata: { ide_type: "ANTIGRAVITY", ide_version: "2.33.0", ide_name: "antigravity" } });
  assert.equal(getAntigravityCredentialWithTokens(credentialA.id).projectId, "project-a");
  assert.deepEqual(credentialA.models, [otherModel, model]);
  assert.equal(credentialA.tokens, undefined);
  const credentialB = await login("code-b");
  assert.equal(getAntigravityCredentialWithTokens(credentialB.id).projectId, "project-b");
  assert.deepEqual((await list(request("/credentials", undefined, admin)).json()).map(item => item.email),
    ["a@example.invalid", "b@example.invalid"]);
  assert.ok(!getMainDb().prepare("SELECT token_envelope FROM antigravity_credentials").get().token_envelope.includes("refresh-a"));

  const refreshCredential = () => refresh(request("/credentials/" + credentialA.id, {}, admin), { params: Promise.resolve({ id: credentialA.id }) });
  for (const result of await Promise.all([refreshCredential(), refreshCredential()])) {
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await result.json()).tokens, undefined);
  }
  assert.equal(accounts.a.refreshes, 1);
  const saved = getAntigravityCredentialWithTokens(credentialA.id);
  replaceAntigravityTokens(saved, { ...saved.tokens, expired: "2000-01-01T00:00:00.000Z" });

  const channels = [];
  for (const [credential, priority] of [[credentialA, 10], [credentialB, 1]]) {
    const response = await createChannel(request("/channels", {
      provider: "antigravity", modelAllowlist: [model, otherModel], credentialId: credential.id, priority,
    }, admin));
    assert.equal(response.status, 201, await response.clone().text());
    channels.push(await response.json());
  }
  assert.deepEqual(channels[0].capabilities, ["chat", "responses", "messages", "count_tokens"]);
  const key = createApiKey({ channelAllowlist: channels.map(channel => channel.id), modelAllowlist: [model, otherModel] });
  const headers = { authorization: "Bearer " + key.key, "content-type": "application/json" };
  const ask = body => postResponses(request("/v1/responses", { model, ...body }, headers));
  const models = await getModels(request("/v1/models", undefined, headers));
  assert.deepEqual((await models.json()).data.map(item => item.id), [model, otherModel]);

  inference.push(() => Response.json(responseFrame([{ thoughtSignature: toolSignature, functionCall: {
    name: "lookup", args: { q: "weather" },
  } }], "STOP", usage)));
  const first = await ask({ input: "What is the weather?", tools, instructions: "Give the current weather",
    max_output_tokens: 50, reasoning: { effort: "high" } });
  assert.equal(first.status, 200, await first.clone().text());
  const output = await first.json();
  assert.equal(accounts.a.refreshes, 2);
  assert.deepEqual(output.output.map(item => item.type), ["reasoning", "function_call"]);
  assert.equal(output.usage.total_tokens, 17);
  const firstCall = upstreamCalls[0];
  assert.equal(firstCall.pathname, "/v1internal:generateContent");
  assert.equal(firstCall.payload.project, "project-a");
  assert.equal(firstCall.payload.userAgent, "antigravity");
  assert.equal(firstCall.payload.requestType, "agent");
  assert.match(firstCall.payload.requestId, /^agent-[0-9a-f-]{36}$/);
  assert.match(firstCall.payload.request.sessionId, /^-\d+$/);
  assert.equal(firstCall.payload.request.systemInstruction.parts[0].text, "Give the current weather");
  // Gemini drops maxOutputTokens; Responses effort enables visible thoughts by default (CPA #5508).
  assert.deepEqual(firstCall.payload.request.generationConfig, { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } });
  assert.deepEqual(firstCall.payload.request.tools[0].functionDeclarations[0].parameters,
    { type: "object", properties: { q: { type: "string", description: "minLength: 2" } } });

  inference.push(() => sse(
    responseFrame([{ text: "Sunny" }]),
    responseFrame([{ text: " today." }], "STOP"),
    responseFrame([], undefined, usage),
  ));
  const history = [{ role: "user", content: "What is the weather?" }, ...output.output,
    { type: "function_call_output", call_id: output.output[1].call_id, output: "sunny" }];
  const second = await ask({ input: history, tools, stream: true });
  assert.equal(second.status, 200);
  const events = (await second.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  assert.deepEqual(events.map(event => event.sequence_number), events.map((_, i) => i));
  assert.equal(events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join(""), "Sunny today.");
  assert.equal(events.at(-1).type, "response.completed");
  const contents = upstreamCalls[1].payload.request.contents;
  assert.equal(upstreamCalls[1].payload.request.sessionId, firstCall.payload.request.sessionId);
  assert.equal(contents[1].parts[0].thoughtSignature, toolSignature);
  assert.deepEqual(contents[2].parts[0].functionResponse, { name: "lookup", response: { output: "sunny" } });

  inference.push(() => sse(responseFrame([{ text: "partial" }])));
  const truncatedBody = await (await ask({ input: "Hello", stream: true })).text();
  assert.match(truncatedBody, /antigravity_response_truncated/);
  assert.doesNotMatch(truncatedBody, /response\.completed/);

  // RATE_LIMIT_EXCEEDED under 3s retries the same credential after the delay.
  inference.push(({ token }) => rateLimit("RATE_LIMIT_EXCEEDED", "0.05s", token),
    () => Response.json(responseFrame([{ text: "ok" }], "STOP", usage)));
  assert.equal((await ask({ input: "Hello" })).status, 200);
  const [retried, retriedAgain] = upstreamCalls.slice(-2).map(call => call.account);
  assert.equal(retriedAgain, retried);

  // A longer delay cools this model on the credential and switches to the next credential.
  inference.push(({ token }) => rateLimit("RATE_LIMIT_EXCEEDED", "30s", token),
    () => Response.json(responseFrame([{ text: "from b" }], "STOP", usage)));
  const switched = await ask({ input: "Hello" });
  assert.equal(switched.status, 200, await switched.clone().text());
  const [limited, fallback] = upstreamCalls.slice(-2).map(call => call.account);
  assert.notEqual(fallback, limited);
  const ids = { a: credentialA.id, b: credentialB.id };
  const cooled = (await list(request("/credentials", undefined, admin)).json()).find(item => item.id === ids[limited]);
  assert.ok(Date.parse(cooled.modelCooldowns[model].until) > Date.now() + 20000);
  assert.equal(cooled.modelCooldowns[otherModel], undefined);

  inference.push(({ token }) => rateLimit("QUOTA_EXHAUSTED", "120s", token));
  const exhausted = await ask({ input: "Hello" });
  assert.equal(exhausted.status, 429);
  assert.equal(exhausted.headers.get("retry-after"), "120");
  assert.ok(!(await exhausted.text()).includes("token-"));
  // The cooled credential is skipped for this model, so only the other credential is tried.
  assert.equal(upstreamCalls.at(-1).account, fallback);

  // Gemini 3 Pro uses the streaming endpoint even for non-stream Chat, and needs tool placeholders.
  inference.push(() => sse(responseFrame([{ text: "Hello" }], "STOP", usage)));
  const chat = await postChat(request("/v1/chat/completions", {
    model: otherModel, max_tokens: 100000,
    messages: [{ role: "system", content: "Be brief" }, { role: "user", content: "Hi" }],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
  }, headers));
  assert.equal(chat.status, 200, await chat.clone().text());
  assert.equal((await chat.json()).choices[0].message.content, "Hello");
  const chatCall = upstreamCalls.at(-1);
  assert.equal(chatCall.pathname, "/v1internal:streamGenerateContent");
  assert.equal(chatCall.payload.request.toolConfig.functionCallingConfig.mode, "AUTO");
  assert.deepEqual(chatCall.payload.request.tools[0].functionDeclarations[0].parameters.required, ["reason"]);
  assert.equal(chatCall.payload.request.generationConfig?.maxOutputTokens, undefined);
  assert.equal(chatCall.payload.request.systemInstruction.parts[0].text, "Be brief");

  inference.push(() => sse(responseFrame([{ text: "Hi there" }], "STOP", usage)));
  const messages = await postMessages(request("/v1/messages", {
    model: otherModel, max_tokens: 1024, stream: true, messages: [{ role: "user", content: "Hi" }],
  }, headers));
  assert.equal(messages.status, 200);
  const claudeEvents = (await messages.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  assert.equal(claudeEvents[0].type, "message_start");
  assert.equal(claudeEvents.filter(event => event.delta?.type === "text_delta").map(event => event.delta.text).join(""), "Hi there");
  assert.equal(claudeEvents.at(-2).delta.stop_reason, "end_turn");
  assert.equal(claudeEvents.at(-1).type, "message_stop");

  inference.push(({ url, payload }) => {
    assert.equal(url.pathname, "/v1internal:countTokens");
    assert.deepEqual(Object.keys(payload), ["request"]);
    assert.equal(payload.request.sessionId, undefined);
    return Response.json({ totalTokens: 42 });
  });
  const counted = await postCountTokens(request("/v1/messages/count_tokens", {
    model: otherModel, messages: [{ role: "user", content: "Hi" }],
  }, headers));
  assert.equal(counted.status, 200, await counted.clone().text());
  assert.deepEqual(await counted.json(), { input_tokens: 42 });

  // TOS_VIOLATION disables the credential and the request continues on the next credential.
  inference.push(() => Response.json({ error: { code: 403, details: [{ reason: "TOS_VIOLATION" }] } }, { status: 403 }),
    () => sse(responseFrame([{ text: "rescued" }], "STOP", usage)));
  const suspended = await ask({ model: otherModel, input: "Hello" });
  assert.equal(suspended.status, 200, await suspended.clone().text());
  const [banned, rescued] = upstreamCalls.slice(-2).map(call => call.account);
  assert.notEqual(rescued, banned);
  assert.equal(getAntigravityCredentialWithTokens(ids[banned]).enabled, false);
  assert.equal(inference.length, 0);
  const calls = upstreamCalls.length;
  // Both credentials are cooled for the Gemini model now; input validation still fails before any upstream call.
  assert.equal((await ask({ input: "Hi" })).status, 503);
  assert.equal((await ask({ model: otherModel, input: "Hi", previous_response_id: "resp_previous" })).status, 400);
  assert.equal(upstreamCalls.length, calls);

  const logs = getLogDb().prepare("SELECT status_code, total_tokens FROM request_logs WHERE request_type = 'responses.antigravity' ORDER BY rowid").all();
  assert.deepEqual(logs.slice(0, 3).map(log => [log.status_code, log.total_tokens]), [[200, 17], [200, 17], [502, 0]]);

  // Admin card actions: health reset clears per-model cooldowns, PATCH re-enables and reweights.
  const context = id => ({ params: Promise.resolve({ id }) });

  // Quota merges partial endpoint answers by group and keeps the first value of each bucket.
  const quotaResponse = await getQuota(request("/credentials/" + ids[rescued] + "/quota", undefined, admin), context(ids[rescued]));
  assert.equal(quotaResponse.status, 200, await quotaResponse.clone().text());
  const quota = await quotaResponse.json();
  assert.deepEqual(quotaHosts, ["daily-cloudcode-pa.googleapis.com", "daily-cloudcode-pa.sandbox.googleapis.com", "cloudcode-pa.googleapis.com"]);
  assert.deepEqual(quota.groups.map(group => [group.label, group.buckets.map(bucket => [bucket.id, bucket.remaining_percent])]), [
    ["Claude and GPT models", [["3p-weekly", 25], ["3p-5h", 90]]],
    ["Gemini Models", [["gemini-weekly", null], ["gemini-5h", 100]]],
  ]);
  // The best group bounds availability: Gemini is untouched (100%), so the account is not "low".
  assert.equal(quota.status, "full");
  const adminCall = (method, pathname, body) => new Request("http://relay.invalid" + pathname, {
    method, headers: admin, body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const id of [credentialA.id, credentialB.id]) {
    const reset = await resetHealth(adminCall("POST", "/credentials/" + id + "/health"), context(id));
    assert.equal(reset.status, 200, await reset.clone().text());
    const body = await reset.json();
    assert.deepEqual(body.modelCooldowns, {});
    assert.equal(body.lastError, null);
    assert.equal(body.usageHealth.requestCount, 0);
  }
  const patched = await patchCredential(adminCall("PATCH", "/credentials/" + ids[banned], { enabled: true, priority: 7, weight: 0 }), context(ids[banned]));
  assert.equal(patched.status, 200, await patched.clone().text());
  assert.deepEqual((({ enabled, priority, weight }) => ({ enabled, priority, weight }))(await patched.json()), { enabled: true, priority: 7, weight: 1 });

  // A channel without a model allowlist serves the bound accounts' catalogs, and a key bound to it sees exactly those.
  const catalogChannelResponse = await createChannel(request("/channels", {
    provider: "antigravity", credentialIds: [credentialA.id, credentialB.id],
  }, admin));
  assert.equal(catalogChannelResponse.status, 201, await catalogChannelResponse.clone().text());
  const catalogChannel = await catalogChannelResponse.json();
  assert.deepEqual(catalogChannel.modelAllowlist, []);
  const catalogKey = createApiKey({ channelAllowlist: [catalogChannel.id] });
  const catalogHeaders = { authorization: "Bearer " + catalogKey.key, "content-type": "application/json" };
  const catalogModels = await getModels(request("/v1/models", undefined, catalogHeaders));
  assert.deepEqual((await catalogModels.json()).data.map(item => item.id), [otherModel, model]);
  inference.push(() => Response.json(responseFrame([{ text: "catalog" }], "STOP", usage)));
  const viaCatalog = await postResponses(request("/v1/responses", { model, input: "Hi" }, catalogHeaders));
  assert.equal(viaCatalog.status, 200, await viaCatalog.clone().text());
  assert.equal(upstreamCalls.at(-1).payload.model, model);
  const outsideCatalog = upstreamCalls.length;
  assert.notEqual((await postResponses(request("/v1/responses", { model: "gemini-not-in-catalog", input: "Hi" }, catalogHeaders))).status, 200);
  assert.equal(upstreamCalls.length, outsideCatalog);

  // Tiered upstream IDs are listed and routed by their standard name; the tier follows the requested effort.
  replaceAntigravityModels(credentialA.id, ["gemini-4-argon-high", "gemini-4-argon-low", "gemini-4-carbon-disabled",
    "tab_flash_lite_preview", model]);
  const tieredModels = await getModels(request("/v1/models", undefined, catalogHeaders));
  assert.deepEqual((await tieredModels.json()).data.map(item => item.id), [otherModel, "gemini-4-argon", model]);
  for (const [requested, effort, expected] of [
    ["gemini-4-argon", "low", "gemini-4-argon-low"],
    ["gemini-4-argon", undefined, "gemini-4-argon-high"],
    // Vendor prefixes resolve like the bare name.
    ["google/gemini-4-argon", "low", "gemini-4-argon-low"],
    ["google/" + model, undefined, model],
  ]) {
    const frame = responseFrame([{ text: "tiered" }], "STOP", usage);
    inference.push(() => Response.json(frame));
    const tiered = await postResponses(request("/v1/responses", {
      model: requested, input: "Hi", ...(effort && { reasoning: { effort } }),
    }, catalogHeaders));
    assert.equal(tiered.status, 200, await tiered.clone().text());
    assert.equal(upstreamCalls.at(-1).account, "a");
    assert.equal(upstreamCalls.at(-1).payload.model, expected);
    assert.equal((await tiered.json()).model, requested);
  }

  // Deleting a credential removes it from every channel that bound it.
  const removed = await deleteCredential(adminCall("DELETE", "/credentials/" + credentialB.id), context(credentialB.id));
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.deepEqual((await list(request("/credentials", undefined, admin)).json()).map(item => item.id), [credentialA.id]);
  const remaining = await (await listChannels(request("/channels", undefined, admin))).json();
  assert.ok(remaining.every(channel => !channel.credentialIds.includes(credentialB.id)));
  assert.deepEqual(remaining.find(channel => channel.id === catalogChannel.id).credentialIds, [credentialA.id]);
});

test("Antigravity forwards thinking before generation finishes and preserves signatures", async () => {
  const admin = { cookie: WEB_SESSION_COOKIE + "=" + createWebSessionToken(), "content-type": "application/json" };
  const credential = saveAntigravityCredential({ accountId: "live-thinking", email: "thinking@example.invalid", projectId: "fixture-project",
    tokens: { access_token: "synthetic-token", refresh_token: "synthetic-refresh", expired: "2099-01-01T00:00:00Z", last_refresh: new Date().toISOString() } });
  const channel = await (await createChannel(request("/channels", {
    provider: "antigravity", credentialId: credential.id, modelAllowlist: [model],
  }, admin))).json();
  const key = createApiKey({ channelAllowlist: [channel.id] });
  const headers = { authorization: "Bearer " + key.key, "content-type": "application/json" };
  const encoder = new TextEncoder();
  let upstream;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { upstream = controller; } }),
    { headers: { "content-type": "text/event-stream" } });
  const response = await postResponses(request("/v1/responses", { model, input: "Think", stream: true,
    reasoning: { effort: "high" } }, headers));
  const reader = response.body.getReader();
  let received = "";
  const send = frame => upstream.enqueue(encoder.encode("data: " + JSON.stringify(frame) + "\n\n"));
  async function until(text) {
    while (!received.includes(text)) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "stream ended before " + text);
      received += new TextDecoder().decode(chunk.value);
    }
  }
  let timer;
  try {
    send(responseFrame([{ thought: true, text: "Considering " }], undefined, usage));
    await Promise.race([
      until("response.reasoning_summary_text.delta"),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Thinking was buffered until the next part or EOF")), 1000); }),
    ]);
    clearTimeout(timer);
    assert.match(received, /Considering /);
    assert.doesNotMatch(received, /response\.completed|reasoning_summary_text\.done/);
    send(responseFrame([{ thought: true, text: "alternatives.", thoughtSignature: toolSignature }]));
    await until("alternatives.");
    send(responseFrame([{ text: "Answer" }], "STOP"));
    // Usage may arrive after the finish reason; do not discard that tail.
    send(responseFrame([], undefined, { ...usage, candidatesTokenCount: 7, totalTokenCount: 21 }));
    upstream.close();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += new TextDecoder().decode(chunk.value);
    }
    const events = received.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    assert.deepEqual(events.map(event => event.sequence_number), events.map((_, i) => i));
    assert.deepEqual(events.filter(event => event.type === "response.reasoning_summary_text.delta").map(event => event.delta),
      ["Considering ", "alternatives."]);
    const completed = events.at(-1);
    assert.equal(completed.type, "response.completed");
    assert.deepEqual(completed.response.output[0].summary, [{ type: "summary_text", text: "Considering alternatives." }]);
    assert.equal(completed.response.output[0].encrypted_content, "relay-antigravity:thought:" + toolSignature);
    assert.equal(completed.response.output[1].content[0].text, "Answer");
    assert.equal(completed.response.usage.output_tokens, 9);
    const detail = getLogDb().prepare("SELECT stage_timings_json FROM request_log_details ORDER BY rowid DESC LIMIT 1").get();
    const stages = JSON.parse(detail.stage_timings_json).map(stage => stage.name);
    for (const name of ["antigravity_authorize", "antigravity_upstream_headers", "antigravity_status_200",
      "stream_first_byte", "stream_first_token", "stream_first_thought", "stream_first_text",
      "stream_upstream_finish", "stream_idle_before_end", "stream_end"]) {
      assert.equal(stages.filter(stage => stage === name).length, 1, "missing or repeated diagnostic: " + name);
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel();
  }
});

test("Antigravity only offers and routes Gemini, including legacy allowlists and unknown catalogs", async () => {
  const admin = { cookie: WEB_SESSION_COOKIE + "=" + createWebSessionToken(), "content-type": "application/json" };
  const agy = saveAntigravityCredential({ accountId: "gemini-only", email: "gemini-only@example.invalid", projectId: "fixture-project",
    tokens: { access_token: "synthetic-token", refresh_token: "synthetic-refresh", expired: "2099-01-01T00:00:00Z", last_refresh: new Date().toISOString() } });
  const native = upsertClaudeCredential({ id: "native-claude", email: "native@example.invalid", accountId: "native-account",
    tokens: { access_token: "synthetic-native-token", expired: "2099-01-01T00:00:00Z" } });
  for (const blocked of ["claude-opus-5-5", "gpt-oss-120b-medium", "gpt-5.5"]) {
    const invalid = await createChannel(request("/channels", {
      provider: "antigravity", credentialId: agy.id, modelAllowlist: [model, blocked],
    }, admin));
    assert.equal(invalid.status, 400, "must reject AGY allowlist containing " + blocked);
    assert.equal((await invalid.json()).error.code, "invalid_antigravity_models");
  }
  const agyChannel = await (await createChannel(request("/channels", {
    provider: "antigravity", credentialId: agy.id, priority: 9999,
  }, admin))).json();
  const claudeChannel = await (await createChannel(request("/channels", {
    provider: "claude", credentialId: native.id, priority: 1,
  }, admin))).json();
  const onlyAgy = createApiKey({ channelAllowlist: [agyChannel.id] });
  const headers = { authorization: "Bearer " + onlyAgy.key, "content-type": "application/json" };
  const both = createApiKey({ channelAllowlist: [agyChannel.id, claudeChannel.id] });
  const apiKey = { id: both.id, name: "Gemini-only probe", prefix: both.prefix, scopes: ["relay"],
    channelAllowlist: [agyChannel.id, claudeChannel.id], modelAllowlist: [], tokenLimitDaily: null };
  const blockedModels = ["claude-opus-5-5", "anthropic/claude-opus-5-5", "gpt-oss-120b", "openai/gpt-oss-120b"];
  let googleCalls = 0;
  globalThis.fetch = async () => { googleCalls++; assert.fail("unsupported AGY model must not reach Google"); };
  for (const catalog of [null, [model, "claude-opus-5-5-high", "gpt-oss-120b-medium"]]) {
    if (catalog) replaceAntigravityModels(agy.id, catalog);
    for (const allowlist of [[], [model, ...blockedModels]]) {
      // Simulate persisted pre-upgrade configuration without going through the new validation.
      updateChannel(agyChannel.id, { modelAllowlist: allowlist });
      const listed = await getModels(request("/v1/models", undefined, headers));
      assert.equal(listed.status, 200);
      assert.deepEqual((await listed.json()).data.map(item => item.id), catalog || allowlist.length ? [model] : []);
      for (const blocked of blockedModels) {
        for (const [handler, pathname, body] of [
          [postResponses, "/v1/responses", { input: "Hi" }],
          [postChat, "/v1/chat/completions", { messages: [{ role: "user", content: "Hi" }] }],
          [postMessages, "/v1/messages", { max_tokens: 10, messages: [{ role: "user", content: "Hi" }] }],
          [postCountTokens, "/v1/messages/count_tokens", { messages: [{ role: "user", content: "Hi" }] }],
        ]) {
          const rejected = await handler(request(pathname, { model: blocked, ...body }, headers));
          assert.equal(rejected.status, 503, pathname + " must not send " + blocked + " to AGY");
        }
      }
      for (const requested of ["claude-opus-5-5", "anthropic/claude-opus-5-5"]) {
        for (const operation of ["responses", "chat", "messages", "count_tokens"]) {
          assert.equal(selectChannelForRequest({ model: requested, operation, apiKey }).channel.id, claudeChannel.id);
        }
      }
      assert.equal(selectChannelForRequest({ model: "google/" + model, operation: "responses", apiKey }).channel.id, agyChannel.id);
    }
  }
  assert.equal(googleCalls, 0);
});
