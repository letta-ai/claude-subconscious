import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
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
} from "../../packages/core/index.js";
import {
  startOwnedAppServer,
  type OwnedAppServer,
} from "./app-server-process.js";

/**
 * Live regression for the model-override pipeline against the real Agent SDK.
 *
 * One disposable hidden observer agent is created whose default model is
 * deliberately unusual (`letta/auto-fast`), so every assertion can tell an
 * inherited value from a leftover override. A fresh observer route then runs
 * with a full harness override - model, reasoning effort, and context window -
 * and the conversation's server-persisted state is read back through the
 * management API rather than trusted from the local route record. Removing
 * every override on the same route must clear that persisted state back to
 * inheritance on the SAME conversation, because a model change that forked a
 * conversation would silently strand the primer and the memory thread.
 *
 * This drives the real broker, real configuration discovery, and the real
 * runtime; only the harness event source is synthetic. Claude Code is
 * incidental to what this suite proves - the hook boundary work has its own
 * suite in `claude-code.e2e.test.ts` - so these cases need a Letta API key
 * and no Claude authentication.
 *
 * Run with `npm run test:model-e2e`. The suite refuses to run without
 * `LETTA_API_KEY` and never prints or persists credential material: the key
 * is read from the environment, passed to SDK clients, and otherwise unused.
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
      "Set LETTA_API_KEY to run the model-override live suite (npm run test:model-e2e).",
    );
  }
  management = new LettaAgentClient({ backend: "cloud", apiKey });
  // One App Server the suite owns and tears down itself. Handing its URL to
  // the SDK client through the public option means no lazily spawned shared
  // server can outlive this worker.
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
  const value = await mkdtemp(join(tmpdir(), `subconscious-model-${prefix}-`));
  roots.push(value);
  return await realpath(value);
}

function descriptorFor(directory: string): BrokerDescriptor {
  return {
    version: 1,
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\subconscious-model-e2e-${randomUUID()}`
        : join(directory, "broker.sock"),
    token: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
}

/**
 * Drive one real observer turn through the running broker and wait until that
 * exact observation is processed. A terminal failure is surfaced the moment
 * the broker records it instead of burning the whole polling budget.
 */
