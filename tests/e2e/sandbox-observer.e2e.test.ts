import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
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

/**
 * Live acceptance for a sandboxed observer: MemFS read plus broker delivery.
 *
 * A disposable hidden observer is created with distinct unpredictable canaries
 * in a project file and its MemFS. Only the MemFS canary is accepted.
 * The project enables `observer.sandbox`, so the runtime opens the turn through
 * the production Cloud client and its Agent SDK sandbox settings: no `cwd`, no
 * session `env`, tools off this machine. The retained Read/LS/Glob/Grep tools
 * still exist; `send_whisper` is still an external tool whose `execute` runs in
 * the broker process.
 *
 * A whisper carrying the MemFS canary therefore proves two things at once: the
 * sandboxed Read tool reached MemFS, and the delivery tool persisted on this
 * machine. Reading a newly mounted project by accident fails on the distinct
 * project canary instead of producing a false-positive acceptance result.
 * A model guessing, a tool denied by the allowlist, or a delivery tool running
 * only inside the sandbox all fail the same way - no pending whisper here.
 *
 * If the live sandbox cannot expose the project file, that is the documented
 * App Server contract: local App Server sessions set `cwd` to the project root,
 * while a managed Cloud sandbox does not mount local paths and Subconscious
 * therefore sends neither `cwd` nor `env`. The test still requires the MemFS
 * copy to be readable. When even that path is blocked, the failure names the
 * exact live error and that contract, rather than skipping.
 *
 * Run with `npx vitest run --config vitest.sandbox-e2e.config.ts`. The suite
 * refuses to run without `DEVELOPERS_API_KEY` and never prints or persists
 * credential material: the key is read from the environment, passed to SDK
 * clients, and otherwise unused.
 */

const execFile = promisify(execFileCb);

const CLOUD_API_BASE = "https://api.letta.com";
const MEMFS_CANARY_PATH = "system/canary.txt";
const PROJECT_CANARY_FILE = "canary.txt";

const roots: string[] = [];
const brokers: SubconsciousBroker[] = [];
const disposableConversationIds = new Set<string>();
const disposableRepositoryIds = new Set<string>();
let management: LettaAgentClient | null = null;
let disposableAgentId: string | null = null;

beforeAll(async () => {
  if (process.env.SUBCONSCIOUS_SANDBOX_LIVE !== "1") return;
  const apiKey = process.env.DEVELOPERS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Set DEVELOPERS_API_KEY to run the sandboxed-observer live suite (npx vitest run --config vitest.sandbox-e2e.config.ts).",
    );
  }
  management = new LettaAgentClient({ backend: "cloud", apiKey });
});

