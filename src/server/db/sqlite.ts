import "server-only";

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serverConfig } from "@/src/server/config/env";

let mainDb: DatabaseSync | null = null;
let logDb: DatabaseSync | null = null;
let initialized = false;

export function getMainDb() {
  ensureInitialized();
  if (!mainDb) {
    throw new Error("Main database is not initialized");
  }
  return mainDb;
}

export function getLogDb() {
  ensureInitialized();
  if (!logDb) {
    throw new Error("Log database is not initialized");
  }
  return logDb;
}

export function ensureInitialized() {
  if (initialized) {
    return;
  }
  fs.mkdirSync(serverConfig.dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(serverConfig.mainDbPath), { recursive: true });
  fs.mkdirSync(path.dirname(serverConfig.logDbPath), { recursive: true });

  mainDb = openDatabase(serverConfig.mainDbPath, true);
  logDb = openDatabase(serverConfig.logDbPath, false);
  migrateMainDb(mainDb);
  migrateLogDb(logDb);
  initialized = true;
}

function openDatabase(filePath: string, foreignKeys: boolean) {
  const db = new DatabaseSync(filePath, {
    timeout: serverConfig.sqliteBusyTimeoutMs,
  });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`PRAGMA busy_timeout = ${serverConfig.sqliteBusyTimeoutMs}`);
  db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  return db;
}

