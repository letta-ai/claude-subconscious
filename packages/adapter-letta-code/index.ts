import { randomUUID } from "node:crypto";
import {
  defaultContextChannel,
  escapeXml,
  eventId,
  formatSessionStatus,
  truncateText,
  type ContextChannel,
  type DeliveryRecord,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessLettaIdentity,
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

export class LettaCodeAdapter implements HarnessAdapter {
  readonly id = "letta-code" as const;
  readonly capabilities = {
    passiveContext: true,
    // Letta Code is not a foreign harness: the session it runs is a Letta agent
    // in a Letta conversation, so the broker adds a queued message to that
    // conversation through the Agent SDK. No hook carries it and no turn
    // boundary gates it, which is what makes an actionable message possible
    // here and impossible in Claude Code and Codex.
    queuedMessage: true,
    transcript: "events" as const,
  };

  async normalizeHookInput(input: unknown): Promise<HarnessEvent | null> {
    if (!isRecord(input)) return null;
    const event =
      stringValue(input.event_type) ?? stringValue(input.hook_event_name);
    const type =
      event === "SessionStart"
        ? "session_start"
        : event === "UserPromptSubmit"
          ? "user_prompt"
          : event === "Stop"
            ? "turn_stop"
            : null;
    if (!type) return null;
    const sessionId =
      stringValue(input.conversation_id) ?? stringValue(input.session_id);
    const workingDirectory =
      stringValue(input.working_directory) ?? stringValue(input.cwd);
    if (!sessionId || !workingDirectory) return null;
    const nativeId =
      stringValue(input.event_id) ??
      stringValue(input.turn_id) ??
      stringValue(input.run_id) ??
      stringValue(input.message_id);
    const occurrence =
      nativeId ??
      (type === "session_start" ? input.is_new_session : randomUUID());
    return {
      id: eventId([
        this.id,
        sessionId,
        event,
        workingDirectory,
        occurrence,
        input.prompt,
        input.user_message,
        input.assistant_message,
        input.stop_reason,
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
    _cursor: SourceCursor | undefined,
  ): Promise<PreparedObservation> {
    if (event.type === "session_start") {
      return {
        text: `Letta Code session ${event.sessionId} started in ${event.workingDirectory}.`,
      };
    }
    if (event.type === "user_prompt") {
      const prompt = stringValue(event.payload.prompt) ?? "";
      return {
        text: `Letta Code user prompt:\n${truncateText(prompt, 12_000)}`,
      };
    }
    const user = stringValue(event.payload.user_message);
    const assistant = stringValue(event.payload.assistant_message);
    const stopReason = stringValue(event.payload.stop_reason) ?? "unknown";
    const parts = [
      `Letta Code turn stopped with reason ${stopReason}.`,
      user ? `User:\n${truncateText(user, 12_000)}` : null,
      assistant ? `Letta Code:\n${truncateText(assistant, 12_000)}` : null,
    ].filter((part): part is string => Boolean(part));
    return { text: parts.join("\n\n") };
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
   * The coding agent behind this hook, not the observer.
   *
   * `sessionId` already carries the Letta Code conversation, but a queued
   * message is addressed to an agent as well as a conversation, and reading
   * both from the payload keeps the pair consistent. The hook fills `agent_id`
   * from its input or from AGENT_ID/LETTA_AGENT_ID; an event without it cannot
   * be addressed and returns null rather than a half identity.
   */
  harnessLettaIdentity(event: HarnessEvent): HarnessLettaIdentity | null {
    const agentId = stringValue(event.payload.agent_id);
    const conversationId =
      stringValue(event.payload.conversation_id) ?? event.sessionId;
    if (!agentId || !conversationId) return null;
    return { agentId, conversationId };
  }

  contextChannel(nativeEvent: string): ContextChannel | null {
    // Letta Code reads additionalContext after a tool runs but not before:
    // PreToolUse consumes only updatedInput, so a whisper emitted there would
    // be acknowledged and never seen. PostToolUseFailure has no counterpart in
    // the other harnesses.
    if (nativeEvent === "PostToolUse" || nativeEvent === "PostToolUseFailure") {
      return "envelope";
    }
    // SessionStart and UserPromptSubmit push raw stdout into context, so an
    // envelope there would inject its own JSON as literal text.
    return defaultContextChannel(nativeEvent);
  }
}

export const lettaCodeAdapter = new LettaCodeAdapter();
