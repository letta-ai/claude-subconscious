import {
  LettaAgentClient,
  type LettaCodeCloudSandboxOptions,
  type SDKResultMessage,
} from "@letta-ai/letta-agent-sdk";
import type {
  AdapterCapabilities,
  AdapterDeliveryResult,
  AppliedModelState,
  DeliveryRecord,
  HarnessEvent,
  HarnessLettaIdentity,
  PreparedObservation,
  ProjectConfig,
  ResolvedModelSelection,
  RouteRecord,
} from "../core/index.js";
import { resolveModelSelection } from "../core/index.js";
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
      /**
       * The model the backend reported for the initialized session. Null when
       * the backend did not report one; consumers must treat that as unknown
       * rather than keeping the previous turn's value.
       */
      effectiveModel: string | null;
      /** The conversation-persisted override triple now ensured server-side. */
      appliedModelState?: AppliedModelState;
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

/**
 * Canonical JSON encoding of a settings tree.
 *
 * Object keys are sorted at every depth, so two trees that differ only in key
 * order encode identically while any value change anywhere encodes
 * differently. A replacer-array `JSON.stringify` cannot do this: its key array
 * filters nested objects, which would hide a change like a new reasoning
 * budget inside `settings.thinking`.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            (value as { [key: string]: unknown })[key],
          )}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Compare the override state the conversation should carry against the one
 * the runtime last ensured.
 *
 * Every field participates, including reasoning effort: it is applied through
 * session options but can persist inside the conversation's model settings,
 * so an effort transition must reconcile even when nothing else moved.
 */
function sameModelState(
  left: AppliedModelState | undefined,
  right: AppliedModelState,
): boolean {
  if (!left) return false;
  if ((left.model ?? null) !== (right.model ?? null)) return false;
  if ((left.contextWindowLimit ?? null) !== (right.contextWindowLimit ?? null))
    return false;
  if ((left.reasoningEffort ?? null) !== (right.reasoningEffort ?? null))
    return false;
  return (
    canonicalJson(left.modelSettings ?? null) ===
    canonicalJson(right.modelSettings ?? null)
  );
}

/**
 * The conversation-persisted state that follows from one model selection.
 *
 * A field absent from the selection becomes `null`, which is what clears a
 * previously persisted override back to inheritance.
 */
