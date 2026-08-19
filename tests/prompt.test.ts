import { describe, expect, it } from "vitest";
import {
  formatObservationPrompt,
  OBSERVER_SYSTEM_PROMPT,
} from "../packages/agent-runtime/prompt.js";
import type { HarnessEvent, ProjectConfig } from "../packages/core/index.js";

describe("observer context-management prompt", () => {
  it("defines MemFS routing, retrieval, and next-turn delivery", () => {
    expect(OBSERVER_SYSTEM_PROMPT).toContain(
      "the context manager for coding-agent sessions",
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
  });
});
