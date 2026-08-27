import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  LettaAgentClient,
  type SDKResultMessage,
} from "@letta-ai/letta-agent-sdk";
import { lettaSessionRouteId } from "../../packages/adapter-letta-code/index.js";
import {
  AgentRuntime,
  createObserverAgent,
  type QueuedMessageResult,
  type RunObservationResult,
} from "../../packages/agent-runtime/index.js";
import {
  SubconsciousBroker,
  type BrokerRuntime,
} from "../../packages/cli/broker.js";
import {
  deliveryId,
  routeKey,
  sendBrokerRequest,
  validateProjectConfig,
  writeProjectConfig,
  type BrokerDescriptor,
  type BrokerState,
  type DeliveryRecord,
  type RouteRecord,
} from "../../packages/core/index.js";
import {
  startOwnedAppServer,
  type OwnedAppServer,
} from "./app-server-process.js";

/**
 * Positive Cloud queue_message acceptance against a credited Letta API key.
 *
 * The local Letta Code live suite still records the provider-specific SDK
 * 0.7.6 ack blocker for `--backend local`. This file is the missing Cloud
 * criterion: a disposable Cloud agent, an owned App Server on the API
 * backend, two real conversations, and production AgentRuntime (default
 * timeout, no model rewrite) delivering a queued canary through the real
 * broker. Persistence alone is not success; the broker must reach
 * `delivered` with a nativeReceipt after a terminal SDK result.
 *
 * Key resolution, in order: SUBCONSCIOUS_LETTA_QUEUE_API_KEY,
 * COMPANY_LETTA_API_KEY, LETTA_API_KEY. Values are remembered only so
 * `scrub()` can strip them from failure text. They are never printed.
 *
 * Run with:
 *   npm run test:letta-cloud-queue-e2e
 */

const QUEUE_KEY_NAMES = [
  "SUBCONSCIOUS_LETTA_QUEUE_API_KEY",
  "COMPANY_LETTA_API_KEY",
  "LETTA_API_KEY",
] as const;
const SECRET_NAMES = [
  ...QUEUE_KEY_NAMES,
  "DEVELOPERS_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
] as const;

const roots: string[] = [];
const sockets: string[] = [];
const brokers: SubconsciousBroker[] = [];
const secrets: string[] = [];
let apiKey: string | null = null;
let management: LettaAgentClient | null = null;
let ownedServer: OwnedAppServer | null = null;
let localClient: LettaAgentClient | null = null;
let disposableAgentId: string | null = null;
let lastQueuedResult: QueuedMessageResult | undefined;

const silentObserver = {
  run: async (): Promise<RunObservationResult> => ({
    status: "success",
    conversationId: "conv-observer",
    result: {
      type: "result",
      success: true,
      durationMs: 1,
      conversationId: "conv-observer",
      runIds: ["run-observer"],
    },
    effectiveModel: null,
  }),
};

function rememberSecret(value: string | undefined): void {
  if (value && value.length > 0 && !secrets.includes(value)) {
    secrets.push(value);
  }
}

function rememberEnvSecrets(): void {
  for (const name of SECRET_NAMES) rememberSecret(process.env[name]);
}

