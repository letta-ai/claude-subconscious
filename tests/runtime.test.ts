import type {
  LettaAgentClient,
  LettaCodeClientSessionOptions,
} from "@letta-ai/letta-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../packages/agent-runtime/index.js";
import type { ProjectConfig, RouteRecord } from "../packages/core/index.js";

function route(conversationId: string | null = null): RouteRecord {
  return {
    key: "route",
    configPath: "/project/subconscious.toml",
    projectRoot: "/project",
    agentId: "agent-observer",
    model: "letta/auto",
    harness: "claude-code",
    sessionId: "session",
    conversationId,
    createdAt: "now",
    updatedAt: "now",
  };
}

function observerSession() {
  return {
    send: vi.fn(async () => {}),
    close: vi.fn(),
    conversationId: "conv-observer",
    bootstrapState: vi.fn(async () => ({
      agentId: "agent-observer",
      model: "letta/auto",
      conversationId: "conv-observer",
      messages: [],
    })),
    async *stream() {
      yield {
        type: "result",
        success: true,
        durationMs: 1,
        conversationId: "conv-observer",
        runIds: ["run-one"],
      };
    },
  };
}

/**
 * A client that records the options of the session it was asked to open, so a
 * test can prove which client ran the turn and what it sent.
 */
function recordingClient(session: ReturnType<typeof observerSession>) {
  const captured: { options?: LettaCodeClientSessionOptions } = {};
  const client = {
    createSession: vi.fn(
      (_agentId: string, options: LettaCodeClientSessionOptions) => {
        captured.options = options;
        return session;
      },
    ),
    resumeSession: vi.fn(),
    agents: { retrieve: vi.fn(async () => ({ tools: [] })) },
  };
  return { client, captured };
}

function observation(config: ProjectConfig) {
  return {
    event: {
      id: "event",
      harness: "claude-code" as const,
      type: "turn_stop" as const,
      sessionId: "session",
      workingDirectory: "/project",
      occurredAt: "now",
      payload: {},
    },
    route: route(),
    config,
    prepared: { text: "Observed turn." },
    capabilities: {
      passiveContext: true,
      queuedMessage: false,
      transcript: "file" as const,
    },
    persistDelivery: async () => {},
  };
}

function projectConfig(sandbox: boolean): ProjectConfig {
  return {
    version: 1,
    agentId: "agent-observer",
    model: "letta/auto",
    delivery: { whispers: true, queueMessages: false },
    observer: sandbox ? { sandbox: true } : {},
  };
}