afterEach(async () => {
  const failures: string[] = [];
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
  const apiKey = process.env.DEVELOPERS_API_KEY;
  if (management && apiKey) {
    for (const conversationId of disposableConversationIds) {
      try {
        await deleteCloudConversation(apiKey, conversationId);
      } catch (error) {
        failures.push(
          `disposable conversation ${conversationId} is probably still in your account: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    disposableConversationIds.clear();
    for (const repositoryId of disposableRepositoryIds) {
      try {
        await management.repositories.delete(repositoryId);
      } catch (error) {
        failures.push(
          `disposable repository ${repositoryId} is probably still in your account: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    disposableRepositoryIds.clear();
    if (disposableAgentId) {
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
  }
  if (failures.length > 0) {
    throw new Error(`Cleanup failed:\n- ${failures.join("\n- ")}`);
  }
});

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(
    join(tmpdir(), `subconscious-sandbox-${prefix}-`),
  );
  roots.push(value);
  return await realpath(value);
}

function descriptorFor(directory: string): BrokerDescriptor {
  return {
    version: 1,
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\subconscious-sandbox-e2e-${randomUUID()}`
        : join(directory, "broker.sock"),
    token: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
}

function redactSecrets(text: string): string {
  return text
    .replace(
      /Authorization:\s*Basic\s+\S+/gi,
      "Authorization: Basic <redacted>",
    )
    .replace(
      /Authorization:\s*Bearer\s+\S+/gi,
      "Authorization: Bearer <redacted>",
    )
    .replace(/Basic [A-Za-z0-9+/=]{16,}/g, "Basic <redacted>");
}

async function deleteCloudConversation(
  apiKey: string,
  conversationId: string,
): Promise<void> {
  const response = await fetch(
    `${CLOUD_API_BASE}/v1/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );
  if (response.ok || response.status === 404) return;
  const body = redactSecrets(await response.text());
  throw new Error(`HTTP ${response.status}: ${body}`);
}

async function rememberConversations(
  descriptor: BrokerDescriptor,
): Promise<void> {
  const state = await sendBrokerRequest(descriptor, { type: "status" });
  if (!state.ok || state.type !== "status") return;
  for (const route of Object.values(state.state.routes)) {
    if (route.conversationId) {
      disposableConversationIds.add(route.conversationId);
    }
  }
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
  const eventId = `event-sandbox-${randomUUID()}`;
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

interface MemfsSeed {
  method: "git" | "attached-repository" | "none";
  detail: string;
  repositoryId?: string;
}

async function runGit(
  apiKey: string,
  cwd: string,
  args: string[],
  network = false,
): Promise<string> {
  try {
    const { stdout } = await execFile("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        GIT_ASKPASS: "",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: cwd,
        ...(network
          ? {
              GIT_CONFIG_COUNT: "3",
              GIT_CONFIG_KEY_0: "credential.helper",
              GIT_CONFIG_VALUE_0: "",
              GIT_CONFIG_KEY_1: "core.askPass",
              GIT_CONFIG_VALUE_1: "",
              GIT_CONFIG_KEY_2: "http.extraHeader",
              GIT_CONFIG_VALUE_2: `Authorization: Basic ${Buffer.from(`letta:${apiKey}`).toString("base64")}`,
            }
          : {}),
      },
    });
    return stdout;
  } catch (error) {
    throw new Error(
      redactSecrets(error instanceof Error ? error.message : String(error)),
    );
  }
}

async function seedMemfsViaGit(
  apiKey: string,
  agentId: string,
  directory: string,
  canary: string,
): Promise<MemfsSeed> {
  const cloneDir = join(directory, "memfs-clone");
  const remote = `${CLOUD_API_BASE}/v1/git/${encodeURIComponent(agentId)}/state.git`;
  const deadline = Date.now() + 60_000;
  let cloned = false;
  let lastError = "clone not attempted";
  while (Date.now() < deadline && !cloned) {
    await rm(cloneDir, { recursive: true, force: true });
    await mkdir(cloneDir, { recursive: true });
    try {
      await runGit(
        apiKey,
        cloneDir,
        ["clone", "--depth", "1", remote, "."],
        true,
      );
      cloned = true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  if (!cloned) {
    await rm(cloneDir, { recursive: true, force: true });
    await mkdir(cloneDir, { recursive: true });
    await runGit(apiKey, cloneDir, ["init", "-b", "main"]);
    await runGit(apiKey, cloneDir, ["remote", "add", "origin", remote]);
  }
  await runGit(apiKey, cloneDir, [
    "config",
    "user.email",
    "sandbox-e2e@invalid",
  ]);
  await runGit(apiKey, cloneDir, ["config", "user.name", "sandbox-e2e"]);
  await mkdir(join(cloneDir, "system"), { recursive: true });
  await writeFile(join(cloneDir, MEMFS_CANARY_PATH), `${canary}\n`);
  await runGit(apiKey, cloneDir, ["add", MEMFS_CANARY_PATH]);
  await runGit(apiKey, cloneDir, [
    "commit",
    "-m",
    "Seed sandboxed-observer canary.",
  ]);
  try {
    await runGit(apiKey, cloneDir, ["push", "-u", "origin", "HEAD"], true);
  } catch {
    await runGit(apiKey, cloneDir, ["push", "-u", "origin", "HEAD:main"], true);
  }
  return {
    method: "git",
    detail: cloned
      ? `Pushed ${MEMFS_CANARY_PATH} to the agent's MemFS git remote.`
      : `Initialized MemFS git after clone failed (${lastError}) and pushed ${MEMFS_CANARY_PATH}.`,
  };
}

async function seedMemfsViaAttachedRepository(
  client: LettaAgentClient,
  agentId: string,
  canary: string,
): Promise<MemfsSeed> {
  const attached = await client.agents.repositories.list(agentId);
  const existing =
    attached.find((repository) => repository.isPrimary) ?? attached[0];
  if (existing) {
    // The agent itself is disposable, so its generated primary repository is
    // disposable too. Track it before writing so teardown cannot leave the
    // canary behind if deleting the agent does not cascade to repositories.
    disposableRepositoryIds.add(existing.id);
    try {
      await client.repositories.files.create(existing.id, {
        path: MEMFS_CANARY_PATH,
        content: `${canary}\n`,
      });
    } catch {
      await client.repositories.files.update(existing.id, {
        path: MEMFS_CANARY_PATH,
        content: `${canary}\n`,
      });
    }
    return {
      method: "attached-repository",
      detail: `Wrote ${MEMFS_CANARY_PATH} through the agent's attached repository ${existing.id}.`,
      repositoryId: existing.id,
    };
  }
  const created = await client.repositories.create({
    name: `sandbox-e2e-${randomUUID().slice(0, 8)}`,
  });
  disposableRepositoryIds.add(created.id);
  await client.repositories.files.create(created.id, {
    path: MEMFS_CANARY_PATH,
    content: `${canary}\n`,
  });
  await client.agents.repositories.attach(agentId, created.id, {
    permissions: "read",
    recompile: false,
  });
  return {
    method: "attached-repository",
    detail: `Created and attached repository ${created.id} containing ${MEMFS_CANARY_PATH}.`,
    repositoryId: created.id,
  };
}

async function seedMemfsCanary(
  client: LettaAgentClient,
  apiKey: string,
  agentId: string,
  directory: string,
  canary: string,
): Promise<MemfsSeed> {
  const errors: string[] = [];
  try {
    return await seedMemfsViaGit(apiKey, agentId, directory, canary);
  } catch (error) {
    errors.push(
      `git: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return await seedMemfsViaAttachedRepository(client, agentId, canary);
  } catch (error) {
    errors.push(
      `repository: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    method: "none",
    detail: `Could not seed MemFS (${errors.join("; ")}).`,
  };
}

function sandboxProjectFileBlocker(parts: string[]): string {
  return [
    "The live sandboxed observer did not deliver the canary through send_whisper.",
    "Exact App Server / sandbox contract blocker:",
    "- Local App Server sessions (the non-sandbox path this suite also starts) set cwd to the project root, so Read can see a project file.",
    "- observer.sandbox switches the runtime onto a Cloud LettaAgentClient constructed with the production Agent SDK sandbox options (ttlMinutes 5, refreshIntervalMs 240000, terminateOnClose false).",
    "- That client owns a managed sandbox. LettaCodeCloudSandboxOptions can clone GitHub repositories; it has no local-path mount, and Subconscious therefore sends neither cwd nor session env.",
    "- Read/LS/Glob/Grep are retained so the observer can still read MemFS. send_whisper still executes in the broker process as an external tool.",
    ...parts.map((part) => `- ${part}`),
  ].join("\n");
}

const liveDescribe =
  process.env.SUBCONSCIOUS_SANDBOX_LIVE === "1" ? describe : describe.skip;

liveDescribe("sandboxed observer against the live Agent SDK", () => {
  it(
    "reads a MemFS canary through the retained Read tool and delivers it verbatim through broker-process send_whisper",
    { timeout: 480_000 },
    async () => {
      const apiKey = process.env.DEVELOPERS_API_KEY;
      if (!apiKey || !management) {
        throw new Error("DEVELOPERS_API_KEY disappeared mid-suite.");
      }
      disposableAgentId = await createObserverAgent({
        apiKey,
        model: "letta/auto-fast",
        client: management,
      });

      const directory = await root("canary");
      const sessionId = randomUUID();
      const projectCanary = `PROJECT-${randomUUID()}`;
      const memfsCanary = `MEMFS-${randomUUID()}`;
      await writeFile(
        join(directory, PROJECT_CANARY_FILE),
        `${projectCanary}\n`,
      );
      const memfsSeed = await seedMemfsCanary(
        management,
        apiKey,
        disposableAgentId,
        directory,
        memfsCanary,
      );
      await writeProjectConfig(
        directory,
        validateProjectConfig({
          version: 1,
          agent_id: disposableAgentId,
          delivery: { whispers: true, queue_messages: false },
          observer: {
            sandbox: true,
            instructions:
              "Read $MEMORY_DIR/system/canary.txt from your memory filesystem with the Read tool. If the variable is not expanded, Read system/canary.txt. Do not read the project file. Immediately call send_whisper with the trimmed MemFS contents and nothing else.",
          },
        }),
      );

      const descriptor = descriptorFor(directory);
      const broker = new SubconsciousBroker({
        descriptor,
        stateDirectory: directory,
        runtime: new AgentRuntime({ apiKey }),
      });
      brokers.push(broker);
      await broker.start();

      try {
        try {
          await observeOrFail(descriptor, directory, sessionId);
        } catch (error) {
          throw new Error(
            sandboxProjectFileBlocker([
              `MemFS seed: ${memfsSeed.method} — ${memfsSeed.detail}`,
              `Live observer error: ${error instanceof Error ? error.message : String(error)}`,
            ]),
          );
        }

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
          if (!whisper)
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (!whisper || whisper.text !== memfsCanary) {
          throw new Error(
            sandboxProjectFileBlocker([
              `MemFS seed: ${memfsSeed.method} — ${memfsSeed.detail}`,
              whisper
                ? `A whisper persisted locally (broker-process send_whisper ran) but its text did not match the MemFS canary. Project-file false positives are rejected.`
                : "No pending whisper appeared in local broker state.json, so send_whisper either was not called or did not execute in the broker process.",
            ]),
          );
        }
        expect(whisper.status).toBe("pending");
        expect(whisper.text).toBe(memfsCanary);
        expect(whisper.text).not.toBe(projectCanary);
        expect(whisper.text).toBe(whisper.text.trim());

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
        expect(leased.deliveries[0]?.id).toBe(whisper.id);
        expect(leased.deliveries[0]?.kind).toBe("whisper");
        expect(leased.deliveries[0]?.status).toBe("pending");
        expect(leased.deliveries[0]?.text).toBe(memfsCanary);
      } finally {
        await rememberConversations(descriptor).catch(() => undefined);
      }
    },
  );
});
