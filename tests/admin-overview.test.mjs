import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Admin overview statistics on a synthetic log database; expectations are worked out by hand.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-admin-overview-"));
process.env.DATA_DIR = dataDir;
process.env.RELAY_MAIN_DB_PATH = path.join(dataDir, "main.sqlite");
process.env.RELAY_LOG_DB_PATH = path.join(dataDir, "logs.sqlite");
process.env.RELAY_ENCRYPTION_KEY = "synthetic-overview-test-secret";
process.env.RELAY_IMPORT_LEGACY_CREDENTIALS = "0";
const projectRoot = new URL("../", import.meta.url);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  if (specifier.startsWith("@/")) return nextResolve(new URL(specifier.slice(2) + ".ts", projectRoot).href, context);
  return nextResolve(specifier, context);
} });

const { appendRequestLog, appendRequestLogDetail, getAdminOverviewStats } = await import("../src/server/repositories/logs.ts");
const { getLogDb } = await import("../src/server/db/sqlite.ts");

const day = (offset) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const stage = (name, startedAtMs) => ({ name, label: name, startedAtMs, endedAtMs: startedAtMs, durationMs: 0 });

function log({ at, model = "m", latencyMs, status = 200, tokens = 10, apiKeyId = "key-a", channelId = "ch-1", timings }) {
  const id = appendRequestLog({
    startedAt: at, completedAt: at, method: "POST", path: "/v1/responses", requestType: "responses",
    stream: true, model, statusCode: status, latencyMs, apiKeyId, apiKeyPrefix: apiKeyId && apiKeyId + "-p",
    apiKeyName: apiKeyId && apiKeyId.toUpperCase(), channelId, channelName: channelId && "Channel " + channelId,
    usage: { promptTokens: tokens, completionTokens: 0, totalTokens: tokens, cachedTokens: Math.floor(tokens / 2) },
  });
  if (timings) appendRequestLogDetail(id, { stageTimings: timings });
}

test("overview groups, p95 samples and first-token latency follow the documented rules", async () => {
  // Model "big": 1200 requests today, latency = its index (oldest 0 ... newest 1199).
  // p95 uses only the newest 1000 (latencies 200..1199): index ceil(1000*0.95)-1 = 949 -> 1149.
  const today = day(0);
  for (let i = 0; i < 1200; i++) {
    const at = `${today}T00:00:${String(Math.floor(i / 100)).padStart(2, "0")}.${String(i % 100).padStart(3, "0")}Z`;
    log({ at, model: "big", latencyMs: i, tokens: 1 });
  }
  // Model "ft": first-token prefers stream_first_token over stream_first_chunk, else falls back.
  const yesterday = day(1);
  log({ at: `${yesterday}T01:00:00.000Z`, model: "ft", latencyMs: 50, tokens: 500, timings: [stage("stream_first_chunk", 30), stage("stream_first_token", 40)] });
  log({ at: `${yesterday}T02:00:00.000Z`, model: "ft", latencyMs: 70, status: 502, tokens: 500, timings: [stage("stream_first_chunk", 20)] });
  log({ at: `${yesterday}T03:00:00.000Z`, model: "ft", latencyMs: 90, tokens: 500, timings: [stage("upstream_fetch", 5)] });
  // No API key and no channel: grouped under the empty key, like COALESCE(col, '').
  log({ at: `${yesterday}T04:00:00.000Z`, model: "ft", latencyMs: 10, tokens: 1, apiKeyId: null, channelId: null });
  // Outside the 30-day window: counted in totals only.
  log({ at: `${day(40)}T00:00:00.000Z`, model: "old", latencyMs: 99999, tokens: 7 });

  const stats = await getAdminOverviewStats();

  assert.equal(stats.totals.requestCount, 1205);
  assert.equal(stats.totals.totalTokens, 1200 + 1500 + 1 + 7);
  assert.equal(stats.totals.errorCount, 1);
  assert.equal(stats.totals.firstRequestAt, `${day(40)}T00:00:00.000Z`);
  // Window-wide p95 over the newest 1000 requests: all from "big" today -> 1149.
  assert.equal(stats.totals.p95LatencyMs, 1149);
  // First-token samples come from the newest 500 requests, none of which has timings.
  assert.equal(stats.totals.avgFirstTokenLatencyMs, 0);

  // Ordered by total tokens: "ft" (1501) before "big" (1200); "old" is outside the window.
  assert.deepEqual(stats.byModel.map((row) => row.label), ["ft", "big"]);
  const ft = stats.byModel[0];
  assert.equal(ft.requestCount, 4);
  assert.equal(ft.successCount, 3);
  assert.equal(ft.errorCount, 1);
  assert.equal(ft.avgLatencyMs, 55); // (50 + 70 + 90 + 10) / 4
  assert.equal(ft.p95LatencyMs, 90); // sorted 10,50,70,90 -> index ceil(3.8)-1 = 3
  assert.equal(ft.avgFirstTokenLatencyMs, 30); // 40 (first_token wins) and 20 (chunk fallback)
  assert.equal(ft.p95FirstTokenLatencyMs, 40);
  assert.equal(ft.cacheHitRate, 49.97); // 750 cached / 1501 prompt
  const big = stats.byModel[1];
  assert.equal(big.requestCount, 1200);
  assert.equal(big.p95LatencyMs, 1149);
  assert.equal(big.firstRequestAt, `${today}T00:00:00.000Z`);
  assert.equal(big.lastRequestAt, `${today}T00:00:11.099Z`);

  const noKey = stats.byApiKey.find((row) => row.apiKeyId === "");
  assert.equal(noKey.requestCount, 1);
  assert.equal(noKey.label, "未知 Key");
  const noChannel = stats.byChannel.find((row) => row.key === "未记录");
  assert.equal(noChannel.requestCount, 1);
  assert.equal(noChannel.p95LatencyMs, 10);

  const keyModel = stats.byApiKeyModel.find((row) => row.apiKeyId === "key-a" && row.model === "ft");
  assert.equal(keyModel.requestCount, 3);
  assert.equal(keyModel.apiKeyName, "KEY-A");
  assert.equal(keyModel.p95FirstTokenLatencyMs, 40);

  assert.deepEqual(stats.byDay.map((row) => [row.date, row.requestCount]), [[today, 1200], [yesterday, 4]]);
  assert.equal(stats.byDay[1].p95LatencyMs, 90);
  assert.equal(stats.byDay[1].avgFirstTokenLatencyMs, 30);
});

test("concurrent overview requests share one computation and the cache", async () => {
  getLogDb().exec("DELETE FROM request_logs");
  const [first, second] = await Promise.all([getAdminOverviewStats(), getAdminOverviewStats()]);
  assert.equal(first, second);
});
