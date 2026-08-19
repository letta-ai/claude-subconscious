import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRetention,
  boundPayload,
  buildFingerprint,
  createEmptyState,
  createRouteRecord,
  DEFAULT_RETENTION,
  OMITTED_PAYLOAD_KEY,
  routeKey,
  StateStore,
  type BrokerState,
  type ObservationRecord,
  type ObservationStatus,
} from "../packages/core/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "subconscious-state-"));
  roots.push(value);
  return value;
}

describe("durable state", () => {
  it("serializes concurrent updates", async () => {
    const store = new StateStore(await root());
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.update((state) => {
          state.observationOrder.push(String(index));
        }),
      ),
    );
    expect((await store.snapshot()).observationOrder).toHaveLength(20);
    expect(JSON.parse(await readFile(store.path, "utf8"))).toMatchObject({
      version: 1,
    });
  });

  it("marks interrupted observations for reconciliation", async () => {
    const directory = await root();
    const store = new StateStore(directory);
    await store.update((state) => {
      state.observations.event = {
        event: {
          id: "event",
          harness: "claude-code",
          type: "turn_stop",
          sessionId: "session",
          workingDirectory: directory,
          occurredAt: new Date().toISOString(),
          payload: {},
        },
        routeKey: "route",
        config: {
          version: 1,
          agentId: "agent-test",
          model: "letta/auto",
          delivery: { whispers: true, queueMessages: false },
          observer: {},
        },
        status: "processing",
        attempts: 1,
        createdAt: "now",
        updatedAt: "now",
        otid: "event",
      };
    });
    await store.recoverInterrupted("later");
    expect((await store.snapshot()).observations.event?.status).toBe(
      "needs_reconciliation",
    );
  });

  it("includes project and session identity in route keys", () => {
    const base = {
      configPath: "/a/subconscious.toml",
      projectRoot: "/a",
      agentId: "agent-test",
      model: "letta/auto",
      harness: "claude-code" as const,
      sessionId: "one",
    };
    expect(routeKey(base)).not.toBe(routeKey({ ...base, sessionId: "two" }));
    expect(createRouteRecord(base).conversationId).toBeNull();
    expect(createEmptyState().version).toBe(1);
  });
});

function record(
  id: string,
  status: ObservationStatus,
  updatedAt: string,
  payload: Record<string, unknown> = {},
): ObservationRecord {
  return {
    event: {
      id,
      harness: "claude-code",
      type: "turn_stop",
      sessionId: "session",
      workingDirectory: "/project",
      occurredAt: updatedAt,
      payload,
    },
    routeKey: "route",
    config: {
      version: 1,
      agentId: "agent-test",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    },
    status,
    attempts: 1,
    createdAt: updatedAt,
    updatedAt,
    otid: id,
  };
}

function stateWith(records: ObservationRecord[]): BrokerState {
  const state = createEmptyState();
  for (const entry of records) {
    state.observations[entry.event.id] = entry;
    state.observationOrder.push(entry.event.id);
  }
  return state;
}

