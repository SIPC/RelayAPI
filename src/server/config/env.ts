import "server-only";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const projectRoot = path.join(/*turbopackIgnore: true*/ process.cwd());

function projectPath(...segments: string[]) {
  return path.join(/*turbopackIgnore: true*/ process.cwd(), ...segments);
}

function resolveFromProject(inputPath: string | undefined, fallback: string) {
  const value = inputPath?.trim();
  if (!value) {
    return fallback;
  }
  return path.isAbsolute(value) ? value : projectPath(value);
}

function intEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function ensureLocalSecret(dataDir: string) {
  const secretPath = path.join(dataDir, ".relay-encryption-key");
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(secretPath)) {
    const existing = fs.readFileSync(secretPath, "utf8").trim();
    if (existing) {
      return existing;
    }
  }
  const generated = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(secretPath, `${generated}\n`, { mode: 0o600 });
  return generated;
}

function resolvePathList(value: string | undefined) {
  if (!value?.trim()) {
    return [];
  }
  return value
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (path.isAbsolute(item) ? item : projectPath(item)));
}

const port = intEnv("PORT", 3000);
const dataDir = resolveFromProject(process.env.DATA_DIR, projectPath("data"));

export function getEncryptionSecret() {
  // Token encryption is lazy so build-time dashboard reads do not create a secret file.
  return (
    process.env.RELAY_ENCRYPTION_KEY ||
    process.env.RELAY_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    ensureLocalSecret(dataDir)
  );
}

export const serverConfig = {
  projectRoot,
  port,
  dataDir,
  mainDbPath: resolveFromProject(
    process.env.RELAY_MAIN_DB_PATH,
    path.join(dataDir, "relay-main.sqlite"),
  ),
  logDbPath: resolveFromProject(
    process.env.RELAY_LOG_DB_PATH,
    path.join(dataDir, "relay-log.sqlite"),
  ),
  sqliteBusyTimeoutMs: intEnv("SQLITE_BUSY_TIMEOUT_MS", 10_000),
  codexRedirectUri:
    process.env.CODEX_REDIRECT_URI || "http://localhost:1455/auth/callback",
  codexBaseUrl: (
    process.env.CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex"
  ).replace(/\/+$/, ""),
  codexDefaultModel: process.env.CODEX_DEFAULT_MODEL || "gpt-5.3-codex",
  requestTimeoutMs: intEnv("REQUEST_TIMEOUT_MS", 300_000),
  userAgent:
    process.env.CODEX_USER_AGENT ||
    "codex-tui/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9 (codex-tui; 0.118.0)",
  autoImportLegacyCredentials:
    process.env.RELAY_IMPORT_LEGACY_CREDENTIALS === "1",
  legacyCredentialDirs: [
    path.join(dataDir, "auths"),
    ...resolvePathList(process.env.RELAY_LEGACY_CREDENTIAL_DIRS),
  ],
};
