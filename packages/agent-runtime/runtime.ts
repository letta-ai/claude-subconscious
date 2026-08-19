import {
  LettaAgentClient,
  type LettaCodeCloudSandboxOptions,
  type SDKResultMessage,
} from "@letta-ai/letta-agent-sdk";
import type {
  AdapterCapabilities,
  AdapterDeliveryResult,
  DeliveryRecord,
  HarnessEvent,
  HarnessLettaIdentity,
  PreparedObservation,
  ProjectConfig,
  RouteRecord,
} from "../core/index.js";
import { formatObservationPrompt } from "./prompt.js";
import { createDeliveryTools } from "./tools.js";

const OBSERVER_TOOLS = [
  "Read",
  "LS",
  "Glob",
  "Grep",
  "memory_apply_patch",
] as const;

/**
 * Managed-sandbox settings for projects that move observer tools off this
 * machine.
 *
 * Every observation opens and closes a session on the same resumed
 * conversation, so terminating the sandbox on close would pay a cold start per
 * turn. The refresh interval stays below the TTL so an idle turn cannot expire
 * the sandbox mid-session.
 */
const SANDBOX_OPTIONS: LettaCodeCloudSandboxOptions = {
  ttlMinutes: 5,
  readyTimeoutMs: 120_000,
  readyPollIntervalMs: 1_000,
  refreshIntervalMs: 240_000,
  terminateOnClose: false,
};

export interface AgentRuntimeOptions {
  apiKey: string;
  client?: LettaAgentClient;
  /**
   * Client for projects that enable the managed sandbox. It defaults to a Cloud
   * client that owns the sandbox, and is constructed only when such a project
   * runs, so local projects never open a Cloud session.
   */
  sandboxClient?: LettaAgentClient;
}

export interface RunObservationInput {
  event: HarnessEvent;
  route: RouteRecord;
  config: ProjectConfig;
  prepared: PreparedObservation;
  capabilities: AdapterCapabilities;
  persistDelivery(delivery: DeliveryRecord): Promise<void>;
}

export interface OtidConversationMatch {
  conversationId: string;
}

export interface QueuedMessageDelivery {
  /** The coding agent and conversation that receive the message. */
  identity: HarnessLettaIdentity;
  /**
   * The stable delivery ID. It travels as the send OTID so a retry after an
   * unknown transport result deduplicates instead of posting the text twice.
   */
  deliveryId: string;
  text: string;
}

/**
 * Outcome of one direct delivery attempt. `error` explains a `retry` or a
 * `stale`, which no hook is present to report.
 */
export type QueuedMessageResult = AdapterDeliveryResult & { error?: string };

