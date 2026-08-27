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
    send: vi.fn(async (_message: string, _options?: { otid: string }) => {}),
    close: vi.fn(),
    conversationId: "conv-observer",
    ready: vi.fn(async () => ({
      agentId: "agent-observer",
      model: "letta/auto",
      conversationId: "conv-observer",
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
    conversations: {
      create: vi.fn(async () => ({ id: "conv-observer", hidden: true })),
      update: vi.fn(async () => ({})),
    },
    resumeSession: vi.fn(
      (_conversationId: string, options: LettaCodeClientSessionOptions) => {
        captured.options = options;
        return session;
      },
    ),
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
      ready: vi.fn(async () => ({
        agentId: "agent-observer",
        model: "letta/auto",
        conversationId: "conv-observer",
        tools: ["Read", "send_whisper"],
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
    let createdPayload: Record<string, unknown> | undefined;
    const client = {
      conversations: {
        create: vi.fn(async (payload: Record<string, unknown>) => {
          createdPayload = payload;
          return { id: "conv-observer", hidden: true };
        }),
        update: vi.fn(async () => ({})),
      },
      resumeSession: vi.fn(
        (_conversationId: string, options: LettaCodeClientSessionOptions) => {
          sessionOptions = options;
          return session;
        },
      ),
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
      ready: async () => ({
        agentId: "agent-observer",
        model: "letta/auto",
        conversationId: "conv-observer",
      }),
      async *stream(): AsyncGenerator<never> {
        throw new Error("connection lost");
      },
    };
    const client = {
      createSession: () => session,
      resumeSession: () => session,
      agents: { retrieve: async () => ({ tools: [] }) },
      conversations: { update: async () => ({}) },
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
      ready: async () => ({
        agentId: "agent-observer",
        model: "letta/auto",
        conversationId: "conv-observer",
      }),
      async *stream(): AsyncGenerator<never> {},
    };
    const client = {
      createSession: () => session,
      resumeSession: () => session,
      agents: { retrieve: async () => ({ tools: [] }) },
      conversations: { update: async () => ({}) },
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
      conversations: {
        create: () => {
          throw new Error("invalid conversation setup");
        },
        update: async () => ({}),
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
    expect(sandbox.client.conversations.create).not.toHaveBeenCalled();
    expect(local.captured.options?.cwd).toBe("/project");
    expect(local.captured.options?.env).toEqual({ LETTA_API_KEY: "test-key" });
  });

  it("applies the project model to the observer conversation", async () => {
    const local = recordingClient(observerSession());
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: local.client as unknown as LettaAgentClient,
    });
    const input = observation({
      ...projectConfig(false),
      model: "anthropic/claude-sonnet-4-5",
    });
    input.route = route("conv-observer");

    const result = await runtime.run(input);

    expect(result.status).toBe("success");
    expect(local.client.resumeSession).toHaveBeenCalledWith(
      "conv-observer",
      expect.anything(),
    );
    expect(local.captured.options?.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("prefers the harness override over the project model", async () => {
    const local = recordingClient(observerSession());
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: local.client as unknown as LettaAgentClient,
    });
    const config = {
      ...projectConfig(false),
      model: "letta/auto",
      modelOverrides: {
        claude_code: {
          model: "anthropic/claude-sonnet-5",
          reasoningEffort: "high" as const,
        },
      },
    };
    const result = await runtime.run(observation(config));

    expect(local.captured.options?.model).toBe("anthropic/claude-sonnet-5");
    expect(local.captured.options?.reasoningEffort).toBe("high");
  });

  it("inherits the agent default when no level names a model", async () => {
    const session = observerSession();
    session.ready.mockImplementation(async () => ({
      agentId: "agent-observer",
      model: "anthropic/claude-opus-4-6",
      conversationId: "conv-observer",
    }));
    const local = recordingClient(session);
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: local.client as unknown as LettaAgentClient,
    });
    const input = observation({
      version: 1,
      agentId: "agent-observer",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
    input.route = route("conv-observer");

    const result = await runtime.run(input);

    expect(result.status).toBe("success");
    expect(local.captured.options?.model).toBeUndefined();
    expect(local.captured.options?.reasoningEffort).toBeUndefined();
    // Inheritance is honest in both directions: the route reports where the
    // model came from and what the backend actually resolved.
    expect(result.status === "success" && result.effectiveModel).toBe(
      "anthropic/claude-opus-4-6",
    );
  });

  it("reconciles a changed override onto an existing conversation before opening it", async () => {
    const local = recordingClient(observerSession());
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: local.client as unknown as LettaAgentClient,
    });
    const input = observation({
      ...projectConfig(false),
      modelOverrides: {
        claude_code: {
          model: "openai/gpt-5.2",
          contextWindowLimit: 200000,
          settings: { temperature: 0.2 },
        },
      },
    });
    input.route = {
      ...route("conv-observer"),
      appliedModelState: {
        model: null,
        modelSettings: null,
        contextWindowLimit: null,
      },
    };

    const result = await runtime.run(input);

    expect(result.status).toBe("success");
    expect(local.client.conversations.update).toHaveBeenCalledWith(
      "conv-observer",
      {
        model: "openai/gpt-5.2",
        contextWindowLimit: 200000,
        modelSettings: { temperature: 0.2 },
      },
    );
    // The management call lands before the session opens so the turn itself
    // runs on the state the file asked for.
    expect(
      local.client.conversations.update.mock.invocationCallOrder[0],
    ).toBeLessThan(local.client.resumeSession.mock.invocationCallOrder[0]);
    expect(result.status === "success" && result.appliedModelState).toEqual({
      model: "openai/gpt-5.2",
      contextWindowLimit: 200000,
      modelSettings: { temperature: 0.2 },
      reasoningEffort: null,
    });
  });

  it("skips reconciliation when the persisted override already matches", async () => {
    const local = recordingClient(observerSession());
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: local.client as unknown as LettaAgentClient,
    });
    const input = observation(projectConfig(false));
    input.route = {
      ...route("conv-observer"),
      appliedModelState: {
        model: "letta/auto",
        modelSettings: null,
        contextWindowLimit: null,
      },
    };

    await runtime.run(input);

    expect(local.client.conversations.update).not.toHaveBeenCalled();
  });

  it("clears a removed override back to inheritance on an existing conversation", async () => {
    const local = recordingClient(observerSession());
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: local.client as unknown as LettaAgentClient,
    });
    const input = observation({
      version: 1,
      agentId: "agent-observer",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
    input.route = {
      ...route("conv-observer"),
      appliedModelState: {
        model: "anthropic/claude-sonnet-5",
        modelSettings: { temperature: 0.2 },
        contextWindowLimit: 200000,
      },
    };

    const result = await runtime.run(input);

    expect(result.status).toBe("success");
    expect(local.captured.options?.model).toBeUndefined();
    expect(local.client.conversations.update).toHaveBeenCalledWith(
      "conv-observer",
      { model: null, contextWindowLimit: null, modelSettings: null },
    );
  });

  it("reconciles when only a nested setting changes", async () => {
    const local = recordingClient(observerSession());
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: local.client as unknown as LettaAgentClient,
    });
    const input = observation({
      ...projectConfig(false),
      modelOverrides: {
        claude_code: {
          model: "openai/gpt-5.2",
          settings: {
            temperature: 0.2,
            thinking: { type: "enabled", budget_tokens: 1024 },
          },
        },
      },
    });
    input.route = {
      ...route("conv-observer"),
      appliedModelState: {
        model: "openai/gpt-5.2",
        contextWindowLimit: null,
        reasoningEffort: null,
        modelSettings: {
          temperature: 0.2,
          thinking: { type: "enabled", budget_tokens: 2048 },
        },
      },
    };

    const result = await runtime.run(input);

    // A replacer-array comparison would call these two trees equal and skip
    // the update; the nested budget change must reconcile.
    expect(result.status).toBe("success");
    expect(local.client.conversations.update).toHaveBeenCalledWith(
      "conv-observer",
      {
        model: "openai/gpt-5.2",
        contextWindowLimit: null,
        modelSettings: {
          temperature: 0.2,
          thinking: { type: "enabled", budget_tokens: 1024 },
        },
      },
    );
  });

  it("ignores key-order differences inside settings", async () => {
    const local = recordingClient(observerSession());
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: local.client as unknown as LettaAgentClient,
    });
    const input = observation({
      ...projectConfig(false),
      modelOverrides: {
        claude_code: {
          model: "openai/gpt-5.2",
          settings: {
            temperature: 0.2,
            thinking: { budget_tokens: 2048, type: "enabled" },
          },
        },
      },
    });
    input.route = {
      ...route("conv-observer"),
      appliedModelState: {
        model: "openai/gpt-5.2",
        contextWindowLimit: null,
        reasoningEffort: null,
        // Same tree, different key order at both depths.
        modelSettings: {
          thinking: { type: "enabled", budget_tokens: 2048 },
          temperature: 0.2,
        },
      },
    };

    await runtime.run(input);

    expect(local.client.conversations.update).not.toHaveBeenCalled();
  });

  it("clears a persisted reasoning tier when the override is removed", async () => {
    const session = observerSession();
    const local = recordingClient(session);
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: local.client as unknown as LettaAgentClient,
    });
    const input = observation(projectConfig(false));
    input.route = {
      ...route("conv-observer"),
      appliedModelState: {
        model: "letta/auto",
        modelSettings: null,
        contextWindowLimit: null,
        reasoningEffort: "high",
      },
    };

    const result = await runtime.run(input);

    expect(result.status).toBe("success");
    // The stale high tier can persist inside the conversation's model
    // settings, so the reconciliation clears them before ready() applies the
    // session's own - absent - effort.
    expect(local.client.conversations.update).toHaveBeenCalledWith(
      "conv-observer",
      {
        model: "letta/auto",
        contextWindowLimit: null,
        modelSettings: null,
      },
    );
    expect(local.captured.options?.reasoningEffort).toBeUndefined();
    expect(result.status === "success" && result.appliedModelState).toEqual({
      model: "letta/auto",
      modelSettings: null,
      contextWindowLimit: null,
      reasoningEffort: null,
    });
  });

  it("clears the old tier before applying a changed reasoning effort", async () => {
    const session = observerSession();
    const local = recordingClient(session);
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: local.client as unknown as LettaAgentClient,
    });
    const input = observation({
      ...projectConfig(false),
      modelOverrides: { claude_code: { reasoningEffort: "medium" } },
    });
    input.route = {
      ...route("conv-observer"),
      appliedModelState: {
        model: "letta/auto",
        modelSettings: null,
        contextWindowLimit: null,
        reasoningEffort: "high",
      },
    };

    const result = await runtime.run(input);

    expect(result.status).toBe("success");
    expect(local.client.conversations.update).toHaveBeenCalledWith(
      "conv-observer",
      {
        model: "letta/auto",
        contextWindowLimit: null,
        modelSettings: null,
      },
    );
    // The cleared conversation settings cannot outvote the session's new tier.
    const updateOrder =
      local.client.conversations.update.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(
      local.client.resumeSession.mock.invocationCallOrder[0],
    );
    expect(updateOrder).toBeLessThan(session.ready.mock.invocationCallOrder[0]);
    expect(local.captured.options?.reasoningEffort).toBe("medium");
    expect(result.status === "success" && result.appliedModelState).toEqual({
      model: "letta/auto",
      modelSettings: null,
      contextWindowLimit: null,
      reasoningEffort: "medium",
    });
  });

  it("reconciles a legacy route that never recorded applied state", async () => {
    const session = observerSession();
    session.ready.mockImplementation(
      async () =>
        ({
          agentId: "agent-observer",
          model: undefined,
          conversationId: "conv-observer",
        }) as unknown as Awaited<ReturnType<typeof session.ready>>,
    );
    const local = recordingClient(session);
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: local.client as unknown as LettaAgentClient,
    });
    const input = observation(projectConfig(false));
    // Written by a build that predated overrides: the bare model field, no
    // recorded applied state.
    input.route = { ...route("conv-observer"), model: "letta/auto" };

    const result = await runtime.run(input);

    expect(result.status).toBe("success");
    expect(local.client.conversations.update).toHaveBeenCalledWith(
      "conv-observer",
      {
        model: "letta/auto",
        contextWindowLimit: null,
        modelSettings: null,
      },
    );
    expect(result.status === "success" && result.appliedModelState).toEqual({
      model: "letta/auto",
      modelSettings: null,
      contextWindowLimit: null,
      reasoningEffort: null,
    });
    // The backend reported no model this turn, so the route must record the
    // absence instead of keeping any earlier value.
    expect(
      result.status === "success" ? result.effectiveModel : undefined,
    ).toBeNull();
  });

  it("creates a fresh conversation with its full override payload before resuming it", async () => {
    const session = observerSession();
    const local = recordingClient(session);
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: local.client as unknown as LettaAgentClient,
    });
    const input = observation({
      ...projectConfig(false),
      modelOverrides: {
        claude_code: {
          model: "anthropic/claude-sonnet-5",
          contextWindowLimit: 128000,
          settings: { temperature: 0.1 },
        },
      },
    });

    await runtime.run(input);

    // The conversation is born with every persistent override already on it,
    // so the first turn cannot run on a configuration that a post-hoc patch
    // would have missed.
    expect(local.client.conversations.create).toHaveBeenCalledWith({
      agentId: "agent-observer",
      hidden: true,
      model: "anthropic/claude-sonnet-5",
      contextWindowLimit: 128000,
      modelSettings: { temperature: 0.1 },
    });
    expect(local.client.conversations.update).not.toHaveBeenCalled();
    expect(local.client.resumeSession).toHaveBeenCalledWith(
      "conv-observer",
      expect.anything(),
    );
    // Creation strictly precedes resume, which strictly precedes ready and
    // the first send.
    const createOrder =
      local.client.conversations.create.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(
      local.client.resumeSession.mock.invocationCallOrder[0],
    );
    expect(createOrder).toBeLessThan(session.ready.mock.invocationCallOrder[0]);
    expect(createOrder).toBeLessThan(session.send.mock.invocationCallOrder[0]);
  });

  it("creates an inheritance-only conversation without any model fields", async () => {
    const local = recordingClient(observerSession());
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: local.client as unknown as LettaAgentClient,
    });

    const result = await runtime.run(
      observation({
        version: 1,
        agentId: "agent-observer",
        delivery: { whispers: true, queueMessages: false },
        observer: {},
      }),
    );

    expect(result.status).toBe("success");
    // No level names a model, so nothing is requested on creation and the
    // conversation inherits whatever the agent defaults to.
    expect(local.client.conversations.create).toHaveBeenCalledWith({
      agentId: "agent-observer",
      hidden: true,
    });
    expect(local.captured.options?.model).toBeUndefined();
    expect(local.captured.options?.reasoningEffort).toBeUndefined();
    // Every turn resumes by conversation ID; the agent default conversation is
    // never opened.
    expect(local.client.resumeSession).toHaveBeenCalledTimes(1);
  });

  it("reports a failed override reconciliation before anything is sent", async () => {
    const session = observerSession();
    const local = recordingClient(session);
    // The backend rejects this exact handle; the error must name it.
    const invalidHandle = "openai/gpt-9";
    local.client.conversations.update.mockRejectedValue(
      new Error(`unknown model handle ${invalidHandle}`),
    );
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: local.client as unknown as LettaAgentClient,
    });
    const input = observation({
      ...projectConfig(false),
      modelOverrides: { claude_code: { model: invalidHandle } },
    });
    input.route = {
      ...route("conv-observer"),
      appliedModelState: {
        model: null,
        modelSettings: null,
        contextWindowLimit: null,
      },
    };

    const result = await runtime.run(input);

    expect(result).toMatchObject({
      status: "failed",
      error: `unknown model handle ${invalidHandle}`,
    });
    // The failing handle is what was actually sent, so the error is
    // attributable to the configuration rather than to transport noise.
    expect(local.client.conversations.update).toHaveBeenCalledWith(
      "conv-observer",
      expect.objectContaining({ model: invalidHandle }),
    );
    expect(session.send).not.toHaveBeenCalled();
  });

  it("primes only a newly created Subconscious conversation", async () => {
    const session = observerSession();
    const local = recordingClient(session);
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: local.client as unknown as LettaAgentClient,
    });

    await runtime.run(observation(projectConfig(false)));
    const resumed = observation(projectConfig(false));
    resumed.route = route("conv-observer");
    await runtime.run(resumed);

    const first = String(session.send.mock.calls[0]?.[0]);
    const second = String(session.send.mock.calls[1]?.[0]);
    expect(first).toContain("This agent session is using Subconscious");
    expect(first).toContain('<observation type="turn_stop">');
    expect(second).toBe(
      '<observation type="turn_stop">\nObserved turn.\n</observation>',
    );
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
    expect(local.client.conversations.create).not.toHaveBeenCalled();
    expect(sandbox.client.conversations.create).toHaveBeenCalledOnce();
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

