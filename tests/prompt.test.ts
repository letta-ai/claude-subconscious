import { describe, expect, it } from "vitest";
import {
  formatObservationPrompt,
  OBSERVER_SYSTEM_PROMPT,
} from "../packages/agent-runtime/prompt.js";
import type { HarnessEvent, ProjectConfig } from "../packages/core/index.js";

describe("observer context-management prompt", () => {
  it("defines MemFS routing, retrieval, and next-turn delivery", () => {
    expect(OBSERVER_SYSTEM_PROMPT).toContain(
      "observes coding agents and builds memory across all of them",
    );
    expect(OBSERVER_SYSTEM_PROMPT).toContain(
      "Retrieve related context from MemFS",
    );
    expect(OBSERVER_SYSTEM_PROMPT).toContain(
      "Route new durable information into MemFS",
    );
    expect(OBSERVER_SYSTEM_PROMPT).toContain(
      "frequently needed facts under system/",
    );
    expect(OBSERVER_SYSTEM_PROMPT).toContain(
      "detailed decisions, explanations, incidents, and history under reference/",
    );
    expect(OBSERVER_SYSTEM_PROMPT).toContain(
      "These are MemFS files, not memory blocks",
    );
    expect(OBSERVER_SYSTEM_PROMPT).toContain(
      "becomes available at the next safe prompt boundary",
    );
  });

  it("asks each observer turn to retrieve, route, and prepare context", () => {
    const event: HarnessEvent = {
      id: "event-1",
      harness: "claude-code",
      type: "user_prompt",
      sessionId: "session-1",
      workingDirectory: "/project",
      occurredAt: "2026-08-18T00:00:00.000Z",
      payload: {},
    };
    const config: ProjectConfig = {
      version: 1,
      agentId: "agent-observer",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    };

    const prompt = formatObservationPrompt(
      event,
      config,
      "Implement the status formatter.",
      ["send_whisper"],
      "/project",
    );

    expect(prompt).toContain("maintain MemFS");
    expect(prompt).toContain(
      "Check MemFS for information tied to the active task",
    );
    expect(prompt).toContain(
      "prepare relevant context for the next coding-agent turn",
    );
    expect(prompt).toContain("Silence is the normal outcome");
  });

  it("makes silence the default and names what the agent already holds", () => {
    expect(OBSERVER_SYSTEM_PROMPT).toContain(
      "The coding agent sees the whole current session",
    );
    expect(OBSERVER_SYSTEM_PROMPT).toContain("Silence is the normal outcome");
    expect(OBSERVER_SYSTEM_PROMPT).toContain(
      "Summaries, recaps, or status reports of what just happened",
    );
    expect(OBSERVER_SYSTEM_PROMPT).toContain(
      "Facts you learned only from the observation you were just handed",
    );
    expect(OBSERVER_SYSTEM_PROMPT).toContain(
      "State only what you have verified in MemFS or in a file you read",
    );
  });

  it("tells a sandboxed observer that the project is unreadable", () => {
    const event: HarnessEvent = {
      id: "event-1",
      harness: "claude-code",
      type: "user_prompt",
      sessionId: "session-1",
      workingDirectory: "/project",
      occurredAt: "2026-08-18T00:00:00.000Z",
      payload: {},
    };
    const config: ProjectConfig = {
      version: 1,
      agentId: "agent-observer",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    };

    expect(
      formatObservationPrompt(
        event,
        config,
        "Observed.",
        ["send_whisper"],
        "/project",
      ),
    ).not.toContain("managed sandbox");
    expect(
      formatObservationPrompt(
        event,
        { ...config, observer: { sandbox: true } },
        "Observed.",
        ["send_whisper"],
        "/project",
      ),
    ).toContain(
      "Your tools run in a managed sandbox that does not mount it, so MemFS and this observation are the only readable sources.",
    );
  });

  it("tells a mid-turn observer that the agent is still working", () => {
    const config: ProjectConfig = {
      version: 1,
      agentId: "agent-observer",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: { midTurn: { minToolCalls: 5, minSeconds: 90 } },
    };
    const toolResult: HarnessEvent = {
      id: "event-tool",
      harness: "claude-code",
      type: "tool_result",
      sessionId: "session-1",
      workingDirectory: "/project",
      occurredAt: "2026-08-18T00:00:00.000Z",
      payload: { tool_name: "Bash" },
    };

    const prompt = formatObservationPrompt(
      toolResult,
      config,
      "Claude Code is still working on this turn.",
      ["send_whisper"],
      "/project",
    );

    expect(prompt).toContain("in the middle of this turn");
    expect(prompt).toContain("at its next tool boundary");
    // Reaching a turn already in progress raises the bar rather than lowering
    // it, so the mid-turn branch states the default more strongly.
    expect(prompt).toContain("Silence is even more strongly the default here");
    expect(OBSERVER_SYSTEM_PROMPT).toContain("Observing a turn in progress");
  });

  it("primes a starting session with a cheatsheet instead of the usual bar", () => {
    const config: ProjectConfig = {
      version: 1,
      agentId: "agent-observer",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    };
    const sessionStart: HarnessEvent = {
      id: "event-start",
      harness: "claude-code",
      type: "session_start",
      sessionId: "session-1",
      workingDirectory: "/project",
      occurredAt: "2026-08-18T00:00:00.000Z",
      payload: {},
    };

    const prompt = formatObservationPrompt(
      sessionStart,
      config,
      "Claude Code session session-1 started in /project.",
      ["send_whisper"],
      "/project",
    );

    expect(prompt).toContain("Prime the coding agent before it works");
    expect(prompt).toContain("compact cheatsheet");
    expect(prompt).toContain("so it reaches the first turn");
    // The usual restraint does not apply when there is no transcript yet.
    expect(prompt).not.toContain("Silence is the normal outcome");
  });
});