function applyMigration(
  db: DatabaseSync,
  name: string,
  migration: string | ((db: DatabaseSync) => void),
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const existing = db
    .prepare("SELECT name FROM schema_migrations WHERE name = ?")
    .get(name);
  if (existing) {
    return;
  }
  db.exec("BEGIN");
  try {
    if (typeof migration === "string") {
      db.exec(migration);
    } else {
      migration(db);
    }
    db.prepare(
      "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
    ).run(name, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateMainDb(db: DatabaseSync) {
  applyMigration(
    db,
    "001_main_foundation",
    `
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        model_allowlist_json TEXT NOT NULL,
        channel_allowlist_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        token_limit_daily INTEGER,
        rate_limit_per_minute INTEGER,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
      CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);

      CREATE TABLE IF NOT EXISTS codex_credentials (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'codex',
        email TEXT NOT NULL DEFAULT '',
        account_id TEXT NOT NULL DEFAULT '',
        plan_type TEXT NOT NULL DEFAULT '',
        token_envelope TEXT NOT NULL,
        proxy_envelope TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        priority INTEGER NOT NULL DEFAULT 100,
        weight INTEGER NOT NULL DEFAULT 1,
        expires_at TEXT,
        last_refresh_at TEXT,
        last_used_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'codex',
        base_url TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        priority INTEGER NOT NULL DEFAULT 100,
        weight INTEGER NOT NULL DEFAULT 1,
        model_allowlist_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'healthy',
        health_score REAL NOT NULL DEFAULT 100,
        cooldown_until TEXT,
        last_error TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_channels_credential
        ON channels(credential_id);
      CREATE INDEX IF NOT EXISTS idx_channels_routing
        ON channels(enabled, status, priority, weight);

      CREATE TABLE IF NOT EXISTS channel_credentials (
        channel_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, credential_id),
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_channel_credentials_credential
        ON channel_credentials(credential_id);

      CREATE TABLE IF NOT EXISTS codex_quota_cache (
        credential_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'unknown',
        cache_json TEXT NOT NULL,
        retrieved_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (credential_id) REFERENCES codex_credentials(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  );

  applyMigration(db, "002_remove_codex_credential_status", (database) => {
    const columns = database
      .prepare("PRAGMA table_info(codex_credentials)")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "status")) {
      return;
    }
    database.exec("DROP INDEX IF EXISTS idx_codex_credentials_status");
    database.exec("ALTER TABLE codex_credentials DROP COLUMN status");
  });

  applyMigration(
    db,
    "003_oauth_pending_states",
    `
      CREATE TABLE IF NOT EXISTS oauth_pending_states (
        state TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_oauth_pending_states_expires
        ON oauth_pending_states(expires_at);
    `,
  );

  applyMigration(db, "004_routing_credentials", (database) => {
    addColumnIfMissing(
      database,
      "codex_credentials",
      "enabled",
      "INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))",
    );
    addColumnIfMissing(
      database,
      "codex_credentials",
      "priority",
      "INTEGER NOT NULL DEFAULT 100",
    );
    addColumnIfMissing(
      database,
      "codex_credentials",
      "weight",
      "INTEGER NOT NULL DEFAULT 1",
    );
    addColumnIfMissing(database, "codex_credentials", "last_used_at", "TEXT");
    database.exec(`
      CREATE TABLE IF NOT EXISTS channel_credentials (
        channel_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, credential_id),
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_channel_credentials_credential
        ON channel_credentials(credential_id);

      INSERT OR IGNORE INTO channel_credentials (channel_id, credential_id, created_at)
      SELECT id, credential_id, created_at
      FROM channels
      WHERE credential_id IS NOT NULL AND credential_id <> '';
    `);
  });

  applyMigration(db, "005_credential_proxy", (database) => {
    addColumnIfMissing(database, "codex_credentials", "proxy_envelope", "TEXT");
  });

  applyMigration(
    db,
    "006_proxy_pool",
    `
      CREATE TABLE IF NOT EXISTS proxy_pool (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('socks5', 'socks5h')),
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        password_envelope TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_proxy_pool_enabled
        ON proxy_pool(enabled, updated_at);
    `,
  );

  applyMigration(
    db,
    "007_claude_credentials",
    `
      CREATE TABLE IF NOT EXISTS claude_credentials (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL DEFAULT 'claude',
        email TEXT NOT NULL DEFAULT '',
        account_id TEXT NOT NULL DEFAULT '',
        token_envelope TEXT NOT NULL,
        proxy_envelope TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        priority INTEGER NOT NULL DEFAULT 100,
        weight INTEGER NOT NULL DEFAULT 1,
        expires_at TEXT,
        last_refresh_at TEXT,
        last_used_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_claude_credentials_routing
        ON claude_credentials(enabled, priority, weight);
    `,
  );

  applyMigration(db, "008_multi_provider_channels", (database) => {
    database.exec(`
      DROP INDEX IF EXISTS idx_channel_credentials_credential;
      DROP INDEX IF EXISTS idx_channels_routing;
      DROP INDEX IF EXISTS idx_channels_credential;

      ALTER TABLE channel_credentials RENAME TO channel_credentials_legacy_008;
      ALTER TABLE channels RENAME TO channels_legacy_008;

      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'codex' CHECK (provider IN ('codex', 'claude')),
        base_url TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        priority INTEGER NOT NULL DEFAULT 100,
        weight INTEGER NOT NULL DEFAULT 1,
        model_allowlist_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'healthy',
        health_score REAL NOT NULL DEFAULT 100,
        cooldown_until TEXT,
        last_error TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE channel_credentials (
        channel_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, credential_id),
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      ) STRICT;

      INSERT INTO channels (
        id, name, provider, base_url, credential_id, enabled, priority,
        weight, model_allowlist_json, status, health_score, cooldown_until,
        last_error, last_used_at, created_at, updated_at
      )
      SELECT
        id, name,
        CASE WHEN provider = 'claude' THEN 'claude' ELSE 'codex' END,
        base_url, credential_id, enabled, priority, weight,
        model_allowlist_json, status, health_score, cooldown_until,
        last_error, last_used_at, created_at, updated_at
      FROM channels_legacy_008;

      INSERT OR IGNORE INTO channel_credentials (channel_id, credential_id, created_at)
      SELECT channel_id, credential_id, created_at
      FROM channel_credentials_legacy_008;

      CREATE INDEX IF NOT EXISTS idx_channels_credential
        ON channels(credential_id);
      CREATE INDEX IF NOT EXISTS idx_channels_routing
        ON channels(provider, enabled, status, priority, weight);
      CREATE INDEX IF NOT EXISTS idx_channel_credentials_credential
        ON channel_credentials(credential_id);

      DROP TABLE channel_credentials_legacy_008;
      DROP TABLE channels_legacy_008;
    `);
  });

  applyMigration(db, "010_api_upstream_credentials", (database) => {
    const extraIndexes = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'index'
        AND tbl_name IN ('channels', 'channel_credentials') AND sql IS NOT NULL
        AND name NOT IN ('idx_channels_credential', 'idx_channels_routing', 'idx_channel_credentials_credential')
    `).all() as Array<{ sql: string }>;
    // Rebuild both sides of the FK together; renaming only channels would retarget it.
    database.exec(`
      DROP INDEX IF EXISTS idx_channel_credentials_credential;
      DROP INDEX IF EXISTS idx_channels_routing;
      DROP INDEX IF EXISTS idx_channels_credential;
      ALTER TABLE channel_credentials RENAME TO channel_credentials_legacy_010;
      ALTER TABLE channels RENAME TO channels_legacy_010;

      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'codex'
          CHECK (provider IN ('codex', 'claude', 'openai', 'anthropic')),
        base_url TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        priority INTEGER NOT NULL DEFAULT 100,
        weight INTEGER NOT NULL DEFAULT 1,
        model_allowlist_json TEXT NOT NULL DEFAULT '[]',
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'healthy',
        health_score REAL NOT NULL DEFAULT 100,
        cooldown_until TEXT,
        last_error TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE channel_credentials (
        channel_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, credential_id),
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      ) STRICT;

      INSERT INTO channels (
        id, name, provider, base_url, credential_id, enabled, priority, weight,
        model_allowlist_json, capabilities_json, status, health_score,
        cooldown_until, last_error, last_used_at, created_at, updated_at
      ) SELECT
        id, name, provider, base_url, credential_id, enabled, priority, weight,
        model_allowlist_json,
        CASE WHEN provider = 'claude'
          THEN '["chat","responses","messages","count_tokens"]'
          ELSE '["chat","responses","images_generations","images_edits"]' END,
        status, health_score, cooldown_until, last_error, last_used_at, created_at, updated_at
      FROM channels_legacy_010;

      INSERT INTO channel_credentials (channel_id, credential_id, created_at)
      SELECT channel_id, credential_id, created_at FROM channel_credentials_legacy_010;

      CREATE INDEX idx_channels_credential ON channels(credential_id);
      CREATE INDEX idx_channels_routing ON channels(provider, enabled, status, priority, weight);
      CREATE INDEX idx_channel_credentials_credential ON channel_credentials(credential_id);
      DROP TABLE channel_credentials_legacy_010;
      DROP TABLE channels_legacy_010;

      CREATE TABLE upstream_credentials (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic')),
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_envelope TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        priority INTEGER NOT NULL DEFAULT 100,
        weight INTEGER NOT NULL DEFAULT 1,
        use_global_proxy INTEGER NOT NULL DEFAULT 0 CHECK (use_global_proxy IN (0, 1)),
        proxy_pool_id TEXT,
        proxy_envelope TEXT,
        last_used_at TEXT,
        cooldown_until TEXT,
        last_error TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_upstream_credentials_routing
        ON upstream_credentials(provider, enabled, priority, weight);
    `);
    for (const index of extraIndexes) database.exec(index.sql);
  });
  applyMigration(db, "011_antigravity_oauth", (database) => {
    const indexes = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'index'
        AND tbl_name IN ('channels', 'channel_credentials') AND sql IS NOT NULL
    `).all() as Array<{ sql: string }>;
    database.exec(`
      ALTER TABLE channel_credentials RENAME TO channel_credentials_legacy_011;
      ALTER TABLE channels RENAME TO channels_legacy_011;

      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'codex'
          CHECK (provider IN ('codex', 'claude', 'openai', 'anthropic', 'antigravity')),
        base_url TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        priority INTEGER NOT NULL DEFAULT 100,
        weight INTEGER NOT NULL DEFAULT 1,
        model_allowlist_json TEXT NOT NULL DEFAULT '[]',
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'healthy',
        health_score REAL NOT NULL DEFAULT 100,
        cooldown_until TEXT,
        last_error TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE channel_credentials (
        channel_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, credential_id),
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO channels SELECT * FROM channels_legacy_011;
      INSERT INTO channel_credentials SELECT * FROM channel_credentials_legacy_011;
      DROP TABLE channel_credentials_legacy_011;
      DROP TABLE channels_legacy_011;

      CREATE TABLE antigravity_credentials (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        email TEXT NOT NULL,
        project_id TEXT NOT NULL,
        token_envelope TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        priority INTEGER NOT NULL DEFAULT 100,
        weight INTEGER NOT NULL DEFAULT 1,
        expires_at TEXT NOT NULL,
        last_refresh_at TEXT NOT NULL,
        last_used_at TEXT,
        cooldown_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    for (const index of indexes) database.exec(index.sql);
  });
  applyMigration(db, "012_antigravity_cpa_alignment", `
    ALTER TABLE antigravity_credentials ADD COLUMN models_json TEXT;
    ALTER TABLE antigravity_credentials ADD COLUMN model_cooldowns_json TEXT NOT NULL DEFAULT '{}';
  `);
  // Holds usage_health_reset_at, as on the Codex and Claude credential tables.
  applyMigration(db, "013_antigravity_credential_metadata", `
    ALTER TABLE antigravity_credentials ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
  `);
  applyMigration(db, "014_codex_quota_refresh", `
    CREATE TABLE codex_quota_refresh (
      credential_id TEXT PRIMARY KEY REFERENCES codex_credentials(id) ON DELETE CASCADE,
      owner TEXT NOT NULL,
      lease_until INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0
    ) STRICT;
  `);
  applyMigration(db, "015_claude_session_bindings", `
    CREATE TABLE session_bindings (
      binding_key TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      cache_until INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0 CHECK (failed IN (0, 1))
    ) STRICT;
    CREATE INDEX idx_session_bindings_expiry ON session_bindings(expires_at);
  `);

  applyMigration(db, "016_claude_quota_routing", `
    ALTER TABLE channels ADD COLUMN quota_weighted INTEGER NOT NULL DEFAULT 0
      CHECK (quota_weighted IN (0, 1));
    CREATE TABLE claude_quota_cache (
      account_key TEXT PRIMARY KEY,
      windows_json TEXT NOT NULL DEFAULT '[]',
      extra_usage_enabled INTEGER,
      last_usage_at INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      owner TEXT,
      lease_until INTEGER NOT NULL DEFAULT 0
    ) STRICT;
  `);
}

function migrateLogDb(db: DatabaseSync) {
  applyMigration(
    db,
    "001_log_foundation",
    `
      CREATE TABLE IF NOT EXISTS request_logs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_type TEXT NOT NULL,
        stream INTEGER NOT NULL DEFAULT 0 CHECK (stream IN (0, 1)),
        model TEXT NOT NULL DEFAULT '',
        status_code INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        api_key_id TEXT,
        api_key_prefix TEXT,
        api_key_name TEXT,
        channel_id TEXT,
        channel_name TEXT,
        credential_id TEXT,
        credential_email TEXT,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_request_logs_started
        ON request_logs(started_at);
      CREATE INDEX IF NOT EXISTS idx_request_logs_api_key
        ON request_logs(api_key_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_request_logs_channel
        ON request_logs(channel_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_request_logs_credential
        ON request_logs(credential_id, started_at);

      CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        api_key_id TEXT,
        api_key_prefix TEXT,
        api_key_name TEXT,
        channel_id TEXT,
        channel_name TEXT,
        credential_id TEXT,
        credential_email TEXT,
        model TEXT NOT NULL DEFAULT '',
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_usage_records_created
        ON usage_records(created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_records_api_key
        ON usage_records(api_key_id, created_at);

      CREATE TABLE IF NOT EXISTS usage_daily_buckets (
        bucket_date TEXT NOT NULL,
        api_key_id TEXT NOT NULL DEFAULT '',
        channel_id TEXT NOT NULL DEFAULT '',
        credential_id TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        request_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bucket_date, api_key_id, channel_id, credential_id, model)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS channel_health_events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL DEFAULT '',
        credential_id TEXT,
        event_type TEXT NOT NULL,
        status_code INTEGER,
        health_score REAL,
        cooldown_until TEXT,
        message TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_channel_health_events_channel
        ON channel_health_events(channel_id, created_at);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        actor_type TEXT NOT NULL DEFAULT 'system',
        actor_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}'
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_audit_logs_created
        ON audit_logs(created_at);
    `,
  );

  applyMigration(db, "002_api_key_name_log_columns", (database) => {
    addColumnIfMissing(database, "request_logs", "api_key_name", "TEXT");
    addColumnIfMissing(database, "usage_records", "api_key_name", "TEXT");
  });

  applyMigration(
    db,
    "003_request_logs_credential_index",
    "CREATE INDEX IF NOT EXISTS idx_request_logs_credential ON request_logs(credential_id, started_at);",
  );

  applyMigration(
    db,
    "004_request_log_details",
    `
      CREATE TABLE IF NOT EXISTS request_log_details (
        request_log_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        request_headers_json TEXT,
        request_body_text TEXT,
        request_body_truncated INTEGER NOT NULL DEFAULT 0 CHECK (request_body_truncated IN (0, 1)),
        request_body_bytes INTEGER NOT NULL DEFAULT 0,
        forwarded_body_text TEXT,
        forwarded_body_truncated INTEGER NOT NULL DEFAULT 0 CHECK (forwarded_body_truncated IN (0, 1)),
        forwarded_body_bytes INTEGER NOT NULL DEFAULT 0,
        upstream_status_code INTEGER,
        upstream_headers_json TEXT,
        upstream_body_text TEXT,
        upstream_body_truncated INTEGER NOT NULL DEFAULT 0 CHECK (upstream_body_truncated IN (0, 1)),
        upstream_body_bytes INTEGER NOT NULL DEFAULT 0,
        error_name TEXT,
        error_message TEXT,
        error_stack TEXT,
        error_cause_json TEXT,
        detail_json TEXT,
        stage_timings_json TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_request_log_details_updated
        ON request_log_details(updated_at);
      CREATE INDEX IF NOT EXISTS idx_request_log_details_created
        ON request_log_details(created_at);
    `,
  );

  applyMigration(db, "005_request_log_stage_timings", (database) => {
    addColumnIfMissing(
      database,
      "request_log_details",
      "stage_timings_json",
      "TEXT",
    );
  });

  applyMigration(
    db,
    "006_request_log_dashboard_indexes",
    `
      CREATE INDEX IF NOT EXISTS idx_request_logs_status_started
        ON request_logs(status_code, started_at);
      CREATE INDEX IF NOT EXISTS idx_request_logs_model_started
        ON request_logs(model, started_at);
      CREATE INDEX IF NOT EXISTS idx_request_logs_request_type_started
        ON request_logs(request_type, started_at);
      CREATE INDEX IF NOT EXISTS idx_request_logs_started_latency
        ON request_logs(started_at, latency_ms);
      CREATE INDEX IF NOT EXISTS idx_usage_daily_buckets_updated
        ON usage_daily_buckets(updated_at);
      CREATE INDEX IF NOT EXISTS idx_channel_health_events_created
        ON channel_health_events(created_at);
    `,
  );

  applyMigration(db, "007_cached_token_usage", (database) => {
    addColumnIfMissing(
      database,
      "request_logs",
      "cached_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );
    addColumnIfMissing(
      database,
      "usage_records",
      "cached_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );
    addColumnIfMissing(
      database,
      "usage_daily_buckets",
      "cached_tokens",
      "INTEGER NOT NULL DEFAULT 0",
    );
  });

  applyMigration(db, "008_request_log_forwarded_headers", (database) => {
    addColumnIfMissing(
      database,
      "request_log_details",
      "forwarded_headers_json",
      "TEXT",
    );
  });

  // Both statements are metadata-only in SQLite, so they are instant on a large
  // request_logs. cache_write_tokens stays NULL on older rows: Claude
  // prompt_tokens include cache writes, and NULL means "not split", not zero.
  // quota_snapshots keeps one row per 5-minute bucket of one quota window
  // cycle; reset_key is the window's reset time in whole minutes.
  applyMigration(db, "009_quota_burn", (database) => {
    addColumnIfMissing(database, "request_logs", "cache_write_tokens", "INTEGER");
    database.exec(`
      CREATE TABLE IF NOT EXISTS quota_snapshots (
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        window_id TEXT NOT NULL,
        reset_key INTEGER NOT NULL,
        bucket INTEGER NOT NULL,
        first_at INTEGER NOT NULL,
        first_used REAL NOT NULL,
        last_at INTEGER NOT NULL,
        last_used REAL NOT NULL,
        min_used REAL NOT NULL,
        max_used REAL NOT NULL,
        samples INTEGER NOT NULL,
        PRIMARY KEY (provider, subject, window_id, reset_key, bucket)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_quota_snapshots_last_at ON quota_snapshots(last_at);
    `);
  });
}

function addColumnIfMissing(
  db: DatabaseSync,
  tableName: string,
  columnName: string,
  definition: string,
) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}
