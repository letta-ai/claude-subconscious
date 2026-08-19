import { describe, expect, it } from "vitest";
import { createDeliveryTools } from "../packages/agent-runtime/index.js";
import type { DeliveryRecord } from "../packages/core/index.js";

describe("explicit delivery tools", () => {
  it("persists a whisper before returning success", async () => {
    const deliveries: DeliveryRecord[] = [];
    const [tool] = createDeliveryTools({
      observationId: "event-1",
      routeKey: "route-1",
      allowWhisper: true,
      allowQueuedMessage: false,
      persist: async (delivery) => {
        deliveries.push(delivery);
      },
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const result = await tool!.execute("call-1", {
      text: "Check the migration order.",
      dedupeKey: "migration-order",
    });
    expect(result.isError).not.toBe(true);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      kind: "whisper",
      status: "pending",
      text: "Check the migration order.",
    });
  });

  it("omits queue_message when the adapter has no queue", () => {
    const tools = createDeliveryTools({
      observationId: "event",
      routeKey: "route",
      allowWhisper: true,
      allowQueuedMessage: false,
      persist: async () => {},
    });
    expect(tools.map((tool) => tool.name)).toEqual(["send_whisper"]);
  });

  it("exposes queue_message only when the adapter enables it", async () => {
    const deliveries: DeliveryRecord[] = [];
    const tools = createDeliveryTools({
      observationId: "event",
      routeKey: "route",
      allowWhisper: false,
      allowQueuedMessage: true,
      persist: async (delivery) => {
        deliveries.push(delivery);
      },
    });
    expect(tools.map((tool) => tool.name)).toEqual(["queue_message"]);
    await tools[0]!.execute("call", {
      text: "Please inspect the failed check.",
    });
    expect(deliveries[0]?.kind).toBe("queued_message");
  });

  it("uses a stable delivery ID across repeated calls", async () => {
    const ids: string[] = [];
    const [tool] = createDeliveryTools({
      observationId: "event",
      routeKey: "route",
      allowWhisper: true,
      allowQueuedMessage: false,
      persist: async (delivery) => {
        ids.push(delivery.id);
      },
    });
    await tool!.execute("call-a", { text: "Same", dedupeKey: "same" });
    await tool!.execute("call-b", { text: "Same", dedupeKey: "same" });
    expect(ids[0]).toBe(ids[1]);
  });
});