describe("Agent SDK runtime", () => {
  it("uses an exact read and delivery toolset and discards assistant text", async () => {
    const send = vi.fn(async () => {});
    const close = vi.fn();
    const session = {
      send,
      close,
      conversationId: "conv-observer",
      bootstrapState: vi.fn(async () => ({
        agentId: "agent-observer",
        model: "letta/auto",
        conversationId: "conv-observer",
        tools: ["Read", "send_whisper"],
        messages: [],
      })),
      async *stream() {
        yield {
          type: "assistant",
          content: "This text must not be delivered.",
          uuid: "message",
        };
        yield {
          type: "result",
          success: true,
          durationMs: 1,
          conversationId: "conv-observer",
          runIds: ["run-one"],
        };
      },
    };
    let sessionOptions: LettaCodeClientSessionOptions | undefined;
    const client = {
      createSession: vi.fn(
        (_agentId: string, options: LettaCodeClientSessionOptions) => {
          sessionOptions = options;
          return session;
        },
      ),
      resumeSession: vi.fn(),
      agents: {
        retrieve: vi.fn(async () => ({ tools: [{ name: "memory" }] })),
      },
    } as unknown as LettaAgentClient;
    const persisted = vi.fn(async () => {});
    const runtime = new AgentRuntime({ apiKey: "test-key", client });

    const result = await runtime.run({
      event: {
        id: "event",
        harness: "claude-code",
        type: "turn_stop",
        sessionId: "session",
        workingDirectory: "/project",
        occurredAt: "now",
        payload: {},
      },
      route: route(),
      config: {
        version: 1,
        agentId: "agent-observer",
        model: "letta/auto",
        delivery: { whispers: true, queueMessages: true },
        observer: {},
      },
      prepared: { text: "Observed turn." },
      capabilities: {
        passiveContext: true,
        queuedMessage: false,
        transcript: "file",
      },
      persistDelivery: persisted,
    });

    expect(result.status).toBe("success");
    expect(sessionOptions?.model).toBe("letta/auto");
    expect(sessionOptions?.allowedTools).toEqual([
      "Read",
      "LS",
      "Glob",
      "Grep",
      "memory_apply_patch",
      "send_whisper",
    ]);
    expect(sessionOptions?.toolset).toEqual({
      base: "none",
      include: ["Read", "LS", "Glob", "Grep", "memory_apply_patch"],
    });
    expect(sessionOptions?.skillSources).toEqual([]);
    expect(sessionOptions?.dreaming).toEqual({ trigger: "off" });
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining("Observed turn."),
      { otid: "event" },
    );
    expect(persisted).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      runtimeReportedTools: ["Read", "send_whisper"],
      attachedServerTools: ["memory"],
    });
  });

  it("classifies a stream failure after send as ambiguous", async () => {
    const session = {
      send: async () => {},
      close: () => {},
      conversationId: "conv-observer",
      bootstrapState: async () => ({
        agentId: "agent-observer",
        model: "letta/auto",
        conversationId: "conv-observer",
        messages: [],
      }),
      async *stream(): AsyncGenerator<never> {
        throw new Error("connection lost");
      },
    };
    const client = {
      createSession: () => session,
      resumeSession: () => session,
      agents: { retrieve: async () => ({ tools: [] }) },
    } as unknown as LettaAgentClient;
    const runtime = new AgentRuntime({ apiKey: "test-key", client });
    const result = await runtime.run({
      event: {
        id: "event",
        harness: "letta-code",
        type: "turn_stop",
        sessionId: "session",
        workingDirectory: "/project",
        occurredAt: "now",
        payload: {},
      },
      route: route("conv-observer"),
      config: {
        version: 1,
        agentId: "agent-observer",
        model: "letta/auto",
        delivery: { whispers: true, queueMessages: false },
        observer: {},
      },
      prepared: { text: "Observed turn." },
      capabilities: {
        passiveContext: true,
        queuedMessage: false,
        transcript: "events",
      },
      persistDelivery: async () => {},
    });
    expect(result).toMatchObject({
      status: "ambiguous",
      error: "connection lost",
    });
  });

  it("treats a rejected send as ambiguous because transport may have accepted it", async () => {
    const session = {
      send: async () => {
        throw new Error("acknowledgement lost");
      },
      close: () => {},
      conversationId: "conv-observer",
      bootstrapState: async () => ({
        agentId: "agent-observer",
        model: "letta/auto",
        conversationId: "conv-observer",
        messages: [],
      }),
      async *stream(): AsyncGenerator<never> {},
    };
    const client = {
      createSession: () => session,
      resumeSession: () => session,
      agents: { retrieve: async () => ({ tools: [] }) },
    } as unknown as LettaAgentClient;
    const runtime = new AgentRuntime({ apiKey: "test-key", client });
    const result = await runtime.run({
      event: {
        id: "event",
        harness: "letta-code",
        type: "turn_stop",
        sessionId: "session",
        workingDirectory: "/project",
        occurredAt: "now",
        payload: {},
      },
      route: route("conv-observer"),
      config: {
        version: 1,
        agentId: "agent-observer",
        model: "letta/auto",
        delivery: { whispers: true, queueMessages: false },
        observer: {},
      },
      prepared: { text: "Observed turn." },
      capabilities: {
        passiveContext: true,
        queuedMessage: false,
        transcript: "events",
      },
      persistDelivery: async () => {},
    });
    expect(result).toMatchObject({
      status: "ambiguous",
      error: "acknowledgement lost",
      conversationId: "conv-observer",
    });
  });

  it("classifies a synchronous session-construction failure", async () => {
    const client = {
      createSession: () => {
        throw new Error("invalid conversation setup");
      },
      resumeSession: () => {
        throw new Error("invalid conversation setup");
      },
      agents: { retrieve: async () => ({ tools: [] }) },
    } as unknown as LettaAgentClient;
    const runtime = new AgentRuntime({ apiKey: "test-key", client });
    const result = await runtime.run({
      event: {
        id: "event",
        harness: "claude-code",
        type: "turn_stop",
        sessionId: "session",
        workingDirectory: "/project",
        occurredAt: "now",
        payload: {},
      },
      route: route(),
      config: {
        version: 1,
        agentId: "agent-observer",
        model: "letta/auto",
        delivery: { whispers: true, queueMessages: false },
        observer: {},
      },
      prepared: { text: "Observed turn." },
      capabilities: {
        passiveContext: true,
        queuedMessage: false,
        transcript: "file",
      },
      persistDelivery: async () => {},
    });
    expect(result).toEqual({
      status: "failed",
      conversationId: null,
      error: "invalid conversation setup",
    });
  });

  it("runs tools on this machine when no project asks for a sandbox", async () => {
    const local = recordingClient(observerSession());
    const sandbox = recordingClient(observerSession());
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: local.client as unknown as LettaAgentClient,
      sandboxClient: sandbox.client as unknown as LettaAgentClient,
    });

    const result = await runtime.run(observation(projectConfig(false)));

    expect(result.status).toBe("success");
    expect(sandbox.client.createSession).not.toHaveBeenCalled();
    expect(local.captured.options?.cwd).toBe("/project");
    expect(local.captured.options?.env).toEqual({ LETTA_API_KEY: "test-key" });
  });

  it("moves a sandboxed project onto the Cloud client without the project root", async () => {
    const local = recordingClient(observerSession());
    const sandbox = recordingClient(observerSession());
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: local.client as unknown as LettaAgentClient,
      sandboxClient: sandbox.client as unknown as LettaAgentClient,
    });

    const result = await runtime.run(observation(projectConfig(true)));

    expect(result.status).toBe("success");
    expect(local.client.createSession).not.toHaveBeenCalled();
    expect(sandbox.client.createSession).toHaveBeenCalledOnce();
    // The sandbox has no project checkout and cloud transports ignore session
    // env, so neither belongs on the session.
    expect(sandbox.captured.options?.cwd).toBeUndefined();
    expect(sandbox.captured.options?.env).toBeUndefined();
    // MemFS travels with the agent, so the read tools still have something to
    // read, and the delivery tools still execute in the broker process.
    expect(sandbox.captured.options?.allowedTools).toEqual([
      "Read",
      "LS",
      "Glob",
      "Grep",
      "memory_apply_patch",
      "send_whisper",
    ]);
    expect(sandbox.captured.options?.tools?.map((tool) => tool.name)).toEqual([
      "send_whisper",
    ]);
    expect(sandbox.client.agents.retrieve).toHaveBeenCalledWith(
      "agent-observer",
    );
    expect(local.client.agents.retrieve).not.toHaveBeenCalled();
  });

  it("finds an interrupted OTID through Agent SDK conversation history", async () => {
    const client = {
      conversations: {
        list: vi.fn(async () => [{ id: "conv-new" }, { id: "conv-match" }]),
        listMessages: vi.fn(async (conversationId: string) => ({
          messages:
            conversationId === "conv-match" ? [{ otid: "event-otid" }] : [],
        })),
      },
    } as unknown as LettaAgentClient;
    const runtime = new AgentRuntime({ apiKey: "test-key", client });
    await expect(
      runtime.findConversationByOtid("agent-observer", "event-otid", null),
    ).resolves.toEqual({ conversationId: "conv-match" });
    expect(client.conversations.list).toHaveBeenCalledWith({
      agentId: "agent-observer",
      limit: 100,
      order: "desc",
      orderBy: "lastMessageAt",
    });
  });
});
