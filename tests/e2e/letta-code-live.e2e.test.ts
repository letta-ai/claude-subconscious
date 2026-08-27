import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_SDK_VERSION,
  appServerLogTail,
  assertNoCloudAgentsLeft,
  brokerState,
  cleanupFixtures,
  configureLettaFixture,
  createFixture,
  hookSightings,
  localConversationBlob,
  pendingRecord,
  poll,
  prepareLettaCli,
  registerHarnessRoute,
  repoRoot,
  resolveWorkingIdentity,
  restartBroker,
  runHeadlessTurn,
  seedDelivery,
  sessionRouteId,
  startQueueClient,
} from "./letta-code-fixture.js";

/**
 * Live Letta Code 0.30.32 acceptance for passive whispers and queue_message.
 *
 * Process isolation, the disposable `--backend local` store, the broker, route
 * identity, credential redaction and cleanup all come from
 * tests/e2e/letta-code-fixture.ts; this file holds only the two acceptance
 * cases.
 *
 * Passive whispers: one real headless `-p` process emits PostToolUse without
 * conversation identity, but no SessionStart or UserPromptSubmit delivery
 * boundary. The isolated PTY/TUI path lives in the companion test file.
 *
 * queue_message is a separate case. The original live acceptance (broker
 * status delivered after a terminal SDK result, nativeReceipt, model
 * read-back) stays unchecked. Cloud `--new-agent` was blocked by Letta Cloud
 * quota (insufficient credits and HTTP 402 agent cap 2000). Locally, the
 * first production drain persists the queued canary and Letta Code 0.30.32
 * emits turn_finished, but Agent SDK 0.7.6 never yields a stream result: it
 * waits for usage_statistics after stop_reason and ignores turn_finished
 * without run_id. AgentRuntime bounds that wait with queuedMessageTimeoutMs
 * and returns retry; this suite configures QUEUE_DRAIN_TIMEOUT_MS so the
 * first drain exercises that hang. A second broker drain then reconciles the
 * persisted deliveryId OTID on the target conversation, acknowledges
 * delivered without a second send, and leaves the canary posted once. It
 * does not treat on-disk persistence from the first drain as delivery
 * success by itself.
 *
 * Run with:
 *   npx vitest run --config vitest.letta-code-e2e.config.ts
 * after `npm run build`.
 */

const LIVE_QUEUE_ACCEPTANCE = "unchecked";
const CLOUD_QUEUE_ACCEPTANCE =
  "unchecked: Letta Cloud --new-agent blocked by quota (insufficient credits / HTTP 402 agent cap 2000)";
const QUEUE_DRAIN_TIMEOUT_MS = 20_000;
const LIVE = process.env.SUBCONSCIOUS_LETTA_CODE_LIVE === "1";

configureLettaFixture({
  label: "live",
  tempPrefix: "sc-lc",
  pipeName: "subconscious-letta-e2e",
  observerAgentId: "agent-letta-code-e2e-observer",
  queuedMessageTimeoutMs: QUEUE_DRAIN_TIMEOUT_MS,
});

function isDedicatedLiveRun(): boolean {
  return (
    LIVE ||
    process.argv.some((arg) => arg.includes("vitest.letta-code-e2e.config"))
  );
}

async function assertAgentSdk076QueueAckContract(): Promise<void> {
  const sdkRoot = join(
    repoRoot,
    "node_modules",
    "@letta-ai",
    "letta-agent-sdk",
  );
  const pkg = JSON.parse(
    await readFile(join(sdkRoot, "package.json"), "utf8"),
  ) as { name?: string; version?: string };
  expect(pkg.name).toBe("@letta-ai/letta-agent-sdk");
  expect(pkg.version).toBe(AGENT_SDK_VERSION);
  const coordinator = await readFile(
    join(sdkRoot, "src", "remote-turn-coordinator.ts"),
    "utf8",
  );
  expect(coordinator).toContain("if (!active || !finished.runId) return");
  expect(coordinator).toContain(
    'if (messageType === "usage_statistics" && active.pendingTerminal)',
  );
  expect(coordinator).toContain(
    "this.completeActiveTurn(active.pendingTerminal)",
  );
  expect(coordinator).toContain("if (active.pendingTerminal) return");
}

