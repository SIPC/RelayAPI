import "server-only";

function secretVariants(key: string) {
  if (!key) return [];
  const variants = new Set([key, encodeURIComponent(key)]);
  let escaped = key;
  // A reflected JSON-escaped string acquires another escape layer inside JSON/SSE.
  for (let i = 0; i < 3; i++) {
    escaped = JSON.stringify(escaped).slice(1, -1);
    variants.add(escaped);
  }
  variants.add(encodeURIComponent(key).replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()));
  return [...variants].sort((a, b) => b.length - a.length);
}

type TextAlternative = { text: string; hex?: boolean };
type ByteAlternative = { bytes: Uint8Array; hex?: boolean };

function encodedPatterns(key: string): TextAlternative[][][] {
  if (!key) return [];
  const encoder = new TextEncoder();
  const chars = Array.from(key);
  // Prefix-distinct escape alternatives avoid exponential regex backtracking on near-matches.
  return [
    chars.map((char) => {
      const unicode = Array.from({ length: char.length }, (_, index) => `\\u${char.charCodeAt(index).toString(16).padStart(4, "0")}`).join("");
      const alternatives: TextAlternative[] = [
        ...(char !== '"' && char !== "\\" && char.charCodeAt(0) >= 32 ? [{ text: char }] : []),
        { text: JSON.stringify(char).slice(1, -1) }, { text: unicode, hex: true },
        ...(char === "/" ? [{ text: "\\/" }] : []),
      ];
      return alternatives.filter((part, index) => alternatives.findIndex((candidate) => candidate.text === part.text) === index);
    }),
    chars.map((char) => [...(char !== "%" ? [{ text: char }] : []), { text: Array.from(encoder.encode(char), (byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""), hex: true }]),
  ];
}

function regexEscape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactText(text: string, key: string) {
  for (const secret of secretVariants(key)) text = text.split(secret).join("[REDACTED]");
  for (const pattern of encodedPatterns(key)) {
    const source = pattern.map((token) => "(?:" + token.map((part) => {
      const escaped = regexEscape(part.text);
      return part.hex ? escaped.replace(/[a-f]/gi, (hex) => `[${hex.toLowerCase()}${hex.toUpperCase()}]`) : escaped;
    }).join("|") + ")").join("");
    text = text.replace(new RegExp(source, "gu"), "[REDACTED]");
  }
  return text;
}

function matchEncoded(bytes: Uint8Array, start: number, pattern: ByteAlternative[][]) {
  let cursor = start;
  for (const token of pattern) {
    let matched = 0;
    let partial = false;
    for (const alternative of token) {
      const length = Math.min(bytes.length - cursor, alternative.bytes.length);
      let index = 0;
      for (; index < length; index++) {
        const expected = alternative.bytes[index];
        const actual = bytes[cursor + index];
        if (actual !== expected && !(alternative.hex && /[a-f]/i.test(String.fromCharCode(expected)) && (actual | 32) === (expected | 32))) break;
      }
      if (index !== length) continue;
      if (length < alternative.bytes.length) partial = true;
      else matched = Math.max(matched, alternative.bytes.length);
    }
    if (partial) return { matched: 0, partial: true };
    if (!matched) return { matched: 0, partial: false };
    cursor += matched;
  }
  return { matched: cursor - start, partial: false };
}

export function redactValue(value: unknown, key: string): unknown {
  if (typeof value === "string") return redactText(value, key);
  if (value instanceof Error) return { name: redactText(value.name, key), message: redactText(value.message, key) };
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [redactText(name, key), redactValue(item, key)]));
  }
  return value;
}

export function redactResponseText(text: string, parsed: unknown, key: string) {
  if (parsed !== undefined) {
    const sanitized = JSON.stringify(redactValue(parsed, key));
    if (sanitized !== JSON.stringify(parsed)) return sanitized;
  }
  return redactText(text, key);
}

// Only a suffix that could still become a secret is retained (less than the
// longest encoded secret). Byte matching preserves UTF-8 and unmodified chunks.
export class SecretByteRedactor {
  private patterns: Uint8Array[];
  private encoded: ByteAlternative[][][];
  private pending: Uint8Array = new Uint8Array();
  private replacement = new TextEncoder().encode("[REDACTED]");

  constructor(key: string) {
    const encoder = new TextEncoder();
    this.patterns = secretVariants(key).map((variant) => encoder.encode(variant));
    this.encoded = encodedPatterns(key).map((pattern) => pattern.map((token) => token.map((part) => ({ bytes: encoder.encode(part.text), hex: part.hex }))));
  }

  push(chunk: Uint8Array) { return this.process(chunk, false); }
  finish() { return this.process(new Uint8Array(), true); }

  private process(chunk: Uint8Array, final: boolean) {
    if (!this.patterns.length) return chunk;
    let bytes = chunk;
    if (this.pending.length) {
      bytes = new Uint8Array(this.pending.length + chunk.length);
      bytes.set(this.pending);
      bytes.set(chunk, this.pending.length);
    }
    const parts: Uint8Array[] = [];
    let size = 0;
    const append = (part: Uint8Array) => {
      if (part.length) { parts.push(part); size += part.length; }
    };
    let start = 0;
    let cursor = 0;
    for (; cursor < bytes.length;) {
      let matched = 0;
      let partial = false;
      for (const pattern of this.patterns) {
        if (bytes[cursor] !== pattern[0]) continue;
        const length = Math.min(bytes.length - cursor, pattern.length);
        let index = 1;
        while (index < length && bytes[cursor + index] === pattern[index]) index++;
        if (index !== length) continue;
        if (length < pattern.length) partial = true;
        else matched = Math.max(matched, pattern.length);
      }
      for (const pattern of this.encoded) {
        const result = matchEncoded(bytes, cursor, pattern);
        partial ||= result.partial;
        matched = Math.max(matched, result.matched);
      }
      if (partial && !final) break;
      if (matched) {
        append(bytes.subarray(start, cursor));
        append(this.replacement);
        cursor += matched;
        start = cursor;
      } else cursor++;
    }
    append(bytes.subarray(start, cursor));
    this.pending = bytes.slice(cursor);
    if (parts.length === 1) return parts[0];
    const output = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.length; }
    return output;
  }
}
