import "server-only";
import { extractUsageFromClaudeSseText } from "@/src/server/claude/chat";
import type { UsageSnapshot } from "@/src/shared/types/entities";

export function createClaudeNativeSseStream(
  body: ReadableStream<Uint8Array>,
  input: { onCompleted: (usage: UsageSnapshot) => void; onError: (error: unknown) => void },
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let usageFrames = "";
  let completed = false;
  let failed = false;
  function inspect(frame: string) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (event.type === "message_start" || event.type === "message_delta") usageFrames += "data: " + data + "\n\n";
    if (event.type === "message_stop") completed = true;
    if (event.type === "error" || event.error) {
      failed = true;
      input.onError(new Error(event.error?.message || "Upstream Claude stream failed"));
    }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          inspect(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match[0].length);
          if (failed) break;
        }
        if (value) controller.enqueue(value);
        if (failed) {
          await reader.cancel(); reader.releaseLock(); controller.close(); return;
        }
        if (done) {
          if (buffer.trim()) inspect(buffer);
          if (!failed) {
            if (!completed) throw new Error("Upstream Claude stream ended before message_stop");
            input.onCompleted(extractUsageFromClaudeSseText(usageFrames));
          }
          reader.releaseLock(); controller.close();
        }
      } catch (error) {
        if (!failed) {
          failed = true;
          input.onError(error);
          controller.enqueue(encoder.encode("event: error\ndata: " + JSON.stringify({
            type: "error", error: { type: "api_error", message: error instanceof Error ? error.message : String(error) },
          }) + "\n\n"));
        }
        await reader.cancel().catch(() => {});
        reader.releaseLock(); controller.close();
      }
    },
    async cancel(reason) { await reader.cancel(reason); reader.releaseLock(); },
  });
}
