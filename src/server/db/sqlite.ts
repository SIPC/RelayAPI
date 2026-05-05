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
        expires_at TEXT,
        last_refresh_at TEXT,
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
        updated_at TEXT NOT NULL,
        FOREIGN KEY (credential_id) REFERENCES codex_credentials(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_channels_credential
        ON channels(credential_id);
      CREATE INDEX IF NOT EXISTS idx_channels_routing
        ON channels(enabled, status, priority, weight);

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
