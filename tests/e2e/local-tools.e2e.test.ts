import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import {
  AgentRuntime,
  createObserverAgent,
} from "../../packages/agent-runtime/index.js";
import { SubconsciousBroker } from "../../packages/cli/broker.js";
import {
  sendBrokerRequest,
  validateProjectConfig,
  writeProjectConfig,
  type BrokerDescriptor,
  type DeliveryRecord,
} from "../../packages/core/index.js";
import {
  startOwnedAppServer,
  type OwnedAppServer,
} from "./app-server-process.js";

/**
 * Live regression for local tool execution and whisper delivery.
 *
 * The canary exists only in `canary.txt` inside a temporary project. Trusted
 * `[observer].instructions` tell the disposable hidden observer to Read that
 * file and then call `send_whisper` with its trimmed contents, so a correct
 * run proves the whole local path at once: the app-server executes the real
 * `Read` tool against this machine, the broker executes the custom delivery
 * tool in its own process, and the text that comes back is byte-for-byte what
 * only the file could have supplied. A model guessing, a tool denied by the
 * allowlist, or a delivery tool running somewhere without project access all
 * fail the same way - no pending whisper.
 *
 * The harness event is synthetic because Claude Code is not what this suite
 * proves; the hook boundary has its own Claude-only suite. This case needs
 * `LETTA_API_KEY` and no Claude authentication.
 *
 * Run with `npm run test:model-e2e`. The key is read from the environment,
 * passed to SDK clients, and never printed or written anywhere.
 */

const roots: string[] = [];
const brokers: SubconsciousBroker[] = [];
let management: LettaAgentClient | null = null;
let ownedServer: OwnedAppServer | null = null;
let localClient: LettaAgentClient | null = null;
let disposableAgentId: string | null = null;

beforeAll(async () => {
  const apiKey = process.env.LETTA_API_KEY;
  // Fail loudly instead of skipping: an opted-in suite that silently passes
  // would let the pipeline it guards rot unnoticed.
  if (!apiKey) {
    throw new Error(
      "Set LETTA_API_KEY to run the live suites (npm run test:model-e2e).",
    );
  }
  management = new LettaAgentClient({ backend: "cloud", apiKey });
  // One App Server the suite owns and tears down itself; see the
  // model-overrides suite for the full rationale.
  ownedServer = await startOwnedAppServer();
  localClient = new LettaAgentClient({
    backend: "local",
    appServer: {
      url: ownedServer.url,
      harnessBackend: "api",
      pinGlobalAgent: false,
    },
  });
});

