import type {
  BrokerState,
  DeliveryKind,
  DeliveryRecord,
  HarnessEvent,
  HarnessId,
  SessionStatus,
} from "./types.js";

export interface DeliveryTarget {
  harness: HarnessId;
  sessionId: string;
  workingDirectory: string;
}

export type BrokerRequest =
  | { type: "ping"; token: string }
  | { type: "observe"; token: string; event: HarnessEvent }
  | {
      type: "lease";
      token: string;
      target: DeliveryTarget;
      kind: DeliveryKind;
    }
  | {
      type: "ack";
      token: string;
      deliveryIds: string[];
      nativeReceipt?: string;
    }
  | { type: "status"; token: string }
  | { type: "claim_session_status"; token: string; target: DeliveryTarget }
  | {
      type: "reconcile";
      token: string;
      eventId: string;
      action: "retry" | "discard";
    }
  | { type: "shutdown"; token: string };

export type BrokerRequestWithoutToken = BrokerRequest extends infer Request
  ? Request extends { token: string }
    ? Omit<Request, "token">
    : never
  : never;

export type BrokerResponse =
  | { ok: true; type: "pong" }
  | { ok: true; type: "observed"; accepted: boolean; reason?: string }
  | { ok: true; type: "leased"; deliveries: DeliveryRecord[] }
  | { ok: true; type: "acknowledged"; deliveryIds: string[] }
  | { ok: true; type: "status"; state: BrokerState }
  | {
      ok: true;
      type: "session_status";
      /** null when the route is unknown or the status was already claimed. */
      status: SessionStatus | null;
    }
  | {
      ok: true;
      type: "reconciled";
      eventId: string;
      status: "queued" | "discarded" | "already_recorded";
      conversationId?: string;
    }
  | { ok: true; type: "shutdown" }
  | { ok: false; error: string };
