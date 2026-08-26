import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SubconsciousBroker,
  type BrokerRuntime,
} from "../packages/cli/broker.js";
import {
  deliveryId,
  routeKey,
  sendBrokerRequest,
  validateProjectConfig,
  writeProjectConfig,
  type BrokerDescriptor,
  type DeliveryRecord,
} from "../packages/core/index.js";
import type {
  QueuedMessageDelivery,
  QueuedMessageResult,
  RunObservationInput,
  RunObservationResult,
} from "../packages/agent-runtime/index.js";

type QueuedMessageDeliverer = (
  input: QueuedMessageDelivery,
) => Promise<QueuedMessageResult>;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "subconscious-broker-"));
  roots.push(value);
  return await realpath(value);
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for broker state.");
}

describe("broker lifecycle", () => {
  it("deduplicates observations and acknowledges stable deliveries", async () => {
    const directory = await root();
    await writeProjectConfig(directory, {
      version: 1,
      agentId: "agent-test",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
    const descriptor: BrokerDescriptor = {
      version: 1,
      endpoint:
        process.platform === "win32"
          ? `\\\\.\\pipe\\subconscious-test-${randomUUID()}`
          : join(directory, "broker.sock"),
      token: "test-token",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    let turns = 0;
    const runtime = {
      run: async (
        input: RunObservationInput,
      ): Promise<RunObservationResult> => {
        turns += 1;
        const id = deliveryId(input.event.id, "whisper", "proof");
        const delivery: DeliveryRecord = {
          id,
          routeKey: input.route.key,
          observationId: input.event.id,
          kind: "whisper",
          text: "Check the deployment order.",
          priority: "normal",
          dedupeKey: "proof",
          status: "pending",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          attempts: 0,
        };
        await input.persistDelivery(delivery);
        await input.persistDelivery({
          ...delivery,
          id: deliveryId(input.event.id, "whisper", "expired"),
          text: "Expired guidance.",
          dedupeKey: "expired",
          createdAt: "2000-01-01T00:00:00.000Z",
          expiresAt: "2000-01-01T00:01:00.000Z",
        });
        return {
          status: "success",
          effectiveModel: null,
          conversationId: "conv-observer",
          result: {
            type: "result",
            success: true,
            durationMs: 1,
            conversationId: "conv-observer",
            runIds: ["run-observer"],
          },
        };
      },
    };
    const broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime,
    });
    await broker.start();
    try {
      const event = {
        id: "event-one",
        harness: "claude-code" as const,
        type: "session_start" as const,
        sessionId: "session-one",
        workingDirectory: directory,
        occurredAt: new Date().toISOString(),
        payload: {},
      };
      const first = await sendBrokerRequest(descriptor, {
        type: "observe",
        event,
      });
      const duplicate = await sendBrokerRequest(descriptor, {
        type: "observe",
        event,
      });
      expect(first).toMatchObject({
        ok: true,
        type: "observed",
        accepted: true,
      });
      expect(duplicate).toMatchObject({
        ok: true,
        type: "observed",
        accepted: false,
      });

      await waitFor(async () => {
        const response = await sendBrokerRequest(descriptor, {
          type: "status",
        });
        return (
          response.ok &&
          response.type === "status" &&
          response.state.observations[event.id]?.status === "processed"
        );
      });
      expect(turns).toBe(1);

      await rm(join(directory, "subconscious.toml"));
      await writeProjectConfig(directory, {
        version: 1,
        agentId: "agent-test",
        model: "letta/auto",
        delivery: { whispers: false, queueMessages: false },
        observer: {},
      });
      const disabledLease = await sendBrokerRequest(descriptor, {
        type: "lease",
        target: {
          harness: "claude-code",
          sessionId: "session-one",
          workingDirectory: directory,
        },
        kind: "whisper",
      });
      expect(
        disabledLease.ok && disabledLease.type === "leased"
          ? disabledLease.deliveries
          : [],
      ).toHaveLength(0);
      await rm(join(directory, "subconscious.toml"));
      await writeProjectConfig(directory, {
        version: 1,
        agentId: "agent-test",
        model: "letta/auto",
        delivery: { whispers: true, queueMessages: false },
        observer: {},
      });

      const wrongSessionLease = await sendBrokerRequest(descriptor, {
        type: "lease",
        target: {
          harness: "claude-code",
          sessionId: "session-two",
          workingDirectory: directory,
        },
        kind: "whisper",
      });
      expect(
        wrongSessionLease.ok && wrongSessionLease.type === "leased"
          ? wrongSessionLease.deliveries
          : [],
      ).toHaveLength(0);

      const leased = await sendBrokerRequest(descriptor, {
        type: "lease",
        target: {
          harness: "claude-code",
          sessionId: "session-one",
          workingDirectory: directory,
        },
        kind: "whisper",
      });
      expect(
        leased.ok && leased.type === "leased" ? leased.deliveries : [],
      ).toHaveLength(1);
      const delivery =
        leased.ok && leased.type === "leased"
          ? leased.deliveries[0]
          : undefined;
      expect(delivery?.text).toBe("Check the deployment order.");

      const repeatedLease = await sendBrokerRequest(descriptor, {
        type: "lease",
        target: {
          harness: "claude-code",
          sessionId: "session-one",
          workingDirectory: directory,
        },
        kind: "whisper",
      });
      const repeated =
        repeatedLease.ok && repeatedLease.type === "leased"
          ? repeatedLease.deliveries[0]
          : undefined;
      expect(repeated?.id).toBe(delivery?.id);
      expect(repeated?.attempts).toBe(2);

      await sendBrokerRequest(descriptor, {
        type: "ack",
        deliveryIds: [delivery!.id],
        nativeReceipt: "hook-stdout",
      });
      const status = await sendBrokerRequest(descriptor, { type: "status" });
      if (!status.ok || status.type !== "status")
        throw new Error("Missing broker status.");
      expect(status.state.deliveries[delivery!.id]?.status).toBe("delivered");
      expect(
        status.state.deliveries[deliveryId(event.id, "whisper", "expired")]
          ?.status,
      ).toBe("expired");
      expect(Object.values(status.state.routes)[0]?.conversationId).toBe(
        "conv-observer",
      );
    } finally {
      await broker.close();
    }
  });

  it("blocks a route behind an ambiguous event until OTID reconciliation", async () => {
    const directory = await root();
    await writeProjectConfig(directory, {
      version: 1,
      agentId: "agent-test",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
    const descriptor: BrokerDescriptor = {
      version: 1,
      endpoint:
        process.platform === "win32"
          ? `\\\\.\\pipe\\subconscious-test-${randomUUID()}`
          : join(directory, "reconcile.sock"),
      token: "test-token",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    const seenConversationIds: Array<string | null> = [];
    let turns = 0;
    const runtime = {
      run: async (
        input: RunObservationInput,
      ): Promise<RunObservationResult> => {
        turns += 1;
        seenConversationIds.push(input.route.conversationId);
        if (input.event.id === "ambiguous") throw new Error("runtime crashed");
        return {
          status: "success",
          effectiveModel: null,
          conversationId: "conv-recovered",
          result: {
            type: "result",
            success: true,
            durationMs: 1,
            conversationId: "conv-recovered",
            runIds: ["run-recovered"],
          },
        };
      },
      findConversationByOtid: async () => ({
        conversationId: "conv-recovered",
      }),
    };
    const broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime,
    });
    await broker.start();
    try {
      const event = (id: string) => ({
        id,
        harness: "letta-code" as const,
        type: "turn_stop" as const,
        sessionId: "session-one",
        workingDirectory: directory,
        occurredAt: new Date().toISOString(),
        payload: { assistant_message: id },
      });
      await sendBrokerRequest(descriptor, {
        type: "observe",
        event: event("ambiguous"),
      });
      await sendBrokerRequest(descriptor, {
        type: "observe",
        event: event("later"),
      });
      await waitFor(async () => {
        const response = await sendBrokerRequest(descriptor, {
          type: "status",
        });
        return (
          response.ok &&
          response.type === "status" &&
          response.state.observations.ambiguous?.status ===
            "needs_reconciliation"
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(turns).toBe(1);

      const found = await sendBrokerRequest(descriptor, {
        type: "reconcile",
        eventId: "ambiguous",
        action: "retry",
      });
      expect(found).toMatchObject({
        ok: true,
        type: "reconciled",
        status: "already_recorded",
        conversationId: "conv-recovered",
      });
      expect(turns).toBe(1);

      await sendBrokerRequest(descriptor, {
        type: "reconcile",
        eventId: "ambiguous",
        action: "discard",
      });
      await waitFor(async () => {
        const response = await sendBrokerRequest(descriptor, {
          type: "status",
        });
        return (
          response.ok &&
          response.type === "status" &&
          response.state.observations.later?.status === "processed"
        );
      });
      expect(turns).toBe(2);
      expect(seenConversationIds).toEqual([null, "conv-recovered"]);
    } finally {
      await broker.close();
    }
  });

  it("serializes native sessions that share one observer agent", async () => {
    const directory = await root();
    await writeProjectConfig(directory, {
      version: 1,
      agentId: "agent-shared",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
    const descriptor: BrokerDescriptor = {
      version: 1,
      endpoint:
        process.platform === "win32"
          ? `\\\\.\\pipe\\subconscious-test-${randomUUID()}`
          : join(directory, "serialization.sock"),
      token: "test-token",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    let active = 0;
    let maximumActive = 0;
    const runtime = {
      run: async (
        input: RunObservationInput,
      ): Promise<RunObservationResult> => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        const conversationId = `conv-${input.event.sessionId}`;
        return {
          status: "success",
          effectiveModel: null,
          conversationId,
          result: {
            type: "result",
            success: true,
            durationMs: 25,
            conversationId,
            runIds: [`run-${input.event.sessionId}`],
          },
        };
      },
    };
    const broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime,
    });
    await broker.start();
    try {
      await Promise.all(
        ["one", "two"].map((sessionId) =>
          sendBrokerRequest(descriptor, {
            type: "observe",
            event: {
              id: `event-${sessionId}`,
              harness: "claude-code",
              type: "session_start",
              sessionId,
              workingDirectory: directory,
              occurredAt: new Date().toISOString(),
              payload: {},
            },
          }),
        ),
      );
      await waitFor(async () => {
        const response = await sendBrokerRequest(descriptor, {
          type: "status",
        });
        return (
          response.ok &&
          response.type === "status" &&
          Object.values(response.state.observations).every(
            (observation) => observation.status === "processed",
          )
        );
      });
      const status = await sendBrokerRequest(descriptor, { type: "status" });
      if (!status.ok || status.type !== "status")
        throw new Error("Missing broker status.");
      expect(maximumActive).toBe(1);
      expect(
        Object.values(status.state.routes)
          .map((route) => route.conversationId)
          .sort(),
      ).toEqual(["conv-one", "conv-two"]);
    } finally {
      await broker.close();
    }
  });

  it("keeps pending deliveries across a broker restart", async () => {
    const directory = await root();
    await writeProjectConfig(directory, {
      version: 1,
      agentId: "agent-test",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
    const descriptor: BrokerDescriptor = {
      version: 1,
      endpoint:
        process.platform === "win32"
          ? `\\\\.\\pipe\\subconscious-test-${randomUUID()}`
          : join(directory, "restart.sock"),
      token: "test-token",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    const runtime = {
      run: async (
        input: RunObservationInput,
      ): Promise<RunObservationResult> => {
        await input.persistDelivery({
          id: deliveryId(input.event.id, "whisper", "restart"),
          routeKey: input.route.key,
          observationId: input.event.id,
          kind: "whisper",
          text: "Survived restart.",
          priority: "normal",
          dedupeKey: "restart",
          status: "pending",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          attempts: 0,
        });
        return {
          status: "success",
          effectiveModel: null,
          conversationId: "conv-observer",
          result: {
            type: "result",
            success: true,
            durationMs: 1,
            conversationId: "conv-observer",
            runIds: ["run-observer"],
          },
        };
      },
    };
    let broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime,
    });
    await broker.start();
    try {
      await sendBrokerRequest(descriptor, {
        type: "observe",
        event: {
          id: "restart-event",
          harness: "claude-code",
          type: "session_start",
          sessionId: "restart-session",
          workingDirectory: directory,
          occurredAt: new Date().toISOString(),
          payload: {},
        },
      });
      await waitFor(async () => {
        const response = await sendBrokerRequest(descriptor, {
          type: "status",
        });
        return (
          response.ok &&
          response.type === "status" &&
          response.state.observations["restart-event"]?.status === "processed"
        );
      });
      await broker.close();

      broker = new SubconsciousBroker({
        descriptor,
        stateDirectory: directory,
        runtime,
      });
      await broker.start();
      const leased = await sendBrokerRequest(descriptor, {
        type: "lease",
        target: {
          harness: "claude-code",
          sessionId: "restart-session",
          workingDirectory: directory,
        },
        kind: "whisper",
      });
      expect(
        leased.ok && leased.type === "leased"
          ? leased.deliveries[0]?.text
          : null,
      ).toBe("Survived restart.");
    } finally {
      await broker.close();
    }
  });

  it("never persists an unbounded observation payload", async () => {
    const directory = await root();
    await writeProjectConfig(directory, {
      version: 1,
      agentId: "agent-test",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
    const descriptor: BrokerDescriptor = {
      version: 1,
      endpoint:
        process.platform === "win32"
          ? `\\\\.\\pipe\\subconscious-test-${randomUUID()}`
          : join(directory, "broker.sock"),
      token: "test-token",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    let seenPayload: Record<string, unknown> = {};
    const runtime = {
      run: async (
        input: RunObservationInput,
      ): Promise<RunObservationResult> => {
        seenPayload = input.event.payload;
        return {
          status: "success",
          effectiveModel: null,
          conversationId: "conv-observer",
          result: {
            type: "result",
            success: true,
            durationMs: 1,
            conversationId: "conv-observer",
            runIds: ["run-observer"],
          },
        };
      },
    };
    const broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime,
    });
    await broker.start();
    try {
      const huge = "x".repeat(400_000);
      await sendBrokerRequest(descriptor, {
        type: "observe",
        event: {
          id: "huge-event",
          harness: "claude-code",
          type: "session_start",
          sessionId: "huge-session",
          workingDirectory: directory,
          occurredAt: new Date().toISOString(),
          payload: {
            transcript_path: join(directory, "transcript.jsonl"),
            tool_input: { command: huge },
            tool_response: huge,
          },
        },
      });
      await waitFor(async () => {
        const response = await sendBrokerRequest(descriptor, {
          type: "status",
        });
        return (
          response.ok &&
          response.type === "status" &&
          response.state.observations["huge-event"]?.status === "processed"
        );
      });
      // The turn still saw the small fields it routes on, and never the
      // megabyte the harness sent.
      expect(seenPayload.transcript_path).toBe(
        join(directory, "transcript.jsonl"),
      );
      expect(JSON.stringify(seenPayload).length).toBeLessThan(200_000);
      // A processed observation can never be re-prepared, so nothing of the
      // payload survives on disk.
      const persisted = await readFile(join(directory, "state.json"), "utf8");
      expect(persisted).not.toContain("x".repeat(1_000));
      expect(persisted.length).toBeLessThan(100_000);
    } finally {
      await broker.close();
    }
  });
});

describe("mid-turn observation", () => {
  async function project(midTurn?: {
    minToolCalls: number;
    minSeconds: number;
  }): Promise<string> {
    const directory = await root();
    await writeProjectConfig(directory, {
      version: 1,
      agentId: "agent-mid-turn",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: { ...(midTurn ? { midTurn } : {}) },
    });
    return directory;
  }

  function socket(directory: string, name: string): BrokerDescriptor {
    return {
      version: 1,
      endpoint:
        process.platform === "win32"
          ? `\\\\.\\pipe\\subconscious-test-${randomUUID()}`
          : join(directory, `${name}.sock`),
      token: "test-token",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
  }

  function toolEvent(directory: string, index: number) {
    return {
      id: `tool-${index}`,
      harness: "claude-code" as const,
      type: "tool_result" as const,
      sessionId: "session-mid",
      workingDirectory: directory,
      occurredAt: new Date().toISOString(),
      payload: { session_id: "session-mid", cwd: directory, tool_name: "Bash" },
    };
  }

  async function state(descriptor: BrokerDescriptor) {
    const response = await sendBrokerRequest(descriptor, { type: "status" });
    if (!response.ok || response.type !== "status")
      throw new Error("Missing broker status.");
    return response.state;
  }

  function successfulRun(): RunObservationResult {
    return {
      status: "success",
      effectiveModel: null,
      conversationId: "conv-observer",
      result: {
        type: "result",
        success: true,
        durationMs: 1,
        conversationId: "conv-observer",
        runIds: ["run-observer"],
      },
    };
  }

  it("collapses a burst of tool calls into at most two observer turns", async () => {
    // Every queued observation on one route reads the same transcript delta, so
    // a second one behind the first has nothing left to report. The broker
    // therefore folds them: one record can be running while one collects, and
    // that is the whole cost of a busy turn.
    const directory = await project({ minToolCalls: 1, minSeconds: 0 });
    const descriptor = socket(directory, "coalesce");
    let turns = 0;
    const broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime: {
        run: async (): Promise<RunObservationResult> => {
          turns += 1;
          await new Promise((resolve) => setTimeout(resolve, 200));
          return successfulRun();
        },
      },
    });
    await broker.start();
    try {
      for (let index = 0; index < 20; index += 1) {
        await sendBrokerRequest(descriptor, {
          type: "observe",
          event: toolEvent(directory, index),
        });
      }
      await waitFor(async () => {
        const observations = Object.values(
          (await state(descriptor)).observations,
        );
        return observations.every(
          (observation) =>
            observation.status !== "queued" &&
            observation.status !== "processing",
        );
      }, 5_000);

      const observations = Object.values(
        (await state(descriptor)).observations,
      );
      expect(observations.length).toBeLessThanOrEqual(2);
      expect(turns).toBeLessThanOrEqual(2);
      // All twenty are accounted for: the records together stand for every
      // tool call the harness reported.
      const represented = observations.reduce(
        (total, observation) => total + (observation.coalesced ?? 0) + 1,
        0,
      );
      expect(represented).toBe(20);
    } finally {
      await broker.close();
    }
  });

  it("holds a mid-turn record below the configured thresholds", async () => {
    const directory = await project({ minToolCalls: 5, minSeconds: 0 });
    const descriptor = socket(directory, "gate");
    let turns = 0;
    const broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime: {
        run: async (): Promise<RunObservationResult> => {
          turns += 1;
          return successfulRun();
        },
      },
    });
    await broker.start();
    try {
      for (let index = 0; index < 4; index += 1) {
        await sendBrokerRequest(descriptor, {
          type: "observe",
          event: toolEvent(directory, index),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const waiting = (await state(descriptor)).observations["tool-0"];
      expect(turns).toBe(0);
      expect(waiting?.status).toBe("queued");
      expect(waiting?.coalesced).toBe(3);
      // Folding replaces the event and keeps the record's identity, so the
      // OTID reconciliation searches for is still the one the send will use.
      expect(waiting?.otid).toBe("tool-0");
      expect(waiting?.event.id).toBe("tool-0");
      expect(Object.keys((await state(descriptor)).observations)).toEqual([
        "tool-0",
      ]);

      await sendBrokerRequest(descriptor, {
        type: "observe",
        event: toolEvent(directory, 4),
      });
      await waitFor(
        async () =>
          (await state(descriptor)).observations["tool-0"]?.status ===
          "processed",
      );
      expect(turns).toBe(1);
    } finally {
      await broker.close();
    }
  });

  it("discards a queued mid-turn record when the turn stops", async () => {
    const directory = await project({ minToolCalls: 5, minSeconds: 0 });
    const descriptor = socket(directory, "supersede");
    let turns = 0;
    const broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime: {
        run: async (): Promise<RunObservationResult> => {
          turns += 1;
          return successfulRun();
        },
      },
    });
    await broker.start();
    try {
      for (let index = 0; index < 2; index += 1) {
        await sendBrokerRequest(descriptor, {
          type: "observe",
          event: toolEvent(directory, index),
        });
      }
      await sendBrokerRequest(descriptor, {
        type: "observe",
        event: {
          id: "stop-1",
          harness: "claude-code",
          type: "turn_stop",
          sessionId: "session-mid",
          workingDirectory: directory,
          occurredAt: new Date().toISOString(),
          payload: {},
        },
      });
      await waitFor(
        async () =>
          (await state(descriptor)).observations["stop-1"]?.status ===
          "processed",
      );
      // The Stop delta contains everything the mid-turn record was holding, so
      // running both would spend a turn on an empty observation.
      const superseded = (await state(descriptor)).observations["tool-0"];
      expect(superseded?.status).toBe("discarded");
      expect(superseded?.error).toContain("Superseded");
      expect(turns).toBe(1);
    } finally {
      await broker.close();
    }
  });

  it("refuses a tool boundary when the project has not enabled it", async () => {
    const directory = await project();
    const descriptor = socket(directory, "off");
    let turns = 0;
    const broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime: {
        run: async (): Promise<RunObservationResult> => {
          turns += 1;
          return successfulRun();
        },
      },
    });
    await broker.start();
    try {
      const refused = await sendBrokerRequest(descriptor, {
        type: "observe",
        event: toolEvent(directory, 0),
      });
      expect(refused).toMatchObject({
        ok: true,
        type: "observed",
        accepted: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      // Nothing is recorded at all: no observation, and no route either, so a
      // project without the flag stores what it always stored.
      const current = await state(descriptor);
      expect(Object.keys(current.observations)).toHaveLength(0);
      expect(Object.keys(current.routes)).toHaveLength(0);
      expect(turns).toBe(0);
    } finally {
      await broker.close();
    }
  });

  it("releases a mid-turn record the previous broker left queued", async () => {
    const directory = await project({ minToolCalls: 5, minSeconds: 0 });
    const descriptor = socket(directory, "stranded");
    const runtime = {
      run: async (): Promise<RunObservationResult> => successfulRun(),
    };
    let broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime,
    });
    await broker.start();
    try {
      await sendBrokerRequest(descriptor, {
        type: "observe",
        event: toolEvent(directory, 0),
      });
      expect((await state(descriptor)).observations["tool-0"]?.status).toBe(
        "queued",
      );
    } finally {
      await broker.close();
    }

    broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime,
    });
    await broker.start();
    try {
      // Retention never prunes a queued record, and the turn it belonged to is
      // over, so it would otherwise sit there for good.
      expect((await state(descriptor)).observations["tool-0"]?.status).toBe(
        "discarded",
      );
    } finally {
      await broker.close();
    }
  });
});

describe("broker shutdown", () => {
  it("outlives its own socket while a turn is still in flight", async () => {
    // A shutting-down broker closes its listener first and then waits for the
    // work it already started, because cutting an observer turn in half would
    // leave a whisper that may or may not have been sent. So the socket goes
    // quiet long before the process does, and anything that reads a failed ping
    // as "stopped" will start a replacement while this one still holds the
    // start-up lock. `subconscious stop` therefore waits for the process.
    const directory = await root();
    await writeProjectConfig(directory, {
      version: 1,
      agentId: "agent-test",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
    const descriptor: BrokerDescriptor = {
      version: 1,
      endpoint:
        process.platform === "win32"
          ? `\\\\.\\pipe\\subconscious-test-${randomUUID()}`
          : join(directory, "shutdown.sock"),
      token: "test-token",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime: {
        run: async (): Promise<RunObservationResult> => {
          started = true;
          await inFlight;
          return {
            status: "success",
            effectiveModel: null,
            conversationId: "conv-observer",
            result: {
              type: "result",
              success: true,
              durationMs: 1,
              conversationId: "conv-observer",
              runIds: ["run-observer"],
            },
          };
        },
      },
    });
    await broker.start();
    await sendBrokerRequest(descriptor, {
      type: "observe",
      event: {
        id: "shutdown-event",
        harness: "claude-code",
        type: "session_start",
        sessionId: "shutdown-session",
        workingDirectory: directory,
        occurredAt: new Date().toISOString(),
        payload: {},
      },
    });
    await waitFor(async () => started);

    let closed = false;
    const closing = broker.close().then(() => {
      closed = true;
    });
    await waitFor(async () => {
      // The listener is gone as soon as close() begins.
      const reachable = await sendBrokerRequest(descriptor, { type: "ping" })
        .then(() => true)
        .catch(() => false);
      return !reachable;
    });
    expect(closed).toBe(false);

    release();
    await closing;
    expect(closed).toBe(true);
    const state = JSON.parse(
      await readFile(join(directory, "state.json"), "utf8"),
    ) as { observations: Record<string, { status: string }> };
    // The turn finished rather than being abandoned mid-flight.
    expect(state.observations["shutdown-event"]?.status).toBe("processed");
  });
});

describe("session status claim", () => {
  it("hands the session identity to the first caller only", async () => {
    const directory = await root();
    await writeProjectConfig(directory, {
      version: 1,
      agentId: "agent-test",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
    const descriptor: BrokerDescriptor = {
      version: 1,
      endpoint:
        process.platform === "win32"
          ? `\\\\.\\pipe\\subconscious-test-${randomUUID()}`
          : join(directory, "broker.sock"),
      token: "test-token",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    const runtime = {
      run: async (): Promise<RunObservationResult> => ({
        status: "success",
        effectiveModel: null,
        conversationId: "conv-observer",
        result: {
          type: "result",
          success: true,
          durationMs: 1,
          conversationId: "conv-observer",
          runIds: ["run-observer"],
        },
      }),
    };
    const broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime,
    });
    await broker.start();
    try {
      const target = {
        harness: "claude-code" as const,
        sessionId: "session-status",
        workingDirectory: directory,
      };

      // No route exists until the session's first observation is recorded.
      const beforeRoute = await sendBrokerRequest(descriptor, {
        type: "claim_session_status",
        target,
      });
      expect(beforeRoute).toMatchObject({
        ok: true,
        type: "session_status",
        status: null,
      });

      await sendBrokerRequest(descriptor, {
        type: "observe",
        event: {
          id: "event-status",
          harness: "claude-code" as const,
          type: "session_start" as const,
          sessionId: "session-status",
          workingDirectory: directory,
          occurredAt: new Date().toISOString(),
          payload: {},
        },
      });

      const claimed = await sendBrokerRequest(descriptor, {
        type: "claim_session_status",
        target,
      });
      expect(claimed).toMatchObject({
        ok: true,
        type: "session_status",
        status: {
          agentId: "agent-test",
          model: "letta/auto",
          harness: "claude-code",
          sessionId: "session-status",
          projectRoot: directory,
          whispers: true,
          queuedMessages: false,
        },
      });

      const second = await sendBrokerRequest(descriptor, {
        type: "claim_session_status",
        target,
      });
      expect(second).toMatchObject({
        ok: true,
        type: "session_status",
        status: null,
      });
    } finally {
      await broker.close();
    }
  });
});

describe("model overrides", () => {
  it("records requested, source, effort, and effective model on the route", async () => {
    const directory = await root();
    await writeProjectConfig(
      directory,
      validateProjectConfig({
        version: 1,
        agent_id: "agent-test",
        model_overrides: {
          claude_code: {
            model: "anthropic/claude-sonnet-5",
            reasoning_effort: "high",
          },
          codex: { model: "openai/gpt-5.2" },
        },
        delivery: { whispers: true, queue_messages: false },
        observer: {},
      }),
    );
    const descriptor: BrokerDescriptor = {
      version: 1,
      endpoint:
        process.platform === "win32"
          ? `\\\\.\\pipe\\subconscious-test-${randomUUID()}`
          : join(directory, "broker.sock"),
      token: "test-token",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    const runtime = {
      run: async (
        input: RunObservationInput,
      ): Promise<RunObservationResult> => ({
        status: "success",
        conversationId: "conv-observer",
        result: {
          type: "result",
          success: true,
          durationMs: 1,
          conversationId: "conv-observer",
          runIds: ["run-observer"],
        },
        effectiveModel: "anthropic/claude-sonnet-5",
        appliedModelState: {
          model: "anthropic/claude-sonnet-5",
          modelSettings: null,
          contextWindowLimit: null,
        },
      }),
    };
    const broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime,
    });
    await broker.start();
    try {
      const event = {
        id: "event-override",
        harness: "claude-code" as const,
        type: "session_start" as const,
        sessionId: "session-override",
        workingDirectory: directory,
        occurredAt: new Date().toISOString(),
        payload: {},
      };
      await sendBrokerRequest(descriptor, { type: "observe", event });
      await waitFor(async () => {
        const response = await sendBrokerRequest(descriptor, {
          type: "status",
        });
        return (
          response.ok &&
          response.type === "status" &&
          response.state.observations[event.id]?.status === "processed"
        );
      });

      const state = await sendBrokerRequest(descriptor, { type: "status" });
      if (!state.ok || state.type !== "status") throw new Error("no state");
      const routeKey = Object.keys(state.state.routes)[0];
      expect(state.state.routes[routeKey]).toMatchObject({
        requestedModel: "anthropic/claude-sonnet-5",
        modelOverrideSource: "harness",
        reasoningEffort: "high",
        effectiveModel: "anthropic/claude-sonnet-5",
        appliedModelState: {
          model: "anthropic/claude-sonnet-5",
          modelSettings: null,
          contextWindowLimit: null,
        },
      });

      // The same session under a different harness resolves a different
      // override without disturbing the first route.
      await sendBrokerRequest(descriptor, {
        type: "observe",
        event: {
          ...event,
          id: "event-override-codex",
          harness: "codex" as const,
          sessionId: "session-override-codex",
        },
      });
      await waitFor(async () => {
        const response = await sendBrokerRequest(descriptor, {
          type: "status",
        });
        return (
          response.ok &&
          response.type === "status" &&
          response.state.observations["event-override-codex"]?.status ===
            "processed"
        );
      });
      const after = await sendBrokerRequest(descriptor, { type: "status" });
      if (!after.ok || after.type !== "status") throw new Error("no state");
      const codexRoute = Object.values(after.state.routes).find(
        (route) => route.harness === "codex",
      );
      expect(codexRoute).toMatchObject({
        requestedModel: "openai/gpt-5.2",
        modelOverrideSource: "harness",
      });
    } finally {
      await broker.close();
    }
  });

  it("drops a stale effective model when a later turn reports none", async () => {
    const directory = await root();
    await writeProjectConfig(directory, {
      version: 1,
      agentId: "agent-test",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
    const descriptor: BrokerDescriptor = {
      version: 1,
      endpoint:
        process.platform === "win32"
          ? `\\\\.\\pipe\\subconscious-test-${randomUUID()}`
          : join(directory, "broker.sock"),
      token: "test-token",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    let turns = 0;
    const broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime: {
        run: async (
          input: RunObservationInput,
        ): Promise<RunObservationResult> => {
          turns += 1;
          return {
            status: "success",
            conversationId: "conv-observer",
            result: {
              type: "result",
              success: true,
              durationMs: 1,
              conversationId: "conv-observer",
              runIds: [`run-${turns}`],
            },
            // The backend reported a model on turn one and nothing on turn
            // two; the route must follow rather than keep the old value.
            effectiveModel: turns === 1 ? "letta/auto" : null,
          };
        },
      },
    });
    await broker.start();
    try {
      for (const [index, eventId] of ["event-one", "event-two"].entries()) {
        await sendBrokerRequest(descriptor, {
          type: "observe",
          event: {
            id: eventId,
            harness: "claude-code" as const,
            type: "turn_stop" as const,
            sessionId: "session-effective",
            workingDirectory: directory,
            occurredAt: new Date().toISOString(),
            payload: {},
          },
        });
        await waitFor(async () => {
          const response = await sendBrokerRequest(descriptor, {
            type: "status",
          });
          return (
            response.ok &&
            response.type === "status" &&
            response.state.observations[eventId]?.status === "processed"
          );
        });
        void index;
      }

      const after = await sendBrokerRequest(descriptor, { type: "status" });
      if (!after.ok || after.type !== "status") throw new Error("no state");
      const route = Object.values(after.state.routes)[0];
      expect(turns).toBe(2);
      expect(route.effectiveModel).toBeUndefined();
    } finally {
      await broker.close();
    }
  });

  it("keeps legacy routes that only carry the old model field loadable", async () => {
    const directory = await root();
    await writeProjectConfig(directory, {
      version: 1,
      agentId: "agent-test",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
    // A route written before overrides existed: a bare model string, no
    // requestedModel, no source, no applied state. The key is the real hash of
    // the route identity, because the identity never included the model.
    const identity = {
      configPath: join(directory, "subconscious.toml"),
      projectRoot: directory,
      agentId: "agent-test",
      harness: "claude-code" as const,
      sessionId: "session-legacy",
    };
    const legacyRoute = {
      key: routeKey(identity),
      ...identity,
      model: "letta/auto",
      conversationId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const seeded = {
      version: 1,
      routes: { [legacyRoute.key]: legacyRoute },
      observations: {},
      observationOrder: [],
      deliveries: {},
    };
    await writeFile(join(directory, "state.json"), JSON.stringify(seeded));

    const descriptor: BrokerDescriptor = {
      version: 1,
      endpoint:
        process.platform === "win32"
          ? `\\\\.\\pipe\\subconscious-test-${randomUUID()}`
          : join(directory, "broker.sock"),
      token: "test-token",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    const captured: { input: RunObservationInput | null } = { input: null };
    const broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime: {
        run: async (
          input: RunObservationInput,
        ): Promise<RunObservationResult> => {
          captured.input = input;
          return {
            status: "success",
            effectiveModel: null,
            conversationId: "conv-observer",
            result: {
              type: "result",
              success: true,
              durationMs: 1,
              conversationId: "conv-observer",
              runIds: ["run-legacy"],
            },
          };
        },
      },
    });
    await broker.start();
    try {
      // The legacy route is found by the same identity a new event computes,
      // because the route key never included the model.
      await sendBrokerRequest(descriptor, {
        type: "observe",
        event: {
          id: "event-legacy",
          harness: "claude-code" as const,
          type: "turn_stop" as const,
          sessionId: "session-legacy",
          workingDirectory: directory,
          occurredAt: new Date().toISOString(),
          payload: {},
        },
      });
      await waitFor(async () => {
        const response = await sendBrokerRequest(descriptor, {
          type: "status",
        });
        return (
          response.ok &&
          response.type === "status" &&
          response.state.observations["event-legacy"]?.status === "processed"
        );
      });

      if (!captured.input) throw new Error("The runtime was not called.");
      // The broker's migration claim ends here: the pre-override route is
      // found by the same identity and handed to the runtime with its legacy
      // state intact. Whether that triggers a management update is the
      // runtime's own test.
      expect(captured.input.route.key).toBe(legacyRoute.key);
      expect(captured.input.route.appliedModelState).toBeUndefined();

      const after = await sendBrokerRequest(descriptor, { type: "status" });
      if (!after.ok || after.type !== "status") throw new Error("no state");
      const route = after.state.routes[legacyRoute.key];
      expect(route).toMatchObject({
        modelOverrideSource: "project",
        requestedModel: "letta/auto",
      });
      // The obsolete field is retired on the first processed observation
      // rather than lingering beside its replacements.
      expect(route.model).toBeUndefined();
      expect(route.effectiveModel).toBeUndefined();
    } finally {
      await broker.close();
    }
  });
});

describe("direct queued messages", () => {
  async function project(queueMessages = true): Promise<string> {
    const directory = await root();
    await writeProjectConfig(directory, {
      version: 1,
      agentId: "agent-observer",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages },
      observer: {},
    });
    return directory;
  }

  function socket(directory: string, name: string): BrokerDescriptor {
    return {
      version: 1,
      endpoint:
        process.platform === "win32"
          ? `\\\\.\\pipe\\subconscious-test-${randomUUID()}`
          : join(directory, `${name}.sock`),
      token: "test-token",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
  }

  function lettaCodeEvent(directory: string, id: string) {
    return {
      id,
      harness: "letta-code" as const,
      type: "user_prompt" as const,
      sessionId: "conv-harness",
      workingDirectory: directory,
      occurredAt: new Date().toISOString(),
      payload: {
        agent_id: "agent-harness",
        conversation_id: "conv-harness",
        prompt: "Ship the release.",
      },
    };
  }

  function queueingRuntime(
    deliverQueuedMessage?: QueuedMessageDeliverer,
  ): BrokerRuntime {
    return {
      run: async (
        input: RunObservationInput,
      ): Promise<RunObservationResult> => {
        await input.persistDelivery({
          id: deliveryId(input.event.id, "queued_message", "act-now"),
          routeKey: input.route.key,
          observationId: input.event.id,
          kind: "queued_message",
          text: "Run the migration before the deploy.",
          priority: "normal",
          dedupeKey: "act-now",
          status: "pending",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          attempts: 0,
        });
        return {
          status: "success",
          effectiveModel: null,
          conversationId: "conv-observer",
          result: {
            type: "result",
            success: true,
            durationMs: 1,
            conversationId: "conv-observer",
            runIds: ["run-observer"],
          },
        };
      },
      ...(deliverQueuedMessage ? { deliverQueuedMessage } : {}),
    };
  }

  async function deliveries(
    descriptor: BrokerDescriptor,
  ): Promise<Record<string, DeliveryRecord>> {
    const response = await sendBrokerRequest(descriptor, { type: "status" });
    if (!response.ok || response.type !== "status")
      throw new Error("Missing broker status.");
    return response.state.deliveries;
  }

  it("delivers into the Letta Code conversation without a hook lease", async () => {
    const directory = await project();
    const descriptor = socket(directory, "queue");
    const sent: QueuedMessageDelivery[] = [];
    const broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime: queueingRuntime(async (input) => {
        sent.push(input);
        return { status: "delivered", nativeReceipt: "conv-harness" };
      }),
    });
    await broker.start();
    try {
      await sendBrokerRequest(descriptor, {
        type: "observe",
        event: lettaCodeEvent(directory, "event-queue"),
      });
      const id = deliveryId("event-queue", "queued_message", "act-now");
      await waitFor(
        async () => (await deliveries(descriptor))[id] !== undefined,
      );
      await waitFor(
        async () => (await deliveries(descriptor))[id]?.status === "delivered",
      );

      // The message went to the coding agent, never to the observer.
      expect(sent).toHaveLength(1);
      expect(sent[0]?.identity).toEqual({
        agentId: "agent-harness",
        conversationId: "conv-harness",
      });
      expect(sent[0]?.deliveryId).toBe(id);
      expect(sent[0]?.text).toBe("Run the migration before the deploy.");

      const record = (await deliveries(descriptor))[id];
      expect(record?.acknowledgedAt).toBeTruthy();
      expect(record?.nativeReceipt).toBe("conv-harness");
      expect(record?.attempts).toBe(1);
      expect(record?.lastError).toBeUndefined();

      // No hook ever asks for it, and one that did would get nothing.
      const leased = await sendBrokerRequest(descriptor, {
        type: "lease",
        target: {
          harness: "letta-code",
          sessionId: "conv-harness",
          workingDirectory: directory,
        },
        kind: "queued_message",
      });
      expect(
        leased.ok && leased.type === "leased" ? leased.deliveries : [],
      ).toHaveLength(0);
    } finally {
      await broker.close();
    }
  });

  it("marks a queued message stale when the conversation changed owner", async () => {
    const directory = await project();
    const descriptor = socket(directory, "stale");
    const broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime: queueingRuntime(async () => ({
        status: "stale",
        error: "Conversation conv-harness belongs to another agent.",
      })),
    });
    await broker.start();
    try {
      await sendBrokerRequest(descriptor, {
        type: "observe",
        event: lettaCodeEvent(directory, "event-stale"),
      });
      const id = deliveryId("event-stale", "queued_message", "act-now");
      await waitFor(
        async () => (await deliveries(descriptor))[id]?.status === "stale",
      );
      expect((await deliveries(descriptor))[id]?.lastError).toContain(
        "another agent",
      );
    } finally {
      await broker.close();
    }
  });

  it("keeps a failed queued message pending and retries it after a restart", async () => {
    const directory = await project();
    const descriptor = socket(directory, "retry");
    let attempts = 0;
    const runtime = queueingRuntime(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("socket closed");
      return { status: "delivered", nativeReceipt: "conv-harness" };
    });
    let broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime,
    });
    await broker.start();
    const id = deliveryId("event-retry", "queued_message", "act-now");
    try {
      await sendBrokerRequest(descriptor, {
        type: "observe",
        event: lettaCodeEvent(directory, "event-retry"),
      });
      // A send that throws must not fail the observation that produced it.
      await waitFor(async () => {
        const response = await sendBrokerRequest(descriptor, {
          type: "status",
        });
        return (
          response.ok &&
          response.type === "status" &&
          response.state.observations["event-retry"]?.status === "processed" &&
          response.state.deliveries[id]?.attempts === 1
        );
      });
      const failed = (await deliveries(descriptor))[id];
      expect(failed?.status).toBe("pending");
      expect(failed?.lastError).toContain("socket closed");
    } finally {
      await broker.close();
    }

    broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime,
    });
    await broker.start();
    try {
      await waitFor(
        async () => (await deliveries(descriptor))[id]?.status === "delivered",
      );
      expect(attempts).toBe(2);
    } finally {
      await broker.close();
    }
  });

  it("sends nothing when the project has not opted in", async () => {
    const directory = await project(false);
    const descriptor = socket(directory, "disabled");
    const sent: QueuedMessageDelivery[] = [];
    const broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime: queueingRuntime(async (input) => {
        sent.push(input);
        return { status: "delivered" };
      }),
    });
    await broker.start();
    try {
      await sendBrokerRequest(descriptor, {
        type: "observe",
        event: lettaCodeEvent(directory, "event-disabled"),
      });
      const id = deliveryId("event-disabled", "queued_message", "act-now");
      await waitFor(
        async () => (await deliveries(descriptor))[id] !== undefined,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(sent).toHaveLength(0);
      expect((await deliveries(descriptor))[id]?.status).toBe("pending");
    } finally {
      await broker.close();
    }
  });
});
