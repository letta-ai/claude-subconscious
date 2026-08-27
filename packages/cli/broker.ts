import type { Server } from "node:net";
import { AgentRuntime } from "../agent-runtime/index.js";
import {
  boundPayload,
  createBrokerServer,
  createRouteRecord,
  findProjectConfig,
  identityRedactor,
  resolveModelSelection,
  routeKey,
  StateStore,
  type BrokerDescriptor,
  type BrokerRequest,
  type BrokerResponse,
  type BrokerState,
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
  runtime?: BrokerRuntime | null;
  redactor?: ObservationRedactor;
  onShutdown?: () => void;
}

/**
 * The slice of the Agent SDK runtime the broker needs. Only `run` is required,
 * so a test can drive a real broker with a minimal fake.
 */
export type BrokerRuntime = Pick<AgentRuntime, "run"> &
  Partial<
    Pick<AgentRuntime, "findConversationByOtid" | "deliverQueuedMessage">
  >;

function now(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Copy one record out of the live state read by `StateStore.read`.
 *
 * The selector is handed the store's own object, so anything that outlives the
 * selector has to be a copy or a later mutation would be visible through it.
 */
function cloneOrNull<T>(value: T | undefined): T | null {
  return value ? structuredClone(value) : null;
}

/**
 * The mid-turn observation already waiting on a route, if there is one.
 *
 * There is at most one, because this is exactly what `observe` folds into. A
 * record that has reached `processing` is not a candidate: its turn is running
 * and its transcript delta is already being consumed, so a later tool result
 * has to start a new record. That bounds a route to two mid-turn records at
 * once, one running and one collecting.
 */
function queuedMidTurn(
  state: BrokerState,
  routeKey: string,
): ObservationRecord | undefined {
  for (const record of Object.values(state.observations)) {
    if (record.routeKey !== routeKey) continue;
    if (record.status !== "queued") continue;
    if (record.event.type === "tool_result") return record;
  }
  return undefined;
}

/**
 * Whether a queued mid-turn observation has earned an observer turn yet.
 *
 * Both thresholds have to pass. The count says the record covers enough work to
 * be worth reading; the quiet period says the route has not just been observed.
 * A record whose project has since turned the feature off never runs at all,
 * which is what keeps a stale queue from firing after a configuration change.
 *
 * There is no timer behind this. The gate is re-read whenever the agent's drain
 * loop finishes, and `observe` schedules that loop on every later tool call, so
 * the record is reconsidered at the next tool boundary after it becomes ready.
 */
function midTurnReady(
  observation: ObservationRecord,
  route: RouteRecord,
  nowMs: number,
): boolean {
  const settings = observation.config.observer.midTurn;
  if (!settings) return false;
  if ((observation.coalesced ?? 0) + 1 < settings.minToolCalls) return false;
  if (!route.lastObservedAt) return true;
  const since = nowMs - Date.parse(route.lastObservedAt);
  // An unparseable timestamp compares false here and lets the record through.
  // The gate exists to space observer turns out, not to strand one behind a
  // value nothing can interpret.
  return !(since < settings.minSeconds * 1_000);
}

export class SubconsciousBroker {
  private readonly descriptor: BrokerDescriptor;
  private readonly store: StateStore;
  private readonly runtime: BrokerRuntime | null;
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
    await this.discardStrandedMidTurn();
    this.server = await createBrokerServer(this.descriptor, (request) =>
      this.handle(request),
    );
    const state = await this.store.snapshot();
    for (const route of Object.values(state.routes))
      this.schedule(route.agentId);
    // A queued message is never handed to a hook, so nothing else would pick up
    // one that was still pending when the previous broker stopped.
    const stranded = new Set(
      Object.values(state.deliveries)
        .filter(
          (delivery) =>
            delivery.kind === "queued_message" && delivery.status === "pending",
        )
        .map((delivery) => delivery.routeKey),
    );
    for (const key of stranded) this.track(this.deliverQueuedMessages(key));
  }

  /**
   * Release mid-turn records the previous broker left queued.
   *
   * A mid-turn observation only means something inside the turn that produced
   * it, and that turn ended with the process that was watching it. Its
   * transcript delta is not lost: the cursor never moved, so the session's next
   * turn boundary reports it. Without this the record would sit queued forever,
   * because retention deliberately never prunes a queued observation and the
   * readiness gate has no reason to release one whose route went quiet.
   *
   * The scan runs before the socket opens, and it writes only when it found
   * something, so a broker with no such records writes nothing here.
   */
  private async discardStrandedMidTurn(): Promise<void> {
    const stranded = await this.store.read((state) =>
      Object.values(state.observations)
        .filter(
          (record) =>
            record.status === "queued" && record.event.type === "tool_result",
        )
        .map((record) => record.event.id),
    );
    if (stranded.length === 0) return;
    await this.store.update((state) => {
      const timestamp = now();
      for (const id of stranded) {
        const record = state.observations[id];
        if (!record || record.status !== "queued") continue;
        record.status = "discarded";
        record.error =
          "The broker restarted before this mid-turn observation ran. Its transcript delta reaches the next turn boundary instead.";
        record.updatedAt = timestamp;
      }
    });
  }

  /**
   * Keep a background task alive for close() to await, so a shutdown cannot cut
   * a delivery in half.
   */
  private track(task: Promise<void>): void {
    const tracked = task.finally(() => this.activeDrains.delete(tracked));
    this.activeDrains.add(tracked);
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
    // Mid-turn observation is refused before any state is touched, so a project
    // that has not asked for it stores exactly what it stored before the
    // feature existed. The hook checks the same flag to save itself the round
    // trip, but configuration is only authoritative here, and a hook running
    // against a file that has since changed must not be able to enable it.
    if (event.type === "tool_result" && !project.config.observer.midTurn) {
      return {
        ok: true,
        type: "observed",
        accepted: false,
        reason: `Configuration ${project.path} does not enable observer.mid_turn.`,
      };
    }
    const identity = {
      configPath: project.path,
      projectRoot: project.projectRoot,
      agentId,
      harness: event.harness,
      sessionId: event.sessionId,
    };
    // The model decision is read per event, not baked into the route key, so
    // editing an override in the file moves the existing conversation instead
    // of forking a new one.
    const selection = resolveModelSelection(project.config, event.harness);
    const key = routeKey(identity);
    const adapter = getAdapter(event.harness);
    const capabilities = adapter.capabilities;
    const harnessIdentity = adapter.harnessLettaIdentity?.(event) ?? null;
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
      state.routes[key] ??= {
        ...createRouteRecord(identity, timestamp),
        ...(selection.model ? { requestedModel: selection.model } : {}),
        modelOverrideSource: selection.source,
        ...(selection.reasoningEffort
          ? { reasoningEffort: selection.reasoningEffort }
          : {}),
      };
      state.routes[key]!.clientDeliveryTools = clientDeliveryTools;
      // Only overwrite when this event carried an identity. Letta Code Stop
      // input has no conversation fields, and clearing the route on one of
      // those would strand every queued message the session later earns.
      if (harnessIdentity) state.routes[key]!.harnessIdentity = harnessIdentity;
      // The stored payload is clamped, not the one the route identity was read
      // from above. `prepareObservation` runs later against this record, so what
      // is stored is what an adapter will see, and a harness payload has no size
      // an adapter can rely on.
      const bounded = { ...event, payload: boundPayload(event.payload) };

      const existing =
        event.type === "tool_result" ? queuedMidTurn(state, key) : undefined;
      if (existing) {
        // Fold this tool result into the record already waiting instead of
        // queueing a second one. Two queued observations on one route are
        // redundant by construction: the first to run consumes the whole
        // transcript delta and the second reports an empty turn.
        //
        // The record keeps its ID, its `otid`, and its `createdAt` while its
        // event is replaced, so the ID no longer hashes the payload it holds.
        // That is the point. The ID is the `otid` this record will send under,
        // and `subconscious reconcile` searches Letta for that `otid`. A new ID
        // per fold would change the identity of a record that has not been sent
        // yet. `observationOrder` is not touched either: the record is already
        // in it, and appending would list it twice.
        existing.event = { ...bounded, id: existing.event.id };
        existing.config = project.config;
        existing.coalesced = (existing.coalesced ?? 0) + 1;
        existing.updatedAt = timestamp;
        accepted = true;
      } else {
        state.observations[event.id] = {
          event: bounded,
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
      }

      if (event.type === "turn_stop") {
        // The Stop delta contains everything a queued mid-turn record on this
        // route was waiting to report, so running both would spend a Letta turn
        // on an observation that reads "nothing new since the last one". This
        // is not guarded by the mid-turn flag: turning the flag off has to
        // release records the previous configuration left behind, which the
        // readiness gate alone would hold queued forever.
        for (const record of Object.values(state.observations)) {
          if (record.routeKey !== key) continue;
          if (record.status !== "queued") continue;
          if (record.event.type !== "tool_result") continue;
          record.status = "discarded";
          record.error =
            "Superseded by the completed turn, whose transcript delta contains this one.";
          record.updatedAt = timestamp;
        }
      }
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
    // The drain loop calls this once per observation, so it reads the live
    // state and copies only the record it selects. Cloning the whole state here
    // made one drain cost time proportional to the entire observation history.
    const nowMs = Date.now();
    return await this.store.read((state) => {
      const blockedRoutes = new Set(
        Object.values(state.observations)
          .filter(
            (observation) => observation.status === "needs_reconciliation",
          )
          .map((observation) => observation.routeKey),
      );
      for (const id of state.observationOrder) {
        const observation = state.observations[id];
        if (!observation || observation.status !== "queued") continue;
        if (blockedRoutes.has(observation.routeKey)) continue;
        const route = state.routes[observation.routeKey];
        if (!route || route.agentId !== agentId) continue;
        // A mid-turn record that is not ready is skipped, not held: a later
        // turn boundary on the same route is still free to run ahead of it.
        if (
          observation.event.type === "tool_result" &&
          !midTurnReady(observation, route, nowMs)
        ) {
          continue;
        }
        return structuredClone(observation);
      }
      return null;
    });
  }

  private async drainAgent(agentId: string): Promise<void> {
    while (true) {
      const observation = await this.nextObservation(agentId);
      if (!observation) return;
      await this.processObservation(observation);
      // A queued message must not wait for a hook lease, which is the entire
      // point of the channel. Sending after the turn instead of inside the tool
      // keeps a transport failure away from the observation that produced it.
      await this.deliverQueuedMessages(observation.routeKey);
    }
  }

  private async processObservation(
    observation: ObservationRecord,
  ): Promise<boolean> {
    const route = await this.store.read((state) =>
      cloneOrNull(state.routes[observation.routeKey]),
    );
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
    // The observer turn is over, whatever it returned. Only the mid-turn gate
    // reads this, and only a project that enabled mid-turn observation stores
    // it, so a project without the flag keeps the route it always had. It is
    // written from here rather than from where the turn started, so a slow turn
    // does not immediately earn the next one, and it is not written on the
    // paths above, which failed before reaching the runtime and spent nothing.
    const observedAt = observation.config.observer.midTurn ? now() : null;

    if (result.status === "success") {
      await this.store.update((current) => {
        const record = current.observations[observation.event.id];
        const currentRoute = current.routes[observation.routeKey];
        if (!record || !currentRoute) return;
        if (observedAt) currentRoute.lastObservedAt = observedAt;
        record.status = "processed";
        record.updatedAt = now();
        record.runIds = result.result.runIds;
        delete record.error;
        currentRoute.conversationId = result.conversationId;
        {
          const selection = resolveModelSelection(
            observation.config,
            observation.event.harness,
          );
          delete currentRoute.model;
          if (selection.model) {
            currentRoute.requestedModel = selection.model;
          } else {
            delete currentRoute.requestedModel;
          }
          currentRoute.modelOverrideSource = selection.source;
          if (selection.reasoningEffort) {
            currentRoute.reasoningEffort = selection.reasoningEffort;
          } else {
            delete currentRoute.reasoningEffort;
          }
        }
        // A null effective model means the backend reported none this turn;
        // the previous value must go rather than posing as current.
        if (result.effectiveModel) {
          currentRoute.effectiveModel = result.effectiveModel;
        } else {
          delete currentRoute.effectiveModel;
        }
        if (result.appliedModelState) {
          currentRoute.appliedModelState = result.appliedModelState;
        }
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
      if (currentRoute && observedAt) currentRoute.lastObservedAt = observedAt;
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

  /**
   * Change one delivery, and only while it is still pending.
   *
   * Every other transition in the broker guards on `pending` too. Keeping the
   * guard here means a slow direct send that finishes after a hook already
   * acknowledged the same delivery cannot rewrite the acknowledgement.
   */
  private async updateDelivery(
    id: string,
    mutate: (delivery: DeliveryRecord) => void,
  ): Promise<void> {
    await this.store.update((state) => {
      const delivery = state.deliveries[id];
      if (!delivery || delivery.status !== "pending") return;
      mutate(delivery);
    });
  }

  /**
   * Deliver every pending queued message on one route.
   *
   * A whisper waits for a hook to open a delivery window. A queued message
   * cannot: it is meant to start a turn, and a harness that is itself a Letta
   * agent has a conversation the broker can write to at any moment. So the
   * broker sends it and acknowledges it itself. There is no hook in this path,
   * which is why every outcome has to be recorded on the delivery here.
   *
   * This never throws. It runs behind an observer turn and at start-up, and a
   * failed message must not take either of those down with it.
   */
  private async deliverQueuedMessages(routeKey: string): Promise<void> {
    try {
      const { route, pending } = await this.store.read((state) => ({
        route: cloneOrNull(state.routes[routeKey]),
        pending: Object.values(state.deliveries)
          .filter(
            (delivery) =>
              delivery.routeKey === routeKey &&
              delivery.kind === "queued_message" &&
              delivery.status === "pending",
          )
          .map((delivery) => structuredClone(delivery)),
      }));
      const identity = route?.harnessIdentity;
      if (!route || !identity) return;
      pending.sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
      if (pending.length === 0) return;

      const runtime = this.runtime;
      if (!runtime?.deliverQueuedMessage) {
        for (const delivery of pending) {
          await this.updateDelivery(delivery.id, (record) => {
            record.lastError =
              "The broker has no Agent SDK runtime, so it cannot deliver a queued message.";
          });
        }
        return;
      }

      // Configuration is read again rather than trusted from the turn that
      // produced the delivery, so revoking the permission stops messages that
      // have not gone out yet. They stay pending and go nowhere.
      const project = await findProjectConfig(route.projectRoot);
      if (!project?.config.delivery.queueMessages) return;
      if (!getAdapter(route.harness).capabilities.queuedMessage) return;

      for (const delivery of pending) {
        const timestamp = now();
        if (delivery.expiresAt <= timestamp) {
          await this.updateDelivery(delivery.id, (record) => {
            record.status = "expired";
          });
          continue;
        }
        let result;
        try {
          result = await runtime.deliverQueuedMessage({
            identity,
            deliveryId: delivery.id,
            previousAttempts: delivery.attempts,
            text: delivery.text,
          });
        } catch (error) {
          result = { status: "retry" as const, error: errorMessage(error) };
        }
        await this.updateDelivery(delivery.id, (record) => {
          record.attempts += 1;
          record.lastAttemptAt = timestamp;
          if (result.status === "delivered") {
            record.status = "delivered";
            record.acknowledgedAt = timestamp;
            if (result.nativeReceipt)
              record.nativeReceipt = result.nativeReceipt;
            delete record.lastError;
            return;
          }
          record.lastError =
            result.error ??
            `The queued message could not be delivered (${result.status}).`;
          // Retry keeps the delivery pending for the next observer turn or
          // broker start. Anything else means the target is gone for good, and
          // the spec forbids redirecting it to a replacement session.
          if (result.status !== "retry") record.status = "stale";
        });
      }
    } catch (error) {
      // Reaching here means the state store itself failed. The deliveries stay
      // pending and the next drain retries them.
      process.emitWarning(
        `Subconscious could not drain queued messages: ${errorMessage(error)}`,
      );
    }
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
      harness: target.harness,
      sessionId: target.sessionId,
    });
    // A hook leases on every tool call, so this path must not clone the whole
    // state to read one route.
    const route = await this.store.read((state) =>
      cloneOrNull(state.routes[key]),
    );
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
    // The route carries the model decision from its last observation; a brand
    // new route falls back to reading the file so the very first banner is
    // still honest about what the configuration asks for.
    const selection = resolveModelSelection(config, route.harness);
    return {
      ok: true,
      type: "session_status",
      status: {
        agentId: route.agentId,
        ...((route.requestedModel ?? selection.model)
          ? { model: route.requestedModel ?? selection.model }
          : {}),
        ...((route.requestedModel ?? selection.model)
          ? { requestedModel: route.requestedModel ?? selection.model }
          : {}),
        modelOverrideSource: route.modelOverrideSource ?? selection.source,
        ...((route.reasoningEffort ?? selection.reasoningEffort)
          ? {
              reasoningEffort:
                route.reasoningEffort ?? selection.reasoningEffort,
            }
          : {}),
        effectiveModel: route.effectiveModel,
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
    if (kind === "queued_message" && resolved.route.harnessIdentity) {
      // The broker sends and acknowledges these itself. Leasing them to a hook
      // as well would deliver the same message twice.
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
