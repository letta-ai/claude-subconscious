import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../packages/adapter-claude-code/index.js";
import { codexAdapter } from "../packages/adapter-codex/index.js";
import { lettaCodeAdapter } from "../packages/adapter-letta-code/index.js";
import { opencodeAdapter } from "../packages/adapter-opencode/index.js";
import { enrichHookInput, formatHookOutput } from "../packages/cli/hook.js";

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

  it("keeps every harness on raw stdout at the prompt boundaries", () => {
    // Letta Code pushes stdout into context verbatim, so an envelope here
    // would inject its own JSON as literal text.
    for (const adapter of [codexAdapter, lettaCodeAdapter]) {
      expect(adapter.contextChannel("SessionStart")).toBe("stdout");
      expect(adapter.contextChannel("UserPromptSubmit")).toBe("stdout");
    }
  });

  it("gives Codex both tool boundaries", () => {
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
