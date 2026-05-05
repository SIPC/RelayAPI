import "server-only";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { serverConfig } from "@/src/server/config/env";
import { HttpError } from "@/src/server/http/errors";

export const WEB_SESSION_COOKIE = "relay_web_session";

const WEB_ACCESS_KEY_FILE = ".relay-web-access-key";
const WEB_ACCESS_KEY_PREFIX = "relay_web_";
const WEB_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const WEB_ACCESS_KEY_ENV_NAMES = ["RELAY_WEB_ACCESS_KEY", "WEB_ACCESS_KEY"];

type StoredWebAccessKey = {
  v: 1;
  hash: string;
  createdAt: string;
};

type WebAccessKeyRecord = {
  hash: string;
  source: "env" | "file";
};

type WebSessionPayload = {
  v: 1;
  iat: number;
  exp: number;
  nonce: string;
};

let cachedWebAccessKey: WebAccessKeyRecord | null = null;

export function initializeWebAccessKey() {
  getWebAccessKeyRecord();
}

export function verifyWebAccessKey(value: unknown) {
  const accessKey = typeof value === "string" ? value.trim() : "";
  if (!accessKey) {
    return false;
  }
  return timingSafeHexEqual(
    hashSecret(accessKey),
    getWebAccessKeyRecord().hash,
  );
}

export function createWebSessionToken(now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const payload = encodeBase64UrlJson({
    v: 1,
    iat: issuedAt,
    exp: issuedAt + WEB_SESSION_TTL_SECONDS,
    nonce: crypto.randomBytes(16).toString("base64url"),
  } satisfies WebSessionPayload);
  return `${payload}.${signSessionPayload(payload)}`;
}

export function isValidWebSessionValue(value: string | null | undefined) {
  if (!value) {
    return false;
  }

  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) {
    return false;
  }
  if (!timingSafeAsciiEqual(signature, signSessionPayload(payload))) {
    return false;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<WebSessionPayload>;
    const now = Math.floor(Date.now() / 1000);
    return (
      parsed.v === 1 &&
      typeof parsed.iat === "number" &&
      typeof parsed.exp === "number" &&
      typeof parsed.nonce === "string" &&
      parsed.iat <= now + 60 &&
      parsed.exp > now
    );
  } catch {
    return false;
  }
}

export function isWebRequestAuthenticated(request: Request) {
  return isValidWebSessionValue(
    readCookie(request.headers.get("cookie"), WEB_SESSION_COOKIE),
  );
}

export function requireWebRequest(request: Request) {
  if (!isWebRequestAuthenticated(request)) {
    throw new HttpError(401, "web_auth_required", "Web access key is required");
  }
}

export function webSessionCookieOptions(requestUrl: string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isHttpsUrl(requestUrl),
    path: "/",
    maxAge: WEB_SESSION_TTL_SECONDS,
  };
}

export function expiredWebSessionCookieOptions(requestUrl: string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isHttpsUrl(requestUrl),
    path: "/",
    maxAge: 0,
  };
}

function getWebAccessKeyRecord(): WebAccessKeyRecord {
  if (cachedWebAccessKey) {
    return cachedWebAccessKey;
  }

  const configuredKey = configuredWebAccessKey();
  if (configuredKey) {
    cachedWebAccessKey = {
      hash: hashSecret(configuredKey),
      source: "env",
    };
    return cachedWebAccessKey;
  }

  const keyPath = path.join(serverConfig.dataDir, WEB_ACCESS_KEY_FILE);
  const existing = readStoredWebAccessKey(keyPath);
  if (existing) {
    cachedWebAccessKey = {
      hash: existing.hash,
      source: "file",
    };
    return cachedWebAccessKey;
  }

  const generatedKey = `${WEB_ACCESS_KEY_PREFIX}${crypto
    .randomBytes(32)
    .toString("base64url")}`;
  const generatedHash = hashSecret(generatedKey);
  const stored: StoredWebAccessKey = {
    v: 1,
    hash: generatedHash,
    createdAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  try {
    fs.writeFileSync(keyPath, `${JSON.stringify(stored, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    cachedWebAccessKey = {
      hash: generatedHash,
      source: "file",
    };
    logGeneratedWebAccessKey(generatedKey, keyPath);
    return cachedWebAccessKey;
  } catch (error) {
    if (isFileAlreadyExistsError(error)) {
      const racedExisting = readStoredWebAccessKey(keyPath);
      if (racedExisting) {
        cachedWebAccessKey = {
          hash: racedExisting.hash,
          source: "file",
        };
        return cachedWebAccessKey;
      }
    }
    throw error;
  }
}

function configuredWebAccessKey() {
  for (const name of WEB_ACCESS_KEY_ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function readStoredWebAccessKey(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<StoredWebAccessKey>;
    if (
      parsed.v === 1 &&
      typeof parsed.hash === "string" &&
      isSha256Hex(parsed.hash)
    ) {
      return parsed as StoredWebAccessKey;
    }
  } catch {
    // Fall through to the clear error below.
  }
  throw new Error(
    `Invalid RelayAPI web access key file: ${filePath}. Delete it to regenerate a new web access key.`,
  );
}

function logGeneratedWebAccessKey(accessKey: string, filePath: string) {
  console.info("");
  console.info("============================================================");
  console.info("RelayAPI Web 访问密钥已生成（只显示这一次）:");
  console.info(accessKey);
  console.info(`密钥哈希已保存到: ${filePath}`);
  console.info("进入 Web 管理页面时请输入这个密钥。");
  console.info("如果丢失，请删除上面的密钥文件后重启服务重新生成。");
  console.info("============================================================");
  console.info("");
}

function signSessionPayload(payload: string) {
  return crypto
    .createHmac("sha256", getWebAccessKeyRecord().hash)
    .update(payload, "utf8")
    .digest("base64url");
}

function encodeBase64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function hashSecret(value: string) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function timingSafeHexEqual(left: string, right: string) {
  if (!isSha256Hex(left) || !isSha256Hex(right)) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(left, "hex"),
    Buffer.from(right, "hex"),
  );
}

function timingSafeAsciiEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isSha256Hex(value: string) {
  return /^[a-f0-9]{64}$/i.test(value);
}

function readCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) {
    return null;
  }
  for (const item of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = item.trim().split("=");
    if (rawName === name) {
      const value = rawValue.join("=");
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

function isHttpsUrl(input: string) {
  try {
    return new URL(input).protocol === "https:";
  } catch {
    return false;
  }
}

function isFileAlreadyExistsError(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
