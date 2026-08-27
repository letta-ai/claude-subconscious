import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../packages/adapter-claude-code/index.js";
import { codexAdapter } from "../packages/adapter-codex/index.js";
import { lettaCodeAdapter } from "../packages/adapter-letta-code/index.js";
import { opencodeAdapter } from "../packages/adapter-opencode/index.js";
import {
  enrichHookInput,
  formatHookOutput,
  targetFor,
} from "../packages/cli/hook.js";

describe("hook context", () => {
  it("fills Letta Code Stop identity from the hook process environment", () => {
    expect(
      enrichHookInput(
        {
          event_type: "Stop",
          working_directory: "/project",
          assistant_message: "done",
        },
        "letta-code",
        {
          AGENT_ID: "agent-parent",
          CONVERSATION_ID: "conv-parent",
        },
      ),
    ).toMatchObject({
      agent_id: "agent-parent",
      conversation_id: "conv-parent",
      working_directory: "/project",
    });
  });

  it("keeps native hook identity ahead of ambient identity", () => {
    expect(
      enrichHookInput(
        {
          session_id: "native-session",
          conversation_id: "native-conversation",
          cwd: "/native-project",
        },
        "claude-code",
        {
          CONVERSATION_ID: "ambient-conversation",
          LETTA_WORKING_DIR: "/ambient-project",
        },
      ),
    ).toMatchObject({
      session_id: "native-session",
      conversation_id: "native-conversation",
      working_directory: "/native-project",
    });
  });

  it("does not copy ambient Letta identity into Claude or Codex hooks", () => {
    expect(
      enrichHookInput(
        { session_id: "claude-session", cwd: "/project" },
        "claude-code",
        { CONVERSATION_ID: "ambient-conversation" },
      ),
    ).not.toHaveProperty("conversation_id");
  });
});

describe("hook delivery target", () => {
  const prompt = (agentId: string) => ({
    event_type: "UserPromptSubmit",
    working_directory: "/project",
    conversation_id: "default",
    agent_id: agentId,
    prompt: "Check the release order.",
  });

  it("scopes the shared local conversation name by agent", async () => {
    // Two agents in one project both report conversation_id "default", so a
    // target read from the conversation alone would lease and acknowledge
    // against the other agent's session.
    const first = targetFor("letta-code", prompt("agent-one"));
    const second = targetFor("letta-code", prompt("agent-two"));
    expect(first?.sessionId).toBe("agent-one:default");
    expect(second?.sessionId).toBe("agent-two:default");
    expect(first?.sessionId).not.toBe(second?.sessionId);
  });

  it("leases the session the observation created", async () => {
    // observe keys the route, lease and ack look it up: a disagreement here is
    // a session that silently never receives a whisper.
    for (const agentId of ["agent-one", "agent-two"]) {
      const input = prompt(agentId);
      const observation = await lettaCodeAdapter.normalizeHookInput(input);
      expect(targetFor("letta-code", input)?.sessionId).toBe(
        observation?.sessionId,
      );
    }
  });

  it("scopes by the agent identity the hook environment supplied", () => {
    const input = enrichHookInput(
      {
        event_type: "Stop",
        working_directory: "/project",
        assistant_message: "done",
      },
      "letta-code",
      { AGENT_ID: "agent-ambient", CONVERSATION_ID: "default" },
    );
    expect(targetFor("letta-code", input)?.sessionId).toBe(
      "agent-ambient:default",
    );
  });

  it("keeps other harnesses on their own session identity", () => {
    expect(
      targetFor("claude-code", {
        session_id: "claude-session",
        agent_id: "agent-one",
        cwd: "/project",
      })?.sessionId,
    ).toBe("claude-session");
  });

  it("has no target without a conversation to key one from", () => {
    expect(
      targetFor("letta-code", { working_directory: "/project" }),
    ).toBeNull();
    expect(targetFor("letta-code", prompt("agent-one"))).toMatchObject({
      harness: "letta-code",
      workingDirectory: "/project",
    });
  });

  it("has no Letta Code target without an agent route scope", () => {
    expect(
      targetFor("letta-code", {
        event_type: "UserPromptSubmit",
        working_directory: "/project",
        conversation_id: "default",
      }),
    ).toBeNull();
  });
});

