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
import { readSqliteDelta } from "./transcript.js";
import {
  defaultHermesRoot as sharedDefaultHermesRoot,
  resolveHermesHome as sharedResolveHermesHome,
} from "./home.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function nativeEvent(
  input: Record<string, unknown>,
): string | undefined {
  return stringValue(input.hook_event_name) ?? stringValue(input.event_type);
}

/**
 * The platform-native Hermes home, matching `hermes_constants.py`.
 *
 * POSIX installs use `~/.hermes`. Native Windows installs use
 * `%LOCALAPPDATA%\hermes`, falling back to `~/AppData/Local/hermes` when the
 * variable is unset — the exact branches of `_get_platform_default_hermes_home`.
 */
export function defaultHermesHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return sharedDefaultHermesRoot(env);
}

/**
 * The Hermes home the event carries.
 *
 * The broker is a global daemon that may have been started by any harness, so
 * its own environment proves nothing about where this session's transcript
 * lives. The hook subprocess therefore stamps the resolved home into every
 * payload (see `withHermesHome`) and this reads only that stamp, falling back
 * to the platform default for events that predate stamping. Never the broker's
 * own HERMES_HOME.
 */
export function hermesHomeFor(input: Record<string, unknown>): string {
  const fromPayload = stringValue(input._hermes_home);
  return fromPayload ?? defaultHermesHome();
}

/**
 * Stamp the hook's resolved Hermes home onto the payload.
 *
 * Called by the hook entry point before normalization, because only the hook
 * process knows which Hermes profile spawned it. Resolution goes through the
 * same active-profile logic the installer uses (see `home.ts`): an unset or
 * root-level HERMES_HOME follows `<root>/active_profile`, so a hook fired by a
 * non-default profile stamps that profile's directory rather than the root —
 * which is what makes the later state.db read land on the right store. The
 * stamp always carries a resolved absolute path so a broker spawned under
 * another profile can never substitute its own environment later. The key is
 * prefixed with an underscore so it can never collide with a native Hermes
 * field.
 */
export function withHermesHome(
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  if (stringValue(input._hermes_home)) return input;
  return { ...input, _hermes_home: sharedResolveHermesHome(env) };
}

/**
 * Whether a finished tool call reported a failure.
 *
 * Hermes derives `status` after the tool ran ("ok" | "error" | "blocked") and
 * carries `error_type` / `error_message` alongside it. Anything unrecognized
 * reads as success: claiming an error the observer cannot see in the
 * transcript is worse than saying nothing.
 */
export function toolFailed(input: Record<string, unknown>): boolean {
  const status = stringValue(input.status)?.toLowerCase();
  if (status === "error" || status === "blocked") return true;
  return input.success === false || input.is_error === true;
}

/**
 * Identity fields shared by every normalized payload.
 *
 * Normalized payloads are deliberately minimal: Hermes' pre_llm_call extra
 * carries the full conversation_history and post_tool_call carries the whole
 * serialized result, and persisting either would duplicate the transcript into
 * broker state on every boundary. The transcript delta reports that content;
 * these fields carry everything else a later read needs.
 */
function identityPayload(
  input: Record<string, unknown>,
  sessionId: string,
  workingDirectory: string,
): Record<string, unknown> {
  const home = stringValue(input._hermes_home);
  const turnId = stringValue(input.turn_id);
  const taskId = stringValue(input.task_id);
  const apiRequestId = stringValue(input.api_request_id);
  const toolCallId = stringValue(input.tool_call_id);
  const model = stringValue(input.model);
  const platform = stringValue(input.platform);
  return {
    session_id: sessionId,
    cwd: workingDirectory,
    ...(home ? { _hermes_home: home } : {}),
    ...(turnId ? { turn_id: turnId } : {}),
    ...(taskId ? { task_id: taskId } : {}),
    ...(apiRequestId ? { api_request_id: apiRequestId } : {}),
    ...(toolCallId ? { tool_call_id: toolCallId } : {}),
    ...(model ? { model } : {}),
    ...(platform ? { platform } : {}),
  };
}

function midTurnHeader(event: HarnessEvent): string {
  const tool = stringValue(event.payload.tool_name);
  const failed = event.payload.tool_error === true;
  return `Hermes is still working on this turn. Its most recent tool call was ${tool ?? "an unnamed tool"}${failed ? ", and it reported an error" : ""}.`;
}

/**
 * Lift the bounded scalar `extra` keys the normalized payloads need.
 *
 * On the wire they arrive nested under `extra`; flattening here keeps the rest
 * of the adapter reading one shape. Only bounded scalars are lifted — never
 * result strings, message lists, or conversation history.
 */
