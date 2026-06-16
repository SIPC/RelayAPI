import "server-only";

const oauthToolRenameMap: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  task: "Task",
  webfetch: "WebFetch",
  todowrite: "TodoWrite",
  question: "Question",
  skill: "Skill",
  ls: "LS",
  todoread: "TodoRead",
  notebookedit: "NotebookEdit",
};

export type ClaudeToolNameReverseMap = Record<string, string>;

export function prepareClaudeOAuthToolNamesForUpstream<T>(payload: T) {
  const cloned = structuredClone(payload) as T;
  const reverseMap: ClaudeToolNameReverseMap = {};
  const recordRename = (original: string, renamed: string) => {
    if (!reverseMap[renamed]) {
      reverseMap[renamed] = original;
    }
  };
  const rename = (name: unknown) => {
    if (typeof name !== "string") {
      return name;
    }
    const mapped = oauthToolRenameMap[name.trim().toLowerCase()];
    if (!mapped) {
      return name;
    }
    recordRename(name, mapped);
    return mapped;
  };

  if (isRecord(cloned)) {
    const payloadRecord = cloned as Record<string, unknown>;
    if (Array.isArray(payloadRecord.tools)) {
      payloadRecord.tools = payloadRecord.tools.map((rawTool) => {
        if (!isRecord(rawTool)) {
          return rawTool;
        }
        return { ...rawTool, name: rename(rawTool.name) };
      });
    }
    const toolChoice = payloadRecord.tool_choice;
    if (isRecord(toolChoice) && toolChoice.name) {
      payloadRecord.tool_choice = {
        ...toolChoice,
        name: rename(toolChoice.name),
      };
    }
    if (Array.isArray(payloadRecord.messages)) {
      payloadRecord.messages = payloadRecord.messages.map((rawMessage) => {
        if (!isRecord(rawMessage) || !Array.isArray(rawMessage.content)) {
          return rawMessage;
        }
        return {
          ...rawMessage,
          content: rawMessage.content.map((rawPart) => {
            if (!isRecord(rawPart)) {
              return rawPart;
            }
            if (rawPart.type === "tool_use") {
              return { ...rawPart, name: rename(rawPart.name) };
            }
            return rawPart;
          }),
        };
      });
    }
  }

  return { payload: cloned, reverseMap };
}

export function restoreClaudeToolName(
  name: unknown,
  reverseMap: ClaudeToolNameReverseMap | null | undefined,
) {
  if (typeof name !== "string" || !reverseMap) {
    return name;
  }
  return reverseMap[name] || name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
