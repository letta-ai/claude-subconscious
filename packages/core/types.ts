export const HARNESS_IDS = ["claude-code", "codex", "letta-code"] as const;

export type KnownHarnessId = (typeof HARNESS_IDS)[number];
export type HarnessId = KnownHarnessId | (string & {});

export type HarnessEventType =
  | "session_start"
  | "user_prompt"
  | "tool_result"
  | "turn_stop"
  | "session_end";

export interface HarnessEvent {
  id: string;
  harness: HarnessId;
  type: HarnessEventType;
  sessionId: string;
  workingDirectory: string;
  occurredAt: string;
  sequence?: number;
  payload: Record<string, unknown>;
}

export interface DeliveryConfig {
  whispers: boolean;
  queueMessages: boolean;
}

/**
 * When a mid-turn observation has earned an observer turn.
 *
 * A mid-turn observation is coalescing by construction: `prepareObservation`
 * reads the route's transcript delta when the turn runs, not when the event
 * arrives, so two queued observations on one route would have the first consume
 * the whole delta and the second report nothing. The broker therefore keeps at
 * most one queued mid-turn record per route and folds every later tool result
 * into it. These two thresholds decide when that record is worth a Letta turn.
 */
export interface MidTurnObservationConfig {
  /**
   * How many tool results one record must represent before it runs.
   *
   * The record already covers everything since the last observation, so a low
   * value buys nothing except more observer turns over the same transcript.
   */
  minToolCalls: number;
  /**
   * The quiet period after the route's previous observer turn ended.
   *
   * This is the cadence control. It bounds how many observer turns one long
   * coding-agent turn can cost, whatever the tool count does.
   */
  minSeconds: number;
}

export interface ObserverConfig {
  instructions?: string;
  /**
   * Run the observer's tools in a Letta managed sandbox instead of on this
   * machine.
   *
   * A managed sandbox does not mount the project, so the observer keeps its
   * MemFS and loses every project file. An absent key means local execution.
   */
  sandbox?: boolean;
  /**
   * Observe tool boundaries inside a turn, not only the turn's edges.
   *
   * Absent means off, which is the only behavior earlier versions had: the
   * observer sees a session start, a prompt, and a completed turn, and says
   * nothing during the minutes between the last two. Present means on, and the
   * thresholds it carries are what keep it affordable.
   */
  midTurn?: MidTurnObservationConfig;
}

export interface ProjectConfig {
  version: 1;
  agentId?: string;
  model: string;
  delivery: DeliveryConfig;
  observer: ObserverConfig;
}

export interface ResolvedProjectConfig {
  path: string;
  projectRoot: string;
  config: ProjectConfig;
}

export interface AdapterCapabilities {
  passiveContext: boolean;
  queuedMessage: boolean;
  transcript: "events" | "file" | "api" | "none";
}

/**
 * How a harness reads context out of a hook.
 *
 * "stdout" takes the text as written. "envelope" requires a JSON object naming
 * the event. Sending the wrong one is silent: the harness drops the output and
 * no context reaches the model.
 */
export type ContextChannel = "stdout" | "envelope";

export interface SourceCursor {
  offset?: number;
  sequence?: number;
  marker?: string;
}

/**
 * The coding agent's own Letta identity, for a harness that is itself a Letta
 * agent.
 *
 * Both IDs belong to the harness being observed, never to Subconscious. A route
 * carries two unrelated agents and two unrelated conversations, and swapping
 * them would send the observer's guidance to the observer. `RouteRecord.agentId`
 * and `RouteRecord.conversationId` are always the observer's; everything under
 * `RouteRecord.harnessIdentity` is always the coding agent's.
 */
export interface HarnessLettaIdentity {
  agentId: string;
  conversationId: string;
}

