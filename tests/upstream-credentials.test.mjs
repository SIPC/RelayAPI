import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { after, afterEach, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-upstream-credentials-"));
process.env.DATA_DIR = dataDir;
process.env.RELAY_MAIN_DB_PATH = path.join(dataDir, "main.sqlite");
process.env.RELAY_LOG_DB_PATH = path.join(dataDir, "logs.sqlite");
process.env.RELAY_ENCRYPTION_KEY = "synthetic-upstream-test-encryption";
process.env.RELAY_WEB_ACCESS_KEY = "synthetic-upstream-web-access";
process.env.RELAY_IMPORT_LEGACY_CREDENTIALS = "0";
for (const name of ["RELAY_GLOBAL_SOCKS_PROXY", "RELAY_GLOBAL_PROXY", "CODEX_PROXY"]) delete process.env[name];
const projectRoot = new URL("../", import.meta.url);
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = () => { networkCalls++; throw new Error("These tests must not use the network"); };

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  if (specifier.startsWith("@/")) return nextResolve(new URL(specifier.slice(2) + ".ts", projectRoot).href, context);
  return nextResolve(specifier, context);
} });

function dbProcess(script, { legacy = false, directory = dataDir } = {}) {
  const code = `
    import fs from 'node:fs';
    import { registerHooks, stripTypeScriptTypes } from 'node:module';
    const root = ${JSON.stringify(projectRoot.href)};
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === 'server-only') return { url: 'data:text/javascript,export {};', shortCircuit: true };
        if (specifier.startsWith('@/')) return nextResolve(new URL(specifier.slice(2) + '.ts', root).href, context);
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        if (${legacy} && url === new URL('src/server/db/sqlite.ts', root).href) {
          const source = fs.readFileSync(new URL(url), 'utf8');
          const start = source.indexOf('  applyMigration(db, "010_api_upstream_credentials"');
          if (start < 0) throw new Error('Migration marker not found');
          // Run the actual pre-010 migrations, without copying their schema into this test.
          const legacySource = source.slice(0, start) + '}\\n\\n' + source.slice(source.indexOf('function migrateLogDb'));
          return { format: 'module', source: stripTypeScriptTypes(legacySource), shortCircuit: true };
        }
        return nextLoad(url, context);
      }
    });
    const { getMainDb, getLogDb } = await import(new URL('src/server/db/sqlite.ts', root));
    const db = getMainDb();
    ${script}
    getMainDb().close(); getLogDb().close();
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, DATA_DIR: directory,
      RELAY_MAIN_DB_PATH: path.join(directory, "main.sqlite"), RELAY_LOG_DB_PATH: path.join(directory, "logs.sqlite") },
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}

const snapshotScript = `
  const tables = ['channels', 'channel_credentials', 'codex_credentials', 'claude_credentials', 'api_keys', 'proxy_pool'];
  console.log(JSON.stringify(Object.fromEntries(tables.map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY 1, 2').all()]))));
`;
const legacySnapshot = dbProcess(`
  const { upsertCodexCredential } = await import(new URL('src/server/repositories/codexCredentials.ts', root));
  const { upsertClaudeCredential } = await import(new URL('src/server/repositories/claudeCredentials.ts', root));
  const tokens = { access_token: 'synthetic-oauth-access', refresh_token: 'synthetic-refresh', id_token: '', expired: '2099-01-01T00:00:00Z', last_refresh: '' };
  for (const id of ['legacy-codex-a', 'legacy-codex-b']) upsertCodexCredential({ id, email: 'legacy@example.invalid', accountId: id, planType: 'plus', tokens });
  upsertClaudeCredential({ id: 'legacy-claude', email: 'legacy@example.invalid', accountId: 'legacy-account', tokens });
  const now = '2025-01-02T03:04:05.000Z';
  for (const [id, provider, credential] of [['legacy-codex', 'codex', 'legacy-codex-a'], ['legacy-claude', 'claude', 'legacy-claude']]) {
    db.prepare("INSERT INTO channels (id,name,provider,base_url,credential_id,enabled,priority,weight,model_allowlist_json,status,health_score,cooldown_until,last_error,last_used_at,created_at,updated_at) VALUES (?,?,?,?,?,1,123,3,?,'degraded',72,?,?,?, ?,?)")
      .run(id, id, provider, provider === 'claude' ? 'https://api.anthropic.com' : 'https://chatgpt.com/backend-api/codex', credential, '["legacy-model"]', now, 'legacy-error', now, now, now);
    db.prepare('INSERT INTO channel_credentials VALUES (?,?,?)').run(id, credential, now);
  }
  db.prepare('INSERT INTO channel_credentials VALUES (?,?,?)').run('legacy-codex', 'legacy-codex-b', now);
  db.prepare('INSERT INTO api_keys (id,name,key_hash,prefix,scopes_json,model_allowlist_json,channel_allowlist_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('legacy-api-key','legacy','synthetic-hash','synthetic','[]','[]','["legacy-codex"]',now,now);
  db.exec('CREATE INDEX idx_channels_test_base ON channels(base_url)');
  db.exec('CREATE INDEX idx_channel_credentials_test_created ON channel_credentials(created_at)');
  db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run('009_reserved_fixture', now);
  ${snapshotScript}
`, { legacy: true });

const dbModule = await import("../src/server/db/sqlite.ts");
const db = dbModule.getMainDb();
const logDb = dbModule.getLogDb();
const credentials = await import("../src/server/services/upstreamCredentials.ts");
const credentialRepo = await import("../src/server/repositories/upstreamCredentials.ts");
const channels = await import("../src/server/services/channels.ts");
const channelRepo = await import("../src/server/repositories/channels.ts");
const codexRepo = await import("../src/server/repositories/codexCredentials.ts");
const claudeRepo = await import("../src/server/repositories/claudeCredentials.ts");
const { createProxyPoolItem, updateProxyPoolItem } = await import("../src/server/repositories/proxyPool.ts");
const { patchGlobalSettings } = await import("../src/server/services/settings.ts");
const { decryptJson } = await import("../src/server/services/crypto.ts");
const web = await import("../src/server/services/webAccess.ts");
const collectionRoute = await import("../app/api/admin/upstream-credentials/route.ts");
const itemRoute = await import("../app/api/admin/upstream-credentials/[id]/route.ts");

function apiKey(channelAllowlist = [], modelAllowlist = []) {
  return { id: "synthetic-relay-key", name: "test", prefix: "test", scopes: ["*"],
    channelAllowlist, modelAllowlist, tokenLimitDaily: null };
}
function upstream(provider = "openai", input = {}) {
  return credentials.createUpstreamCredential({ provider, apiKey: "sk-synthetic-upstream-" + randomUUID(), ...input });
}
function apiChannel(provider = "openai", input = {}) {
  const credential = upstream(provider);
  const channel = channels.createChannel({ provider, credentialId: credential.id,
    modelAllowlist: ["custom-model"], enabled: true, ...input });
  return { credential, channel };
}
function oauth(provider = "codex", input = {}) {
  const id = "synthetic-oauth-" + randomUUID();
  const record = { id, email: "test@example.invalid", accountId: id, planType: "plus",
    tokens: { access_token: "synthetic-oauth-access", refresh_token: "synthetic-refresh", id_token: "",
      expired: "2099-01-01T00:00:00Z", last_refresh: "" } };
  if (provider === "codex") codexRepo.upsertCodexCredential(record);
  else claudeRepo.upsertClaudeCredential(record);
  return channels.createChannel({ provider, credentialId: id, ...input });
}
function select(operation, model, key = apiKey()) {
  return channels.selectChannelForRequest({ operation, model, apiKey: key });
}
function rejectsCode(fn, code, status) {
  assert.throws(fn, (error) => error.code === code && (status === undefined || error.status === status));
}
function unavailable(operation, model, key) {
  rejectsCode(() => select(operation, model, key), "no_available_channel", 503);
}
function publicOnly(record, secrets = []) {
  const text = JSON.stringify(record);
  for (const key of ["apiKey", "key_envelope", "keyEnvelope", "proxy_envelope", "password", "tokens"]) assert.ok(!Object.hasOwn(record, key), key);
  if (record.proxy) assert.ok(!Object.hasOwn(record.proxy, "password"));
  for (const secret of secrets) assert.ok(!text.includes(secret), "Public record leaked a secret");
  return record;
}

afterEach(() => {
  for (const table of ["channels", "upstream_credentials", "codex_credentials", "claude_credentials", "api_keys", "proxy_pool", "settings"]) db.exec("DELETE FROM " + table);
  for (const table of ["channel_health_events", "request_logs", "usage_records", "usage_daily_buckets"]) logDb.exec("DELETE FROM " + table);
});
after(() => {
  assert.equal(networkCalls, 0);
  globalThis.fetch = originalFetch;
  db.close(); logDb.close();
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dataDir).startsWith("relay-upstream-credentials-"));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("010 upgrades legacy data after the reserved 009 marker, preserving associations, indexes and FKs", () => {
  for (const [table, rows] of Object.entries(legacySnapshot)) {
    const actual = db.prepare("SELECT * FROM " + table + " ORDER BY 1, 2").all().map((row) => {
      const copy = { ...row };
      if (table === "channels") {
        assert.equal(copy.quota_weighted, 0);
        delete copy.quota_weighted;
        delete copy.capabilities_json;
      }
      return copy;
    });
    assert.deepEqual(actual, rows, table);
  }
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  const names = db.prepare("SELECT name FROM schema_migrations ORDER BY rowid").all().map((row) => row.name);
  assert.ok(names.indexOf("010_api_upstream_credentials") > names.indexOf("009_reserved_fixture"));
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name));
  for (const name of ["idx_channels_credential", "idx_channels_routing", "idx_channel_credentials_credential", "idx_channels_test_base", "idx_channel_credentials_test_created", "idx_upstream_credentials_routing"]) assert.ok(indexes.has(name), name);
  assert.deepEqual(channelRepo.getChannelById("legacy-claude").capabilities, ["chat", "responses", "messages", "count_tokens"]);
  assert.deepEqual(channelRepo.getChannelById("legacy-codex").capabilities, ["chat", "responses", "images_generations", "images_edits"]);
  assert.equal(channelRepo.getChannelById("legacy-codex").credentialIds.length, 2);
  assert.throws(() => db.prepare("UPDATE channels SET provider = 'unknown'").run(), /CHECK/);
  assert.deepEqual(dbProcess(snapshotScript), Object.fromEntries(Object.keys(legacySnapshot).map((table) => [table, JSON.parse(JSON.stringify(db.prepare("SELECT * FROM " + table + " ORDER BY 1, 2").all()))])));
  channelRepo.deleteChannel("legacy-codex");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM channel_credentials WHERE channel_id = ?").get("legacy-codex").n, 0);
});

test("fresh databases and repeated initialization apply 010 exactly once", () => {
  const directory = fs.mkdtempSync(path.join(dataDir, "fresh-"));
  const script = `console.log(JSON.stringify({ migrations: db.prepare("SELECT name FROM schema_migrations WHERE name = '010_api_upstream_credentials'").all(), columns: db.prepare('PRAGMA table_info(channels)').all().map(row => row.name), foreignKeys: db.prepare('PRAGMA foreign_key_check').all() }));`;
  const first = dbProcess(script, { directory });
  const second = dbProcess(script, { directory });
  assert.deepEqual(first, second);
  assert.equal(first.migrations.length, 1);
  assert.ok(first.columns.includes("capabilities_json"));
  assert.deepEqual(first.foreignKeys, []);
});

test("credential creation encrypts keys and proxy secrets without reflecting plaintext or envelopes", () => {
  for (const provider of ["openai", "anthropic"]) {
    const apiSecret = "sk-synthetic-private-key-" + randomUUID();
    const proxySecret = "synthetic-proxy-password";
    const created = upstream(provider, { apiKey: apiSecret, name: " test ", proxy: "socks5h://user:" + proxySecret + "@127.0.0.1:1080" });
    const row = db.prepare("SELECT * FROM upstream_credentials WHERE id = ?").get(created.id);
    assert.equal(JSON.parse(row.key_envelope).alg, "aes-256-gcm");
    assert.equal(decryptJson(row.key_envelope), apiSecret);
    assert.ok(!JSON.stringify(row).includes(apiSecret));
    assert.ok(!JSON.stringify(row).includes(proxySecret));
    const privateRecord = credentialRepo.getUpstreamCredentialWithSecret(created.id);
    assert.equal(privateRecord.apiKey, apiSecret);
    assert.equal(privateRecord.proxy.password, proxySecret);
    assert.equal(created.keySet, true);
    assert.equal(created.name, "test");
    assert.equal(created.proxy.passwordSet, true);
    publicOnly(created, [apiSecret, proxySecret, row.key_envelope, row.proxy_envelope]);
    publicOnly(credentialRepo.listUpstreamCredentials(provider)[0], [apiSecret, proxySecret]);
    publicOnly(credentials.listPublicUpstreamCredentials().find((item) => item.id === created.id), [apiSecret, proxySecret]);
  }
  const short = upstream("openai", { apiKey: "x" });
  assert.equal(short.keyPrefix, "…");
  assert.equal(credentialRepo.getUpstreamCredentialWithSecret("missing"), null);
});

test("credential validation rejects unsupported providers, missing keys, multiline keys and invalid input", () => {
  for (const input of [null, [], "key"]) rejectsCode(() => credentials.createUpstreamCredential(input), "invalid_upstream_credential", 400);
  rejectsCode(() => upstream("codex"), "invalid_upstream_provider", 400);
  rejectsCode(() => upstream("openai", { apiKey: " " }), "missing_upstream_api_key", 400);
  for (const value of [undefined, null, 123, "sk-one\r\nsk-two"]) rejectsCode(() => upstream("openai", { apiKey: value }), "invalid_upstream_api_key", 400);
  rejectsCode(() => credentials.patchUpstreamCredential("missing", {}), "upstream_credential_not_found", 404);
  rejectsCode(() => credentials.removeUpstreamCredential("missing"), "upstream_credential_not_found", 404);
});

test("blank key patches preserve ciphertext; rotations and routing patches return only public records", () => {
  const created = upstream();
  const original = credentialRepo.getUpstreamCredentialWithSecret(created.id).apiKey;
  const envelope = db.prepare("SELECT key_envelope FROM upstream_credentials WHERE id = ?").get(created.id).key_envelope;
  for (const apiSecret of [undefined, "", "   ", "\r\n\t"]) {
    const updated = credentials.patchUpstreamCredential(created.id, { apiKey: apiSecret, name: "renamed", enabled: false, priority: 300, weight: 0, useGlobalProxy: true });
    publicOnly(updated, [original, envelope]);
    assert.equal(updated.name, "renamed"); assert.equal(updated.weight, 1);
    assert.equal(updated.enabled, false); assert.equal(updated.priority, 300); assert.equal(updated.useGlobalProxy, true);
    assert.equal(db.prepare("SELECT key_envelope FROM upstream_credentials WHERE id = ?").get(created.id).key_envelope, envelope);
  }
  rejectsCode(() => credentials.patchUpstreamCredential(created.id, { provider: "anthropic" }), "upstream_provider_immutable", 400);
  const rotated = "sk-rotated-synthetic-" + randomUUID();
  publicOnly(credentials.patchUpstreamCredential(created.id, { apiKey: " " + rotated + " " }), [original, rotated]);
  assert.equal(credentialRepo.getUpstreamCredentialWithSecret(created.id).apiKey, rotated);
  assert.notEqual(db.prepare("SELECT key_envelope FROM upstream_credentials WHERE id = ?").get(created.id).key_envelope, envelope);
  assert.equal(credentialRepo.updateUpstreamCredential("missing", {}), null);
});

test("proxy precedence remains credential > enabled pool > opted-in global, with private secrets retained", () => {
  const pool = createProxyPoolItem({ name: "pool", enabled: true, type: "socks5h", host: "pool.invalid", port: 1081, username: "pool-user", password: "pool-secret", notes: "" });
  patchGlobalSettings({ proxy: { enabled: true, type: "socks5", host: "global.invalid", port: 1082, username: "global-user", password: "global-secret" } });
  const created = upstream("anthropic", { proxyPoolId: pool.id, useGlobalProxy: true,
    proxy: { type: "socks5", host: "own.invalid", port: 1080, username: "own", password: "own-secret" } });
  const resolve = () => credentials.resolveUpstreamCredentialProxy(credentialRepo.getUpstreamCredentialWithSecret(created.id));
  assert.equal(resolve().host, "own.invalid");
  credentials.patchUpstreamCredential(created.id, { proxy: { enabled: false } });
  assert.equal(resolve().password, "pool-secret");
  assert.ok(db.prepare("SELECT last_used_at FROM proxy_pool WHERE id = ?").get(pool.id).last_used_at);
  updateProxyPoolItem(pool.id, { enabled: false });
  assert.equal(resolve().host, "global.invalid");
  credentials.patchUpstreamCredential(created.id, { useGlobalProxy: false });
  assert.equal(resolve(), null);
  credentials.patchUpstreamCredential(created.id, { proxy: { enabled: true } });
  assert.equal(resolve().password, "own-secret");
  publicOnly(credentials.patchUpstreamCredential(created.id, { proxy: { host: "new-own.invalid" } }), ["own-secret"]);
  assert.equal(resolve().password, "own-secret");
  credentials.patchUpstreamCredential(created.id, { proxy: null, proxyPoolId: null });
  assert.equal(resolve(), null);
  rejectsCode(() => credentials.patchUpstreamCredential(created.id, { proxyPoolId: "missing" }), "proxy_pool_not_found", 400);
  rejectsCode(() => credentials.patchUpstreamCredential(created.id, { proxy: "http://proxy.invalid:1080" }), "unsupported_credential_proxy_type", 400);
  rejectsCode(() => credentials.patchUpstreamCredential(created.id, { proxy: { host: "own.invalid", port: 0 } }), "invalid_credential_proxy_port", 400);
});

test("channel CRUD exposes editable provider-specific capabilities, safe bases and disabled API defaults", () => {
  for (const provider of ["openai", "anthropic"]) {
    const credential = upstream(provider);
    const created = channels.createChannel({ provider, credentialId: credential.id, modelAllowlist: ["custom-model"] });
    assert.equal(created.enabled, false);
    assert.equal(created.baseUrl, provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com/v1");
    assert.ok(created.capabilities.length);
    const operation = provider === "openai" ? "responses" : "messages";
    assert.deepEqual(channels.patchChannel(created.id, { capabilities: [operation, operation], enabled: true }).capabilities, [operation]);
    assert.deepEqual(channelRepo.getChannelByCredentialId(credential.id, provider).capabilities, [operation]);
    assert.deepEqual(channels.patchChannel(created.id, { capabilities: [] }).capabilities, []);
    rejectsCode(() => channels.patchChannel(created.id, { capabilities: [provider === "openai" ? "messages" : "images_edits"] }), "invalid_channel_capabilities", 400);
    rejectsCode(() => channels.patchChannel(created.id, { provider: provider === "openai" ? "anthropic" : "openai" }), "channel_provider_immutable", 400);
    rejectsCode(() => channels.patchChannel(created.id, { modelAllowlist: [] }), "missing_channel_models", 400);
    rejectsCode(() => channels.createChannel({ provider, credentialId: credential.id }), "missing_channel_models", 400);
    const wrongProvider = provider === "openai" ? "anthropic" : "openai";
    rejectsCode(() => channels.createChannel({ provider: wrongProvider, credentialId: credential.id, modelAllowlist: ["model"] }), wrongProvider + "_credential_not_found", 400);
  }
  const claude = oauth("claude");
  assert.equal(claude.baseUrl, process.env.CLAUDE_BASE_URL?.replace(/\/+$/, "") || "https://api.anthropic.com");
  assert.equal(claude.enabled, true);
  assert.deepEqual(claude.capabilities, ["chat", "responses", "messages", "count_tokens"]);
  for (const provider of ["codex", "claude", "openai", "anthropic"]) {
    const channel = provider === "codex" || provider === "claude" ? oauth(provider) : apiChannel(provider).channel;
    for (const baseUrl of ["ftp://host.invalid/v1", "file:///tmp/a", "https://user:password@host.invalid/v1", "https://user@host.invalid", "https://host.invalid/v1?key=secret", "https://host.invalid/v1#hash", "https://host.invalid/v1?", "https://host.invalid/v1#", "not-a-url"]) {
      rejectsCode(() => channels.patchChannel(channel.id, { baseUrl }), "invalid_channel_base_url", 400);
    }
    assert.equal(channels.patchChannel(channel.id, { baseUrl: "https://host.invalid/custom/v1/" }).baseUrl, "https://host.invalid/custom/v1");
  }
  assert.ok(channelRepo.listChannels().every((channel) => Array.isArray(channel.capabilities)));
});

test("credential deletion detaches multi-credential channels and removes empty channels without touching OAuth", () => {
  const first = upstream(); const second = upstream();
  const channel = channels.createChannel({ provider: "openai", credentialIds: [first.id, second.id], modelAllowlist: ["custom-model"] });
  const old = oauth();
  credentials.removeUpstreamCredential(first.id);
  assert.equal(credentialRepo.getUpstreamCredentialWithSecret(first.id), null);
  assert.deepEqual(channelRepo.getChannelById(channel.id).credentialIds, [second.id]);
  credentials.removeUpstreamCredential(second.id);
  assert.equal(channelRepo.getChannelById(channel.id), null);
  assert.ok(channelRepo.getChannelById(old.id));
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("empty relay channel allowlists remain OAuth-only; paid channels require explicit authorization", () => {
  const old = oauth("codex", { priority: 1 });
  const paid = apiChannel("openai", { priority: 1000 });
  assert.equal(select("chat", "custom-model").channel.id, old.id);
  assert.equal(select("responses", "custom-model", apiKey([old.id])).channel.id, old.id);
  const key = apiKey([old.id, paid.channel.id]);
  const selected = select("chat", "custom-model", key);
  assert.equal(selected.channel.id, paid.channel.id);
  assert.equal(selected.credential.apiKey, credentialRepo.getUpstreamCredentialWithSecret(paid.credential.id).apiKey);
  assert.ok(!Object.hasOwn(selected.credential, "tokens"));
  channels.patchChannel(paid.channel.id, { enabled: false });
  assert.equal(select("chat", "custom-model", key).channel.id, old.id);
  unavailable("chat", "custom-model", apiKey([paid.channel.id]));
});

test("API models match exactly, never inheriting OAuth thinking suffixes or empty model wildcards", () => {
  const paid = apiChannel("openai", { modelAllowlist: ["gpt-test"], capabilities: ["responses"] });
  const key = apiKey([paid.channel.id], ["gpt-test"]);
  assert.equal(select("responses", "gpt-test", key).channel.id, paid.channel.id);
  unavailable("chat", "gpt-test", key);
  unavailable("responses", "gpt-test(high)", key);
  unavailable("responses", "GPT-test", apiKey([paid.channel.id]));
  rejectsCode(() => select("responses", "gpt-test", apiKey([paid.channel.id], ["other-model"])), "model_not_allowed", 403);
  channels.patchChannel(paid.channel.id, { modelAllowlist: ["gpt-test(high)"] });
  unavailable("responses", "gpt-test(high)", key);
  assert.equal(select("responses", "gpt-test(high)", apiKey([paid.channel.id], ["gpt-test(high)"])).channel.id, paid.channel.id);
  channelRepo.updateChannel(paid.channel.id, { modelAllowlist: [] });
  unavailable("responses", "gpt-test", apiKey([paid.channel.id]));
  const old = oauth("codex", { modelAllowlist: ["gpt-test"] });
  assert.equal(select("responses", "gpt-test(high)", apiKey([old.id], ["gpt-test"])).channel.id, old.id);
});

for (const [provider, oauthProvider, baseModel, suffixedModel, operations] of [
  ["openai", "codex", "gpt-test", "gpt-test(high)", ["chat", "responses"]],
  ["anthropic", "claude", "claude-sonnet-test", "claude-sonnet-test(1m)(high)", ["chat", "responses", "messages", "count_tokens"]],
]) {
  test(provider + " API model authorization cannot be bypassed by OAuth suffix candidates", () => {
    const paid = apiChannel(provider, { modelAllowlist: [suffixedModel], priority: 10000 });
    const old = oauth(oauthProvider, { modelAllowlist: [baseModel], priority: 1 });
    const baseOnlyKey = apiKey([paid.channel.id], [baseModel]);
    for (const operation of operations) unavailable(operation, suffixedModel, baseOnlyKey);
    assert.equal(channelRepo.getChannelById(paid.channel.id).lastUsedAt, null);
    assert.equal(credentialRepo.getUpstreamCredentialWithSecret(paid.credential.id).lastUsedAt, null);

    const mixedKey = apiKey([old.id, paid.channel.id], [baseModel]);
    for (const operation of ["chat", "responses"]) {
      assert.equal(select(operation, suffixedModel, mixedKey).channel.id, old.id);
    }
    assert.equal(channelRepo.getChannelById(paid.channel.id).lastUsedAt, null);
    assert.equal(credentialRepo.getUpstreamCredentialWithSecret(paid.credential.id).lastUsedAt, null);

    const exactKey = apiKey([paid.channel.id], [suffixedModel]);
    for (const operation of operations) {
      assert.equal(select(operation, suffixedModel, exactKey).channel.id, paid.channel.id);
    }
    assert.equal(select("responses", suffixedModel, apiKey([paid.channel.id])).channel.id, paid.channel.id);
    channels.patchChannel(paid.channel.id, { modelAllowlist: [baseModel] });
    for (const operation of operations) unavailable(operation, suffixedModel, exactKey);
  });
}

test("OAuth request routing retains Claude prefix families and independently gates capabilities", () => {
  const codex = oauth(); const claude = oauth("claude");
  for (const operation of ["chat", "responses"]) {
    assert.equal(select(operation, "claude-sonnet-test").channel.id, claude.id);
    assert.equal(select(operation, "ClAuDe-sonnet-test").channel.id, claude.id);
    assert.equal(select(operation, "non-claude-model").channel.id, codex.id);
  }
  assert.equal(select("messages", "claude-sonnet-test").channel.id, claude.id);
  assert.equal(select("count_tokens", "claude-sonnet-test").channel.id, claude.id);
  // Codex serves Claude Messages and token counting through its Responses capability (Claude Code over Codex).
  assert.equal(select("messages", "gpt-test").channel.id, codex.id);
  assert.equal(select("count_tokens", "gpt-test").channel.id, codex.id);
  channels.patchChannel(codex.id, { capabilities: ["chat"] });
  unavailable("messages", "gpt-test"); unavailable("count_tokens", "gpt-test");
  channels.patchChannel(claude.id, { capabilities: ["messages"] });
  unavailable("responses", "claude-sonnet-test");
  unavailable("count_tokens", "claude-sonnet-test");
  const suffixed = oauth("claude", { modelAllowlist: ["claude-sonnet-test"] });
  assert.equal(select("chat", "claude-sonnet-test(high)", apiKey([suffixed.id], ["claude-sonnet-test"])).channel.id, suffixed.id);
});

test("OAuth images are restricted to registered Codex image models, while paid image lists are exact", () => {
  const codex = oauth(); oauth("claude");
  for (const operation of ["images_generations", "images_edits"]) {
    assert.equal(select(operation, "gpt-image-2").channel.id, codex.id);
    unavailable(operation, "gpt-test"); unavailable(operation, "claude-sonnet-test");
    unavailable(operation, "gpt-image-not-registered"); unavailable(operation, "gpt-image-2(high)");
  }
  const paid = apiChannel("openai", { modelAllowlist: ["custom-image"], capabilities: ["images_generations"] });
  assert.equal(select("images_generations", "custom-image", apiKey([paid.channel.id])).channel.id, paid.channel.id);
  unavailable("images_edits", "custom-image", apiKey([paid.channel.id]));
  unavailable("images_generations", "custom-image");
});

test("Anthropic messages enables native/chat/responses conversion but token counting is independent", () => {
  const paid = apiChannel("anthropic", { capabilities: ["messages"], modelAllowlist: ["custom-model"] });
  const key = apiKey([paid.channel.id]);
  for (const operation of ["chat", "responses", "messages"]) {
    const selected = select(operation, "custom-model", key);
    assert.equal(selected.credential.provider, "anthropic");
    assert.equal(selected.channel.id, paid.channel.id);
  }
  unavailable("count_tokens", "custom-model", key);
  channels.patchChannel(paid.channel.id, { capabilities: ["count_tokens"] });
  assert.equal(select("count_tokens", "custom-model", key).channel.id, paid.channel.id);
  unavailable("messages", "custom-model", key); unavailable("chat", "custom-model", key);
  unavailable("images_generations", "custom-model", key);
});

test("selection filters disabled/cooling channels and credentials, then marks only the selected pair used", () => {
  const first = upstream("openai", { priority: 500 });
  const second = upstream("openai", { priority: 100 });
  const channel = channels.createChannel({ provider: "openai", credentialIds: [first.id, second.id], modelAllowlist: ["custom-model"], enabled: true });
  const key = apiKey([channel.id]);
  credentialRepo.updateUpstreamCredential(first.id, { cooldownUntil: "2099-01-01T00:00:00Z" });
  const selected = select("chat", "custom-model", key);
  assert.equal(selected.credential.id, second.id);
  assert.equal(selected.channel.credentialId, second.id);
  assert.ok(channelRepo.getChannelById(channel.id).lastUsedAt);
  assert.ok(credentialRepo.getUpstreamCredentialWithSecret(second.id).lastUsedAt);
  assert.equal(credentialRepo.getUpstreamCredentialWithSecret(first.id).lastUsedAt, null);
  credentialRepo.updateUpstreamCredential(second.id, { enabled: false });
  unavailable("chat", "custom-model", key);
  credentialRepo.updateUpstreamCredential(first.id, { cooldownUntil: "2000-01-01T00:00:00Z" });
  assert.equal(select("chat", "custom-model", key).credential.id, first.id);
  channels.patchChannel(channel.id, { cooldownUntil: "2099-01-01T00:00:00Z" });
  unavailable("chat", "custom-model", key);
  channels.patchChannel(channel.id, { cooldownUntil: null, status: "disabled" });
  unavailable("chat", "custom-model", key);
});

test("success/failure dispatch targets each provider's own store without falling through to Codex", () => {
  for (const provider of ["codex", "claude", "openai", "anthropic"]) {
    const channel = provider === "codex" || provider === "claude" ? oauth(provider) : apiChannel(provider).channel;
    const get = () => provider === "codex" ? codexRepo.getCodexCredentialWithTokens(channel.credentialId)
      : provider === "claude" ? claudeRepo.getClaudeCredentialWithTokens(channel.credentialId)
      : credentialRepo.getUpstreamCredentialWithSecret(channel.credentialId);
    for (const statusCode of [401, 403, 429]) {
      channels.recordChannelFailure(channel, { statusCode, message: "synthetic rate/auth failure" });
      assert.ok(Date.parse(get().cooldownUntil) > Date.now());
      assert.equal(get().lastError, "synthetic rate/auth failure");
      assert.equal(channelRepo.getChannelById(channel.id).healthScore, 100);
      channels.recordChannelSuccess(channel);
      assert.equal(get().cooldownUntil, null); assert.equal(get().lastError, null);
    }
    channels.recordChannelFailure(channel, { statusCode: 502, message: "synthetic server failure" });
    assert.equal(channelRepo.getChannelById(channel.id).healthScore, 85);
    assert.equal(get().cooldownUntil, null);
  }
  assert.equal(logDb.prepare("SELECT COUNT(*) AS n FROM channel_health_events WHERE event_type = 'credential_failure'").get().n, 12);
});

test("legacy selectChannel stays OAuth-only even with authorized higher-priority API channels", () => {
  const codex = oauth("codex", { priority: 1 });
  const claude = oauth("claude", { priority: 1 });
  const paid = apiChannel("openai", { priority: 10000 });
  const key = apiKey([codex.id, claude.id, paid.channel.id]);
  assert.equal(channels.selectChannel({ model: "custom-model", apiKey: key }).credential.provider, "codex");
  assert.equal(channels.selectChannel({ provider: "claude", model: "custom-model", apiKey: key }).credential.provider, "claude");
  assert.equal(channels.selectChannel({ provider: "openai", model: "custom-model", apiKey: key }).credential.provider, "codex");
  channelRepo.deleteChannel(codex.id);
  rejectsCode(() => channels.selectChannel({ model: "custom-model", apiKey: key }), "no_available_channel", 503);
});

function adminRequest(method, body, { authenticated = true, raw = false, id } = {}) {
  const cookie = web.WEB_SESSION_COOKIE + "=" + web.createWebSessionToken();
  return new Request("http://relay.invalid/api/admin/upstream-credentials" + (id ? "/" + id : ""), {
    method,
    headers: { "content-type": "application/json", ...(authenticated ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
  });
}
function routeContext(id) { return { params: Promise.resolve({ id }) }; }

test("admin handlers reject missing sessions before reading bodies or mutating credentials", async (t) => {
  t.mock.method(console, "error", () => {});
  const existing = upstream();
  const row = db.prepare("SELECT * FROM upstream_credentials WHERE id = ?").get(existing.id);
  for (const [handler, method] of [[collectionRoute.GET, "GET"], [collectionRoute.POST, "POST"], [itemRoute.PATCH, "PATCH"], [itemRoute.DELETE, "DELETE"]]) {
    const result = await handler(adminRequest(method, method === "GET" ? undefined : "not-json", {
      authenticated: false, raw: true, id: method === "PATCH" || method === "DELETE" ? existing.id : undefined,
    }), routeContext(existing.id));
    assert.equal(result.status, 401);
    assert.equal((await result.json()).error.code, "web_auth_required");
  }
  assert.deepEqual(db.prepare("SELECT * FROM upstream_credentials WHERE id = ?").get(existing.id), row);
  assert.equal(credentialRepo.listUpstreamCredentials().length, 1);
});

test("admin session CRUD returns list wrappers and redacts keys, ciphertext and proxy passwords", async (t) => {
  t.mock.method(console, "error", () => {});
  const initial = await collectionRoute.GET(adminRequest("GET"));
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { object: "list", data: [] });
  const records = [];
  const secrets = [];
  for (const provider of ["openai", "anthropic"]) {
    const secret = "sk-synthetic-route-secret-" + randomUUID();
    const password = "synthetic-proxy-password-" + randomUUID();
    const response = await collectionRoute.POST(adminRequest("POST", {
      provider, apiKey: secret, proxy: "socks5h://user:" + password + "@127.0.0.1:1080",
    }));
    assert.equal(response.status, 201);
    const body = await response.json();
    const row = db.prepare("SELECT * FROM upstream_credentials WHERE id = ?").get(body.id);
    secrets.push(secret, password, row.key_envelope, row.proxy_envelope);
    const created = publicOnly(body, secrets);
    assert.equal(created.provider, provider);
    assert.equal(created.keySet, true);
    assert.equal(created.proxy.passwordSet, true);
    assert.equal(credentialRepo.getUpstreamCredentialWithSecret(created.id).apiKey, secret);
    records.push({ id: created.id, provider, secret, envelope: row.key_envelope });
  }
  const listedResponse = await collectionRoute.GET(adminRequest("GET"));
  assert.equal(listedResponse.status, 200);
  const listed = publicOnly(await listedResponse.json(), secrets);
  assert.deepEqual(Object.keys(listed).sort(), ["data", "object"]);
  assert.equal(listed.object, "list");
  assert.equal(listed.data.length, 2);
  assert.deepEqual(listed.data.map((item) => item.id).sort(), records.map((item) => item.id).sort());
  for (const item of listed.data) publicOnly(item, secrets);

  for (const record of records) {
    const context = routeContext(record.id);
    const patched = await itemRoute.PATCH(adminRequest("PATCH", { apiKey: " ", name: "edited " + record.provider }, { id: record.id }), context);
    assert.equal(patched.status, 200);
    const updated = publicOnly(await patched.json(), secrets);
    assert.equal(updated.name, "edited " + record.provider);
    assert.equal(credentialRepo.getUpstreamCredentialWithSecret(record.id).apiKey, record.secret);
    assert.equal(db.prepare("SELECT key_envelope FROM upstream_credentials WHERE id = ?").get(record.id).key_envelope, record.envelope);

    const rotatedSecret = "sk-synthetic-rotated-route-secret-" + randomUUID();
    const rotatedResponse = await itemRoute.PATCH(adminRequest("PATCH", { apiKey: rotatedSecret }, { id: record.id }), context);
    assert.equal(rotatedResponse.status, 200);
    const rotatedRow = db.prepare("SELECT key_envelope FROM upstream_credentials WHERE id = ?").get(record.id);
    secrets.push(rotatedSecret, rotatedRow.key_envelope);
    publicOnly(await rotatedResponse.json(), secrets);
    assert.equal(credentialRepo.getUpstreamCredentialWithSecret(record.id).apiKey, rotatedSecret);
    assert.notEqual(rotatedRow.key_envelope, record.envelope);
    assert.equal((await itemRoute.PATCH(adminRequest("PATCH", {
      provider: record.provider === "openai" ? "anthropic" : "openai",
    }, { id: record.id }), context)).status, 400);
  }
  const editedList = await collectionRoute.GET(adminRequest("GET"));
  assert.equal(editedList.status, 200);
  const edited = publicOnly(await editedList.json(), secrets);
  assert.equal(edited.object, "list");
  assert.deepEqual(edited.data.map((item) => item.name).sort(), ["edited anthropic", "edited openai"]);
  for (const item of edited.data) publicOnly(item, secrets);

  assert.equal((await collectionRoute.POST(adminRequest("POST", "invalid-json", { raw: true }))).status, 400);
  assert.equal((await itemRoute.PATCH(adminRequest("PATCH", "invalid-json", { raw: true, id: records[0].id }), routeContext(records[0].id))).status, 400);
  assert.equal((await collectionRoute.POST(adminRequest("POST", []))).status, 400);
  for (const { id } of records) {
    const deleted = await itemRoute.DELETE(adminRequest("DELETE", undefined, { id }), routeContext(id));
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { id, deleted: true });
    assert.equal(credentialRepo.getUpstreamCredentialWithSecret(id), null);
    assert.equal((await itemRoute.DELETE(adminRequest("DELETE", undefined, { id }), routeContext(id))).status, 404);
    assert.equal((await itemRoute.PATCH(adminRequest("PATCH", {}, { id }), routeContext(id))).status, 404);
  }
  const final = await collectionRoute.GET(adminRequest("GET"));
  assert.equal(final.status, 200);
  assert.deepEqual(await final.json(), { object: "list", data: [] });
});