async function observeAndWait(
  descriptor: BrokerDescriptor,
  directory: string,
  sessionId: string,
  label: string,
): Promise<void> {
  const eventId = `event-${label}-${randomUUID()}`;
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
        `The ${label} observer turn ended ${observation.status}: ${observation.error ?? "no error recorded"}.`,
      );
    }
    if (observation?.status === "processed") return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for the ${label} observer turn.`);
}

describe("model overrides against the live Agent SDK", () => {
  it(
    "applies overrides to a fresh conversation and clears them back to inheritance in place",
    { timeout: 480_000 },
    async () => {
      const apiKey = process.env.LETTA_API_KEY;
      if (!apiKey || !management) {
        throw new Error("LETTA_API_KEY disappeared mid-suite.");
      }
      const agentDefault = "letta/auto-fast";
      disposableAgentId = await createObserverAgent({
        apiKey,
        model: agentDefault,
      });

      const directory = await root("override");
      const sessionId = randomUUID();

      const overridden = validateProjectConfig({
        version: 1,
        agent_id: disposableAgentId,
        delivery: { whispers: true, queue_messages: false },
        observer: {},
        model_overrides: {
          claude_code: {
            model: "openai/gpt-5.6-luna",
            reasoning_effort: "low",
            context_window_limit: 32000,
          },
        },
      });
      await writeProjectConfig(directory, overridden);

      const descriptor = descriptorFor(directory);
      const broker = new SubconsciousBroker({
        descriptor,
        stateDirectory: directory,
        // The runtime is pinned to the App Server this suite owns, so every
        // session and management call runs against a child we tear down.
        runtime: new AgentRuntime({
          apiKey,
          client: localClient as LettaAgentClient,
        }),
      });
      brokers.push(broker);
      await broker.start();

      // Phase one: the very first turn creates the conversation already
      // carrying every persistent override.
      await observeAndWait(descriptor, directory, sessionId, "override");
      const afterOverride = await sendBrokerRequest(descriptor, {
        type: "status",
      });
      expect(afterOverride.ok).toBe(true);
      if (!afterOverride.ok || afterOverride.type !== "status") {
        throw new Error("no state");
      }
      const routeRecord = Object.values(afterOverride.state.routes)[0];
      expect(routeRecord.requestedModel).toBe("openai/gpt-5.6-luna");
      expect(routeRecord.modelOverrideSource).toBe("harness");
      expect(routeRecord.reasoningEffort).toBe("low");

      // Read the SERVER-persisted conversation through Cloud management, not
      // the local record. Propagation from the turn can lag briefly, hence
      // the poll.
      const conversationId = routeRecord.conversationId;
      expect(conversationId).toMatch(/^conv-/);
      const readPersisted = async () =>
        management!.conversations.retrieve(conversationId!);
      let persisted = await readPersisted();
      const settleUntil = async (
        predicate: () => boolean,
        budgetMs = 60_000,
      ): Promise<void> => {
        const deadline = Date.now() + budgetMs;
        while (!predicate()) {
          if (Date.now() > deadline) {
            throw new Error(
              `Conversation state did not settle: ${JSON.stringify({
                model: persisted.model ?? null,
                context_window_limit: persisted.context_window_limit ?? null,
              })}`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          persisted = await readPersisted();
        }
      };
      await settleUntil(
        () =>
          persisted.model === "openai/gpt-5.6-luna" &&
          persisted.context_window_limit === 32000,
      );
      expect(persisted.model).toBe("openai/gpt-5.6-luna");
      expect(persisted.context_window_limit).toBe(32000);
      // If the backend exposes the persisted reasoning state through
      // conversation model settings, it must reflect the override; phase two
      // proves whatever landed here is cleared. When the API keeps the tier
      // out of model_settings entirely, this assertion is vacuous by design.
      const persistedSettings = persisted.model_settings
        ? JSON.stringify(persisted.model_settings)
        : null;
      if (persistedSettings !== null) {
        expect(persistedSettings).toContain("low");
      }
      // The runtime's ready() report agrees with the server on the handle.
      expect(routeRecord.effectiveModel).toContain("gpt-5.6-luna");

      // Phase two: strip every override on the same route. The conversation
      // must survive unchanged and drop back to the agent default.
      await rm(join(directory, "subconscious.toml"));
      await writeProjectConfig(
        directory,
        validateProjectConfig({
          version: 1,
          agent_id: disposableAgentId,
          delivery: { whispers: true, queue_messages: false },
          observer: {},
        }),
      );
      await observeAndWait(descriptor, directory, sessionId, "cleared");
      const afterClear = await sendBrokerRequest(descriptor, {
        type: "status",
      });
      if (!afterClear.ok || afterClear.type !== "status") {
        throw new Error("no state");
      }
      const clearedRoute = afterClear.state.routes[routeRecord.key];
      // Same conversation: no fork, so the primer and memory stay put.
      expect(clearedRoute.conversationId).toBe(routeRecord.conversationId);
      expect(clearedRoute.requestedModel).toBeUndefined();
      expect(clearedRoute.modelOverrideSource).toBe("agent_default");
      expect(clearedRoute.reasoningEffort).toBeUndefined();

      persisted = await readPersisted();
      await settleUntil(
        () =>
          persisted.model !== "openai/gpt-5.6-luna" &&
          (persisted.model ?? null) === null &&
          (persisted.context_window_limit ?? null) === null &&
          (persisted.model_settings ?? null) === null,
      );
      expect(persisted.model).toBeNull();
      expect(persisted.context_window_limit).toBeNull();
      expect(persisted.model_settings ?? null).toBeNull();

      // Inheritance resolves to the disposable agent's own default, and both
      // sides say so exactly: the agent still carries that default, and the
      // runtime reported it for the cleared conversation.
      const agent = await management.agents.retrieve(disposableAgentId);
      expect((agent as { model?: string | null }).model).toBe(agentDefault);
      expect(clearedRoute.effectiveModel).toBe(agentDefault);
    },
  );
});