const liveDescribe = isDedicatedLiveRun() ? describe : describe.skip;

liveDescribe("Letta Code 0.30.32 live acceptance", () => {
  beforeAll(async () => {
    await prepareLettaCli();
  });

  afterEach(cleanupFixtures);

  afterAll(assertNoCloudAgentsLeft);

  it(
    "proves the 0.30.32 headless blocker for passive whispers with one real -p process",
    { timeout: 480_000 },
    async () => {
      const active = await createFixture({ queueMessages: false });
      const canary = `CANARY-${randomUUID().slice(0, 8)}`;
      const toolMarker = `TOOL-${randomUUID().slice(0, 8)}`;
      const evidence = await runHeadlessTurn(
        active,
        `Use exactly one Bash tool call with command: printf ${toolMarker}. Use no other tools. Then reply with exactly NONE.`,
        { newAgent: true },
      );
      expect(evidence.agentId.startsWith("agent-local-")).toBe(true);
      expect(evidence.resultText).not.toContain(canary);

      const routeKeyValue = await registerHarnessRoute(
        active,
        evidence.agentId,
        evidence.conversationId,
      );
      const otherRouteKey = await registerHarnessRoute(
        active,
        `${evidence.agentId}-other`,
        `${evidence.conversationId}-other`,
      );
      const route = (await brokerState(active)).routes[routeKeyValue];
      expect(route).toBeDefined();
      const whisper = pendingRecord(
        route!,
        "whisper",
        `The canary phrase is ${canary}.`,
        `whisper-${canary}`,
      );
      await seedDelivery(active, whisper);

      const hooks = await hookSightings(active);
      const eventTypes = hooks
        .map((entry) => entry.eventType)
        .filter((event): event is string => Boolean(event));
      const postTool = hooks.filter(
        (entry) => entry.eventType === "PostToolUse",
      );
      expect(eventTypes).not.toContain("SessionStart");
      expect(eventTypes).not.toContain("UserPromptSubmit");
      expect(eventTypes).not.toContain("Stop");
      expect(postTool.length).toBeGreaterThan(0);
      for (const sighting of postTool) {
        expect(sighting.conversationIdPresent).toBe(false);
        expect(sighting.sessionIdPresent).toBe(false);
        expect(sighting.env.CONVERSATION_ID).toBe(false);
        expect(sighting.env.LETTA_CONVERSATION_ID).toBe(false);
      }
      const afterSeed = await brokerState(active);
      expect(afterSeed.deliveries[whisper.id]?.status).toBe("pending");
      expect(afterSeed.deliveries[whisper.id]?.acknowledgedAt).toBeUndefined();
      expect(afterSeed.deliveries[whisper.id]?.routeKey).toBe(routeKeyValue);
      expect(afterSeed.deliveries[whisper.id]?.routeKey).not.toBe(
        otherRouteKey,
      );
      expect(evidence.resultText).not.toContain(canary);
    },
  );

  it(
    "proves the 0.30.32 local queue_message SDK hang then delivers via OTID without a duplicate send",
    { timeout: 480_000 },
    async () => {
      expect(LIVE_QUEUE_ACCEPTANCE).toBe("unchecked");
      expect(CLOUD_QUEUE_ACCEPTANCE.startsWith("unchecked:")).toBe(true);
      await assertAgentSdk076QueueAckContract();

      const active = await createFixture({ queueMessages: true });
      const canary = `QUEUE-${randomUUID().slice(0, 8)}`;
      const prompt =
        "Reply with exactly READY and nothing else. Do not use tools.";

      const first = await runHeadlessTurn(active, prompt, { newAgent: true });
      expect(first.conversationId).toBeTruthy();
      const beforeQueue = await localConversationBlob(
        active,
        first.conversationId,
        first.agentId,
      );
      expect(beforeQueue).not.toContain(canary);

      const other = await runHeadlessTurn(active, prompt, { newAgent: true });
      expect(other.conversationId).not.toBe(first.conversationId);
      await startQueueClient(active);
      const firstIdentity = await resolveWorkingIdentity(active, first);
      const otherIdentity = await resolveWorkingIdentity(active, other);
      expect(firstIdentity.conversationId).not.toBe(
        otherIdentity.conversationId,
      );
      const otherRouteKey = await registerHarnessRoute(
        active,
        otherIdentity.agentId,
        otherIdentity.conversationId,
      );

      const routeKeyValue = await registerHarnessRoute(
        active,
        firstIdentity.agentId,
        firstIdentity.conversationId,
      );
      const state = await brokerState(active);
      const route = state.routes[routeKeyValue];
      expect(route?.harnessIdentity).toEqual(firstIdentity);
      const queuedText = `Queued acceptance canary ${canary}. Reply with exactly ${canary}.`;
      const queued = pendingRecord(
        route!,
        "queued_message",
        queuedText,
        `queue-${canary}`,
      );
      await seedDelivery(active, queued);

      const persisted = await poll(
        () =>
          localConversationBlob(
            active,
            firstIdentity.conversationId,
            firstIdentity.agentId,
          ),
        30_000,
        () => `waiting for persisted canary in ${firstIdentity.conversationId}`,
        (blob) => blob.includes(canary),
      );
      expect(persisted).toContain(canary);
      expect(persisted.split(queuedText).length - 1).toBe(1);
      const logs = await poll(
        async () => appServerLogTail(active),
        15_000,
        () => `waiting for turn_finished ${appServerLogTail(active)}`,
        (text) => text.includes("turn_finished"),
      );
      expect(logs).toContain("Emitting turn_finished");

      const retried = await poll(
        () => brokerState(active),
        40_000,
        async () =>
          `queued delivery ${queued.id} ${JSON.stringify((await brokerState(active)).deliveries[queued.id])}`,
        (current) => {
          const queuedDelivery = current.deliveries[queued.id];
          return (
            queuedDelivery?.status === "pending" &&
            (queuedDelivery.attempts ?? 0) > 0 &&
            Boolean(queuedDelivery.lastError)
          );
        },
      );
      const timedOut = retried.deliveries[queued.id];
      expect(timedOut?.status).toBe("pending");
      expect(timedOut?.acknowledgedAt).toBeUndefined();
      expect(timedOut?.nativeReceipt).toBeUndefined();
      expect(timedOut?.attempts).toBeGreaterThanOrEqual(1);
      expect(timedOut?.lastError).toContain("timed out");
      expect(timedOut?.lastError).toContain("terminal SDK result");
      expect(timedOut?.lastError).toContain(String(QUEUE_DRAIN_TIMEOUT_MS));
      expect(timedOut?.routeKey).toBe(routeKeyValue);
      expect(timedOut?.routeKey).not.toBe(otherRouteKey);

      await restartBroker(active);
      const delivered = await poll(
        () => brokerState(active),
        30_000,
        async () =>
          `OTID reconcile ${queued.id} ${JSON.stringify((await brokerState(active)).deliveries[queued.id])}`,
        (current) => current.deliveries[queued.id]?.status === "delivered",
      );
      const record = delivered.deliveries[queued.id];
      expect(record?.status).toBe("delivered");
      expect(record?.nativeReceipt).toBe(firstIdentity.conversationId);
      expect(record?.acknowledgedAt).toBeTruthy();
      expect(record?.attempts).toBeGreaterThanOrEqual(2);
      expect(record?.routeKey).toBe(routeKeyValue);

      const afterReconcile = await localConversationBlob(
        active,
        firstIdentity.conversationId,
        firstIdentity.agentId,
      );
      expect(afterReconcile.split(queuedText).length - 1).toBe(1);
      const otherMessages = await localConversationBlob(
        active,
        otherIdentity.conversationId,
        otherIdentity.agentId,
      );
      expect(otherMessages).not.toContain(canary);
      expect(delivered.routes[otherRouteKey]?.sessionId).toBe(
        sessionRouteId(otherIdentity.agentId, otherIdentity.conversationId),
      );
    },
  );
});
