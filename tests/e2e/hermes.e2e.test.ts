import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RunObservationResult } from "../../packages/agent-runtime/index.js";
import { SubconsciousBroker } from "../../packages/cli/broker.js";
import { defaultHermesRoot } from "../../packages/adapter-hermes/home.js";
import {
  buildFingerprint,
  deliveryId,
  sendBrokerRequest,
  writeBrokerDescriptor,
  writeProjectConfig,
  type BrokerDescriptor,
  type BrokerState,
  type DeliveryRecord,
  type HarnessEventType,
} from "../../packages/core/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const brokerEntry = join(repoRoot, "dist", "packages", "cli", "cli.js");
const HERMES_VERSION = "0.20.5";
// stealth/ox-alpha (the real user's saved default in ~/.hermes/config.yaml)
// has been retired upstream. This run never touches that file — a fresh,
// isolated HERMES_HOME starts with no config.yaml at all — and always pins
// provider/model explicitly on the command line to a model confirmed live
// against the real OpenRouter credential pool in beforeAll.
const HERMES_PROVIDER = "openrouter";
const HERMES_MODEL = "cohere/north-mini-code:free";
const RETIRED_MODEL = "stealth/ox-alpha";
const OUTPUT_TAIL_BYTES = 200_000;
const roots: string[] = [];
const brokers: SubconsciousBroker[] = [];
const children: ChildProcess[] = [];

const silentObserver = {
  run: async (input: {
    prepared: { text: string };
  }): Promise<RunObservationResult> => {
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
      effectiveModel: null,
    };
  },
};

interface Fixture {
  root: string;
  project: string;
  hermesHome: string;
  subconsciousHome: string;
  bin: string;
  env: NodeJS.ProcessEnv;
  descriptor: BrokerDescriptor;
}