function flattenExtra(input: Record<string, unknown>): Record<string, unknown> {
  const extra = input.extra;
  if (!isRecord(extra)) return input;
  const lifted = [
    "turn_id",
    "task_id",
    "api_request_id",
    "tool_call_id",
    "status",
    "error_type",
    "error_message",
    "duration_ms",
    // pre_llm_call / session-edge fields
    "user_message",
    "is_first_turn",
    "model",
    "platform",
    "completed",
    "interrupted",
    "failed",
  ] as const;
  const out: Record<string, unknown> = { ...input };
  for (const key of lifted) {
    const value = extra[key];
    if (
      (typeof value === "string" && value.length > 0) ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] ??= value;
    }
  }
  return out;
}

function promptText(payload: Record<string, unknown>): string | undefined {
  // pre_llm_call names the user's message user_message; accept prompt as the
  // Claude-style alias for forward compatibility.
  return stringValue(payload.user_message) ?? stringValue(payload.prompt);
}

export class HermesAdapter implements HarnessAdapter {
  readonly id = "hermes" as const;
  readonly capabilities = {
    passiveContext: true,
    queuedMessage: false,
    transcript: "file" as const,
  };

  async normalizeHookInput(input: unknown): Promise<HarnessEvent | null> {
    if (!isRecord(input)) return null;
    const event = nativeEvent(input);
    const type =
      event === "on_session_start"
        ? "session_start"
        : // pre_llm_call fires once per turn prologue carrying user_message:
          // it is both the prompt observation and the harness's only context-
          // consuming boundary. There is no separate UserPromptSubmit event.
          event === "pre_llm_call"
          ? "user_prompt"
          : event === "post_tool_call"
            ? "tool_result"
            : // Despite the name, on_session_end fires at the end of every
              // run_conversation call — one per turn — with completed,
              // interrupted, and failed flags. It is the turn_stop boundary.
              event === "on_session_end"
              ? "turn_stop"
              : null;
    if (!type) return null;
    const flat = flattenExtra(input);
    const sessionId = stringValue(flat.session_id);
    const workingDirectory =
      stringValue(flat.cwd) ?? stringValue(flat.working_directory);
    if (!sessionId || !workingDirectory) return null;

    // Native identity that separates two events of one kind within a turn:
    // turn and API request IDs for the edges, plus the tool call identity and
    // the prompt text itself, which separates two submissions even when every
    // ID is missing.
    const turnId = stringValue(flat.turn_id);
    const apiRequestId = stringValue(flat.api_request_id);
    const toolCallId = stringValue(flat.tool_call_id);
    const completed = flat.completed;
    const interrupted = flat.interrupted;
    const failed = flat.failed;

    let payload: Record<string, unknown>;
    if (type === "tool_result") {
      payload = {
        ...identityPayload(flat, sessionId, workingDirectory),
        tool_name: stringValue(flat.tool_name),
        ...(toolFailed(flat) ? { tool_error: true } : {}),
        ...(stringValue(flat.error_type)
          ? { error_type: stringValue(flat.error_type) }
          : {}),
      };
    } else if (type === "user_prompt") {
      payload = {
        ...identityPayload(flat, sessionId, workingDirectory),
        ...(promptText(flat) ? { user_message: promptText(flat) } : {}),
        is_first_turn: flat.is_first_turn === true,
      };
    } else if (type === "turn_stop") {
      payload = {
        ...identityPayload(flat, sessionId, workingDirectory),
        completed: completed === true,
        interrupted: interrupted === true,
        failed: failed === true,
      };
    } else {
      payload = {
        ...identityPayload(flat, sessionId, workingDirectory),
        model: stringValue(flat.model),
      };
    }

    return {
      id: eventId([
        this.id,
        sessionId,
        event,
        workingDirectory,
        turnId,
        apiRequestId,
        toolCallId,
        stringValue(flat.tool_name),
        promptText(flat),
        completed,
        interrupted,
        failed,
      ]),
      harness: this.id,
      type,
      sessionId,
      workingDirectory,
      occurredAt: new Date().toISOString(),
      payload,
    };
  }

