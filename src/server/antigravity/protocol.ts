import { createHash, randomInt, randomUUID } from "node:crypto";

// Values below mirror CLIProxyAPI's Antigravity client fingerprint. CPA resolves the Hub version from the
// updater manifest but always pairs it with the highest known changelist, so the effective User-Agent is this one.
export const ANTIGRAVITY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_VERSION = "2.33.0";
export const ANTIGRAVITY_USER_AGENT =
  `antigravity/hub/${ANTIGRAVITY_VERSION} (aidev_client; os_type=darwin; arch=arm64; cl=1023160026)`;
export const ANTIGRAVITY_ONBOARD_USER_AGENT = ANTIGRAVITY_USER_AGENT + " google-api-nodejs-client/10.3.0";
export const ANTIGRAVITY_GOOG_API_CLIENT = "gl-node/22.21.1";
export const ANTIGRAVITY_TOKEN_USER_AGENT = "Go-http-client/2.0";

const MODEL_PATTERN = /^gemini-[a-z0-9][a-z0-9.-]*$/;

export function isAntigravityModelId(model: string) {
  return MODEL_PATTERN.test(model);
}

export type AntigravityModelInfo = {
  thinking?: { min: number; max: number; zero?: boolean; levels?: string[] };
};

// Capabilities of CPA's static Antigravity registry (internal/registry/models/models.json). Unknown models
// behave like CPA user-defined models: thinking settings pass through without clamping.
const GEMINI_LEVELS = ["low", "medium", "high"];
const MODEL_INFO: Record<string, AntigravityModelInfo> = {
  "gemini-4-argon-high": { thinking: { min: 1, max: 65535, levels: GEMINI_LEVELS } },
  "gemini-4-carbon-high": { thinking: { min: 1, max: 65535, levels: GEMINI_LEVELS } },
  "gemini-4-hydrogen-xhigh": { thinking: { min: 1, max: 65535, levels: [...GEMINI_LEVELS, "xhigh"] } },
  "gemini-4-neon-xhigh": { thinking: { min: 1, max: 65535, levels: [...GEMINI_LEVELS, "xhigh"] } },
  "gemini-3.8-flash-high": { thinking: { min: 1, max: 65535, levels: GEMINI_LEVELS } },
  "gemini-3.8-flash-tiered": { thinking: { min: 1, max: 65535, levels: GEMINI_LEVELS } },
  "gemini-3-flash": { thinking: { min: 128, max: 32768, levels: ["minimal", ...GEMINI_LEVELS] } },
  "gemini-3.1-flash-image": { thinking: { min: 128, max: 32768, levels: ["minimal", "high"] } },
  "gemini-3.1-flash-lite": { thinking: { min: 1, max: 65535, zero: true, levels: ["minimal", ...GEMINI_LEVELS] } },
  "gemini-3.5-flash-lite": { thinking: { min: 1, max: 65535, levels: ["minimal", ...GEMINI_LEVELS] } },
};

// Antigravity publishes one Gemini ID per thinking tier. Relay exposes the standard name
// and picks the tier per account when sending.
const TIER_SUFFIX = /-(minimal|low|medium|high|xhigh|max|thinking)$/;
const TIER_ORDER = ["", "-high", "-xhigh", "-medium", "-thinking", "-low", "-minimal", "-max"];

// Clients may send Google-prefixed names (google/gemini-4-argon).
export function antigravityModelName(model: string) {
  return model.trim().toLowerCase().replace(/^google\//, "");
}

export function antigravityStandardModel(model: string) {
  return antigravityModelName(model).replace(TIER_SUFFIX, "");
}

// Standard names offered by a catalog; internal IDs (tab_*, *-disabled) are hidden.
export function antigravityStandardModels(catalog: string[]) {
  return [...new Set(catalog.filter(id => isAntigravityModelId(id) && !id.endsWith("-disabled"))
    .map(antigravityStandardModel))].sort();
}

// The upstream ID an account serves for a requested name: an exact catalog ID first, then the tier matching the
// requested reasoning effort, then the default tier. An unknown catalog passes the name through.
export function resolveAntigravityModel(catalog: string[] | null, model: string, effort = "") {
  const requested = antigravityModelName(model);
  if (!isAntigravityModelId(requested)) return null;
  if (!catalog || catalog.includes(requested)) return requested;
  const base = antigravityStandardModel(requested);
  const suffixes = effort ? ["-" + effort.toLowerCase(), ...TIER_ORDER] : TIER_ORDER;
  return suffixes.map(suffix => base + suffix).find(id => catalog.includes(id)) ?? null;
}

export function antigravityModelInfo(model: string): AntigravityModelInfo | undefined {
  const id = model.toLowerCase();
  if (MODEL_INFO[id]) return MODEL_INFO[id];
  const base = antigravityStandardModel(id);
  const sibling = Object.keys(MODEL_INFO).find(key => antigravityStandardModel(key) === base);
  return sibling ? MODEL_INFO[sibling] : undefined;
}

// CPA always uses the streaming endpoint for these models and aggregates non-stream responses.
export function antigravityRequiresStreaming(model: string) {
  const value = model.toLowerCase();
  return value.includes("gemini-3-pro") || value.includes("gemini-3.1-flash-image");
}

export function antigravityObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function antigravityString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function antigravityRequestId(model: string) {
  return model.includes("image")
    ? `image_gen/${Date.now()}/${randomUUID()}/12`
    : "agent-" + randomUUID();
}

// Same derivation as CPA: a hash of the first user text keeps one conversation on one session ID.
export function antigravitySessionId(contents: unknown) {
  for (const content of Array.isArray(contents) ? contents : []) {
    const value = antigravityObject(content);
    if (value.role !== "user" || !Array.isArray(value.parts)) continue;
    const text = antigravityString(antigravityObject(value.parts[0]).text);
    if (!text) continue;
    const hash = createHash("sha256").update(text).digest();
    return "-" + (hash.readBigUInt64BE(0) & BigInt("0x7fffffffffffffff")).toString();
  }
  return "-" + (BigInt(randomInt(0, 2 ** 47)) * BigInt(65536) + BigInt(randomInt(0, 65536))).toString();
}
