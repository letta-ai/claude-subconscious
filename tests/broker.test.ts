import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubconsciousBroker } from "../packages/cli/broker.js";
import {
  deliveryId,
  sendBrokerRequest,
  writeProjectConfig,
  type BrokerDescriptor,
  type DeliveryRecord,
} from "../packages/core/index.js";
import type {
  RunObservationInput,
  RunObservationResult,
} from "../packages/agent-runtime/index.js";

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
});
