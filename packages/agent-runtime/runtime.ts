import {
  LettaAgentClient,
  type SDKResultMessage,
} from "@letta-ai/letta-agent-sdk";
import type {
  AdapterCapabilities,
  DeliveryRecord,
  HarnessEvent,
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

export interface AgentRuntimeOptions {
  apiKey: string;
  client?: LettaAgentClient;
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

  constructor(options: AgentRuntimeOptions) {
    this.apiKey = options.apiKey;
    this.client =
      options.client ??
      new LettaAgentClient({
        backend: "local",
        appServer: { harnessBackend: "api", pinGlobalAgent: false },
      });
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
    const sessionOptions = {
      model: input.config.model,
      allowedTools,
      toolset: { base: "none" as const, include: [...OBSERVER_TOOLS] },
      permissionMode: "standard" as const,
      canUseTool,
      cwd: input.route.projectRoot,
      env: { LETTA_API_KEY: this.apiKey },
      skillSources: [],
      dreaming: { trigger: "off" as const },
      tools: deliveryTools,
      maxApprovalRecoveryAttempts: 0,
    };
    let session: ReturnType<LettaAgentClient["createSession"]> | null = null;
    let sendMayHaveStarted = false;
    try {
      session = input.route.conversationId
        ? this.client.resumeSession(input.route.conversationId, sessionOptions)
        : this.client.createSession(input.route.agentId, sessionOptions);
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
      const attachedServerTools = await this.client.agents
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
