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

/**
 * Whether a finished tool call reported a failure.
 *
 * Codex 0.147.0's `post-tool-use.command.input` carries the tool output as the
 * tool produced it, so there is no one field to read. Anything unrecognized
 * reads as success, because claiming an error the observer cannot see in the
 * transcript is worse than saying nothing.
 */
function toolFailed(input: Record<string, unknown>): boolean {
  if (input.success === false || input.is_error === true) return true;
  const output = input.tool_response ?? input.tool_output ?? input.output;
  if (!isRecord(output)) return false;
  return (
    output.is_error === true ||
    output.success === false ||
    typeof output.error === "string"
  );
}

/**
 * The fields a mid-turn observation needs, and nothing else.
 *
 * A tool event's payload carries the whole tool input and the whole tool
 * output, which have no upper bound, and the broker rewrites its state file on
 * every mutation. `boundPayload` clamps what is stored, but clamping a megabyte
 * down to the budget still stores the budget on every tool call, and none of it
 * is read: `prepareObservation` reports the transcript delta, which already
 * contains the call and its result.
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
    ...(toolFailed(input) ? { tool_error: true } : {}),
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
  return `Codex is still working on this turn. Its most recent tool call was ${tool ?? "an unnamed tool"}${failed ? ", and it reported an error" : ""}.`;
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
        : event === "UserPromptSubmit"
          ? "user_prompt"
          : // PostToolUse is the mid-turn boundary. PreToolUse is deliberately
            // absent: nothing has happened yet when it fires, so its transcript
            // delta is the one the previous PostToolUse already reported.
            event === "PostToolUse"
            ? "tool_result"
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
        // The native name separates a prompt from the Stop of the same turn,
        // which share the session, directory, turn ID, and transcript marker.
        event,
        workingDirectory,
        transcriptPath,
        await fileMarker(transcriptPath),
        // Codex 0.147.0 requires turn_id on both prompt and Stop input, which
        // is real native identity rather than a file marker that may not have
        // moved yet. Its schema calls it an extension for internal turn-scoped
        // hooks, so a command hook cannot count on a useful value; the prompt
        // text separates two submissions on its own if the turn ID is empty.
        input.turn_id,
        input.prompt,
        // Two tool calls inside one turn share the session, the directory, the
        // turn ID, and sometimes the marker, because the hook can run before
        // the transcript is flushed. The call itself is what separates them.
        // Two identical calls that also share a marker still collide, and that
        // is the safe direction: the second is treated as a repeat of the
        // first, so it folds into nothing rather than earning an observer turn.
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
        text: `Codex thread ${event.sessionId} started in ${event.workingDirectory}.`,
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
      // what a turn reports does not depend on which hook ran first.
      //
      // Codex 0.147.0's user-prompt-submit.command.input schema requires a
      // `prompt` string, but a hook that runs against another build may not get
      // one, so its absence is reported rather than assumed.
      const prompt = stringValue(event.payload.prompt);
      return {
        text: prompt
          ? `Codex user prompt:\n${truncateText(prompt, 12_000)}`
          : "Codex user prompt submitted with no prompt text on the hook input.",
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
          : `Codex turn stopped.\n${truncateText(JSON.stringify(event.payload), 8_000)}`,
      };
    }
    const delta = await readJsonlDelta(transcriptPath, cursor);
    const text = delta.records
      .map(summarizeRecord)
      .filter((entry): entry is string => Boolean(entry))
      .join("\n\n");
    const empty = midTurn
      ? "Nothing new has been written to the transcript since your last observation."
      : "Codex completed a turn with no new text records.";
    const header = midTurn ? `${midTurnHeader(event)}\n\n` : "";
    return {
      text: `${header}${text || empty}`,
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