describe("observation retention", () => {
  it("keeps every actionable observation at any age or count", () => {
    const ancient = "2000-01-01T00:00:00.000Z";
    const state = stateWith([
      record("queued", "queued", ancient),
      record("processing", "processing", ancient),
      record("blocked", "needs_reconciliation", ancient),
    ]);
    applyRetention(state, { ...DEFAULT_RETENTION, resolvedMaxCount: 0 });
    expect(Object.keys(state.observations).sort()).toEqual([
      "blocked",
      "processing",
      "queued",
    ]);
    expect(state.observationOrder).toHaveLength(3);
  });

  it("drops resolved history past the age and count caps", () => {
    const now = Date.parse("2026-01-10T00:00:00.000Z");
    const state = stateWith([
      record("old", "processed", "2026-01-01T00:00:00.000Z"),
      record("recent", "processed", "2026-01-09T23:00:00.000Z"),
      record("newest", "discarded", "2026-01-09T23:30:00.000Z"),
      record("blocked", "needs_reconciliation", "2026-01-01T00:00:00.000Z"),
    ]);
    applyRetention(state, { ...DEFAULT_RETENTION, resolvedMaxCount: 1 }, now);
    // `old` fails the age cap, `recent` falls outside the count cap, and the
    // reconciliation record a human still has to resolve survives both.
    expect(Object.keys(state.observations).sort()).toEqual([
      "blocked",
      "newest",
    ]);
    expect(state.observationOrder).toEqual(["newest", "blocked"]);
  });

  it("holds a failed observation far longer than resolved history", () => {
    const now = Date.parse("2026-01-10T00:00:00.000Z");
    const state = stateWith([
      record("failed-recent", "failed", "2026-01-08T00:00:00.000Z"),
      record("failed-ancient", "failed", "2020-01-01T00:00:00.000Z"),
      record("processed", "processed", "2026-01-08T00:00:00.000Z"),
    ]);
    applyRetention(state, DEFAULT_RETENTION, now);
    // A failed observation is still `subconscious reconcile --retry` material,
    // so two days does not expire it while the same-age processed record goes.
    expect(Object.keys(state.observations)).toEqual(["failed-recent"]);
  });

  it("does not let successful turns evict an unseen failure", () => {
    const now = Date.parse("2026-01-10T00:00:00.000Z");
    const state = stateWith([
      record("failure", "failed", "2026-01-09T00:00:00.000Z"),
      ...Array.from({ length: 5 }, (_, index) =>
        record(`processed-${index}`, "processed", "2026-01-09T12:00:00.000Z"),
      ),
    ]);
    applyRetention(state, { ...DEFAULT_RETENTION, resolvedMaxCount: 1 }, now);
    expect(state.observations.failure).toBeDefined();
    expect(
      Object.keys(state.observations).filter((id) =>
        id.startsWith("processed-"),
      ),
    ).toHaveLength(1);
  });

  it("drops the payload of an observation nothing can re-prepare", () => {
    const state = stateWith([
      record("done", "processed", "2026-01-01T00:00:00.000Z", {
        tool_response: "x".repeat(10_000),
      }),
      record("retryable", "failed", "2026-01-01T00:00:00.000Z", {
        tool_response: "y".repeat(10),
      }),
    ]);
    applyRetention(
      state,
      DEFAULT_RETENTION,
      Date.parse("2026-01-01T00:00:01.000Z"),
    );
    expect(state.observations.done?.event.payload).toEqual({});
    // A retry re-runs prepareObservation against the stored event, so the
    // payload has to outlive a failure.
    expect(state.observations.retryable?.event.payload).toEqual({
      tool_response: "y".repeat(10),
    });
  });

  it("keeps a pending delivery whose observation was pruned", () => {
    const now = Date.parse("2026-01-10T00:00:00.000Z");
    const state = stateWith([
      record("gone", "processed", "2026-01-01T00:00:00.000Z"),
    ]);
    const base = {
      routeKey: "route",
      observationId: "gone",
      kind: "whisper" as const,
      text: "Check the deployment order.",
      priority: "normal" as const,
      dedupeKey: "proof",
      createdAt: "2026-01-01T00:00:00.000Z",
      attempts: 0,
    };
    state.deliveries.pending = {
      ...base,
      id: "pending",
      status: "pending",
      expiresAt: "2026-02-01T00:00:00.000Z",
    };
    state.deliveries.settled = {
      ...base,
      id: "settled",
      status: "delivered",
      expiresAt: "2026-02-01T00:00:00.000Z",
    };
    applyRetention(state, DEFAULT_RETENTION, now);
    expect(state.observations.gone).toBeUndefined();
    expect(state.deliveries.pending).toBeDefined();
    expect(state.deliveries.settled).toBeUndefined();
  });

  it("prunes an inherited oversized state file on the first write", async () => {
    const directory = await root();
    const legacy = createEmptyState();
    for (let index = 0; index < 500; index += 1) {
      const id = `legacy-${index}`;
      legacy.observations[id] = record(
        id,
        "processed",
        "2000-01-01T00:00:00.000Z",
        {
          tool_response: "z".repeat(2_000),
        },
      );
      legacy.observationOrder.push(id);
    }
    legacy.observations.blocked = record(
      "blocked",
      "needs_reconciliation",
      "2000-01-01T00:00:00.000Z",
    );
    legacy.observationOrder.push("blocked");
    await writeFile(
      join(directory, "state.json"),
      `${JSON.stringify(legacy, null, 2)}\n`,
      "utf8",
    );

    const store = new StateStore(directory);
    // A broker calls this first, so the repair happens before anything else
    // reads the state.
    await store.recoverInterrupted();
    const persisted = JSON.parse(
      await readFile(store.path, "utf8"),
    ) as BrokerState;
    expect(Object.keys(persisted.observations)).toEqual(["blocked"]);
    expect(persisted.observationOrder).toEqual(["blocked"]);
  });
});