export type RunObservationResult =
  | {
      status: "success";
      conversationId: string;
      result: SDKResultMessage;
      runtimeReportedTools?: string[];
      attachedServerTools?: string[];
    }
  | {
      status: "failed" | "ambiguous";
      conversationId: string | null;
      error: string;
      result?: SDKResultMessage;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultError(result: SDKResultMessage): string {
  return (
    result.errorDetail ??
    result.error ??
    result.stopReason ??
    result.errorCode ??
    "The observer turn failed."
  );
}

export class AgentRuntime {
  private readonly client: LettaAgentClient;
  private readonly apiKey: string;
  private sandboxClient: LettaAgentClient | null;

  constructor(options: AgentRuntimeOptions) {
    this.apiKey = options.apiKey;
    this.client =
      options.client ??
      new LettaAgentClient({
        backend: "local",
        appServer: { harnessBackend: "api", pinGlobalAgent: false },
      });
    this.sandboxClient = options.sandboxClient ?? null;
  }

  /**
   * The client that runs one observation.
   *
   * The Cloud client owns the managed sandbox, so a sandboxed project must use
   * it for the session and for the tool inventory that follows the turn.
   * Otherwise the local App Server client keeps running tools on this machine.
   */
  private clientFor(config: ProjectConfig): LettaAgentClient {
    if (!config.observer.sandbox) return this.client;
    this.sandboxClient ??= new LettaAgentClient({
      backend: "cloud",
      apiKey: this.apiKey,
      sandbox: SANDBOX_OPTIONS,
    });
    return this.sandboxClient;
  }

  async findConversationByOtid(
    agentId: string,
    otid: string,
    preferredConversationId?: string | null,
  ): Promise<OtidConversationMatch | null> {
    const searched = new Set<string>();
    const conversationContainsOtid = async (
      conversationId: string,
    ): Promise<boolean> => {
      let before: string | undefined;
      const seenCursors = new Set<string>();
      while (true) {
        const page = await this.client.conversations.listMessages(
          conversationId,
          {
            limit: 100,
            order: "desc",
            ...(before ? { before } : {}),
          },
        );
        if (page.messages.some((message) => message.otid === otid)) return true;
        const next = page.nextBefore ?? undefined;
        if (!next || page.hasMore === false || seenCursors.has(next))
          return false;
        seenCursors.add(next);
        before = next;
      }
    };
    if (preferredConversationId) {
      searched.add(preferredConversationId);
      if (await conversationContainsOtid(preferredConversationId)) {
        return { conversationId: preferredConversationId };
      }
    }

    let after: string | undefined;
    const seenPages = new Set<string>();
    while (true) {
      const conversations = await this.client.conversations.list({
        agentId,
        limit: 100,
        order: "desc",
        orderBy: "lastMessageAt",
        ...(after ? { after } : {}),
      });
      if (conversations.length === 0) return null;
      for (const conversation of conversations) {
        if (searched.has(conversation.id)) continue;
        searched.add(conversation.id);
        if (await conversationContainsOtid(conversation.id)) {
          return { conversationId: conversation.id };
        }
      }
      if (conversations.length < 100) return null;
      const next = conversations.at(-1)?.id;
      if (!next || seenPages.has(next)) return null;
      seenPages.add(next);
      after = next;
    }
  }

  /**
   * Put an actionable message into a coding agent's own Letta conversation.
   *
   * This is why `queue_message` can exist for Letta Code at all. The target is
   * a Letta conversation, so the broker writes into it with the Agent SDK
   * instead of waiting for a hook to open a delivery window. The message is in
   * the coding agent's context from its next turn onward.
   *
   * The session deliberately carries no model and no tools. A model would
   * rewrite the coding agent's own configuration, and any client tool would
   * make the broker process a device that executes the coding agent's tool
   * calls. Subconscious is delivering a message here, not running the harness.
   */
  async deliverQueuedMessage(
    input: QueuedMessageDelivery,
  ): Promise<QueuedMessageResult> {
    const { identity } = input;
    let conversation;
    try {
      conversation = await this.client.conversations.retrieve(
        identity.conversationId,
      );
    } catch (error) {
      // A lookup that fails is usually transport, not a deleted conversation,
      // so the delivery stays pending rather than being written off as stale.
      return {
        status: "retry",
        error: `The Letta Code conversation ${identity.conversationId} could not be read: ${errorMessage(error)}`,
      };
    }
    if (conversation.agent_id !== identity.agentId) {
      // The conversation belongs to another agent now. A queued message must
      // never land in a replacement session, so it stops here permanently.
      return {
        status: "stale",
        error: `Conversation ${identity.conversationId} belongs to ${conversation.agent_id}, not to the observed agent ${identity.agentId}.`,
      };
    }
    let session: ReturnType<LettaAgentClient["resumeSession"]> | null = null;
    try {
      session = this.client.resumeSession(identity.conversationId, {
        allowedTools: [],
        toolset: { base: "none", include: [] },
        permissionMode: "standard",
        canUseTool: (toolName: string) => ({
          behavior: "deny" as const,
          message: `Subconscious opened this session only to deliver a message. Tool ${toolName} is not available on it.`,
          interrupt: false,
        }),
        skillSources: [],
        dreaming: { trigger: "off" },
        env: { LETTA_API_KEY: this.apiKey },
      });
      await session.send(input.text, { otid: input.deliveryId });
      // The stream is not drained. The message is persisted in the conversation
      // once send resolves, and the coding agent's turn is its own business and
      // can outlast this process by minutes.
      return { status: "delivered", nativeReceipt: identity.conversationId };
    } catch (error) {
      return { status: "retry", error: errorMessage(error) };
    } finally {
      session?.close();
    }
  }

  async run(input: RunObservationInput): Promise<RunObservationResult> {
    const allowWhisper =
      input.config.delivery.whispers && input.capabilities.passiveContext;
    const allowQueuedMessage =
      input.config.delivery.queueMessages && input.capabilities.queuedMessage;
    const deliveryTools = createDeliveryTools({
      observationId: input.event.id,
      routeKey: input.route.key,
      allowWhisper,
      allowQueuedMessage,
      persist: input.persistDelivery,
    });
    const allowedTools = [
      ...OBSERVER_TOOLS,
      ...deliveryTools.map((tool) => tool.name),
    ];
    const canUseTool = (toolName: string) =>
      allowedTools.includes(toolName)
        ? { behavior: "allow" as const }
        : {
            behavior: "deny" as const,
            message: `Tool ${toolName} is not in the Subconscious client allowlist.`,
            interrupt: false,
          };
    const client = this.clientFor(input.config);
    const sandboxed = input.config.observer.sandbox === true;
    const sessionOptions = {
      model: input.config.model,
      allowedTools,
      toolset: { base: "none" as const, include: [...OBSERVER_TOOLS] },
      permissionMode: "standard" as const,
      canUseTool,
      /**
       * A managed sandbox does not mount the project, so the project root names
       * a path that does not exist there, and cloud transports ignore session
       * env. The Cloud client carries the credential for those sessions.
       */
      ...(sandboxed
        ? {}
        : {
            cwd: input.route.projectRoot,
            env: { LETTA_API_KEY: this.apiKey },
          }),
      skillSources: [],
      dreaming: { trigger: "off" as const },
      tools: deliveryTools,
      maxApprovalRecoveryAttempts: 0,
    };
    let session: ReturnType<LettaAgentClient["createSession"]> | null = null;
    let sendMayHaveStarted = false;
    try {
      session = input.route.conversationId
        ? client.resumeSession(input.route.conversationId, sessionOptions)
        : client.createSession(input.route.agentId, sessionOptions);
      const initialized = await session.bootstrapState({ limit: 1 });
      const message = formatObservationPrompt(
        input.event,
        input.config,
        input.prepared.text,
        deliveryTools.map((tool) => tool.name),
        input.route.projectRoot,
      );
      sendMayHaveStarted = true;
      await session.send(message, { otid: input.event.id });
      let result: SDKResultMessage | null = null;
      for await (const sdkMessage of session.stream()) {
        if (sdkMessage.type === "result") result = sdkMessage;
      }
      if (!result) {
        return {
          status: "ambiguous",
          conversationId: session.conversationId,
          error: "The Agent SDK stream ended without a terminal result.",
        };
      }
      if (!result.success) {
        return {
          status: "failed",
          conversationId: result.conversationId ?? session.conversationId,
          error: resultError(result),
          result,
        };
      }
      const conversationId = result.conversationId ?? session.conversationId;
      if (!conversationId) {
        return {
          status: "ambiguous",
          conversationId: null,
          error: "The observer turn succeeded without a conversation ID.",
        };
      }
      const attachedServerTools = await client.agents
        .retrieve(input.route.agentId)
        .then((agent) =>
          agent.tools?.flatMap((tool) => (tool.name ? [tool.name] : [])),
        )
        .catch(() => undefined);
      return {
        status: "success",
        conversationId,
        result,
        ...(initialized.tools
          ? { runtimeReportedTools: [...initialized.tools] }
          : {}),
        ...(attachedServerTools ? { attachedServerTools } : {}),
      };
    } catch (error) {
      return {
        status: sendMayHaveStarted ? "ambiguous" : "failed",
        conversationId: session?.conversationId ?? input.route.conversationId,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      session?.close();
    }
  }
}
