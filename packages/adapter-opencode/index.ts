import { createHash } from "node:crypto";
import {
  escapeXml,
  eventId,
  formatSessionStatus,
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

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * The native event names the plugin forwards, and the boundary each maps to.
 *
 * Verified against the OpenCode plugin hook surface (plugin SDK 1.2.27, host
 * 1.18.23). `session.idle` is deliberately absent: it is the legacy turn-end
 * signal and `session.status` with `status.type === "idle"` carries the same
 * fact with less ambiguity. Handling both would double-stop every turn.
 */
const EVENT_TYPES = {
  session_created: "session_start",
  user_prompt: "user_prompt",
  tool_result: "tool_result",
  turn_stop: "turn_stop",
  session_end: "session_end",
} as const;

export type OpencodeNativeEvent = keyof typeof EVENT_TYPES;

/**
 * One semantic transcript record, normalized from a snapshot before it is
 * persisted.
 *
 * `key` is the stable part identity (`messageID:partID`); `version` hashes the
 * semantic content or tool state, so a part whose content was rewritten in
 * place (streaming edits, compaction rewrites) produces a new version under
 * the same key instead of silently reading as unchanged.
 */
export interface TranscriptRecord {
  key: string;
  version: string;
  role: "user" | "assistant";
  kind: "text" | "reasoning" | "tool";
  text?: string;
  tool?: string;
  toolError?: boolean;
}

/**
 * How large a persisted transcript tail may get.
 *
 * The broker clamps stored payloads to `DEFAULT_PAYLOAD_LIMITS` (12,000
 * characters per string, 64,000 serialized) and drops whole top-level fields
 * largest first when over budget — which would drop the entire records array.
 * These bounds keep the tail a no-op for that clamp: at most 30 records, each
 * text field capped, and the serialized array stopped before 48,000
 * characters, leaving headroom for the identity fields beside it.
 */
const MAX_RECORDS = 30;
const MAX_RECORD_TEXT_CHARS = 2_000;
const MAX_TOOL_OUTPUT_CHARS = 1_200;
const MAX_TAIL_SERIALIZED_CHARS = 48_000;
const CURSOR_SEPARATOR = "#";
const TAIL_MARKER_PREFIX = "tail:";

function recordMarker(record: TranscriptRecord): string {
  return `${record.key}${CURSOR_SEPARATOR}${record.version}`;
}

function encodeTailMarker(records: TranscriptRecord[]): string {
  return `${TAIL_MARKER_PREFIX}${Buffer.from(
    JSON.stringify(records.map(recordMarker)),
  ).toString("base64url")}`;
}

function decodeTailMarker(marker: string): string[] | null {
  if (!marker.startsWith(TAIL_MARKER_PREFIX)) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(
        marker.slice(TAIL_MARKER_PREFIX.length),
        "base64url",
      ).toString("utf8"),
    ) as unknown;
    return Array.isArray(decoded) &&
      decoded.every((entry) => typeof entry === "string")
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function recordVersion(record: Omit<TranscriptRecord, "version">): string {
  return shortHash(
    JSON.stringify([
      record.role,
      record.kind,
      record.text ?? null,
      record.tool ?? null,
      record.toolError ? true : null,
    ]),
  );
}

/**
 * Whether a finished tool call reported a failure.
 *
 * Only terminal states count: a pending or running part has not happened yet,
 * and claiming its outcome would be invention. Anything unrecognized reads as
 * success, because claiming an error the observer cannot see in the snapshot
 * is worse than saying nothing.
 */
function toolPartFailed(part: Record<string, unknown>): boolean | null {
  const state = isRecord(part.state) ? part.state : undefined;
  if (!state) return null;
  if (state.status === "error") return true;
  if (state.status === "completed") return false;
  return null;
}

function toolPartText(part: Record<string, unknown>): string | undefined {
  const state = isRecord(part.state) ? part.state : undefined;
  if (!state) return undefined;
  const raw =
    typeof state.output === "string"
      ? state.output
      : typeof state.error === "string"
        ? state.error
        : undefined;
  const text = raw?.trim();
  return text ? truncateText(text, MAX_TOOL_OUTPUT_CHARS) : undefined;
}

function normalizeRecordsFromMessages(messages: unknown[]): TranscriptRecord[] {
  const collected: TranscriptRecord[] = [];
  let budget = MAX_TAIL_SERIALIZED_CHARS;
  // Walk newest-first and keep a bounded tail; the result is reversed into
  // chronological order before storage so rendering reads naturally.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (!isRecord(entry)) continue;
    const info = isRecord(entry.info) ? entry.info : {};
    const role = info.role === "user" ? "user" : "assistant";
    const messageID = stringValue(info.id);
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    for (let pIndex = parts.length - 1; pIndex >= 0; pIndex -= 1) {
      const part = parts[pIndex];
      if (!isRecord(part)) continue;
      const partID = stringValue(part.id);
      const type = stringValue(part.type);
      let base: Omit<TranscriptRecord, "version"> | null = null;
      if (type === "text") {
        // Synthetic parts are harness-written plumbing, not model output, and
        // ignored parts are excluded from the model's own view. Neither is
        // worth an observer turn.
        if (part.synthetic === true || part.ignored === true) continue;
        const text = stringValue(part.text)?.trim();
        if (!text) continue;
        base = {
          key: `${messageID ?? "?"}:${partID ?? "?"}`,
          role,
          kind: "text",
          text: truncateText(text, MAX_RECORD_TEXT_CHARS),
        };
      } else if (type === "reasoning") {
        const text = stringValue(part.text)?.trim();
        if (!text) continue;
        base = {
          key: `${messageID ?? "?"}:${partID ?? "?"}`,
          role,
          kind: "reasoning",
          text: truncateText(text, MAX_RECORD_TEXT_CHARS),
        };
      } else if (type === "tool") {
        const failed = toolPartFailed(part);
        if (failed === null) continue;
        const text = toolPartText(part);
        base = {
          key: `${messageID ?? "?"}:${stringValue(part.callID) ?? partID ?? "?"}`,
          role,
          kind: "tool",
          tool: stringValue(part.tool) ?? "unknown-tool",
          toolError: failed,
          ...(text ? { text } : {}),
        };
      }
      if (!base) continue;
      const record: TranscriptRecord = {
        ...base,
        version: recordVersion(base),
      };
      budget -= JSON.stringify(record).length;
      collected.push(record);
      if (collected.length >= MAX_RECORDS || budget <= 0) {
        return collected.reverse();
      }
    }
  }
  return collected.reverse();
}