afterEach(async () => {
  const failures: string[] = [];
  // Brokers are closed even if one fails, and the fixtures are removed even
  // if every broker close failed; nothing in teardown short-circuits.
  for (const broker of brokers.splice(0)) {
    try {
      await broker.close();
    } catch (error) {
      failures.push(
        `broker close: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const removed = await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  for (const result of removed) {
    if (result.status === "rejected") {
      failures.push(`fixture removal: ${String(result.reason)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Teardown failures:\n- ${failures.join("\n- ")}`);
  }
});

afterAll(async () => {
  const failures: string[] = [];
  // Both cleanup steps run regardless of the other's outcome, and every
  // failure is reported together instead of the first one masking the rest.
  if (management && disposableAgentId) {
    const agentId = disposableAgentId;
    disposableAgentId = null;
    try {
      await management.agents.delete(agentId);
    } catch (error) {
      failures.push(
        `disposable agent ${agentId} is probably still in your account: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (ownedServer) {
    const server = ownedServer;
    ownedServer = null;
    try {
      await server.close();
    } catch (error) {
      failures.push(
        `owned App Server did not terminate cleanly: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`Cleanup failed:\n- ${failures.join("\n- ")}`);
  }
});

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), `subconscious-tools-${prefix}-`));
  roots.push(value);
  return await realpath(value);
}

function descriptorFor(directory: string): BrokerDescriptor {
  return {
    version: 1,
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\subconscious-tools-e2e-${randomUUID()}`
        : join(directory, "broker.sock"),
    token: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
}

/**
 * Drive one real observer turn through the running broker. Terminal failure
 * surfaces immediately instead of burning the polling budget.
 */
async function observeOrFail(
  descriptor: BrokerDescriptor,
  directory: string,
  sessionId: string,
): Promise<string> {
  const eventId = `event-tools-${randomUUID()}`;
  await sendBrokerRequest(descriptor, {
    type: "observe",
    event: {
      id: eventId,
      harness: "claude-code" as const,
      type: "session_start" as const,
      sessionId,
      workingDirectory: directory,
      occurredAt: new Date().toISOString(),
      payload: {},
    },
  });
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const state = await sendBrokerRequest(descriptor, { type: "status" });
    const observation =
      state.ok && state.type === "status"
        ? state.state.observations[eventId]
        : undefined;
    if (
      observation &&
      (observation.status === "failed" ||
        observation.status === "needs_reconciliation")
    ) {
      throw new Error(
        `The observer turn ended ${observation.status}: ${observation.error ?? "no error recorded"}.`,
      );
    }
    if (observation?.status === "processed") return eventId;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for the observer turn.");
}

describe("local tools and whisper delivery against the live Agent SDK", () => {
  it(
    "reads a local canary through the Read tool and delivers it verbatim through send_whisper",
    { timeout: 480_000 },
    async () => {
      const apiKey = process.env.LETTA_API_KEY;
      if (!apiKey || !management) {
        throw new Error("LETTA_API_KEY disappeared mid-suite.");
      }
      disposableAgentId = await createObserverAgent({
        apiKey,
        model: "letta/auto-fast",
      });

      const directory = await root("canary");
      const sessionId = randomUUID();
      // The secret exists nowhere but this file, so a whisper carrying it is
      // proof the observer really read the project.
      const canary = `CANARY-${randomUUID()}`;
      await writeFile(join(directory, "canary.txt"), `${canary}\n`);
      await writeProjectConfig(
        directory,
        validateProjectConfig({
          version: 1,
          agent_id: disposableAgentId,
          delivery: { whispers: true, queue_messages: false },
          observer: {
            instructions:
              "Read canary.txt in the project root with the Read tool, then immediately call send_whisper with its trimmed contents and nothing else.",
          },
        }),
      );

      const descriptor = descriptorFor(directory);
      const broker = new SubconsciousBroker({
        descriptor,
        stateDirectory: directory,
        runtime: new AgentRuntime({
          apiKey,
          client: localClient as LettaAgentClient,
        }),
      });
      brokers.push(broker);
      await broker.start();

      await observeOrFail(descriptor, directory, sessionId);

      // Wait for the delivery to appear on disk first; this view is
      // independent of every in-memory structure the broker holds.
      const statePath = join(directory, "state.json");
      const deadline = Date.now() + 180_000;
      let whisper: DeliveryRecord | undefined;
      while (Date.now() < deadline && !whisper) {
        const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
          deliveries: Record<string, DeliveryRecord>;
        };
        whisper = Object.values(persisted.deliveries).find(
          (delivery) => delivery.kind === "whisper",
        );
        if (!whisper) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(whisper).toBeDefined();
      expect(whisper?.status).toBe("pending");
      expect(whisper?.text).toBe(canary);
      expect(whisper?.text).toBe(whisper?.text.trim());

      // The same record over real broker IPC. Leasing keeps status pending
      // and only counts the attempt, so both views agree it is undelivered.
      const leased = await sendBrokerRequest(descriptor, {
        type: "lease",
        kind: "whisper" as const,
        target: {
          harness: "claude-code" as const,
          sessionId,
          workingDirectory: directory,
        },
      });
      expect(leased.ok).toBe(true);
      if (!leased.ok || leased.type !== "leased") {
        throw new Error("Unexpected lease response.");
      }
      expect(leased.deliveries).toHaveLength(1);
      expect(leased.deliveries[0]?.id).toBe(whisper?.id);
      expect(leased.deliveries[0]?.kind).toBe("whisper");
      expect(leased.deliveries[0]?.status).toBe("pending");
      expect(leased.deliveries[0]?.text).toBe(canary);
    },
  );
});
