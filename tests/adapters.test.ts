import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../packages/adapter-claude-code/index.js";
import { codexAdapter } from "../packages/adapter-codex/index.js";
import { lettaCodeAdapter } from "../packages/adapter-letta-code/index.js";
import type { HarnessAdapter } from "../packages/core/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "subconscious-adapter-"));
  roots.push(value);
  return value;
}

describe("harness adapters", () => {
  it("reads only new Claude Code transcript records", async () => {
    const directory = await root();
    const transcript = join(directory, "transcript.jsonl");
    const first = `${JSON.stringify({ type: "user", message: { content: "first" } })}\n`;
    await writeFile(
      transcript,
      `${first}${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "second" }] } })}\n`,
    );
    const event = await claudeCodeAdapter.normalizeHookInput({
      hook_event_name: "Stop",
      session_id: "session",
      cwd: directory,
      transcript_path: transcript,
    });
    expect(event).not.toBeNull();
    const prepared = await claudeCodeAdapter.prepareObservation(event!, {
      offset: Buffer.byteLength(first),
    });
    expect(prepared.text).toContain("second");
    expect(prepared.text).not.toContain("first");
  });

  // Both transcript-reading harnesses answer the same questions about a prompt
  // boundary, and the only difference that matters to a caller is the label.
  const promptAdapters: Array<{ adapter: HarnessAdapter; label: string }> = [
    { adapter: claudeCodeAdapter, label: "Claude Code user prompt" },
    { adapter: codexAdapter, label: "Codex user prompt" },
  ];

  it("observes a submitted prompt before the turn that answers it", async () => {
    for (const { adapter, label } of promptAdapters) {
      const directory = await root();
      const transcript = join(directory, "transcript.jsonl");
      await writeFile(
        transcript,
        `${JSON.stringify({ type: "user", message: { content: "earlier turn" } })}\n`,
      );
      const event = await adapter.normalizeHookInput({
        hook_event_name: "UserPromptSubmit",
        session_id: "session",
        cwd: directory,
        transcript_path: transcript,
        prompt: "Ship the release notes first.",
      });
      expect(event).toMatchObject({
        harness: adapter.id,
        type: "user_prompt",
        sessionId: "session",
      });
      const prepared = await adapter.prepareObservation(event!, undefined);
      expect(prepared.text).toBe(`${label}:\nShip the release notes first.`);
      // The prompt is the whole observation. Reading the transcript here would
      // resend the previous turn and move the cursor turn_stop depends on.
      expect(prepared.text).not.toContain("earlier turn");
      expect(prepared.nextCursor).toBeUndefined();
    }
  });

  it("keeps a submitted prompt distinct from the Stop of the same turn", async () => {
    for (const { adapter } of promptAdapters) {
      const directory = await root();
      const transcript = join(directory, "transcript.jsonl");
      await writeFile(transcript, "{}\n");
      // Nothing writes to the transcript between these calls, so the marker is
      // identical and only the native name and the prompt text separate them.
      const base = {
        session_id: "session",
        cwd: directory,
        transcript_path: transcript,
        turn_id: "turn-1",
      };
      const first = await adapter.normalizeHookInput({
        ...base,
        hook_event_name: "UserPromptSubmit",
        prompt: "first",
      });
      const second = await adapter.normalizeHookInput({
        ...base,
        hook_event_name: "UserPromptSubmit",
        prompt: "second",
      });
      const stop = await adapter.normalizeHookInput({
        ...base,
        hook_event_name: "Stop",
      });
      expect(new Set([first!.id, second!.id, stop!.id]).size).toBe(3);
    }
  });

  it("reports a prompt event whose hook input carries no prompt text", async () => {
    for (const { adapter, label } of promptAdapters) {
      const event = await adapter.normalizeHookInput({
        hook_event_name: "UserPromptSubmit",
        session_id: "session",
        cwd: await root(),
      });
      expect(event?.type).toBe("user_prompt");
      const prepared = await adapter.prepareObservation(event!, undefined);
      expect(prepared.text).toBe(
        `${label} submitted with no prompt text on the hook input.`,
      );
      expect(prepared.nextCursor).toBeUndefined();
    }
  });

  it("bounds a very large submitted prompt", async () => {
    for (const { adapter } of promptAdapters) {
      const event = await adapter.normalizeHookInput({
        hook_event_name: "UserPromptSubmit",
        session_id: "session",
        cwd: await root(),
        prompt: "x".repeat(40_000),
      });
      const prepared = await adapter.prepareObservation(event!, undefined);
      expect(prepared.text).toContain("[truncated]");
      expect(prepared.text.length).toBeLessThan(13_000);
    }
  });

  // Mid-turn observation is the same contract in both transcript harnesses:
  // PostToolUse becomes a tool_result event carrying route identity only.
  const midTurnAdapters: Array<{ adapter: HarnessAdapter; label: string }> = [
    { adapter: claudeCodeAdapter, label: "Claude Code" },
    { adapter: codexAdapter, label: "Codex" },
  ];

  it("observes a finished tool call without storing the tool payload", async () => {
    for (const { adapter } of midTurnAdapters) {
      const directory = await root();
      const transcript = join(directory, "transcript.jsonl");
      await writeFile(transcript, "{}\n");
      const event = await adapter.normalizeHookInput({
        hook_event_name: "PostToolUse",
        session_id: "session",
        cwd: directory,
        transcript_path: transcript,
        tool_name: "Bash",
        tool_input: { command: "x".repeat(50_000) },
        tool_response: { stdout: "y".repeat(50_000) },
      });
      expect(event).toMatchObject({
        harness: adapter.id,
        type: "tool_result",
        sessionId: "session",
      });
      // The transcript delta already contains the call and its result, so the
      // unbounded fields are never worth a place in durable state.
      expect(event!.payload).toEqual({
        session_id: "session",
        cwd: directory,
        transcript_path: transcript,
        tool_name: "Bash",
      });
    }
  });

  it("marks a failed tool call on the mid-turn event", async () => {
    for (const { adapter } of midTurnAdapters) {
      const event = await adapter.normalizeHookInput({
        hook_event_name: "PostToolUse",
        session_id: "session",
        cwd: await root(),
        tool_name: "Bash",
        tool_response: { is_error: true, error: "exit 1" },
      });
      expect(event!.payload.tool_error).toBe(true);
      expect(
        (await adapter.prepareObservation(event!, undefined)).text,
      ).toContain("reported an error");
    }
  });

  it("reports the mid-turn transcript delta and advances the cursor", async () => {
    for (const { adapter, label } of midTurnAdapters) {
      const directory = await root();
      const transcript = join(directory, "transcript.jsonl");
      const first = `${JSON.stringify({ type: "user", message: { content: "earlier" } })}\n`;
      await writeFile(
        transcript,
        `${first}${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "mid-turn work" }] } })}\n`,
      );
      const event = await adapter.normalizeHookInput({
        hook_event_name: "PostToolUse",
        session_id: "session",
        cwd: directory,
        transcript_path: transcript,
        tool_name: "Read",
      });
      const prepared = await adapter.prepareObservation(event!, {
        offset: Buffer.byteLength(first),
      });
      expect(prepared.text).toContain(`${label} is still working on this turn`);
      expect(prepared.text).toContain("Read");
      expect(prepared.text).toContain("mid-turn work");
      expect(prepared.text).not.toContain("earlier");
      // The delta this observation consumed is the delta the next turn_stop
      // would have resent, so the cursor has to move with it.
      expect(prepared.nextCursor?.offset).toBe(
        Buffer.byteLength(await readFile(transcript, "utf8")),
      );
    }
  });

  it("keeps two tool calls in one turn distinct", async () => {
    for (const { adapter } of midTurnAdapters) {
      const directory = await root();
      const transcript = join(directory, "transcript.jsonl");
      await writeFile(transcript, "{}\n");
      // Nothing writes to the transcript between these calls, so the marker is
      // identical and only the call itself separates them.
      const base = {
        hook_event_name: "PostToolUse",
        session_id: "session",
        cwd: directory,
        transcript_path: transcript,
        turn_id: "turn-1",
      };
      const read = await adapter.normalizeHookInput({
        ...base,
        tool_name: "Read",
        tool_input: { file_path: "a.ts" },
      });
      const other = await adapter.normalizeHookInput({
        ...base,
        tool_name: "Read",
        tool_input: { file_path: "b.ts" },
      });
      const stop = await adapter.normalizeHookInput({
        ...base,
        hook_event_name: "Stop",
      });
      expect(new Set([read!.id, other!.id, stop!.id]).size).toBe(3);
    }
  });

  it("leaves PreToolUse unobserved", async () => {
    for (const { adapter } of midTurnAdapters) {
      // Nothing has happened yet when PreToolUse fires, so its delta is the one
      // the previous PostToolUse already reported.
      await expect(
        adapter.normalizeHookInput({
          hook_event_name: "PreToolUse",
          session_id: "session",
          cwd: await root(),
          tool_name: "Bash",
        }),
      ).resolves.toBeNull();
    }
  });

  it("does not observe Letta Code tool boundaries", async () => {
    // Letta Code formats its observations from the hook payload and keeps no
    // transcript cursor, so coalescing tool events there would drop payloads.
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
      await expect(
        lettaCodeAdapter.normalizeHookInput({
          event_type: event,
          working_directory: await root(),
          conversation_id: "conv-parent",
          tool_name: "Bash",
        }),
      ).resolves.toBeNull();
    }
  });

  it("normalizes Codex hook identity", async () => {
    const directory = await root();
    const event = await codexAdapter.normalizeHookInput({
      hook_event_name: "SessionStart",
      session_id: "thread",
      cwd: directory,
    });
    expect(event).toMatchObject({
      harness: "codex",
      type: "session_start",
      sessionId: "thread",
    });
  });

  it("keeps transcript-less Codex Stop events distinct", async () => {
    const directory = await root();
    const first = await codexAdapter.normalizeHookInput({
      hook_event_name: "Stop",
      session_id: "thread",
      cwd: directory,
      last_assistant_message: "first",
    });
    const second = await codexAdapter.normalizeHookInput({
      hook_event_name: "Stop",
      session_id: "thread",
      cwd: directory,
      last_assistant_message: "second",
    });
    expect(first?.id).not.toBe(second?.id);
  });

  it("uses the Letta Code agent and conversation as native session identity", async () => {
    const directory = await root();
    const event = await lettaCodeAdapter.normalizeHookInput({
      event_type: "Stop",
      working_directory: directory,
      conversation_id: "conv-parent",
      agent_id: "agent-parent",
      user_message: "question",
      assistant_message: "answer",
      stop_reason: "end_turn",
    });
    expect(event?.sessionId).toBe("agent-parent:conv-parent");
    expect(
      (await lettaCodeAdapter.prepareObservation(event!, undefined)).text,
    ).toContain("answer");
  });

  it("keeps identical Letta Code turns distinct without a native turn ID", async () => {
    const directory = await root();
    const input = {
      event_type: "Stop",
      working_directory: directory,
      conversation_id: "conv-parent",
      agent_id: "agent-parent",
      user_message: "same",
      assistant_message: "same",
      stop_reason: "end_turn",
    };
    const first = await lettaCodeAdapter.normalizeHookInput(input);
    const second = await lettaCodeAdapter.normalizeHookInput(input);
    expect(first?.id).not.toBe(second?.id);
  });

  it("observes Letta Code prompts with their conversation identity", async () => {
    const directory = await root();
    const event = await lettaCodeAdapter.normalizeHookInput({
      event_type: "UserPromptSubmit",
      working_directory: directory,
      conversation_id: "conv-parent",
      agent_id: "agent-parent",
      prompt: "Check the release order.",
    });
    expect(event).toMatchObject({
      harness: "letta-code",
      type: "user_prompt",
      sessionId: "agent-parent:conv-parent",
    });
    expect(
      (await lettaCodeAdapter.prepareObservation(event!, undefined)).text,
    ).toContain("Check the release order.");
  });

  it("exposes a queue only for the harness that is itself a Letta agent", () => {
    expect(lettaCodeAdapter.capabilities.queuedMessage).toBe(true);
    expect(claudeCodeAdapter.capabilities.queuedMessage).toBe(false);
    expect(codexAdapter.capabilities.queuedMessage).toBe(false);
    // A foreign harness has no Letta identity to address, so it cannot answer
    // the question at all.
    const foreign: HarnessAdapter[] = [claudeCodeAdapter, codexAdapter];
    for (const adapter of foreign) {
      expect(adapter.harnessLettaIdentity).toBeUndefined();
    }
  });

  it("reads the Letta Code agent's own identity from the hook payload", async () => {
    const directory = await root();
    const event = await lettaCodeAdapter.normalizeHookInput({
      event_type: "UserPromptSubmit",
      working_directory: directory,
      conversation_id: "conv-harness",
      agent_id: "agent-harness",
      prompt: "Check the release order.",
    });
    expect(lettaCodeAdapter.harnessLettaIdentity!(event!)).toEqual({
      agentId: "agent-harness",
      conversationId: "conv-harness",
    });
  });

  it("refuses a Letta Code route with an agent but no conversation", async () => {
    const directory = await root();
    const event = await lettaCodeAdapter.normalizeHookInput({
      event_type: "UserPromptSubmit",
      working_directory: directory,
      agent_id: "agent-harness",
      prompt: "Check the release order.",
    });
    expect(event).toBeNull();
  });

  it("separates two agents that share the local conversation name", async () => {
    // Letta Code 0.30.32 names the first local conversation of every agent
    // `default`, so a route keyed from the conversation alone merges two
    // agents working in one project into one session.
    const directory = await root();
    const prompt = (agentId: string) => ({
      event_type: "UserPromptSubmit" as const,
      working_directory: directory,
      conversation_id: "default",
      agent_id: agentId,
      prompt: "Check the release order.",
    });
    const first = await lettaCodeAdapter.normalizeHookInput(
      prompt("agent-one"),
    );
    const second = await lettaCodeAdapter.normalizeHookInput(
      prompt("agent-two"),
    );
    expect(first?.sessionId).toBe("agent-one:default");
    expect(second?.sessionId).toBe("agent-two:default");
    expect(first?.sessionId).not.toBe(second?.sessionId);
    // The queue is still addressed to the conversation Letta Code reported,
    // not to the scoped route id.
    expect(lettaCodeAdapter.harnessLettaIdentity!(first!)).toEqual({
      agentId: "agent-one",
      conversationId: "default",
    });
    expect(lettaCodeAdapter.harnessLettaIdentity!(second!)).toEqual({
      agentId: "agent-two",
      conversationId: "default",
    });
  });

  it("falls back to the session id for the conversation the queue addresses", async () => {
    const directory = await root();
    const event = await lettaCodeAdapter.normalizeHookInput({
      event_type: "UserPromptSubmit",
      working_directory: directory,
      session_id: "conv-fallback",
      agent_id: "agent-harness",
      prompt: "Check the release order.",
    });
    expect(event?.sessionId).toBe("agent-harness:conv-fallback");
    expect(lettaCodeAdapter.harnessLettaIdentity!(event!)).toEqual({
      agentId: "agent-harness",
      conversationId: "conv-fallback",
    });
  });

  it("rejects a Letta Code conversation without an agent route scope", async () => {
    const directory = await root();
    const event = await lettaCodeAdapter.normalizeHookInput({
      event_type: "UserPromptSubmit",
      working_directory: directory,
      conversation_id: "conv-parent",
      prompt: "Check the release order.",
    });
    expect(event).toBeNull();
  });

  it("skips Letta Code Stop events that have no conversation identity", async () => {
    await expect(
      lettaCodeAdapter.normalizeHookInput({
        event_type: "Stop",
        working_directory: await root(),
        user_message: "question",
        assistant_message: "answer",
      }),
    ).resolves.toBeNull();
  });
});

