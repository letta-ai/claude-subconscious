import { describe, expect, it } from "vitest";
import { enrichHookInput } from "../packages/cli/hook.js";

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
