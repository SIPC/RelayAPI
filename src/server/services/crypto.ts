import "server-only";

import crypto from "node:crypto";
import { getEncryptionSecret } from "@/src/server/config/env";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";

function encryptionKey() {
  return crypto
    .createHash("sha256")
    .update(getEncryptionSecret(), "utf8")
    .digest();
}

export function randomId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(16).toString("base64url")}`;
}

export function base64Url(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value: string) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function encryptJson(value: unknown) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    ENCRYPTION_ALGORITHM,
    encryptionKey(),
    iv,
  );
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    alg: ENCRYPTION_ALGORITHM,
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    data: ciphertext.toString("base64url"),
  });
}

export function decryptJson<T = unknown>(envelopeText: string): T {
  const envelope = JSON.parse(envelopeText) as {
    v: number;
    alg: string;
    iv: string;
    tag: string;
    data: string;
  };
  if (envelope.v !== 1 || envelope.alg !== ENCRYPTION_ALGORITHM) {
    throw new Error("Unsupported encrypted payload envelope");
  }
  const decipher = crypto.createDecipheriv(
    ENCRYPTION_ALGORITHM,
    encryptionKey(),
    Buffer.from(envelope.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function safeJsonParse<T>(
  value: string | null | undefined,
  fallback: T,
): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function jsonStringify(value: unknown) {
  return JSON.stringify(value ?? null);
}
