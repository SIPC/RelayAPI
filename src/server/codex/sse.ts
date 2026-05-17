import "server-only";

export type ParsedCodexSseFrame = {
  frame: string;
  data: string;
  event: Record<string, unknown> | null;
};

export class CodexResponsesSseFramer {
  private pending = "";
  private outputItemsByIndex = new Map<number, unknown>();
  private outputItemsFallback: unknown[] = [];

  push(text: string) {
    if (!text) {
      return [] as ParsedCodexSseFrame[];
    }

    if (responsesSseNeedsLineBreak(this.pending, text)) {
      this.pending += "\n";
    }
    this.pending += text;

    const frames: ParsedCodexSseFrame[] = [];
    while (true) {
      const frameLength = responsesSseFrameLength(this.pending);
      if (frameLength <= 0) {
        break;
      }
      const frame = this.pending.slice(0, frameLength);
      this.pending = this.pending.slice(frameLength);
      frames.push(this.repairFrame(frame));
    }

    if (!this.pending.trim()) {
      this.pending = "";
      return frames;
    }

    if (responsesSseCanEmitWithoutDelimiter(this.pending)) {
      frames.push(this.repairFrame(this.pending));
      this.pending = "";
    }

    return frames;
  }

  flush() {
    if (!this.pending) {
      return [] as ParsedCodexSseFrame[];
    }
    if (!this.pending.trim()) {
      this.pending = "";
      return [] as ParsedCodexSseFrame[];
    }
    if (!responsesSseCanEmitWithoutDelimiter(this.pending)) {
      this.pending = "";
      return [] as ParsedCodexSseFrame[];
    }
    const frame = this.repairFrame(this.pending);
    this.pending = "";
    return [frame];
  }

  private repairFrame(frame: string): ParsedCodexSseFrame {
    const data = responsesSseDataPayload(frame);
    if (!data || data === "[DONE]") {
      return {
        frame: ensureSseFrameTerminator(frame),
        data: data || "",
        event: null,
      };
    }

    const event = parseMaybeJson<Record<string, unknown>>(data);
    if (!event) {
      return { frame: ensureSseFrameTerminator(frame), data, event: null };
    }

    const eventType = stringValue(event.type);
    if (eventType === "response.output_item.done") {
      this.recordOutputItem(event);
      return { frame: ensureSseFrameTerminator(frame), data, event };
    }

    if (eventType !== "response.completed") {
      return { frame: ensureSseFrameTerminator(frame), data, event };
    }

    const repairedEvent = this.repairCompletedEvent(event);
    if (repairedEvent === event) {
      return { frame: ensureSseFrameTerminator(frame), data, event };
    }

    const repairedData = JSON.stringify(repairedEvent);
    return {
      frame: responsesSseFrameWithData(frame, repairedData),
      data: repairedData,
      event: repairedEvent,
    };
  }

  private recordOutputItem(event: Record<string, unknown>) {
    const item = isRecord(event.item) ? event.item : null;
    if (!item || !stringValue(item.type)) {
      return;
    }

    const outputIndex = integerValue(event.output_index);
    if (outputIndex !== null) {
      this.outputItemsByIndex.set(outputIndex, structuredClone(item));
      return;
    }

    this.outputItemsFallback.push(structuredClone(item));
  }

  private repairCompletedEvent(event: Record<string, unknown>) {
    if (
      this.outputItemsByIndex.size === 0 &&
      this.outputItemsFallback.length === 0
    ) {
      return event;
    }

    const response = isRecord(event.response) ? event.response : null;
    if (!response) {
      return event;
    }

    if (Array.isArray(response.output) && response.output.length > 0) {
      return event;
    }
    if (response.output !== undefined && !Array.isArray(response.output)) {
      return event;
    }

    return {
      ...event,
      response: {
        ...response,
        output: this.orderedOutputItems(),
      },
    };
  }

  private orderedOutputItems() {
    return [
      ...[...this.outputItemsByIndex.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, item]) => item),
      ...this.outputItemsFallback,
    ];
  }
}

export function parseCodexSseFrames(text: string) {
  const framer = new CodexResponsesSseFramer();
  return [...framer.push(String(text || "")), ...framer.flush()];
}

export function responsesSseDataPayload(frame: string) {
  const dataLines: string[] = [];
  for (const rawLine of frame
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) {
      continue;
    }
    let data = line.slice(5);
    if (data.startsWith(" ")) {
      data = data.slice(1);
    }
    dataLines.push(data.trimEnd());
  }
  return dataLines.join("\n").trim();
}

function responsesSseFrameWithData(frame: string, data: string) {
  let output = "";
  for (const rawLine of frame
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("data:")) {
      continue;
    }
    output += `${rawLine}\n`;
  }
  for (const line of data.split("\n")) {
    output += `data: ${line}\n`;
  }
  return `${output}\n`;
}

function responsesSseFrameLength(text: string) {
  if (!text) {
    return 0;
  }
  const lf = text.indexOf("\n\n");
  const crlf = text.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) {
    return 0;
  }
  if (lf < 0) {
    return crlf + 4;
  }
  if (crlf < 0) {
    return lf + 2;
  }
  return lf < crlf ? lf + 2 : crlf + 4;
}

function responsesSseCanEmitWithoutDelimiter(text: string) {
  const trimmed = text.trim();
  if (
    !trimmed ||
    responsesSseNeedsMoreData(trimmed) ||
    !responsesSseHasField(trimmed, "data:")
  ) {
    return false;
  }
  return responsesSseDataLinesValid(trimmed);
}

function responsesSseNeedsMoreData(text: string) {
  return (
    responsesSseHasField(text, "event:") && !responsesSseHasField(text, "data:")
  );
}

function responsesSseHasField(text: string, prefix: string) {
  for (const rawLine of text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")) {
    if (rawLine.trim().startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function responsesSseDataLinesValid(text: string) {
  for (const rawLine of text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")) {
    const line = rawLine.trim();
    if (!line || !line.startsWith("data:")) {
      continue;
    }
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    if (!parseMaybeJson<unknown>(data)) {
      return false;
    }
  }
  return true;
}

function responsesSseNeedsLineBreak(pending: string, next: string) {
  if (!pending || !next) {
    return false;
  }
  if (pending.endsWith("\n") || pending.endsWith("\r")) {
    return false;
  }
  if (next.startsWith("\n") || next.startsWith("\r")) {
    return false;
  }
  const trimmed = next.trimStart();
  if (!trimmed) {
    return false;
  }
  return ["data:", "event:", "id:", "retry:", ":"].some((prefix) =>
    trimmed.startsWith(prefix),
  );
}

function ensureSseFrameTerminator(frame: string) {
  if (frame.endsWith("\n\n") || frame.endsWith("\r\n\r\n")) {
    return frame;
  }
  if (frame.endsWith("\r\n")) {
    return `${frame}\r\n`;
  }
  if (frame.endsWith("\n")) {
    return `${frame}\n`;
  }
  return `${frame}\n\n`;
}

function parseMaybeJson<T>(text: string) {
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "";
}

function integerValue(value: unknown) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}
