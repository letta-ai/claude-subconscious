import { describe, expect, it } from "vitest";
import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { createObserverAgent } from "../packages/agent-runtime/index.js";

describe("observer agent creation", () => {
  it("uses only Agent SDK creation options supported by the App Server", async () => {
    let request: Record<string, unknown> | undefined;
    const client = {
      createAgent: async (input: Record<string, unknown>) => {
        request = input;
        return "agent-observer";
      },
    } as unknown as LettaAgentClient;

    await expect(
      createObserverAgent({ apiKey: "test-key", client }),
    ).resolves.toBe("agent-observer");
    expect(request).toMatchObject({
      hidden: true,
      model: "letta/auto",
      memfs: true,
      baseTools: [],
      skillSources: [],
    });
    expect(request).not.toHaveProperty("memory");
    expect(request).not.toHaveProperty("systemInfoReminder");
  });
});