function desiredModelState(
  selection: ResolvedModelSelection,
): AppliedModelState {
  return {
    model: selection.model ?? null,
    modelSettings: selection.settings ?? null,
    contextWindowLimit: selection.contextWindowLimit ?? null,
    reasoningEffort: selection.reasoningEffort ?? null,
  };
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
  /**
   * One chain per observed-agent conversation, so two drains can never
   * interleave sends into the same coding agent's session.
   */
  private readonly deliveryChains = new Map<string, Promise<unknown>>();
  /**
   * Deliveries currently being sent, keyed by conversation and delivery ID.
   *
   * Startup recovery and the normal drain can both pick up the same pending
   * record in the same instant; the second caller joins the first instead of
   * sending a duplicate turn.
   */
  private readonly deliveriesInFlight = new Map<
    string,
    Promise<QueuedMessageResult>
  >();

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
   * Deliveries are serialized per observed-agent conversation: startup
   * recovery and the normal drain run on independent loops and can pick up the
   * same pending record at the same instant. Calls for one conversation are
   * chained so their turns never interleave, and a call that arrives while its
   * exact record is already being sent joins that in-flight send instead of
   * opening a second session for it.
   */
  async deliverQueuedMessage(
    input: QueuedMessageDelivery,
  ): Promise<QueuedMessageResult> {
    const conversationKey = input.identity.conversationId;
    const recordKey = `${conversationKey}\u0000${input.deliveryId}`;
    const duplicate = this.deliveriesInFlight.get(recordKey);
    if (duplicate) return duplicate;
    const gate = this.deliveryChains.get(conversationKey) ?? Promise.resolve();
    const send = gate
      .catch(() => undefined)
      .then(() =>
        this.sendQueuedMessage(input),
      ) as Promise<QueuedMessageResult>;
    this.deliveriesInFlight.set(recordKey, send);
    this.deliveryChains.set(
      conversationKey,
      send.catch(() => undefined),
    );
    try {
      return await send;
    } finally {
      if (this.deliveriesInFlight.get(recordKey) === send) {
        this.deliveriesInFlight.delete(recordKey);
      }
      if (this.deliveryChains.get(conversationKey) === send) {
        this.deliveryChains.delete(conversationKey);
      }
    }
  }

  /**
   * The session deliberately carries no model and no reasoning effort and no
   * dreaming settings. A model or tier would rewrite the coding agent's own
   * configuration, and the SDK applies dreaming persistently with scope both,
   * which would turn off an agent's own reflection settings. Any client tool
   * would make the broker process a device that executes the coding agent's
   * tool calls. Subconscious is delivering a message here, not running the
   * harness.
   */
  private async sendQueuedMessage(
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
        env: { LETTA_API_KEY: this.apiKey },
      });
      await session.send(input.text, { otid: input.deliveryId });
      // Agent SDK send() starts the turn, but the session has to remain open and
      // its stream has to be drained for the message and turn to persist. Closing
      // immediately after send can report success while dropping the message.
      let result: SDKResultMessage | null = null;
      for await (const sdkMessage of session.stream()) {
        if (sdkMessage.type === "result") result = sdkMessage;
      }
      if (!result) {
        return {
          status: "retry",
          error: "The queued-message stream ended without a terminal result.",
        };
      }
      if (!result.success) {
        return { status: "retry", error: resultError(result) };
      }
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
    // Precedence lives in the config module; the runtime only decides where
    // each field lands. The session option carries the model and reasoning
    // tier because that path re-applies them on every turn, while settings and
    // the context window have no session-scoped route and are persisted onto
    // the named conversation through the management API below.
    const selection = resolveModelSelection(input.config, input.event.harness);
    const desiredState = desiredModelState(selection);
    const sessionOptions = {
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.reasoningEffort
        ? { reasoningEffort: selection.reasoningEffort }
        : {}),
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
    let session: ReturnType<LettaAgentClient["resumeSession"]> | null = null;
    let sendMayHaveStarted = false;
    try {
      /**
       * Reconcile an existing Subconscious conversation with the configured
       * overrides before the session opens.
       *
       * A session can apply a model and reasoning tier but cannot express
       * clearing or carry raw provider settings, so the management call is the
       * only way to keep an existing conversation honest with the file. It is
       * skipped when nothing has changed since the last successful turn, and
       * it never touches anything but this route's own conversation. Clearing
       * before ready() also wipes a reasoning tier a previous `update_model`
       * left persisted in the conversation settings, so the new tier - or no
       * tier - is what this turn actually uses.
       */
      let reconciledState: AppliedModelState | undefined;
      if (
        input.route.conversationId &&
        !sameModelState(input.route.appliedModelState, desiredState)
      ) {
        await client.conversations.update(input.route.conversationId, {
          model: desiredState.model ?? null,
          contextWindowLimit: desiredState.contextWindowLimit ?? null,
          modelSettings: (desiredState.modelSettings ?? null) as never,
        });
        reconciledState = desiredState;
      }
      /**
       * A fresh route creates its named conversation explicitly, with every
       * persistent override already on it.
       *
       * Opening a session first and patching afterwards would let the first
       * observer turn run on whatever configuration the session initialized
       * with rather than what the file asked for. Creating first also means
       * every turn of this route's life resumes by conversation ID; the
       * agent-default conversation is never touched, and inheritance-only
       * conversations are born bare instead of being cleared after the fact.
       */
      let conversationId = input.route.conversationId;
      if (!conversationId) {
        const created = await client.conversations.create({
          agentId: input.route.agentId,
          hidden: true,
          ...(selection.model ? { model: selection.model } : {}),
          ...(selection.settings
            ? { modelSettings: selection.settings as never }
            : {}),
          ...(selection.contextWindowLimit !== undefined
            ? { contextWindowLimit: selection.contextWindowLimit }
            : {}),
        });
        conversationId = created.id;
        reconciledState = desiredState;
      }
      session = client.resumeSession(conversationId, sessionOptions);
      // ready() initializes the runtime and transport, applies any model and
      // reasoning override from the session options, and reports the effective
      // backend model without fetching transcript history.
      const readyInfo = await session.ready();
      const message = formatObservationPrompt(
        input.event,
        input.config,
        input.prepared.text,
        deliveryTools.map((tool) => tool.name),
        input.route.projectRoot,
        input.route.conversationId === null,
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
      const resolvedConversationId =
        result.conversationId ?? session.conversationId;
      if (!resolvedConversationId) {
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
        conversationId: resolvedConversationId,
        result,
        ...(readyInfo.tools
          ? { runtimeReportedTools: [...readyInfo.tools] }
          : {}),
        ...(attachedServerTools ? { attachedServerTools } : {}),
        // Null is meaningful: the backend did not report a model this turn,
        // and keeping the previous value would present stale data as current.
        effectiveModel: readyInfo.model ?? null,
        ...(reconciledState ? { appliedModelState: reconciledState } : {}),
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