afterEach(async () => {
  const failures: string[] = [];
  for (const child of children.splice(0)) {
    try {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill("SIGTERM");
      const killed = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, 5_000);
      killed.unref();
      await new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
      clearTimeout(killed);
    } catch (error) {
      failures.push(
        `child cleanup: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const broker of brokers.splice(0)) {
    try {
      await broker.close();
    } catch (error) {
      failures.push(
        `broker cleanup: ${error instanceof Error ? error.message : String(error)}`,
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
    throw new Error(`Cleanup failed:\n- ${failures.join("\n- ")}`);
  }
});

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(`/tmp/subconscious-hermes-e2e-${prefix}-`);
  roots.push(value);
  return value;
}

function trimTail(text: string): string {
  return text.slice(-OUTPUT_TAIL_BYTES);
}

interface OwnedChild {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  wait(): Promise<number | null>;
}

function trackChild(child: ChildProcess): OwnedChild {
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = trimTail(stdout + chunk);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = trimTail(stderr + chunk);
  });
  return {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    wait: () =>
      new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      }),
  };
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const owned = trackChild(
    spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const code = await owned.wait();
  return { code, stdout: owned.stdout, stderr: owned.stderr };
}

async function poll<T>(
  action: () => Promise<T> | T,
  timeoutMs: number,
  detail: () => string,
  predicate: (value: T) => boolean = Boolean as (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last!: T;
  while (Date.now() < deadline) {
    last = await action();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out after ${timeoutMs}ms. ${detail()}`);
}

/**
 * The real OpenRouter key from the machine's actual Hermes install, read
 * once and only ever placed in a child process's env — never logged, never
 * written into any isolated HERMES_HOME's files.
 */
async function resolveOpenRouterApiKey(): Promise<string> {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const envPath = join(defaultHermesRoot(), ".env");
  const text = await readFile(envPath, "utf8").catch(() => "");
  const match = /^OPENROUTER_API_KEY\s*=\s*(.+)$/m.exec(text);
  const value = match?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!value) {
    throw new Error(
      "No OPENROUTER_API_KEY available via process env or the real Hermes .env store; this e2e requires a working provider credential.",
    );
  }
  return value;
}

function which(command: string): string {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  const path = result.stdout?.trim();
  if (result.status !== 0 || !path) {
    throw new Error(`Could not locate ${command} on PATH via 'which'.`);
  }
  return path;
}

async function fixture(): Promise<Fixture> {
  const rootDir = await root("fixture");
  const project = join(rootDir, "project");
  const home = join(rootDir, "home");
  const hermesHome = join(rootDir, "hermes-home");
  const subconsciousHome = join(rootDir, "subconscious-home");
  const bin = join(rootDir, "bin");
  const tmp = join(rootDir, "tmp");
  for (const path of [project, home, hermesHome, subconsciousHome, bin, tmp]) {
    await mkdir(path, { recursive: true });
  }
  await writeProjectConfig(project, {
    version: 1,
    agentId: "agent-hermes-e2e",
    delivery: { whispers: true, queueMessages: false },
    observer: { midTurn: { minToolCalls: 1, minSeconds: 0 } },
  });
  await writeFile(
    join(bin, "subconscious"),
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const brokerEntry = ${JSON.stringify(brokerEntry)};
const result = spawnSync(process.execPath, [brokerEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status === null ? 1 : result.status);
`,
    { mode: 0o755 },
  );
  const hermesBinDir = dirname(which("hermes"));
  const apiKey = await resolveOpenRouterApiKey();
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    HERMES_HOME: hermesHome,
    SUBCONSCIOUS_HOME: subconsciousHome,
    TMPDIR: tmp,
    PATH: `${bin}:${hermesBinDir}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    OPENROUTER_API_KEY: apiKey,
    NO_COLOR: "1",
  };

  const descriptor: BrokerDescriptor = {
    version: 1,
    endpoint: join(subconsciousHome, "broker.sock"),
    token: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    build: await buildFingerprint(brokerEntry),
  };
  await startBroker(subconsciousHome, descriptor);

  // Install hooks through the production installer — a real CLI invocation
  // of `subconscious install hermes`, writing only into the isolated
  // HERMES_HOME above. Never touches the real ~/.hermes.
  const installResult = await runCommand(
    "subconscious",
    ["install", "hermes"],
    {
      cwd: project,
      env,
    },
  );
  if (installResult.code !== 0) {
    throw new Error(
      `subconscious install hermes failed (${installResult.code}).\nstdout:\n${installResult.stdout}\nstderr:\n${installResult.stderr}`,
    );
  }
  const configText = await readFile(join(hermesHome, "config.yaml"), "utf8");
  for (const event of [
    "on_session_start",
    "pre_llm_call",
    "post_tool_call",
    "on_session_end",
  ]) {
    expect(configText).toContain(event);
  }
  expect(configText).toContain("subconscious hook hermes");
  const allowlist = JSON.parse(
    await readFile(join(hermesHome, "shell-hooks-allowlist.json"), "utf8"),
  ) as { approvals: Array<{ event: string; command: string }> };
  expect(
    allowlist.approvals.filter(
      (entry) => entry.command === "subconscious hook hermes",
    ),
  ).toHaveLength(4);

  return {
    root: rootDir,
    project,
    hermesHome,
    subconsciousHome,
    bin,
    env,
    descriptor,
  };
}

async function startBroker(
  subconsciousHome: string,
  descriptor: BrokerDescriptor,
): Promise<SubconsciousBroker> {
  const broker = new SubconsciousBroker({
    descriptor,
    stateDirectory: subconsciousHome,
    runtime: silentObserver,
  });
  brokers.push(broker);
  await broker.start();
  await writeBrokerDescriptor(
    join(subconsciousHome, "broker.json"),
    descriptor,
  );
  return broker;
}

function parseSessionId(stderr: string): string {
  const match = /^session_id:\s*(\S+)\s*$/m.exec(stderr);
  if (!match) {
    throw new Error(`No session_id line found in hermes stderr:\n${stderr}`);
  }
  return match[1];
}

function finalResponse(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error(`hermes produced no response text on stdout:\n${stdout}`);
  }
  return lines[lines.length - 1];
}

async function runTurn(
  active: Fixture,
  prompt: string,
  sessionId?: string,
): Promise<{
  sessionId: string;
  response: string;
  stdout: string;
  stderr: string;
}> {
  const args = [
    "chat",
    "-q",
    prompt,
    "--provider",
    HERMES_PROVIDER,
    "--model",
    HERMES_MODEL,
    "--max-turns",
    "8",
    "--run-budget",
    "150",
    "-Q",
    ...(sessionId ? ["--resume", sessionId] : []),
  ];
  const result = await runCommand("hermes", args, {
    cwd: active.project,
    env: active.env,
  });
  if (result.code !== 0) {
    throw new Error(
      `hermes chat failed (${result.code}).\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return {
    sessionId: parseSessionId(result.stderr),
    response: finalResponse(result.stdout),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function brokerState(active: Fixture): Promise<BrokerState> {
  const response = await sendBrokerRequest(active.descriptor, {
    type: "status",
  });
  if (!response.ok || response.type !== "status") {
    throw new Error(
      `Unexpected broker status response: ${JSON.stringify(response)}`,
    );
  }
  return response.state;
}

function routeKeyForSession(
  state: BrokerState,
  sessionId: string,
): string | null {
  for (const [key, route] of Object.entries(state.routes)) {
    if (route.harness === "hermes" && route.sessionId === sessionId) return key;
  }
  return null;
}

function routeObservations(
  state: BrokerState,
  sessionId: string,
): Array<{ type: HarnessEventType; status: string }> {
  const key = routeKeyForSession(state, sessionId);
  if (!key) return [];
  return Object.values(state.observations)
    .filter((record) => record.routeKey === key)
    .map((record) => ({ type: record.event.type, status: record.status }));
}

async function waitForObservationSet(
  active: Fixture,
  sessionId: string,
  expected: Partial<Record<HarnessEventType, number>>,
): Promise<{ state: BrokerState; key: string | null }> {
  let last: { state: BrokerState; key: string | null } | null = null;
  return await poll(
    async () => {
      const state = await brokerState(active);
      last = { state, key: routeKeyForSession(state, sessionId) };
      return last;
    },
    120_000,
    () =>
      `waiting for observations on ${sessionId}: ${JSON.stringify(
        last
          ? {
              routeKey: last.key,
              observations: routeObservations(last.state, sessionId),
            }
          : null,
      )}`,
    ({ state, key }) => {
      if (!key) return false;
      const observations = routeObservations(state, sessionId);
      return Object.entries(expected).every(([type, count]) => {
        const matches = observations.filter(
          (record) => record.type === type && record.status === "processed",
        );
        return matches.length >= (count ?? 0);
      });
    },
  );
}

async function seedPendingWhisper(
  active: Fixture,
  routeKeyValue: string,
  canary: string,
): Promise<string> {
  for (const broker of brokers.splice(0)) {
    await broker.close();
  }
  const statePath = join(active.subconsciousHome, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as BrokerState;
  const delivery: DeliveryRecord = {
    id: deliveryId("seed-hermes", "whisper", `canary-${canary}`),
    routeKey: routeKeyValue,
    observationId: "seed-hermes",
    kind: "whisper",
    text: canary,
    priority: "normal",
    dedupeKey: `canary-${canary}`,
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    attempts: 0,
  };
  state.deliveries[delivery.id] = delivery;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await startBroker(active.subconsciousHome, active.descriptor);
  return delivery.id;
}

interface SessionRow {
  id: number;
  role: string | null;
  content: unknown;
  tool_name: string | null;
}

async function readSessionRows(
  hermesHome: string,
  sessionId: string,
): Promise<SessionRow[]> {
  return await poll(
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(join(hermesHome, "state.db"), {
        readOnly: true,
      });
      try {
        return database
          .prepare(
            "SELECT id, role, content, tool_name FROM messages WHERE session_id = ? ORDER BY id ASC",
          )
          .all(sessionId) as unknown as SessionRow[];
      } finally {
        database.close();
      }
    },
    30_000,
    () => `waiting for state.db rows for session ${sessionId}`,
    (rows) => rows.length > 0,
  );
}

// Every turn uses the same instructions: do exactly one real tool call and
// answer BASELINE, unless a subconscious whisper is already visible in this
// turn's context — in which case skip the tool call and echo the whisper
// text verbatim instead. Hermes only exposes injected context on
// pre_llm_call (the turn prologue), so a whisper seeded after turn 1 can only
// become visible at the start of a later turn, never mid-turn.
const PROMPT =
  'Before doing anything else, inspect the full context you were given for this turn, including any injected context blocks that look like <subconscious_whisper delivery_id="...">...some content...</subconscious_whisper>. If such a block is present: copy out the exact characters between the opening and closing subconscious_whisper tags, and reply with ONLY that copied content and nothing else — no tags, no explanation, no quotes, and do not literally output the word "TEXT" or any other placeholder; output the real characters you found between the tags, verbatim. If no such block is present anywhere in your context, use exactly one tool call to run the shell command: printf SUBCONSCIOUS_E2E_TOOL_OK — use no other tool calls — and then reply with exactly the word BASELINE and nothing else.';

beforeAll(async () => {
  if (process.env.SUBCONSCIOUS_HERMES_LIVE !== "1") return;
  await readFile(brokerEntry).catch(() => {
    throw new Error(
      `No broker build at ${brokerEntry}. Run npm run build first.`,
    );
  });
  const version = spawnSync("hermes", ["--version"], { encoding: "utf8" });
  if (version.status !== 0) {
    throw new Error(
      `hermes --version failed (${version.status}).\n${version.stdout}\n${version.stderr}`,
    );
  }
  const versionMatch = /Hermes Agent v(\S+)/.exec(version.stdout);
  expect(versionMatch?.[1]).toBe(HERMES_VERSION);

  const apiKey = await resolveOpenRouterApiKey();
  const catalog = (await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  }).then((response) => response.json())) as {
    data?: Array<{ id?: string }>;
  };
  const ids = new Set(
    (catalog.data ?? []).map((model) => model.id).filter(Boolean),
  );
  expect(ids.has(HERMES_MODEL)).toBe(true);
  expect(ids.has(RETIRED_MODEL)).toBe(false);
}, 60_000);

const liveDescribe =
  process.env.SUBCONSCIOUS_HERMES_LIVE === "1" ? describe : describe.skip;

liveDescribe("Hermes live end-to-end", () => {
  it(
    "observes a real tool turn against the real state.db and delivers one seeded whisper only into the same native session via pre_llm_call",
    { timeout: 480_000 },
    async () => {
      const active = await fixture();
      const canary = `CNY-${randomUUID().replaceAll("-", "").slice(0, 16)}`;

      const first = await runTurn(active, PROMPT);
      const sessionId = first.sessionId;
      expect(first.response).toBe("BASELINE");

      const firstObserved = await waitForObservationSet(active, sessionId, {
        session_start: 1,
        user_prompt: 1,
        tool_result: 1,
        turn_stop: 1,
      });
      const routeKeyValue = firstObserved.key;
      expect(routeKeyValue).toBeTruthy();
      expect(firstObserved.state.routes[routeKeyValue!]).toBeDefined();
      expect(
        firstObserved.state.routes[routeKeyValue!]?.sourceCursor?.sequence,
      ).toBeGreaterThan(0);

      const firstRows = await readSessionRows(active.hermesHome, sessionId);
      // The prompt asks for exactly one tool call; a small free model
      // occasionally makes an extra one, so this checks that at least one
      // real terminal call landed in state.db rather than policing the
      // model's exact tool-call discipline.
      const toolRows = firstRows.filter((row) => row.role === "tool");
      expect(toolRows.length).toBeGreaterThanOrEqual(1);
      expect(
        toolRows.some(
          (row) =>
            row.tool_name === "terminal" &&
            String(row.content ?? "").includes("SUBCONSCIOUS_E2E_TOOL_OK"),
        ),
      ).toBe(true);
      expect(JSON.stringify(firstRows)).not.toContain(canary);

      // Seed an unpredictable whisper for the exact native session that just
      // ran — real DeliveryRecord written into the broker's own state.json,
      // scoped to that session's routeKey.
      const deliveryIdSeeded = await seedPendingWhisper(
        active,
        routeKeyValue!,
        canary,
      );

      // A different, brand-new native session must never see it.
      const other = await runTurn(active, PROMPT);
      expect(other.sessionId).not.toBe(sessionId);
      expect(other.response).toBe("BASELINE");
      const otherObserved = await waitForObservationSet(
        active,
        other.sessionId,
        {
          session_start: 1,
          user_prompt: 1,
          tool_result: 1,
          turn_stop: 1,
        },
      );
      expect(otherObserved.key).not.toBe(routeKeyValue);
      const otherRows = await readSessionRows(
        active.hermesHome,
        other.sessionId,
      );
      expect(JSON.stringify(otherRows)).not.toContain(canary);
      const stateAfterOther = await brokerState(active);
      expect(stateAfterOther.deliveries[deliveryIdSeeded]?.status).toBe(
        "pending",
      );
      expect(
        stateAfterOther.deliveries[deliveryIdSeeded]?.acknowledgedAt,
      ).toBeUndefined();

      // Resuming the exact native session surfaces the whisper on the next
      // pre_llm_call, and the model reads it back verbatim.
      const second = await runTurn(active, PROMPT, sessionId);
      expect(second.sessionId).toBe(sessionId);

      const secondState = await poll(
        async () => await brokerState(active),
        120_000,
        () => `broker state for ${sessionId}`,
        (state) => {
          const records = routeObservations(state, sessionId);
          const delivered = state.deliveries[deliveryIdSeeded];
          return (
            records.filter(
              (record) =>
                record.type === "user_prompt" && record.status === "processed",
            ).length >= 2 &&
            records.filter(
              (record) =>
                record.type === "turn_stop" && record.status === "processed",
            ).length >= 2 &&
            delivered?.status === "delivered" &&
            Boolean(delivered.acknowledgedAt)
          );
        },
      );
      expect(secondState.deliveries[deliveryIdSeeded]?.routeKey).toBe(
        routeKeyValue,
      );
      expect(routeKeyForSession(secondState, sessionId)).toBe(routeKeyValue);

      if (second.response !== canary) {
        throw new Error(
          [
            `Expected final response ${canary} but received ${second.response}.`,
            `Delivery state: ${JSON.stringify(secondState.deliveries[deliveryIdSeeded])}`,
            `stdout tail: ${second.stdout.slice(-4_000)}`,
          ].join("\n"),
        );
      }
      expect(second.response).toBe(canary);

      // The whisper is ephemeral: the stored transcript row for turn 2's
      // user message never carries it, only the model's own reply does.
      const secondRows = await readSessionRows(active.hermesHome, sessionId);
      const userRows = secondRows.filter((row) => row.role === "user");
      const assistantRows = secondRows.filter(
        (row) => row.role === "assistant",
      );
      for (const row of userRows) {
        expect(String(row.content ?? "")).not.toContain(canary);
      }
      expect(
        assistantRows.some((row) => String(row.content ?? "").includes(canary)),
      ).toBe(true);
    },
  );
});
