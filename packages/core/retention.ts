import { truncateText } from "./jsonl.js";
import type {
  BrokerState,
  ObservationRecord,
  ObservationStatus,
} from "./types.js";

/**
 * How long a terminal observation stays in durable state.
 *
 * The two buckets exist because the records mean different things to a human.
 * `processed` and `discarded` are history: nothing acts on them again, and
 * `subconscious status` only counts them. `failed` is a to-do, because
 * `subconscious reconcile <event-id> --retry` still accepts it, so it earns a
 * far longer window before the broker decides nobody is coming for it.
 *
 * Each bucket has both an age cap and a count cap. The age cap bounds a state
 * directory that sits idle for months; the count cap bounds a burst that would
 * otherwise write hundreds of megabytes inside one age window. The caps are
 * applied per bucket so a flood of successful turns cannot evict a failure an
 * operator has not seen yet.
 */
export interface RetentionPolicy {
  resolvedMaxAgeMs: number;
  resolvedMaxCount: number;
  failedMaxAgeMs: number;
  failedMaxCount: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  resolvedMaxAgeMs: 24 * 60 * 60 * 1000,
  resolvedMaxCount: 200,
  failedMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  failedMaxCount: 200,
};

/**
 * Statuses that retention never touches, at any age and at any count.
 *
 * `queued` and `processing` are the broker's own work list. `needs_reconciliation`
 * blocks every later observation on its route until a human runs
 * `subconscious reconcile`, so pruning one would unblock the route silently and
 * lose the only handle the human has on it.
 */
const RETAINED_STATUSES = new Set<ObservationStatus>([
  "queued",
  "processing",
  "needs_reconciliation",
]);

/**
 * Statuses no code path can re-prepare from.
 *
 * `reconcile` accepts only `failed` and `needs_reconciliation`, and a retry
 * re-runs `prepareObservation` against the stored event. Once a record is past
 * both, its payload can never be read again, so keeping it only pays to copy it
 * into every subsequent whole-file write.
 */
const PAYLOADLESS_STATUSES = new Set<ObservationStatus>([
  "processed",
  "discarded",
]);

function ageMs(timestamp: string, now: number): number {
  const parsed = Date.parse(timestamp);
  // An unparseable timestamp reads as brand new rather than infinitely old, so
  // a malformed record is kept for inspection instead of silently deleted.
  return Number.isNaN(parsed) ? 0 : now - parsed;
}

function newestFirst(
  left: ObservationRecord,
  right: ObservationRecord,
): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function expired(
  bucket: ObservationRecord[],
  maxAgeMs: number,
  maxCount: number,
  now: number,
): ObservationRecord[] {
  bucket.sort(newestFirst);
  return bucket.filter(
    (record, index) =>
      index >= maxCount || ageMs(record.updatedAt, now) > maxAgeMs,
  );
}

/**
 * Bring durable state back inside its size budget.
 *
 * This runs on the writer's side of every state write, so the file on disk is
 * always the pruned one and an existing oversized `state.json` is repaired by
 * the first write the broker makes. It only ever removes; it never invents a
 * record or an order entry, so a state whose `observations` and
 * `observationOrder` already disagree comes out no worse than it went in.
 */