describe("session status", () => {
  const status = {
    agentId: "agent-f036ea00-dded-4f58-ab3b-044d2f42f9c5",
    model: "letta/auto",
    harness: "claude-code" as const,
    sessionId: "session-one",
    conversationId: "conv-one",
    projectRoot: "/project",
    whispers: true,
    queuedMessages: false,
  };

  it("reports the agent identity the terminal banner never shows the harness", () => {
    const output = claudeCodeAdapter.formatStatus(status);
    expect(output).toBe(
      '<subconscious_status agent_id="agent-f036ea00-dded-4f58-ab3b-044d2f42f9c5" conversation_id="conv-one" />',
    );
  });

  it("uses the same minimal identity for every harness", () => {
    const expected =
      '<subconscious_status agent_id="agent-f036ea00-dded-4f58-ab3b-044d2f42f9c5" conversation_id="conv-one" />';
    expect(claudeCodeAdapter.formatStatus(status)).toBe(expected);
    expect(codexAdapter.formatStatus(status)).toBe(expected);
    expect(lettaCodeAdapter.formatStatus(status)).toBe(expected);
  });

  it("omits a conversation attribute until one exists", () => {
    const output = claudeCodeAdapter.formatStatus({
      ...status,
      conversationId: null,
    });
    expect(output).toBe(
      '<subconscious_status agent_id="agent-f036ea00-dded-4f58-ab3b-044d2f42f9c5" />',
    );
  });
});
