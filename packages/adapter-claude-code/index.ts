import { stat } from "node:fs/promises";
import {
  escapeXml,
  eventId,
  readJsonlDelta,
  truncateText,
  type DeliveryRecord,
  type HarnessAdapter,
  type HarnessEvent,
  type PreparedObservation,
  type SourceCursor,
} from "../core/index.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventType(input: Record<string, unknown>): string | undefined {
  return stringValue(input.hook_event_name) ?? stringValue(input.event_type);
}

async function transcriptMarker(path: string | undefined): Promise<string> {
  if (!path) return "no-transcript";
  try {
    const info = await stat(path);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return "missing-transcript";
  }
}

function contentText(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const type = stringValue(item.type);
    if (type === "text") {
      const text = stringValue(item.text);
      if (text) parts.push(text);
      continue;
    }
    if (type === "tool_use") {
      const name = stringValue(item.name) ?? "unknown";
      const input =
        item.input === undefined
          ? ""
          : truncateText(JSON.stringify(item.input), 2_000);
      parts.push(`[Tool call: ${name}]${input ? `\n${input}` : ""}`);
      continue;
    }
    if (type === "tool_result") {
      const result =
        typeof item.content === "string"
          ? item.content
          : JSON.stringify(item.content);
      parts.push(
        `[Tool result${item.is_error === true ? " error" : ""}]\n${truncateText(result, 4_000)}`,
      );
    }
  }
  return parts;
}

function summarizeRecord(record: Record<string, unknown>): string | null {
  if (record.type === "summary" && typeof record.summary === "string") {
    return `[Session summary]\n${record.summary}`;
  }
  if (record.type !== "user" && record.type !== "assistant") return null;
  const message = isRecord(record.message) ? record.message : record;
  const role = record.type === "assistant" ? "Claude Code" : "User";
  const parts = contentText(message.content ?? record.content);
  if (parts.length === 0) return null;
  return `${role}:\n${parts.join("\n")}`;
}

function formatDelivery(delivery: DeliveryRecord): string {
  return `<subconscious_whisper delivery_id="${escapeXml(delivery.id)}">\n${escapeXml(delivery.text)}\n</subconscious_whisper>`;
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = "claude-code" as const;
  readonly capabilities = {
    passiveContext: true,
    queuedMessage: false,
    transcript: "file" as const,
  };

  async normalizeHookInput(input: unknown): Promise<HarnessEvent | null> {
    if (!isRecord(input)) return null;
    const nativeEvent = eventType(input);
    const type =
      nativeEvent === "SessionStart"
        ? "session_start"
        : nativeEvent === "Stop"
          ? "turn_stop"
          : null;
    if (!type) return null;
    const sessionId = stringValue(input.session_id);
    const workingDirectory =
      stringValue(input.cwd) ?? stringValue(input.working_directory);
    if (!sessionId || !workingDirectory) return null;
    const transcriptPath = stringValue(input.transcript_path);
    const marker = await transcriptMarker(transcriptPath);
    return {
      id: eventId([
        this.id,
        sessionId,
        nativeEvent,
        workingDirectory,
        transcriptPath,
        marker,
        ...(transcriptPath ? [] : [input]),
      ]),
      harness: this.id,
      type,
      sessionId,
      workingDirectory,
      occurredAt: new Date().toISOString(),
      payload: { ...input },
    };
  }

  async prepareObservation(
    event: HarnessEvent,
    cursor: SourceCursor | undefined,
  ): Promise<PreparedObservation> {
    if (event.type === "session_start") {
      return {
        text: `Claude Code session ${event.sessionId} started in ${event.workingDirectory}.`,
      };
    }
    const transcriptPath = stringValue(event.payload.transcript_path);
    if (!transcriptPath) {
      return {
        text: `Claude Code turn stopped.\n${truncateText(JSON.stringify(event.payload), 8_000)}`,
      };
    }
    const delta = await readJsonlDelta(transcriptPath, cursor);
    const transcript = delta.records
      .map(summarizeRecord)
      .filter((entry): entry is string => Boolean(entry))
      .join("\n\n");
    const skipped =
      delta.skippedBytes > 0
        ? `[Skipped ${delta.skippedBytes} earlier transcript bytes.]\n\n`
        : "";
    return {
      text: `${skipped}${transcript || "Claude Code completed a turn with no new text records."}`,
      nextCursor: delta.nextCursor,
    };
  }

  formatWhispers(deliveries: DeliveryRecord[]): string {
    return deliveries.map(formatDelivery).join("\n\n");
  }
}

export const claudeCodeAdapter = new ClaudeCodeAdapter();