/** Pull the bounded tail of one message-list snapshot out of its raw shape. */
export function normalizeSnapshot(snapshot: unknown): TranscriptRecord[] {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.messages)) return [];
  return normalizeRecordsFromMessages(snapshot.messages);
}

function renderRecord(record: TranscriptRecord): string | null {
  if (record.kind === "tool") {
    const header = `[OpenCode ${record.toolError ? "tool error" : "tool call"}: ${record.tool}]`;
    return record.text ? `${header}\n${record.text}` : header;
  }
  if (record.kind === "reasoning") {
    return record.text ? `[reasoning]\n${record.text}` : null;
  }
  if (!record.text) return null;
  return `${record.role === "user" ? "User" : "OpenCode"}:\n${record.text}`;
}

function midTurnHeader(event: HarnessEvent): string {
  const tool = stringValue(event.payload.tool);
  const failed = event.payload.tool_error === true;
  return `OpenCode is still working on this turn. Its most recent tool call was ${tool ?? "an unnamed tool"}${failed ? ", and it reported an error" : ""}.`;
}

/**
 * Render the delta between a cursor marker and the current tail.
 *
 * The marker names the last record a previous observation reported. When that
 * record has vanished — compaction rewrote history, a mutable part was
 * replaced, or the bounded tail rotated past it — the whole visible tail is
 * replayed behind an explicit note: telling the observer something twice beats
 * letting it miss something once. A missing marker with no prior cursor is the
 * first read of a session and renders the tail without the note.
 */
