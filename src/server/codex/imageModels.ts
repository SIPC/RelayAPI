import "server-only";

export const CODEX_IMAGE_MODELS = [
  { id: "gpt-image-2", displayName: "GPT Image 2", created: 1704067200 },
  {
    id: "gpt-image-2.5-sunburst",
    displayName: "GPT Image 2.5 Sunburst",
    created: 1788825600,
  },
  {
    id: "gpt-image-2.5-flare",
    displayName: "GPT Image 2.5 Flare",
    created: 1788825600,
  },
  {
    id: "gpt-image-2.5-sunburst-2026-09-08",
    displayName: "GPT Image 2.5 Sunburst (2026-09-08)",
    created: 1788825600,
  },
  {
    id: "gpt-image-2.5-flare-2026-09-08",
    displayName: "GPT Image 2.5 Flare (2026-09-08)",
    created: 1788825600,
  },
] as const;

export const CODEX_IMAGE_MODEL_IDS = CODEX_IMAGE_MODELS.map(({ id }) => id);

const imageModelIds = new Set<string>(CODEX_IMAGE_MODEL_IDS);

export function isCodexImageModel(model: string) {
  const base = model.slice(model.lastIndexOf("/") + 1).toLowerCase();
  return imageModelIds.has(base);
}
