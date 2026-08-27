import { stat } from "node:fs/promises";
import {
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

/**
 * Whether a finished tool call reported a failure.
 *
 * Claude Code has no single documented error field on `PostToolUse`: the tool
 * response is whatever the tool returned. These are the shapes the built-in
 * tools use, and anything unrecognized reads as success, because claiming an
 * error the observer cannot see in the transcript is worse than saying nothing.
 */
function toolFailed(response: unknown): boolean {
  if (!isRecord(response)) return false;
  return (
    response.is_error === true ||
    response.isError === true ||
    response.success === false ||
    typeof response.error === "string"
  );
}

/**
 * The fields a mid-turn observation needs, and nothing else.
 *
 * A `PostToolUse` payload carries the whole tool input and the whole tool
 * response, which have no upper bound, and the broker rewrites its state file
 * on every mutation. `boundPayload` clamps whatever is stored, but clamping a
 * megabyte of tool output down to the budget still stores the budget on every
 * tool call, and none of it is read: `prepareObservation` reports the transcript
 * delta, which already contains the call and its result. So the adapter sends
 * the route identity, the transcript it reads from, and the two facts the
 * observation text states directly.
 */
function midTurnPayload(
  input: Record<string, unknown>,
  sessionId: string,
  workingDirectory: string,
  transcriptPath: string | undefined,
): Record<string, unknown> {
  const toolName = stringValue(input.tool_name);
  return {
    session_id: sessionId,
    cwd: workingDirectory,
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    ...(toolName ? { tool_name: toolName } : {}),
    ...(toolFailed(input.tool_response) ? { tool_error: true } : {}),
  };
}

/**
 * The first line of a mid-turn observation.
 *
 * One record can stand for several tool calls, so it names the latest one
 * rather than claiming to describe all of them. The transcript delta below it
 * is the full account.
 */
function midTurnHeader(event: HarnessEvent): string {
  const tool = stringValue(event.payload.tool_name);
  const failed = event.payload.tool_error === true;
  return `Claude Code is still working on this turn. Its most recent tool call was ${tool ?? "an unnamed tool"}${failed ? ", and it reported an error" : ""}.`;
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
        : nativeEvent === "UserPromptSubmit"
          ? "user_prompt"
          : // PostToolUse is the mid-turn boundary. PreToolUse is deliberately
            // absent: nothing has happened yet when it fires, so its transcript
            // delta is the one the previous PostToolUse already reported.
            nativeEvent === "PostToolUse"
            ? "tool_result"
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
        // The native name separates a prompt from the Stop of the same turn,
        // which otherwise agree on session, directory, and transcript marker.
        nativeEvent,
        workingDirectory,
        transcriptPath,
        marker,
        // A prompt hook fires before the turn writes anything, so the marker
        // cannot be trusted to have moved since the last event. The prompt text
        // is what actually distinguishes two submissions. Every other event
        // leaves it undefined, which is one constant more in the hash.
        input.prompt,
        // Two tool calls inside one turn share the session, the directory, and
        // sometimes the marker, because the hook can run before the transcript
        // is flushed. The call itself is what separates them. Two identical
        // calls that also share a marker still collide, and that is the safe
        // direction: the second is treated as a repeat of the first, so it
        // folds into nothing rather than earning a second observer turn.
        input.tool_name,
        input.tool_input,
        ...(transcriptPath ? [] : [input]),
      ]),
      harness: this.id,
      type,
      sessionId,
      workingDirectory,
      occurredAt: new Date().toISOString(),
      payload:
        type === "tool_result"
          ? midTurnPayload(input, sessionId, workingDirectory, transcriptPath)
          : { ...input },
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
    if (event.type === "user_prompt") {
      // A prompt observation reports the prompt and nothing else.
      //
      // The transcript delta belongs to turn_stop. At a prompt boundary that
      // delta is the previous turn, which turn_stop already sent, and on the
      // first prompt after a resume it is the whole transcript tail, because
      // session_start sets no cursor. Neither is the new instruction this
      // observation exists to report, and both would be paid for on the
      // interactive path where the user is waiting on the hook. Leaving
      // nextCursor unset also keeps turn_stop the only writer of the cursor, so
      // what a turn reports does not depend on which hook ran first. The prompt
      // itself is on the hook input and reaches the observer verbatim; the next
      // turn_stop carries it again in the surrounding turn.
      const prompt = stringValue(event.payload.prompt);
      return {
        text: prompt
          ? `Claude Code user prompt:\n${truncateText(prompt, 12_000)}`
          : "Claude Code user prompt submitted with no prompt text on the hook input.",
      };
    }
    // Everything below reads the transcript delta, which is what turn_stop and
    // tool_result share. The two prompt-side types return above, so the wording
    // here cannot land on a prompt observation.
    //
    // A mid-turn observation advances the same cursor as turn_stop, and it has
    // to: the delta it consumed is exactly the delta the following turn_stop
    // would otherwise resend. That is also why the broker keeps only one queued
    // mid-turn record per route. Whichever observation runs first takes the
    // whole delta, and a second one behind it would report an empty turn.
    const midTurn = event.type === "tool_result";
    const transcriptPath = stringValue(event.payload.transcript_path);
    if (!transcriptPath) {
      return {
        text: midTurn
          ? `${midTurnHeader(event)} The hook input carried no transcript path, so there is nothing further to report.`
          : `Claude Code turn stopped.\n${truncateText(JSON.stringify(event.payload), 8_000)}`,
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
    const empty = midTurn
      ? "Nothing new has been written to the transcript since your last observation."
      : "Claude Code completed a turn with no new text records.";
    const header = midTurn ? `${midTurnHeader(event)}\n\n` : "";
    return {
      text: `${header}${skipped}${transcript || empty}`,
      nextCursor: delta.nextCursor,
    };
  }

  formatWhispers(deliveries: DeliveryRecord[]): string {
    return deliveries.map(formatDelivery).join("\n\n");
  }

  formatStatus(status: SessionStatus): string {
    return formatSessionStatus(status);
  }

  contextChannel(nativeEvent: string): ContextChannel | null {
    // Per the Claude Code hook reference: these two read plain stdout, the
    // tool events read only hookSpecificOutput.additionalContext, and
    // PreCompact, Notification, and SessionEnd have their output discarded.
    if (nativeEvent === "SessionStart" || nativeEvent === "UserPromptSubmit") {
      return "stdout";
    }
    if (nativeEvent === "PreToolUse" || nativeEvent === "PostToolUse") {
      return "envelope";
    }
    return null;
  }
}

export const claudeCodeAdapter = new ClaudeCodeAdapter();
