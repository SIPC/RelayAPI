import "server-only";

export const CLAUDE_LONG_CONTEXT_SUFFIX = "1m";
export const CLAUDE_LONG_CONTEXT_TOKENS = 1_000_000;
export const CLAUDE_THINKING_SUFFIX_LEVELS = [
  "low",
  "medium",
  "high",
  "max",
] as const;

const CLAUDE_CONTEXT_SUFFIXES = new Set([CLAUDE_LONG_CONTEXT_SUFFIX]);
const CLAUDE_THINKING_SUFFIXES = new Set<string>(CLAUDE_THINKING_SUFFIX_LEVELS);

export interface ClaudeModelSuffixes {
  baseModel: string;
  hasSuffix: boolean;
  hasContextSuffix: boolean;
  contextSuffix: string;
  hasThinkingSuffix: boolean;
  thinkingEffort: string;
}

export function parseClaudeModelSuffixes(
  modelId: unknown,
): ClaudeModelSuffixes {
  const original = normalizeModelId(modelId);
  let baseModel = original;
  let contextSuffix = "";
  let thinkingEffort = "";
  let hasSuffix = false;

  for (;;) {
    const lastOpen = baseModel.lastIndexOf("(");
    if (lastOpen <= 0 || !baseModel.endsWith(")")) {
      break;
    }

    const nextBaseModel = baseModel.slice(0, lastOpen).trim();
    const suffix = baseModel
      .slice(lastOpen + 1, -1)
      .trim()
      .toLowerCase();
    if (!nextBaseModel) {
      break;
    }

    if (CLAUDE_CONTEXT_SUFFIXES.has(suffix) && !contextSuffix) {
      contextSuffix = suffix;
      hasSuffix = true;
      baseModel = nextBaseModel;
      continue;
    }

    if (CLAUDE_THINKING_SUFFIXES.has(suffix) && !thinkingEffort) {
      thinkingEffort = suffix;
      hasSuffix = true;
      baseModel = nextBaseModel;
      continue;
    }

    break;
  }

  return {
    baseModel: baseModel || original,
    hasSuffix,
    hasContextSuffix: Boolean(contextSuffix),
    contextSuffix,
    hasThinkingSuffix: Boolean(thinkingEffort),
    thinkingEffort,
  };
}

export function stripClaudeModelSuffixes(modelId: unknown) {
  return parseClaudeModelSuffixes(modelId).baseModel;
}

export function claudeModelAllowlistCandidates(modelId: unknown) {
  const value = normalizeModelId(modelId);
  const parsed = parseClaudeModelSuffixes(value);
  const candidates = [value];
  if (parsed.hasContextSuffix && parsed.hasThinkingSuffix) {
    candidates.push(
      `${parsed.baseModel}(${parsed.contextSuffix})(${parsed.thinkingEffort})`,
    );
  }
  if (parsed.hasContextSuffix) {
    candidates.push(`${parsed.baseModel}(${parsed.contextSuffix})`);
  }
  if (parsed.hasThinkingSuffix) {
    candidates.push(`${parsed.baseModel}(${parsed.thinkingEffort})`);
  }
  if (parsed.hasSuffix) {
    candidates.push(parsed.baseModel);
  }
  return [...new Set(candidates.filter(Boolean))];
}

function normalizeModelId(modelId: unknown) {
  return String(modelId || "").trim();
}
