import { stat } from "node:fs/promises";
import {
  defaultContextChannel,
  escapeXml,
  eventId,
  formatSessionStatus,
  readJsonlDelta,
  truncateText,
  type ContextChannel,
  type DeliveryRecord,
  type HarnessAdapter,
  type HarnessEvent,
  type PreparedObservation,
  type SessionStatus,
  type SourceCursor,
} from "../core/index.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nativeEvent(input: Record<string, unknown>): string | undefined {
  return stringValue(input.hook_event_name) ?? stringValue(input.event_type);
}

async function fileMarker(path: string | undefined): Promise<string> {
  if (!path) return "no-transcript";
  try {
    const info = await stat(path);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return "missing-transcript";
  }
}

function collectText(value: unknown, output: string[], depth = 0): void {
  if (depth > 5) return;
  if (typeof value === "string") {
    if (value.trim()) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of ["text", "message", "content", "input", "output"]) {
    if (key in value) collectText(value[key], output, depth + 1);
  }
}

function summarizeRecord(record: Record<string, unknown>): string | null {
  const payload = isRecord(record.payload) ? record.payload : record;
  const type = stringValue(payload.type) ?? stringValue(record.type) ?? "event";
  if (["session_meta", "turn_context", "token_count"].includes(type))
    return null;
  const text: string[] = [];
  collectText(payload, text);
  if (text.length === 0) return null;
  return `[Codex ${type}]\n${truncateText([...new Set(text)].join("\n"), 8_000)}`;
}

export class CodexAdapter implements HarnessAdapter {
  readonly id = "codex" as const;
  readonly capabilities = {
    passiveContext: true,
    queuedMessage: false,
    transcript: "file" as const,
  };

  async normalizeHookInput(input: unknown): Promise<HarnessEvent | null> {
    if (!isRecord(input)) return null;
    const event = nativeEvent(input);
    const type =
      event === "SessionStart"
        ? "session_start"
        : event === "Stop"
          ? "turn_stop"
          : null;
    if (!type) return null;
    const sessionId =
      stringValue(input.session_id) ?? stringValue(input.thread_id);
    const workingDirectory =
      stringValue(input.cwd) ?? stringValue(input.working_directory);
    if (!sessionId || !workingDirectory) return null;
    const transcriptPath = stringValue(input.transcript_path);
    return {
      id: eventId([
        this.id,
        sessionId,
        event,
        workingDirectory,
        transcriptPath,
        await fileMarker(transcriptPath),
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
        text: `Codex thread ${event.sessionId} started in ${event.workingDirectory}.`,
      };
    }
    const transcriptPath = stringValue(event.payload.transcript_path);
    if (!transcriptPath) {
      return {
        text: `Codex turn stopped.\n${truncateText(JSON.stringify(event.payload), 8_000)}`,
      };
    }
    const delta = await readJsonlDelta(transcriptPath, cursor);
    const text = delta.records
      .map(summarizeRecord)
      .filter((entry): entry is string => Boolean(entry))
      .join("\n\n");
    return {
      text: text || "Codex completed a turn with no new text records.",
      nextCursor: delta.nextCursor,
    };
  }

  formatWhispers(deliveries: DeliveryRecord[]): string {
    return deliveries
      .map(
        (delivery) =>
          `<subconscious_whisper delivery_id="${escapeXml(delivery.id)}">\n${escapeXml(delivery.text)}\n</subconscious_whisper>`,
      )
      .join("\n\n");
  }

  formatStatus(status: SessionStatus): string {
    return formatSessionStatus(status);
  }

  contextChannel(nativeEvent: string): ContextChannel | null {
    // Codex 0.147.0 ships a hookSpecificOutput schema for both tool events,
    // and its error strings show non-empty stdout there must be valid JSON.
    // SubagentStart also accepts context, but it targets the subagent rather
    // than the route that caused the observation, so it stays unclaimed.
    if (nativeEvent === "PreToolUse" || nativeEvent === "PostToolUse") {
      return "envelope";
    }
    return defaultContextChannel(nativeEvent);
  }
}

export const codexAdapter = new CodexAdapter();
