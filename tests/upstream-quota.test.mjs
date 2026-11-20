import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
    if (specifier === "@/src/server/repositories/quota") return {
      url: "data:text/javascript,export function getCodexQuotaCacheByCredentialId() { throw new Error('API keys must not read OAuth quota storage'); }",
      shortCircuit: true,
    };
    if (specifier.startsWith("@/")) return nextResolve(new URL(specifier.slice(2) + ".ts", root).href, context);
    return nextResolve(specifier, context);
  },
});
const { accountQuotaHeaders, withAccountQuotaHeaders } = await import("../src/server/http/accountQuota.ts");
const { addCorsHeaders, corsPreflightResponse } = await import("../src/server/http/cors.ts");
const now = Date.parse("2026-11-06T12:00:00Z");

function limits() {
  return new Headers({
    "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "80", "x-ratelimit-reset-requests": "6m0s",
    "x-ratelimit-limit-tokens": "1000", "x-ratelimit-remaining-tokens": "400", "x-ratelimit-reset-tokens": "1500ms",
  });
}

test("OpenAI request/token rate limits and relative durations are not subscription balances", () => {
  const source = limits();
  source.set("anthropic-ratelimit-unified-5h-utilization", "0.9");
  const headers = accountQuotaHeaders("openai", randomUUID(), source, now);
  assert.equal(headers.get("x-relay-quota-provider"), "openai");
  assert.equal(headers.get("x-relay-quota-source"), "upstream");
  assert.equal(headers.get("x-relay-quota-requests-remaining"), "80");
  assert.equal(headers.get("x-relay-quota-requests-remaining-percent"), "80");
  assert.equal(headers.get("x-relay-quota-tokens-remaining-percent"), "40");
  assert.equal(headers.get("x-relay-quota-requests-reset-at"), "2026-11-06T12:06:00.000Z");
  assert.equal(headers.get("x-relay-quota-tokens-reset-at"), "2026-11-06T12:00:01.500Z");
  assert.equal(headers.get("x-relay-quota-5h-remaining-percent"), null);
  assert.equal(headers.get("x-relay-quota-7d-remaining-percent"), null);
});

test("Anthropic API request and cache-token limits retain their own metric names", () => {
  const headers = accountQuotaHeaders("anthropic", randomUUID(), new Headers({
    "anthropic-ratelimit-requests-limit": "100", "anthropic-ratelimit-requests-remaining": "75",
    "anthropic-ratelimit-requests-reset": "2026-11-06T12:01:00Z",
    "anthropic-ratelimit-cache-creation-input-tokens-limit": "2000",
    "anthropic-ratelimit-cache-creation-input-tokens-remaining": "500",
    "anthropic-ratelimit-unified-5h-utilization": "0.8",
  }), now);
  assert.equal(headers.get("x-relay-quota-provider"), "anthropic");
  assert.equal(headers.get("x-relay-quota-requests-remaining-percent"), "75");
  assert.equal(headers.get("x-relay-quota-requests-reset-at"), "2026-11-06T12:01:00.000Z");
  assert.equal(headers.get("x-relay-quota-cache-creation-input-tokens-remaining-percent"), "25");
  assert.equal(headers.get("x-relay-quota-5h-remaining-percent"), null);
});

test("API quota caches are provider/key isolated and drop individually expired windows", () => {
  const id = randomUUID();
  accountQuotaHeaders("openai", id, limits(), now);
  const cached = accountQuotaHeaders("openai", id, new Headers(), now + 2000);
  assert.equal(cached.get("x-relay-quota-source"), "cache");
  assert.equal(cached.get("x-relay-quota-requests-remaining"), "80");
  assert.equal(cached.get("x-relay-quota-tokens-remaining"), null);
  assert.equal(cached.get("x-ratelimit-limit-requests"), null);
  for (const [provider, credential] of [["anthropic", id], ["openai", randomUUID()]]) {
    const empty = accountQuotaHeaders(provider, credential, new Headers(), now + 2000);
    assert.equal(empty.get("x-relay-quota-source"), "unavailable");
    assert.equal(empty.get("x-relay-quota-requests-remaining"), null);
  }
  assert.equal(accountQuotaHeaders("openai", id, new Headers(), now + 300001).get("x-relay-quota-source"), "unavailable");
});

test("API response headers reject forged Relay quota and expose rate limits, request IDs and retry-after via CORS", async () => {
  const response = addCorsHeaders(withAccountQuotaHeaders(new Response("data: test\n\n", {
    status: 429, headers: {
      ...Object.fromEntries(limits()), "content-type": "text/event-stream", "retry-after": "37", "x-request-id": "synthetic-request",
      "x-relay-quota-provider": "forged", "x-relay-quota-fake-remaining-percent": "100",
    },
  }), "openai", randomUUID()));
  assert.equal(response.status, 429);
  assert.equal(await response.text(), "data: test\n\n");
  assert.equal(response.headers.get("x-relay-quota-provider"), "openai");
  assert.equal(response.headers.get("x-relay-quota-fake-remaining-percent"), null);
  const exposed = response.headers.get("access-control-expose-headers").toLowerCase().split(/,\s*/);
  for (const name of ["retry-after", "x-request-id", "x-ratelimit-remaining-requests", "x-relay-quota-provider"]) {
    assert.ok(exposed.includes(name));
  }
  const allowed = corsPreflightResponse().headers.get("access-control-allow-headers").toLowerCase();
  assert.ok(allowed.includes("anthropic-version"));
  assert.ok(allowed.includes("anthropic-beta"));
});