describe("hook context output", () => {
  it("writes plain text on the stdout channel", () => {
    expect(formatHookOutput("SessionStart", "context", "stdout")).toBe(
      "context",
    );
    expect(formatHookOutput("UserPromptSubmit", "context", "stdout")).toBe(
      "context",
    );
  });

  it("names the event in the envelope the tool hooks require", () => {
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const output = formatHookOutput(event, "context", "envelope");
      expect(output).not.toBeNull();
      expect(JSON.parse(output!)).toEqual({
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: "context",
        },
      });
    }
  });

  it("says nothing when there is no context", () => {
    expect(formatHookOutput("PreToolUse", "", "envelope")).toBeNull();
    expect(formatHookOutput("UserPromptSubmit", "", "stdout")).toBeNull();
  });
});

describe("adapter context channels", () => {
  it("gives Claude Code the tool boundaries on the envelope channel", () => {
    expect(claudeCodeAdapter.contextChannel("SessionStart")).toBe("stdout");
    expect(claudeCodeAdapter.contextChannel("UserPromptSubmit")).toBe("stdout");
    expect(claudeCodeAdapter.contextChannel("PreToolUse")).toBe("envelope");
    expect(claudeCodeAdapter.contextChannel("PostToolUse")).toBe("envelope");
  });

  it("refuses the events whose output the harness discards", () => {
    for (const event of ["PreCompact", "Notification", "SessionEnd", "Stop"]) {
      expect(claudeCodeAdapter.contextChannel(event)).toBeNull();
    }
  });

  it("keeps Letta Code on raw stdout at the prompt boundaries", () => {
    // Letta Code pushes stdout into context verbatim, so an envelope here
    // would inject its own JSON as literal text.
    expect(lettaCodeAdapter.contextChannel("SessionStart")).toBe("stdout");
    expect(lettaCodeAdapter.contextChannel("UserPromptSubmit")).toBe("stdout");
  });

  it("gives Codex the envelope on all four context boundaries", () => {
    // Codex is not Claude Code here, even though it shares
    // `defaultContextChannel` with it: confirmed live, plain stdout on
    // SessionStart/UserPromptSubmit completes the hook but the text never
    // becomes model-attended context, while the identical text sent as
    // `hookSpecificOutput.additionalContext` is read reliably. Claude Code
    // and Letta Code genuinely do read plain stdout at these boundaries, so
    // the override lives on the Codex adapter, not in the shared default.
    expect(codexAdapter.contextChannel("SessionStart")).toBe("envelope");
    expect(codexAdapter.contextChannel("UserPromptSubmit")).toBe("envelope");
    expect(codexAdapter.contextChannel("PreToolUse")).toBe("envelope");
    expect(codexAdapter.contextChannel("PostToolUse")).toBe("envelope");
  });

  it("withholds PreToolUse from Letta Code, which reads no context there", () => {
    // A whisper emitted here would be acknowledged and never seen.
    expect(lettaCodeAdapter.contextChannel("PreToolUse")).toBeNull();
    expect(lettaCodeAdapter.contextChannel("PostToolUse")).toBe("envelope");
    expect(lettaCodeAdapter.contextChannel("PostToolUseFailure")).toBe(
      "envelope",
    );
  });

  it("claims nothing on events no harness reads", () => {
    for (const adapter of [
      claudeCodeAdapter,
      codexAdapter,
      lettaCodeAdapter,
      opencodeAdapter,
    ]) {
      expect(adapter.contextChannel("PreCompact")).toBeNull();
      expect(adapter.contextChannel("SessionEnd")).toBeNull();
    }
  });
});