  async prepareObservation(
    event: HarnessEvent,
    cursor: SourceCursor | undefined,
  ): Promise<PreparedObservation> {
    if (event.type === "session_start") {
      return {
        text: `Hermes session ${event.sessionId} started in ${event.workingDirectory}.`,
      };
    }
    if (event.type === "user_prompt") {
      // A prompt observation reports the prompt and nothing else. The
      // transcript delta belongs to turn_stop; reading it here would resend the
      // previous turn and move the cursor turn_stop depends on.
      const prompt = promptText(event.payload);
      return {
        text: prompt
          ? `Hermes user prompt:\n${truncateText(prompt, 12_000)}`
          : "Hermes user prompt submitted with no prompt text on the hook input.",
      };
    }
    // Everything below reads the state.db delta, shared by turn_stop and
    // tool_result. A mid-turn observation advances the same cursor as
    // turn_stop: the delta it consumes is exactly what turn_stop would
    // otherwise resend, which is why the broker queues at most one mid-turn
    // record per route.
    const midTurn = event.type === "tool_result";
    const home = hermesHomeFor(event.payload);
    const header = midTurn ? `${midTurnHeader(event)}\n\n` : "";
    let delta;
    try {
      delta = await readSqliteDelta(home, event.sessionId, cursor);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Fail open: an unreadable store costs the delta, never the session.
      return {
        text: midTurn
          ? `${midTurnHeader(event)} The session store could not be read (${reason}).`
          : `Hermes turn stopped. The session store could not be read (${reason}).`,
      };
    }
    const text = delta.records
      .map((record) => summarizeRow(record))
      .filter((entry): entry is string => Boolean(entry))
      .join("\n\n");
    const truncatedNote = delta.truncated
      ? `\n\n[${delta.readRows} records shown; the remaining newer records will be read at the next boundary.]`
      : "";
    const empty = midTurn
      ? "Nothing new has been written to the session store since your last observation."
      : "Hermes completed a turn with no new records.";
    return {
      text: `${header}${text || empty}${truncatedNote}`,
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

  /**
   * Only pre_llm_call consumes hook output.
   *
   * Verified against agent/shell_hooks.py `_parse_response`: the bare
   * {"context": "..."} shape is passed through only for pre_llm_call; every
   * other event's stdout is parsed but discarded at the fire site, so claiming
   * a channel there would spend each whisper permanently on output no one
   * reads.
   */
  contextChannel(nativeEvent: string): ContextChannel | null {
    return nativeEvent === "pre_llm_call" ? "context" : null;
  }
}

/**
 * Render one state.db row as observation text.
 *
 * Content shapes verified against Hermes' persistence path: plain text rows
 * store a string in `content`, assistant messages may store OpenAI-style
 * content-part arrays (sometimes JSON-encoded), tool results arrive as
 * role="tool" with tool_name, and assistant tool-call requests live inside
 * `tool_calls` JSON. Nothing is dropped silently: a row with both text and
 * tool calls reports both, and tool arguments are included in bounded form so
 * the observer sees what was asked without a full transcript duplicate.
 */
export function summarizeRow(record: Record<string, unknown>): string | null {
  const role = stringValue(record.role) ?? "record";
  if (role === "session_meta") return null;
  const parts: string[] = [];

  const body = contentText(record.content);
  if (body) parts.push(`[${role}]\n${body}`);

  const toolName = stringValue(record.tool_name);
  if (toolName && role !== "assistant") {
    const failed = record.finish_reason === "error";
    if (!body || role === "tool") {
      parts.push(`[tool:${toolName}${failed ? " (error)" : ""}]`);
    }
  }

  const calls = parseToolCalls(record.tool_calls);
  if (calls.length > 0) {
    parts.push(
      ...calls.map(
        (call) =>
          `[assistant requested ${call.name}${call.args ? `: ${call.args}` : ""}]`,
      ),
    );
  }

  if (parts.length === 0) {
    // Keep the row visible even without readable content.
    return toolName ? `[${role}:${toolName}]` : null;
  }
  return parts.join("\n");
}

function contentText(content: unknown): string | undefined {
  let value = content;
  // A JSON-encoded content array arrives as a plain string; try decoding it
  // before treating the text literally.
  if (typeof value === "string" && /^\s*[[{]/.test(value)) {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      value = content; // Fall back to the original plain string.
    }
  }
  if (typeof value === "string") {
    return value.trim() ? truncateText(value, 8_000) : undefined;
  }
  if (isRecord(value)) {
    const text = stringValue(value.text) ?? stringValue(value.content);
    return text && text.trim() ? truncateText(text, 8_000) : undefined;
  }
  if (Array.isArray(value)) {
    const pieces = value
      .map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item)) {
          return stringValue(item.text) ?? stringValue(item.content);
        }
        return undefined;
      })
      .filter((piece): piece is string => Boolean(piece && piece.trim()));
    if (pieces.length > 0) return truncateText(pieces.join("\n"), 8_000);
  }
  return undefined;
}

interface ToolCallSummary {
  name: string;
  /** Bounded arguments summary, or undefined when there is nothing to show. */
  args?: string;
}

function parseToolCalls(raw: unknown): ToolCallSummary[] {
  let value = raw;
  if (typeof value === "string") {
    if (!value.trim()) return [];
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((call) => {
    const fn = isRecord(call.function) ? call.function : call;
    const name = stringValue(fn.name) ?? "unknown-tool";
    const argsRaw = fn.arguments ?? fn.args ?? fn.input;
    let args: string | undefined;
    if (typeof argsRaw === "string" && argsRaw.trim()) {
      args = truncateText(argsRaw.trim(), 400);
    } else if (isRecord(argsRaw) && Object.keys(argsRaw).length > 0) {
      try {
        args = truncateText(JSON.stringify(argsRaw), 400);
      } catch {
        args = undefined;
      }
    }
    return { name, ...(args ? { args } : {}) };
  });
}

export const hermesAdapter = new HermesAdapter();