describe("direct queued-message delivery", () => {
  function harnessClient(
    conversation: { id: string; agent_id: string } | Error,
    session = {
      send: vi.fn(async () => {}),
      close: vi.fn(),
      conversationId: "conv-harness",
      stream: vi.fn(() =>
        (async function* () {
          yield {
            type: "result" as const,
            success: true,
            durationMs: 1,
            conversationId: "conv-harness",
            runIds: ["run-delivery"],
          };
        })(),
      ),
    },
  ) {
    const captured: { options?: LettaCodeClientSessionOptions } = {};
    const client = {
      conversations: {
        retrieve: vi.fn(async () => {
          if (conversation instanceof Error) throw conversation;
          return conversation;
        }),
        listMessages: vi.fn(async () => ({ messages: [] })),
      },
      resumeSession: vi.fn(
        (_id: string, options: LettaCodeClientSessionOptions) => {
          captured.options = options;
          return session;
        },
      ),
    };
    return { client, captured, session };
  }

  const identity = {
    agentId: "agent-harness",
    conversationId: "conv-harness",
  };

  it("writes into the coding agent's conversation with no hook and no tools", async () => {
    const { client, captured, session } = harnessClient({
      id: "conv-harness",
      agent_id: "agent-harness",
    });
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: client as unknown as LettaAgentClient,
    });

    const result = await runtime.deliverQueuedMessage({
      identity,
      deliveryId: "delivery-one",
      text: "The migration has to run before the deploy.",
    });

    expect(result).toEqual({
      status: "delivered",
      nativeReceipt: "conv-harness",
    });
    expect(client.resumeSession).toHaveBeenCalledWith(
      "conv-harness",
      expect.anything(),
    );
    // The delivery ID doubles as the OTID so a retry deduplicates server side.
    expect(session.send).toHaveBeenCalledWith(
      "The migration has to run before the deploy.",
      { otid: "delivery-one" },
    );
    expect(session.stream).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledOnce();
    // A model would rewrite the coding agent's own configuration, and a client
    // tool would make the broker execute the coding agent's tool calls. The
    // SDK applies dreaming persistently with scope both, so it must stay off
    // the delivery options entirely rather than being explicitly disabled.
    expect(captured.options?.model).toBeUndefined();
    expect(captured.options?.reasoningEffort).toBeUndefined();
    expect(captured.options?.dreaming).toBeUndefined();
    expect(captured.options?.allowedTools).toEqual([]);
    expect(captured.options?.toolset).toEqual({ base: "none", include: [] });
    expect(
      captured.options?.canUseTool?.("Bash", {}, {
        signal: new AbortController().signal,
      } as never),
    ).toMatchObject({ behavior: "deny" });
  });

  it("reports a conversation that changed owner as stale", async () => {
    const { client, session } = harnessClient({
      id: "conv-harness",
      agent_id: "agent-someone-else",
    });
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: client as unknown as LettaAgentClient,
    });

    const result = await runtime.deliverQueuedMessage({
      identity,
      deliveryId: "delivery-one",
      text: "Do not send this to a replacement session.",
    });

    expect(result.status).toBe("stale");
    expect(client.resumeSession).not.toHaveBeenCalled();
    expect(session.send).not.toHaveBeenCalled();
  });

  it("keeps a transport failure retryable", async () => {
    const { client } = harnessClient(new Error("conversation lookup failed"));
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: client as unknown as LettaAgentClient,
    });

    const result = await runtime.deliverQueuedMessage({
      identity,
      deliveryId: "delivery-one",
      text: "Retry me.",
    });

    expect(result.status).toBe("retry");
    expect(result.error).toContain("conversation lookup failed");
  });

  it("keeps a rejected send retryable and closes the session", async () => {
    const session = {
      send: vi.fn(async () => {
        throw new Error("socket closed");
      }),
      close: vi.fn(),
      conversationId: "conv-harness",
      stream: vi.fn(() =>
        (async function* () {
          yield {
            type: "result" as const,
            success: true,
            durationMs: 1,
            conversationId: "conv-harness",
            runIds: ["run-delivery"],
          };
        })(),
      ),
    };
    const { client } = harnessClient(
      { id: "conv-harness", agent_id: "agent-harness" },
      session,
    );
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: client as unknown as LettaAgentClient,
    });

    const result = await runtime.deliverQueuedMessage({
      identity,
      deliveryId: "delivery-one",
      text: "Retry me.",
    });

    expect(result).toEqual({ status: "retry", error: "socket closed" });
    expect(session.stream).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("does not acknowledge a queued message before its turn completes", async () => {
    const session = {
      send: vi.fn(async () => {}),
      close: vi.fn(),
      conversationId: "conv-harness",
      stream: vi.fn(() =>
        (async function* () {
          yield {
            type: "result" as const,
            success: false,
            durationMs: 1,
            conversationId: "conv-harness",
            runIds: ["run-delivery"],
            errorDetail: "turn failed before persistence",
          };
        })(),
      ),
    };
    const { client } = harnessClient(
      { id: "conv-harness", agent_id: "agent-harness" },
      session,
    );
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: client as unknown as LettaAgentClient,
    });

    const result = await runtime.deliverQueuedMessage({
      identity,
      deliveryId: "delivery-one",
      text: "Retry the complete turn.",
    });

    expect(result).toEqual({
      status: "retry",
      error: "turn failed before persistence",
    });
    expect(session.stream).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("returns retry when the queued-message stream never settles", async () => {
    let releaseStream: (() => void) | undefined;
    const neverResult = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const session = {
      send: vi.fn(async () => {}),
      close: vi.fn(() => {
        releaseStream?.();
      }),
      conversationId: "conv-harness",
      stream: vi.fn(() =>
        (async function* () {
          await neverResult;
        })(),
      ),
    };
    const { client } = harnessClient(
      { id: "conv-harness", agent_id: "agent-harness" },
      session,
    );
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: client as unknown as LettaAgentClient,
      queuedMessageTimeoutMs: 25,
    });

    const result = await runtime.deliverQueuedMessage({
      identity,
      deliveryId: "delivery-hang",
      text: "Do not wait forever.",
    });

    expect(result.status).toBe("retry");
    expect(result.error).toContain("timed out after 25ms");
    expect(result.error).toContain("terminal SDK result");
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("acknowledges a persisted OTID on retry instead of sending a second turn", async () => {
    const persisted: { otid?: string }[] = [];
    let releaseStream: (() => void) | undefined;
    const neverResult = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const session = {
      send: vi.fn(async (_text: string, options?: { otid: string }) => {
        persisted.push({ otid: options?.otid });
      }),
      close: vi.fn(() => {
        releaseStream?.();
      }),
      conversationId: "conv-harness",
      stream: vi.fn(() =>
        (async function* () {
          await neverResult;
        })(),
      ),
    };
    const { client } = harnessClient(
      { id: "conv-harness", agent_id: "agent-harness" },
      session,
    );
    client.conversations.listMessages = vi.fn(async () => ({
      messages: [...persisted],
    }));
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: client as unknown as LettaAgentClient,
      queuedMessageTimeoutMs: 25,
    });
    const input = {
      identity,
      deliveryId: "delivery-hang",
      text: "Do not wait forever.",
    };

    const first = await runtime.deliverQueuedMessage(input);
    expect(client.conversations.listMessages).not.toHaveBeenCalled();
    const second = await runtime.deliverQueuedMessage({
      ...input,
      previousAttempts: 1,
    });

    expect(first.status).toBe("retry");
    expect(first.error).toContain("timed out after 25ms");
    expect(second).toEqual({
      status: "delivered",
      nativeReceipt: "conv-harness",
    });
    expect(session.send).toHaveBeenCalledOnce();
    expect(client.conversations.listMessages).toHaveBeenCalledWith(
      "conv-harness",
      expect.objectContaining({ limit: 100, order: "desc" }),
    );
    expect("list" in client.conversations).toBe(false);
  });

  it("keeps an OTID lookup failure retryable without sending", async () => {
    const { client, session } = harnessClient({
      id: "conv-harness",
      agent_id: "agent-harness",
    });
    client.conversations.listMessages = vi.fn(async () => {
      throw new Error("history unavailable");
    });
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: client as unknown as LettaAgentClient,
    });

    const result = await runtime.deliverQueuedMessage({
      identity,
      deliveryId: "delivery-one",
      previousAttempts: 1,
      text: "Do not send this while history is unread.",
    });

    expect(result.status).toBe("retry");
    expect(result.error).toContain("history unavailable");
    expect(client.resumeSession).not.toHaveBeenCalled();
    expect(session.send).not.toHaveBeenCalled();
  });

  it("sends once when startup recovery and the drain race on one record", async () => {
    let release: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = {
      send: vi.fn(async () => {
        await inFlight;
      }),
      close: vi.fn(),
      conversationId: "conv-harness",
      stream: vi.fn(() =>
        (async function* () {
          yield {
            type: "result" as const,
            success: true,
            durationMs: 1,
            conversationId: "conv-harness",
            runIds: ["run-delivery"],
          };
        })(),
      ),
    };
    const { client } = harnessClient(
      { id: "conv-harness", agent_id: "agent-harness" },
      session,
    );
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: client as unknown as LettaAgentClient,
    });
    const input = {
      identity,
      deliveryId: "delivery-race",
      text: "Ship the lock fix.",
    };

    // Both loops grab the same pending record in the same instant.
    const first = runtime.deliverQueuedMessage(input);
    const second = runtime.deliverQueuedMessage(input);
    while (session.send.mock.calls.length === 0) {
      await Promise.resolve();
    }
    release?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe("delivered");
    expect(secondResult.status).toBe("delivered");
    // The second caller joined the first's in-flight send instead of opening
    // its own session for the same record.
    expect(session.send).toHaveBeenCalledOnce();
    expect(session.stream).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("serializes distinct deliveries so their turns never interleave", async () => {
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const session = {
      send: vi.fn(async (message: string) => {
        events.push(`send:${message}`);
        if (message === "first") await firstGate;
      }),
      close: vi.fn(),
      conversationId: "conv-harness",
      stream: vi.fn(() =>
        (async function* () {
          yield {
            type: "result" as const,
            success: true,
            durationMs: 1,
            conversationId: "conv-harness",
            runIds: ["run-delivery"],
          };
        })(),
      ),
    };
    const { client } = harnessClient(
      { id: "conv-harness", agent_id: "agent-harness" },
      session,
    );
    const runtime = new AgentRuntime({
      apiKey: "test-key",
      client: client as unknown as LettaAgentClient,
    });

    const first = runtime.deliverQueuedMessage({
      identity,
      deliveryId: "delivery-a",
      text: "first",
    });
    const second = runtime.deliverQueuedMessage({
      identity,
      deliveryId: "delivery-b",
      text: "second",
    });
    // Give the second call a chance to run ahead; serialization must hold it
    // until the first turn has fully settled.
    await Promise.resolve();
    await Promise.resolve();
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(events.indexOf("send:first")).toBeLessThan(
      events.indexOf("send:second"),
    );
    expect(session.send).toHaveBeenCalledTimes(2);
  });
});