describe("payload bounds", () => {
  const limits = { maxStringLength: 100, maxTotalLength: 400 };

  it("truncates a long string and leaves the payload shape intact", () => {
    const bounded = boundPayload(
      { transcript_path: "/tmp/session.jsonl", prompt: "a".repeat(5_000) },
      limits,
    );
    expect(bounded.transcript_path).toBe("/tmp/session.jsonl");
    expect(String(bounded.prompt)).toHaveLength(100 + "\n[truncated]".length);
  });

  it("drops the largest fields first and names what it dropped", () => {
    const bounded = boundPayload(
      {
        session_id: "session-one",
        transcript_path: "/tmp/session.jsonl",
        tool_input: { command: "b".repeat(90) },
        tool_response: Array.from({ length: 40 }, () => "c".repeat(90)),
      },
      limits,
    );
    expect(bounded.session_id).toBe("session-one");
    expect(bounded.transcript_path).toBe("/tmp/session.jsonl");
    expect(bounded.tool_response).toBeUndefined();
    expect(bounded[OMITTED_PAYLOAD_KEY]).toEqual(["tool_response"]);
  });

  it("leaves a payload that already fits exactly as it was", () => {
    const payload = { session_id: "one", nested: { depth: [1, 2, 3] } };
    expect(boundPayload(payload, limits)).toEqual(payload);
  });
});

describe("build fingerprint", () => {
  it("changes when the entry point is rebuilt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subconscious-build-"));
    try {
      const entry = join(directory, "cli.js");
      await writeFile(entry, "// first");
      const first = await buildFingerprint(entry);

      await writeFile(entry, "// second");
      await utimes(entry, new Date(), new Date(Date.now() + 1_000));
      const second = await buildFingerprint(entry);

      expect(first).not.toBe(second);
      expect(first).toContain(entry);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes two installs of the same file name", async () => {
    const left = await mkdtemp(join(tmpdir(), "subconscious-left-"));
    const right = await mkdtemp(join(tmpdir(), "subconscious-right-"));
    try {
      const leftEntry = join(left, "cli.js");
      const rightEntry = join(right, "cli.js");
      await writeFile(leftEntry, "// same bytes");
      await writeFile(rightEntry, "// same bytes");
      // Repointing the plugin at another checkout is the case that started this.
      expect(await buildFingerprint(leftEntry)).not.toBe(
        await buildFingerprint(rightEntry),
      );
    } finally {
      await rm(left, { recursive: true, force: true });
      await rm(right, { recursive: true, force: true });
    }
  });

  it("falls back to the path when the entry point is missing", async () => {
    expect(await buildFingerprint("/nope/cli.js")).toBe("/nope/cli.js");
  });
});

describe("payload bounding against adapter limits", () => {
  it("keeps as much of a string as the hungriest adapter reads", () => {
    // The Letta Code adapter truncates prompts and turn messages at 12,000
    // characters. Bounding below that would cut text it meant to keep, and the
    // loss would show up as the observer seeing less rather than as an error.
    const prompt = "p".repeat(12_000);
    const bounded = boundPayload({ prompt }) as { prompt: string };
    expect(bounded.prompt).toBe(prompt);
  });

  it("leaves a payload alone when truncation alone brings it under budget", () => {
    // Two huge fields shrink to the string cap and fit, so nothing is dropped.
    // Raising the string cap to match the adapters made this the common case.
    const bounded = boundPayload({
      tool_response: "x".repeat(60_000),
      tool_input: "y".repeat(60_000),
    }) as Record<string, unknown>;
    expect(bounded[OMITTED_PAYLOAD_KEY]).toBeUndefined();
  });

  it("keeps the small identity fields when it has to drop whole fields", () => {
    // Fields are dropped largest-first so the identity an adapter looks up by
    // name survives a payload that blew the total budget even after truncation.
    const bulk = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `bulk_${index}`,
        "x".repeat(12_000),
      ]),
    );
    const bounded = boundPayload({
      transcript_path: "/tmp/transcript.jsonl",
      session_id: "session-one",
      conversation_id: "conv-one",
      ...bulk,
    }) as Record<string, unknown>;
    expect(bounded.transcript_path).toBe("/tmp/transcript.jsonl");
    expect(bounded.session_id).toBe("session-one");
    expect(bounded.conversation_id).toBe("conv-one");
    expect(bounded[OMITTED_PAYLOAD_KEY]).toBeDefined();
  });
});