export function applyRetention(
  state: BrokerState,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  now: number = Date.now(),
): void {
  const resolved: ObservationRecord[] = [];
  const failed: ObservationRecord[] = [];
  for (const record of Object.values(state.observations)) {
    if (RETAINED_STATUSES.has(record.status)) continue;
    if (PAYLOADLESS_STATUSES.has(record.status)) {
      if (Object.keys(record.event.payload).length > 0)
        record.event = { ...record.event, payload: {} };
      resolved.push(record);
      continue;
    }
    failed.push(record);
  }

  const removed = new Set(
    [
      ...expired(
        resolved,
        policy.resolvedMaxAgeMs,
        policy.resolvedMaxCount,
        now,
      ),
      ...expired(failed, policy.failedMaxAgeMs, policy.failedMaxCount, now),
    ].map((record) => record.event.id),
  );
  if (removed.size === 0) return;

  for (const id of removed) delete state.observations[id];
  state.observationOrder = state.observationOrder.filter(
    (id) => !removed.has(id),
  );

  // A delivery outlives its observation only while it can still be acted on.
  // Dropping a settled one with its observation keeps delivery history bounded
  // by the same policy, and keeping every pending unexpired one preserves the
  // guarantee that a delivery survives until an adapter acknowledges it.
  const timestamp = new Date(now).toISOString();
  for (const [id, delivery] of Object.entries(state.deliveries)) {
    if (!removed.has(delivery.observationId)) continue;
    if (delivery.status === "pending" && delivery.expiresAt > timestamp)
      continue;
    delete state.deliveries[id];
  }
}

/**
 * How large a stored event payload may get.
 *
 * A hook payload is whatever the harness chose to send. Tool events carry the
 * tool input and the tool response, which have no upper bound, and the broker
 * rewrites the whole state file on every mutation, so an unbounded payload is
 * paid for on every later write rather than once.
 */
export interface PayloadLimits {
  maxStringLength: number;
  maxTotalLength: number;
}

/**
 * The string cap matches the largest truncation an adapter applies to a field
 * it reads by name, which is the Letta Code adapter's 12,000 characters for
 * prompts and turn messages. Clamping tighter here would silently cut text the
 * adapter intended to keep, and the loss would appear as the observer quietly
 * seeing less of a long prompt rather than as an error.
 */
export const DEFAULT_PAYLOAD_LIMITS: PayloadLimits = {
  maxStringLength: 12_000,
  maxTotalLength: 64_000,
};

/** The key `boundPayload` adds when it had to drop whole fields. */
export const OMITTED_PAYLOAD_KEY = "__subconsciousOmitted";

const MAX_PAYLOAD_DEPTH = 8;
const MAX_PAYLOAD_ITEMS = 200;

function boundValue(
  value: unknown,
  limits: PayloadLimits,
  depth: number,
): unknown {
  if (typeof value === "string")
    return truncateText(value, limits.maxStringLength);
  if (Array.isArray(value)) {
    if (depth >= MAX_PAYLOAD_DEPTH) return "[nested value omitted]";
    return value
      .slice(0, MAX_PAYLOAD_ITEMS)
      .map((item) => boundValue(item, limits, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth >= MAX_PAYLOAD_DEPTH) return "[nested value omitted]";
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        boundValue(item, limits, depth + 1),
      ]),
    );
  }
  return value;
}

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Clamp an event payload to a size the broker can afford to store.
 *
 * Long strings are truncated first, which is enough for almost every real
 * payload and leaves its shape intact. If the result is still over budget the
 * remaining top-level fields are dropped largest first, because the small
 * fields are the ones adapters read by name: `transcript_path`, `session_id`,
 * `agent_id`, `conversation_id`. Whatever went is named under
 * `OMITTED_PAYLOAD_KEY` rather than disappearing, since an adapter that falls
 * back to serializing the whole payload should say so to the observer.
 */
export function boundPayload(
  payload: Record<string, unknown>,
  limits: PayloadLimits = DEFAULT_PAYLOAD_LIMITS,
): Record<string, unknown> {
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    bounded[key] = boundValue(value, limits, 0);
  }
  let total = serializedLength(bounded);
  if (total <= limits.maxTotalLength) return bounded;

  const omitted: string[] = [];
  const largestFirst = Object.entries(bounded)
    .map(([key, value]) => ({ key, size: serializedLength(value) }))
    .sort((left, right) => right.size - left.size);
  for (const { key, size } of largestFirst) {
    if (total <= limits.maxTotalLength) break;
    delete bounded[key];
    omitted.push(key);
    total -= size;
  }
  if (omitted.length > 0) bounded[OMITTED_PAYLOAD_KEY] = omitted.sort();
  return bounded;
}
