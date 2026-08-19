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

export interface ObserverConfig {
  instructions?: string;
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

export interface SourceCursor {
  offset?: number;
  sequence?: number;
  marker?: string;
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
  clientDeliveryTools?: Array<"send_whisper" | "queue_message">;
  runtimeReportedTools?: string[];
  attachedServerTools?: string[];
  sourceCursor?: SourceCursor;
  createdAt: string;
  updatedAt: string;
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
}