function scrub(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function resolveQueueApiKey(): string {
  rememberEnvSecrets();
  for (const name of QUEUE_KEY_NAMES) {
    const value = process.env[name]?.trim();
    if (value) {
      rememberSecret(value);
      return value;
    }
  }
  throw new Error(
    "Set SUBCONSCIOUS_LETTA_QUEUE_API_KEY, COMPANY_LETTA_API_KEY, or LETTA_API_KEY to run Cloud queue acceptance.",
  );
}

function queueRuntime(client: LettaAgentClient): BrokerRuntime {
  const agentRuntime = new AgentRuntime({
    apiKey: apiKey!,
    client,
  });
  return {
    run: silentObserver.run,
    deliverQueuedMessage: async (input) => {
      lastQueuedResult = await agentRuntime.deliverQueuedMessage(input);
      return lastQueuedResult;
    },
  };
}

beforeAll(async () => {
  if (process.env.SUBCONSCIOUS_LETTA_CLOUD_QUEUE_LIVE !== "1") return;
  apiKey = resolveQueueApiKey();
  management = new LettaAgentClient({ backend: "cloud", apiKey });
  ownedServer = await startOwnedAppServer({
    env: { LETTA_API_KEY: apiKey },
  });
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
  for (const broker of brokers.splice(0)) {
    try {
      await broker.close();
    } catch (error) {
      failures.push(
        `broker close: ${scrub(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }
  const removed = await Promise.allSettled(
    [...roots.splice(0), ...sockets.splice(0)].map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
  for (const result of removed) {
    if (result.status === "rejected") {
      failures.push(`fixture removal: ${scrub(String(result.reason))}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Teardown failures:\n- ${failures.join("\n- ")}`);
  }
});

afterAll(async () => {
  const failures: string[] = [];
  if (management && disposableAgentId) {
    const agentId = disposableAgentId;
    disposableAgentId = null;
    try {
      await management.agents.delete(agentId);
    } catch (error) {
      failures.push(
        `disposable agent ${agentId} is probably still in your account: ${scrub(error instanceof Error ? error.message : String(error))}`,
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
        `owned App Server did not terminate cleanly: ${scrub(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`Cleanup failed:\n- ${failures.join("\n- ")}`);
  }
});

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(
    join(tmpdir(), `subconscious-cloud-queue-${prefix}-`),
  );
  roots.push(value);
  return await realpath(value);
}

function descriptorFor(): BrokerDescriptor {
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\subconscious-cloud-queue-e2e-${randomUUID()}`
      : `/tmp/scq-${randomUUID().slice(0, 12)}.sock`;
  if (process.platform !== "win32") sockets.push(endpoint);
  return {
    version: 1,
    endpoint,
    token: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
}

async function startBroker(
  directory: string,
  descriptor: BrokerDescriptor,
  client: LettaAgentClient,
): Promise<SubconsciousBroker> {
  const broker = new SubconsciousBroker({
    descriptor,
    stateDirectory: directory,
    runtime: queueRuntime(client),
  });
  brokers.push(broker);
  await broker.start();
  return broker;
}

async function brokerState(descriptor: BrokerDescriptor): Promise<BrokerState> {
  const response = await sendBrokerRequest(descriptor, { type: "status" });
  if (!response.ok || response.type !== "status") {
    throw new Error(
      `Unexpected broker status: ${scrub(JSON.stringify(response))}`,
    );
  }
  return response.state;
}

async function poll<T>(
  action: () => Promise<T>,
  timeoutMs: number,
  detail: () => string | Promise<string>,
  predicate: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last!: T;
  while (Date.now() < deadline) {
    last = await action();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms. ${scrub(await Promise.resolve(detail()))}`,
  );
}

async function conversationBlob(
  client: LettaAgentClient,
  conversationId: string,
): Promise<string> {
  const page = await client.conversations.listMessages(conversationId, {
    order: "asc",
    limit: 100,
  });
  return JSON.stringify(page.messages ?? []);
}

async function assistantBlob(
  client: LettaAgentClient,
  conversationId: string,
): Promise<string> {
  const page = await client.conversations.listMessages(conversationId, {
    order: "asc",
    limit: 100,
  });
  return JSON.stringify(
    (page.messages ?? []).filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "message_type" in message &&
        message.message_type === "assistant_message",
    ),
  );
}

async function runReadyTurn(
  client: LettaAgentClient,
  conversationId: string,
): Promise<SDKResultMessage> {
  let session: ReturnType<LettaAgentClient["resumeSession"]> | null = null;
  try {
    session = client.resumeSession(conversationId, {
      allowedTools: [],
      toolset: { base: "none", include: [] },
      permissionMode: "standard",
      env: { LETTA_API_KEY: apiKey! },
    });
    await session.send(
      "Reply with exactly READY and nothing else. Do not use tools.",
    );
    let result: SDKResultMessage | null = null;
    for await (const message of session.stream()) {
      if (message.type === "result") result = message;
    }
    if (!result) {
      throw new Error(
        `The ready turn on ${conversationId} ended without a terminal SDK result.`,
      );
    }
    if (!result.success) {
      throw new Error(
        `The ready turn on ${conversationId} failed: ${scrub(result.errorDetail ?? result.error ?? "unknown")}`,
      );
    }
    return result;
  } finally {
    session?.close();
  }
}

async function createConversationWithTurn(
  client: LettaAgentClient,
  agentId: string,
): Promise<string> {
  const created = await client.conversations.create({
    agentId,
    hidden: true,
  });
  const retrieved = await client.conversations.retrieve(created.id);
  if (retrieved.agent_id !== agentId) {
    throw new Error(
      `Conversation ${created.id} belongs to ${retrieved.agent_id}, not ${agentId}.`,
    );
  }
  await runReadyTurn(client, created.id);
  return created.id;
}

function sessionIdFor(agentId: string, conversationId: string): string {
  const id = lettaSessionRouteId({
    agent_id: agentId,
    conversation_id: conversationId,
  });
  if (!id) {
    throw new Error(
      `Letta Code route id is unavailable for ${agentId}/${conversationId}.`,
    );
  }
  return id;
}

async function registerHarnessRoute(
  descriptor: BrokerDescriptor,
  directory: string,
  observerAgentId: string,
  identity: { agentId: string; conversationId: string },
): Promise<string> {
  const sessionId = sessionIdFor(identity.agentId, identity.conversationId);
  await sendBrokerRequest(descriptor, {
    type: "observe",
    event: {
      id: `cloud-queue-${identity.conversationId}-${randomUUID()}`,
      harness: "letta-code" as const,
      type: "user_prompt" as const,
      sessionId,
      workingDirectory: directory,
      occurredAt: new Date().toISOString(),
      payload: {
        event_type: "UserPromptSubmit",
        working_directory: directory,
        conversation_id: identity.conversationId,
        agent_id: identity.agentId,
        prompt: "Register the Cloud Letta Code conversation.",
      },
    },
  });
  const key = routeKey({
    configPath: join(directory, "subconscious.toml"),
    projectRoot: directory,
    agentId: observerAgentId,
    harness: "letta-code",
    sessionId,
  });
  await poll(
    () => brokerState(descriptor),
    30_000,
    () => `waiting for route ${key}`,
    (state) => Boolean(state.routes[key]?.harnessIdentity),
  );
  return key;
}

function pendingQueued(
  route: RouteRecord,
  text: string,
  dedupeKey: string,
): DeliveryRecord {
  const now = new Date().toISOString();
  return {
    id: deliveryId("seed-queued_message", "queued_message", dedupeKey),
    routeKey: route.key,
    observationId: "seed-queued_message",
    kind: "queued_message",
    text,
    priority: "normal",
    dedupeKey,
    status: "pending",
    createdAt: now,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    attempts: 0,
  };
}

async function seedQueuedDelivery(
  directory: string,
  descriptor: BrokerDescriptor,
  client: LettaAgentClient,
  record: DeliveryRecord,
): Promise<void> {
  for (const broker of brokers.splice(0)) {
    await broker.close();
  }
  const statePath = join(directory, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as BrokerState;
  if (!state.routes[record.routeKey]) {
    throw new Error(
      `Cannot seed delivery; route ${record.routeKey} is missing.`,
    );
  }
  state.deliveries[record.id] = record;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  lastQueuedResult = undefined;
  await startBroker(directory, descriptor, client);
}

const liveDescribe =
  process.env.SUBCONSCIOUS_LETTA_CLOUD_QUEUE_LIVE === "1"
    ? describe
    : describe.skip;

liveDescribe("Letta Cloud queue_message acceptance", () => {
  it(
    "delivers queue_message through the real broker into a disposable Cloud conversation and isolates the wrong conversation",
    { timeout: 480_000 },
    async () => {
      if (!apiKey || !management || !localClient) {
        throw new Error("Cloud queue clients were not started.");
      }
      disposableAgentId = await createObserverAgent({
        apiKey,
        model: "letta/auto-fast",
        client: management,
      });

      const directory = await root("accept");
      await writeProjectConfig(
        directory,
        validateProjectConfig({
          version: 1,
          agent_id: disposableAgentId,
          delivery: { whispers: true, queue_messages: true },
          observer: {},
        }),
      );

      const firstConversationId = await createConversationWithTurn(
        localClient,
        disposableAgentId,
      );
      const otherConversationId = await createConversationWithTurn(
        localClient,
        disposableAgentId,
      );
      expect(otherConversationId).not.toBe(firstConversationId);

      const canary = `QUEUE-${randomUUID().slice(0, 8)}`;
      const beforeQueue = await conversationBlob(
        localClient,
        firstConversationId,
      );
      expect(beforeQueue).not.toContain(canary);
      const otherBefore = await conversationBlob(
        localClient,
        otherConversationId,
      );
      expect(otherBefore).not.toContain(canary);

      const descriptor = descriptorFor();
      await startBroker(directory, descriptor, localClient);
      const otherRouteKey = await registerHarnessRoute(
        descriptor,
        directory,
        disposableAgentId,
        {
          agentId: disposableAgentId,
          conversationId: otherConversationId,
        },
      );
      const routeKeyValue = await registerHarnessRoute(
        descriptor,
        directory,
        disposableAgentId,
        {
          agentId: disposableAgentId,
          conversationId: firstConversationId,
        },
      );
      expect(routeKeyValue).not.toBe(otherRouteKey);

      const state = await brokerState(descriptor);
      const route = state.routes[routeKeyValue];
      expect(route?.harnessIdentity).toEqual({
        agentId: disposableAgentId,
        conversationId: firstConversationId,
      });
      const queued = pendingQueued(
        route!,
        `Queued acceptance canary ${canary}. Reply with exactly ${canary}.`,
        `queue-${canary}`,
      );
      await seedQueuedDelivery(directory, descriptor, localClient, queued);

      const delivered = await poll(
        () => brokerState(descriptor),
        240_000,
        async () =>
          `queued delivery ${queued.id} runtime=${JSON.stringify(lastQueuedResult)} ${JSON.stringify((await brokerState(descriptor)).deliveries[queued.id])}`,
        (current) => current.deliveries[queued.id]?.status === "delivered",
      );
      const record = delivered.deliveries[queued.id];
      expect(lastQueuedResult).toEqual({
        status: "delivered",
        nativeReceipt: firstConversationId,
      });
      expect(record?.status).toBe("delivered");
      expect(record?.nativeReceipt).toBe(firstConversationId);
      expect(record?.acknowledgedAt).toBeTruthy();
      expect(record?.routeKey).toBe(routeKeyValue);
      expect(record?.routeKey).not.toBe(otherRouteKey);

      const persisted = await conversationBlob(
        localClient,
        firstConversationId,
      );
      expect(persisted).toContain(canary);
      expect(await assistantBlob(localClient, firstConversationId)).toContain(
        canary,
      );
      const otherMessages = await conversationBlob(
        localClient,
        otherConversationId,
      );
      expect(otherMessages).not.toContain(canary);
      expect(
        delivered.routes[otherRouteKey]?.harnessIdentity?.conversationId,
      ).toBe(otherConversationId);
    },
  );
});