export function renderDelta(
  records: TranscriptRecord[],
  cursor: SourceCursor | undefined,
): { text: string; nextCursor?: SourceCursor } {
  const marker = cursor?.marker;
  if (records.length === 0) {
    return { text: "" };
  }
  let replayed = false;
  let startIndex = 0;
  if (marker) {
    const previousTail = decodeTailMarker(marker);
    if (previousTail) {
      const currentTail = records.map(recordMarker);
      const samePrefix =
        currentTail.length >= previousTail.length &&
        previousTail.every((entry, index) => currentTail[index] === entry);
      if (samePrefix) startIndex = previousTail.length;
      else replayed = true;
    } else {
      // Backward compatibility with the earlier final-record-only marker.
      const found = records.findIndex(
        (record) => recordMarker(record) === marker,
      );
      if (found >= 0) startIndex = found + 1;
      else replayed = true;
    }
  }
  const slice = records.slice(startIndex);
  if (slice.length === 0) return { text: "" };
  const body = slice
    .map(renderRecord)
    .filter((entry): entry is string => Boolean(entry))
    .join("\n\n");
  const note = replayed
    ? "[Earlier transcript records were compacted, rewritten, or truncated; the recent tail is replayed rather than skipped.]\n\n"
    : "";
  const last = slice[slice.length - 1];
  return {
    text: `${note}${body}`,
    nextCursor: { marker: encodeTailMarker(records) },
  };
}

function snapshotErrorFrom(input: Record<string, unknown>): string | undefined {
  const nested = isRecord(input.snapshot)
    ? stringValue(input.snapshot.snapshot_error)
    : undefined;
  return stringValue(input.snapshot_error) ?? nested;
}

/**
 * The plugin's observe payload, already shaped by the generated host plugin.
 *
 * The plugin stays dumb — it forwards native identities and the raw message
 * snapshot it fetched through `client.session.messages` — while this adapter
 * owns every semantic decision: event typing, tool failure derivation, record
 * normalization, and bounds.
 */
export class OpencodeAdapter implements HarnessAdapter {
  readonly id = "opencode" as const;
  readonly capabilities = {
    passiveContext: true,
    queuedMessage: false,
    // Transcript content arrives inside observed events as snapshots fetched
    // by the plugin; there is no file path and no broker-side API reader.
    transcript: "events" as const,
  };

  async normalizeHookInput(input: unknown): Promise<HarnessEvent | null> {
    if (!isRecord(input)) return null;
    const native = stringValue(input.event);
    if (!native || !(native in EVENT_TYPES)) return null;
    const type = EVENT_TYPES[native as OpencodeNativeEvent];
    const sessionId = stringValue(input.session_id);
    const workingDirectory =
      stringValue(input.cwd) ?? stringValue(input.working_directory);
    if (!sessionId || !workingDirectory) return null;

    const messageId = stringValue(input.message_id);
    const callId = stringValue(input.call_id);
    const tool = stringValue(input.tool);
    const promptText = stringValue(input.prompt_text);
    const turnId = stringValue(input.turn_id);
    const turnSequence = numberValue(input.turn_sequence);
    const records =
      type === "turn_stop" || type === "tool_result"
        ? normalizeSnapshot(input.snapshot)
        : [];

    // Tool failure is derived here, not trusted from the plugin: OpenCode's
    // canonical mid-turn observation waits for terminal message.part.updated,
    // and the authoritative answer is the terminal tool-part state inside the
    // canonical snapshot.
    let toolError: boolean | undefined;
    if (type === "tool_result") {
      const match = records.find(
        (record) =>
          record.kind === "tool" &&
          (callId ? record.key.endsWith(`:${callId}`) : false),
      );
      toolError = match?.toolError;
    }

    const snapshotError =
      type === "turn_stop" || type === "tool_result"
        ? snapshotErrorFrom(input)
        : undefined;

    const payload: Record<string, unknown> = {
      session_id: sessionId,
      cwd: workingDirectory,
      ...(messageId ? { message_id: messageId } : {}),
      ...(callId ? { call_id: callId } : {}),
      ...(tool ? { tool } : {}),
      ...(turnId ? { turn_id: turnId } : {}),
      ...(turnSequence !== undefined ? { turn_sequence: turnSequence } : {}),
      ...(promptText ? { prompt_text: truncateText(promptText, 12_000) } : {}),
      ...(type === "tool_result" && toolError !== undefined
        ? { tool_error: toolError }
        : {}),
      ...((type === "turn_stop" || type === "tool_result") && records.length > 0
        ? { records }
        : {}),
      ...(snapshotError ? { snapshot_error: snapshotError } : {}),
    };

    return {
      id: eventId([
        this.id,
        sessionId,
        native,
        workingDirectory,
        messageId,
        callId,
        tool,
        turnId,
        turnSequence,
        promptText,
        records.map((record) => `${record.key}#${record.version}`),
      ]),
      harness: this.id,
      type,
      sessionId,
      workingDirectory,
      occurredAt: new Date().toISOString(),
      ...(turnSequence !== undefined ? { sequence: turnSequence } : {}),
      payload,
    };
  }

