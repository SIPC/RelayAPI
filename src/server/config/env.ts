import "server-only";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  CredentialProxyConfig,
  CredentialProxyType,
} from "@/src/shared/types/entities";

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

function resolveGlobalProxy(): CredentialProxyConfig | null {
  const raw =
    process.env.RELAY_GLOBAL_SOCKS_PROXY ||
    process.env.RELAY_GLOBAL_PROXY ||
    process.env.CODEX_PROXY ||
    "";
  const value = raw.trim();
  if (!value) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Global proxy must be a valid socks5:// or socks5h:// URL");
  }

  const type = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (type !== "socks5" && type !== "socks5h") {
    throw new Error("Global proxy only supports socks5:// and socks5h:// URLs");
  }

  const port = Number.parseInt(parsed.port || "", 10);
  if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Global proxy URL must include host and port");
  }

  return {
    enabled: true,
    type: type as CredentialProxyType,
    host: parsed.hostname,
    port,
    username: decodeURIComponent(parsed.username || ""),
    password: decodeURIComponent(parsed.password || ""),
  };
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
  streamRequestTimeoutMs: intEnv("STREAM_REQUEST_TIMEOUT_MS", 1_800_000),
  globalProxy: resolveGlobalProxy(),
  userAgent:
    process.env.CODEX_USER_AGENT ||
    "codex_cli_rs/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9",
  codexOriginator: process.env.CODEX_ORIGINATOR || "codex_cli_rs",
  autoImportLegacyCredentials:
    process.env.RELAY_IMPORT_LEGACY_CREDENTIALS === "1",
  legacyCredentialDirs: [
    path.join(dataDir, "auths"),
    ...resolvePathList(process.env.RELAY_LEGACY_CREDENTIAL_DIRS),
  ],
};