export interface RouteRecord {
  key: string;
  configPath: string;
  projectRoot: string;
  agentId: string;
  model: string;
  harness: HarnessId;
  sessionId: string;
  conversationId: string | null;
  /**
   * The observed coding agent's Letta identity, when it has one. Present only
   * for a harness that runs as a Letta agent, and the reason a queued message
   * can reach that harness without a hook.
   */
  harnessIdentity?: HarnessLettaIdentity;
  clientDeliveryTools?: Array<"send_whisper" | "queue_message">;
  runtimeReportedTools?: string[];
  attachedServerTools?: string[];
  sourceCursor?: SourceCursor;
  /**
   * When this route's last observer turn finished, whatever its outcome.
   *
   * Only the mid-turn gate reads it, and only a path that actually reached the
   * runtime writes it: a failure before the turn started spent nothing and must
   * not delay a real observation. It is written only for a project that enables
   * mid-turn observation, so a project without the flag stores exactly the route
   * it stored before the flag existed.
   */
  lastObservedAt?: string;
  statusSentAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Identity of the Subconscious watching a session.
 *
 * The install banner is written straight to the terminal, so the harness never
 * sees which agent is attached. Without this the assistant cannot answer basic
 * questions about its own Subconscious, so the hook injects it once per session.
 */
export interface SessionStatus {
  agentId: string;
  model: string;
  harness: HarnessId;
  sessionId: string;
  conversationId: string | null;
  projectRoot: string;
  whispers: boolean;
  queuedMessages: boolean;
}

export type ObservationStatus =
  | "queued"
  | "processing"
  | "processed"
  | "failed"
  | "needs_reconciliation"
  | "discarded";

export interface ObservationRecord {
  event: HarnessEvent;
  routeKey: string;
  config: ProjectConfig;
  status: ObservationStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  otid: string;
  error?: string;
  runIds?: string[];
  /**
   * How many later tool results were folded into this record while it waited.
   *
   * Absent means none, so the record stands for one event. The record therefore
   * represents `coalesced + 1` tool results, which is what the readiness gate
   * compares against `minToolCalls`.
   *
   * Folding keeps `id`, `otid`, and `createdAt` and replaces `event`, so the
   * record's ID no longer hashes the payload it now holds. That is deliberate:
   * the ID is the Agent SDK `otid` for the turn this record will run, and
   * reconciliation searches Letta for `otid`. Rewriting it on every fold would
   * change the identity of a record that has not been sent yet, and a crash
   * between the fold and the send would leave `reconcile` searching for an
   * `otid` the broker never used.
   */
  coalesced?: number;
}

export type DeliveryKind = "whisper" | "queued_message";
export type DeliveryStatus = "pending" | "delivered" | "stale" | "expired";

export interface DeliveryRecord {
  id: string;
  routeKey: string;
  observationId: string;
  kind: DeliveryKind;
  text: string;
  priority: "normal" | "high";
  dedupeKey: string;
  status: DeliveryStatus;
  createdAt: string;
  expiresAt: string;
  attempts: number;
  lastAttemptAt?: string;
  acknowledgedAt?: string;
  nativeReceipt?: string;
  /**
   * Why the last attempt did not land. A hook-leased delivery never sets it,
   * because a hook that fails simply stops acknowledging. A directly delivered
   * message has no hook to report through, so the failure has to be recorded
   * here or it disappears.
   */
  lastError?: string;
}

export interface BrokerState {
  version: 1;
  routes: Record<string, RouteRecord>;
  observations: Record<string, ObservationRecord>;
  observationOrder: string[];
  deliveries: Record<string, DeliveryRecord>;
}

export interface DeliveryInput {
  text: string;
  dedupeKey?: string;
  ttlSeconds?: number;
  priority?: "normal" | "high";
}

export interface AdapterDeliveryResult {
  status: "delivered" | "retry" | "stale" | "unsupported";
  nativeReceipt?: string;
}

export interface PreparedObservation {
  text: string;
  nextCursor?: SourceCursor;
}

export interface HarnessAdapter {
  id: HarnessId;
  capabilities: AdapterCapabilities;
  normalizeHookInput(input: unknown): Promise<HarnessEvent | null>;
  prepareObservation(
    event: HarnessEvent,
    cursor: SourceCursor | undefined,
  ): Promise<PreparedObservation>;
  formatWhispers(deliveries: DeliveryRecord[]): string;
  formatStatus(status: SessionStatus): string;
  /**
   * The coding agent's own Letta identity for this event, when the harness runs
   * as a Letta agent.
   *
   * A harness that answers this can be handed a queued message straight into
   * its conversation, with no hook and no turn boundary to wait for. A harness
   * that is foreign to Letta omits the method, and its queued messages have
   * nowhere to go.
   */
  harnessLettaIdentity?(event: HarnessEvent): HarnessLettaIdentity | null;
  /**
   * The channel this harness accepts context on for a native hook event, or
   * null when the event cannot carry any. An adapter claims an event only once
   * a live run against the current harness version proves it.
   */
  contextChannel(nativeEvent: string): ContextChannel | null;
}