  async prepareObservation(
    event: HarnessEvent,
    cursor: SourceCursor | undefined,
  ): Promise<PreparedObservation> {
    if (event.type === "session_start") {
      return {
        text: `OpenCode session ${event.sessionId} started in ${event.workingDirectory}.`,
      };
    }
    if (event.type === "user_prompt") {
      // The prompt reports its direct parts and nothing else. It never
      // advances the transcript cursor: the snapshot delta belongs to
      // turn_stop (and mid-turn tool boundaries), which are the only writers.
      const prompt = stringValue(event.payload.prompt_text);
      return {
        text: prompt
          ? `OpenCode user prompt:\n${truncateText(prompt, 12_000)}`
          : "OpenCode user prompt submitted with no readable prompt text.",
      };
    }
    if (event.type === "session_end") {
      return {
        text: `OpenCode session ${event.sessionId} ended.`,
      };
    }

    // turn_stop and tool_result share the snapshot delta below. A mid-turn
    // observation advances the same cursor turn_stop will read, which is why
    // the broker folds later tool results into one queued record per route.
    const midTurn = event.type === "tool_result";
    const records = Array.isArray(event.payload.records)
      ? (event.payload.records as TranscriptRecord[])
      : [];
    const snapshotError = stringValue(event.payload.snapshot_error);
    const header = midTurn ? `${midTurnHeader(event)}\n\n` : "";
    if (records.length === 0) {
      const reason = snapshotError
        ? ` The session transcript could not be read (${snapshotError}).`
        : "";
      const empty = midTurn
        ? "Nothing new has been written to the session since your last observation."
        : "OpenCode completed a turn with no new readable records.";
      return { text: `${header}${empty}${reason}` };
    }
    const delta = renderDelta(records, cursor);
    if (!delta.text) {
      return {
        text: midTurn
          ? `${header}Nothing new has been written to the session since your last observation.`
          : "OpenCode completed a turn with no new readable records.",
      };
    }
    return {
      text: `${header}${delta.text}`,
      ...(delta.nextCursor ? { nextCursor: delta.nextCursor } : {}),
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

  /**
   * No CLI hook path exists for this harness.
   *
   * Passive delivery happens inside the generated plugin: prompt-boundary
   * context arrives as a synthetic `chat.message` part, and mid-turn context
   * arrives through `experimental.chat.system.transform`. There is no CLI hook
   * stdout channel for runHook to write, and pretending otherwise would
   * acknowledge whispers no model ever sees.
   */
  contextChannel(_nativeEvent: string): ContextChannel | null {
    return null;
  }
}

export const opencodeAdapter = new OpencodeAdapter();
