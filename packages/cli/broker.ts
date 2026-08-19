import type { Server } from "node:net";
import { AgentRuntime } from "../agent-runtime/index.js";
import {
  createBrokerServer,
  createRouteRecord,
  findProjectConfig,
  identityRedactor,
  routeKey,
  StateStore,
  type BrokerDescriptor,
  type BrokerRequest,
  type BrokerResponse,
  type DeliveryRecord,
  type DeliveryTarget,
  type HarnessEvent,
  type ObservationRecord,
  type ObservationRedactor,
  type ProjectConfig,
  type RouteRecord,
} from "../core/index.js";
import { getAdapter } from "./adapters.js";

export interface BrokerOptions {
  descriptor: BrokerDescriptor;
  stateDirectory: string;
  apiKey?: string;
  runtime?:
    | (Pick<AgentRuntime, "run"> &
        Partial<Pick<AgentRuntime, "findConversationByOtid">>)
    | null;
  redactor?: ObservationRedactor;
  onShutdown?: () => void;
}

function now(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SubconsciousBroker {
  private readonly descriptor: BrokerDescriptor;
  private readonly store: StateStore;
  private readonly runtime:
    | (Pick<AgentRuntime, "run"> &
        Partial<Pick<AgentRuntime, "findConversationByOtid">>)
    | null;
  private readonly processingAgents = new Set<string>();
  private readonly activeDrains = new Set<Promise<void>>();
  private readonly onShutdown?: () => void;
  private readonly redactor: ObservationRedactor;
  private server: Server | null = null;

  constructor(options: BrokerOptions) {
    this.descriptor = options.descriptor;
    this.store = new StateStore(options.stateDirectory);
    this.runtime =
      options.runtime !== undefined
        ? options.runtime
        : options.apiKey
          ? new AgentRuntime({ apiKey: options.apiKey })
          : null;
    this.onShutdown = options.onShutdown;
    this.redactor = options.redactor ?? identityRedactor;
  }

  async start(): Promise<void> {
    await this.store.recoverInterrupted();
    this.server = await createBrokerServer(this.descriptor, (request) =>
      this.handle(request),
    );
    const state = await this.store.snapshot();
    for (const route of Object.values(state.routes))
      this.schedule(route.agentId);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled([...this.activeDrains]);
  }

  private async handle(request: BrokerRequest): Promise<BrokerResponse> {
    switch (request.type) {
      case "ping":
        return { ok: true, type: "pong" };
      case "observe":
        return await this.observe(request.event);
      case "lease":
        return await this.lease(request.target, request.kind);
      case "ack":
        return await this.ack(request.deliveryIds, request.nativeReceipt);
      case "status":
        return { ok: true, type: "status", state: await this.store.snapshot() };
      case "claim_session_status":
        return await this.claimSessionStatus(request.target);
      case "reconcile":
        return await this.reconcile(request.eventId, request.action);
      case "shutdown":
        queueMicrotask(() => this.onShutdown?.());
        return { ok: true, type: "shutdown" };
    }
  }

  private async observe(event: HarnessEvent): Promise<BrokerResponse> {
    event = await this.redactor.redact(event);
    const project = await findProjectConfig(event.workingDirectory);
    if (!project) {
      return {
        ok: true,
        type: "observed",
        accepted: false,
        reason: "No subconscious.toml applies to this working directory.",
      };
    }
    const agentId = project.config.agentId;
    if (!agentId) {
      return {
        ok: true,
        type: "observed",
        accepted: false,
        reason: `Configuration ${project.path} has no agent_id. Run subconscious init.`,
      };
    }
    const identity = {
      configPath: project.path,
      projectRoot: project.projectRoot,
      agentId,
      model: project.config.model,
      harness: event.harness,
      sessionId: event.sessionId,
    };
    const key = routeKey(identity);
    const capabilities = getAdapter(event.harness).capabilities;
    const clientDeliveryTools: Array<"send_whisper" | "queue_message"> = [
      ...(project.config.delivery.whispers && capabilities.passiveContext
        ? (["send_whisper"] as const)
        : []),
      ...(project.config.delivery.queueMessages && capabilities.queuedMessage
        ? (["queue_message"] as const)
        : []),
    ];
    let accepted = false;
    await this.store.update((state) => {
      if (state.observations[event.id]) return;
      const timestamp = now();
      state.routes[key] ??= createRouteRecord(identity, timestamp);
      state.routes[key]!.clientDeliveryTools = clientDeliveryTools;
      state.observations[event.id] = {
        event,
        routeKey: key,
        config: project.config,
        status: "queued",
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        otid: event.id,
      };
      state.observationOrder.push(event.id);
      accepted = true;
    });
    if (accepted) this.schedule(agentId);
    return { ok: true, type: "observed", accepted };
  }

  private schedule(agentId: string): void {
    if (this.processingAgents.has(agentId)) return;
    this.processingAgents.add(agentId);
    const task = this.drainAgent(agentId).finally(async () => {
      this.processingAgents.delete(agentId);
      this.activeDrains.delete(task);
      if (await this.nextObservation(agentId)) this.schedule(agentId);
    });
    this.activeDrains.add(task);
  }

  private async nextObservation(
    agentId: string,
  ): Promise<ObservationRecord | null> {
    const state = await this.store.snapshot();
    const blockedRoutes = new Set(
      Object.values(state.observations)
        .filter((observation) => observation.status === "needs_reconciliation")
        .map((observation) => observation.routeKey),
    );
    for (const id of state.observationOrder) {
      const observation = state.observations[id];
      if (!observation || observation.status !== "queued") continue;
      if (blockedRoutes.has(observation.routeKey)) continue;
      const route = state.routes[observation.routeKey];
      if (route?.agentId === agentId) return observation;
    }
    return null;
  }

  private async drainAgent(agentId: string): Promise<void> {
    while (true) {
      const observation = await this.nextObservation(agentId);
      if (!observation) return;
      await this.processObservation(observation);
    }
  }

  private async processObservation(
    observation: ObservationRecord,
  ): Promise<boolean> {
    const state = await this.store.snapshot();
    const route = state.routes[observation.routeKey];
    if (!route) {
      await this.failObservation(
        observation.event.id,
        "The observation route is missing.",
      );
      return false;
    }
    await this.store.update((current) => {
      const record = current.observations[observation.event.id];
      if (!record || record.status !== "queued") return;
      record.status = "processing";
      record.attempts += 1;
      record.updatedAt = now();
    });
    if (!this.runtime) {
      await this.failObservation(
        observation.event.id,
        "LETTA_API_KEY is not set in the broker environment.",
      );
      return false;
    }

    const adapter = getAdapter(observation.event.harness);
    let prepared;
    try {
      prepared = await adapter.prepareObservation(
        observation.event,
        route.sourceCursor,
      );
    } catch (error) {
      await this.failObservation(observation.event.id, errorMessage(error));
      return false;
    }

    let result;
    try {
      result = await this.runtime.run({
        event: observation.event,
        route,
        config: observation.config,
        prepared,
        capabilities: adapter.capabilities,
        persistDelivery: (delivery) => this.persistDelivery(delivery),
      });
    } catch (error) {
      await this.store.update((current) => {
        const record = current.observations[observation.event.id];
        if (!record) return;
        record.status = "needs_reconciliation";
        record.error = `The observer runtime exited unexpectedly: ${errorMessage(error)}`;
        record.updatedAt = now();
      });
      return false;
    }
    if (result.status === "success") {
      await this.store.update((current) => {
        const record = current.observations[observation.event.id];
        const currentRoute = current.routes[observation.routeKey];
        if (!record || !currentRoute) return;
        record.status = "processed";
        record.updatedAt = now();
        record.runIds = result.result.runIds;
        delete record.error;
        currentRoute.conversationId = result.conversationId;
        currentRoute.model = observation.config.model;
        if (result.runtimeReportedTools) {
          currentRoute.runtimeReportedTools = result.runtimeReportedTools;
        }
        if (result.attachedServerTools) {
          currentRoute.attachedServerTools = result.attachedServerTools;
        }
        currentRoute.updatedAt = now();
        if (prepared.nextCursor)
          currentRoute.sourceCursor = prepared.nextCursor;
      });
      return true;
    }
    await this.store.update((current) => {
      const record = current.observations[observation.event.id];
      const currentRoute = current.routes[observation.routeKey];
      if (!record) return;
      record.status =
        result.status === "ambiguous" ? "needs_reconciliation" : "failed";
      record.error = result.error;
      record.updatedAt = now();
      if (result.result?.runIds) record.runIds = result.result.runIds;
      if (currentRoute && result.conversationId) {
        currentRoute.conversationId = result.conversationId;
        currentRoute.updatedAt = now();
      }
    });
    return false;
  }

  private async failObservation(id: string, error: string): Promise<void> {
    await this.store.update((state) => {
      const record = state.observations[id];
      if (!record) return;
      record.status = "failed";
      record.error = error;
      record.updatedAt = now();
    });
  }

  private async reconcile(
    eventId: string,
    action: "retry" | "discard",
  ): Promise<BrokerResponse> {
    const snapshot = await this.store.snapshot();
    const observation = snapshot.observations[eventId];
    if (!observation)
      return { ok: false, error: `Unknown observation: ${eventId}` };
    if (
      observation.status !== "failed" &&
      observation.status !== "needs_reconciliation"
    ) {
      return {
        ok: false,
        error: `Observation ${eventId} is ${observation.status}, not failed or awaiting reconciliation.`,
      };
    }
    const route = snapshot.routes[observation.routeKey];
    if (!route)
      return { ok: false, error: `Observation ${eventId} has no route.` };

    if (action === "discard") {
      await this.store.update((state) => {
        const current = state.observations[eventId];
        if (!current) return;
        current.status = "discarded";
        current.error = "Discarded by explicit operator reconciliation.";
        current.updatedAt = now();
      });
      this.schedule(route.agentId);
      return { ok: true, type: "reconciled", eventId, status: "discarded" };
    }

    if (!this.runtime?.findConversationByOtid) {
      return {
        ok: false,
        error:
          "The broker cannot query OTID state. Restart it with LETTA_API_KEY before retrying.",
      };
    }
    let match;
    try {
      match = await this.runtime.findConversationByOtid(
        route.agentId,
        observation.otid,
        route.conversationId,
      );
    } catch (error) {
      return {
        ok: false,
        error: `OTID reconciliation failed: ${errorMessage(error)}`,
      };
    }
    if (match) {
      await this.store.update((state) => {
        const currentRoute = state.routes[observation.routeKey];
        const current = state.observations[eventId];
        if (currentRoute) {
          currentRoute.conversationId = match.conversationId;
          currentRoute.updatedAt = now();
        }
        if (current) {
          current.status = "needs_reconciliation";
          current.error =
            "The OTID already exists in this conversation. Inspect the turn, then discard this reconciliation record to continue.";
          current.updatedAt = now();
        }
      });
      return {
        ok: true,
        type: "reconciled",
        eventId,
        status: "already_recorded",
        conversationId: match.conversationId,
      };
    }

    await this.store.update((state) => {
      const current = state.observations[eventId];
      if (!current) return;
      current.status = "queued";
      delete current.error;
      current.updatedAt = now();
    });
    this.schedule(route.agentId);
    return { ok: true, type: "reconciled", eventId, status: "queued" };
  }

  private async persistDelivery(delivery: DeliveryRecord): Promise<void> {
    await this.store.update((state) => {
      state.deliveries[delivery.id] ??= delivery;
    });
  }

  private async targetRoute(
    target: DeliveryTarget,
  ): Promise<{ route: RouteRecord; config: ProjectConfig } | null> {
    const project = await findProjectConfig(target.workingDirectory);
    if (!project?.config.agentId) return null;
    const key = routeKey({
      configPath: project.path,
      projectRoot: project.projectRoot,
      agentId: project.config.agentId,
      model: project.config.model,
      harness: target.harness,
      sessionId: target.sessionId,
    });
    const state = await this.store.snapshot();
    const route = state.routes[key];
    return route ? { route, config: project.config } : null;
  }

  /**
   * Hand back the session's identity the first time it is asked for.
   *
   * The claim is made inside a single store update so two hooks racing on the
   * same session cannot both win and inject the banner twice.
   */
  private async claimSessionStatus(
    target: DeliveryTarget,
  ): Promise<BrokerResponse> {
    const resolved = await this.targetRoute(target);
    if (!resolved) return { ok: true, type: "session_status", status: null };
    let claimed = false;
    await this.store.update((state) => {
      const route = state.routes[resolved.route.key];
      if (!route || route.statusSentAt) return;
      route.statusSentAt = now();
      route.updatedAt = route.statusSentAt;
      claimed = true;
    });
    if (!claimed) return { ok: true, type: "session_status", status: null };
    const { route, config } = resolved;
    return {
      ok: true,
      type: "session_status",
      status: {
        agentId: route.agentId,
        model: route.model,
        harness: route.harness,
        sessionId: route.sessionId,
        conversationId: route.conversationId,
        projectRoot: route.projectRoot,
        whispers: config.delivery.whispers,
        queuedMessages: config.delivery.queueMessages,
      },
    };
  }

  private async lease(
    target: DeliveryTarget,
    kind: DeliveryRecord["kind"],
  ): Promise<BrokerResponse> {
    const resolved = await this.targetRoute(target);
    if (!resolved) return { ok: true, type: "leased", deliveries: [] };
    const capabilities = getAdapter(target.harness).capabilities;
    if (
      (kind === "whisper" &&
        (!resolved.config.delivery.whispers || !capabilities.passiveContext)) ||
      (kind === "queued_message" &&
        (!resolved.config.delivery.queueMessages ||
          !capabilities.queuedMessage))
    ) {
      return { ok: true, type: "leased", deliveries: [] };
    }
    const leased: DeliveryRecord[] = [];
    const timestamp = now();
    await this.store.update((state) => {
      for (const delivery of Object.values(state.deliveries)) {
        if (delivery.routeKey !== resolved.route.key || delivery.kind !== kind)
          continue;
        if (delivery.status !== "pending") continue;
        if (delivery.expiresAt <= timestamp) {
          delivery.status = "expired";
          continue;
        }
        delivery.attempts += 1;
        delivery.lastAttemptAt = timestamp;
        leased.push(structuredClone(delivery));
      }
    });
    leased.sort((left, right) => {
      if (left.priority !== right.priority)
        return left.priority === "high" ? -1 : 1;
      return left.createdAt.localeCompare(right.createdAt);
    });
    return { ok: true, type: "leased", deliveries: leased };
  }

  private async ack(
    deliveryIds: string[],
    nativeReceipt: string | undefined,
  ): Promise<BrokerResponse> {
    const acknowledged: string[] = [];
    await this.store.update((state) => {
      for (const id of new Set(deliveryIds)) {
        const delivery = state.deliveries[id];
        if (!delivery || delivery.status !== "pending") continue;
        delivery.status = "delivered";
        delivery.acknowledgedAt = now();
        if (nativeReceipt) delivery.nativeReceipt = nativeReceipt;
        acknowledged.push(id);
      }
    });
    return { ok: true, type: "acknowledged", deliveryIds: acknowledged };
  }
}
