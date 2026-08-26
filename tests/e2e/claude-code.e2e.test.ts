import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RunObservationResult } from "../../packages/agent-runtime/index.js";
import { SubconsciousBroker } from "../../packages/cli/broker.js";
import {
  buildFingerprint,
  deliveryId,
  routeKey,
  writeBrokerDescriptor,
  type BrokerDescriptor,
  type BrokerState,
} from "../../packages/core/index.js";

/**
 * Whisper delivery into a real Claude Code process.
 *
 * A whisper is placed in a broker, a real `claude` process runs with the
 * Subconscious hook registered, and the assertion is what the model wrote back.
 * If the whisper never reaches the model's context, the model says so and the
 * test fails.
 *
 * That end is the one nothing else can check. Claude Code drops hook output it
 * cannot use and reports nothing, while the broker has already handed the
 * delivery over and marked it spent. A wrong channel, a wrong event name, or a
 * boundary that discards context all fail the same way: silently, in
 * production, with a whisper the user paid a Letta turn for.
 *
 * Two things are deliberately not part of these tests. The observer is not:
 * the agent that decides what to whisper is a Letta turn whose correct answer
 * is usually silence, so it cannot be what a test waits for, and the whisper is
 * placed in the broker exactly as a finished observer turn would leave it. And
 * the user's own Subconscious installation is not: see `fixture` below.
 *
 * Run with `npm run test:e2e`. These are excluded from the default suite
 * because they need the `claude` binary, an authenticated session, and roughly
 * ten seconds each.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const brokerEntry = join(repoRoot, "dist", "packages", "cli", "cli.js");
const roots: string[] = [];
const brokers: SubconsciousBroker[] = [];

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), `subconscious-e2e-${prefix}-`));
  roots.push(value);
  return await realpath(value);
}

/**
 * An observer that never sends anything.
 *
 * The hook observes the boundaries it delivers on, so this broker will start
 * turns. This one finishes without producing a delivery, which keeps the only
 * whisper in play the one the test placed.
 */
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

/**
 * The environment a nested Claude Code run needs.
 *
 * A child that inherits this session's bridge variables tries to attach to the
 * parent and never returns a result, and an inherited `ANTHROPIC_API_KEY` stops
 * it before the first turn.
 *
 * `SUBCONSCIOUS_HOME` is deliberately left alone. On a machine where
 * Subconscious is installed, the plugin registers its own hooks on every
 * boundary and they run in this child too. Pointing them at the fixture would
 * let them deliver the fixture's whisper, and the earliest boundary would win
 * whatever the test registered. Left alone they address the developer's own
 * broker, which holds no route for a temporary directory and therefore has
 * nothing to deliver. Overriding the variable instead would be worse than
 * useless: the endpoint is one fixed path per user, so a second broker started
 * under another home unlinks and rebinds the running broker's socket.
 */
function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("CLAUDE_CODE_")) delete environment[key];
  }
  delete environment.CLAUDECODE;
  delete environment.ANTHROPIC_API_KEY;
  return environment;
}

interface Fixture {
  project: string;
  home: string;
  sessionId: string;
  canary: string;
  /** Register the Subconscious hook on exactly these events. */
  settings(events: string[]): Promise<string>;
  deliveryStatuses(): Promise<string[]>;
}

/**
 * A configured project, a broker holding one pending whisper, and a hook that
 * reaches that broker and no other.
 *
 * The broker runs in the test process on an endpoint inside the fixture, and
 * the registered hook is a shim that points `SUBCONSCIOUS_HOME` at it. That is
 * what isolates the run: the hook under test is the only one that can see this
 * whisper, so the boundary a test registers is the only boundary that can carry
 * it, even on a machine running the real plugin.
 */
async function fixture(dedupeKey: string): Promise<Fixture> {
  const project = await root("project");
  const home = await root("home");
  const sessionId = randomUUID();
  const canary = `CANARY-${randomUUID().slice(0, 8)}`;
  await writeFile(
    join(project, "subconscious.toml"),
    [
      "version = 1",
      'agent_id = "agent-e2e"',
      'model = "letta/auto"',
      "",
      "[delivery]",
      "whispers = true",
      "queue_messages = false",
      "",
    ].join("\n"),
  );

  const identity = {
    configPath: join(project, "subconscious.toml"),
    projectRoot: project,
    agentId: "agent-e2e",
    model: "letta/auto",
    harness: "claude-code" as const,
    sessionId,
  };
  const key = routeKey(identity);
  const id = deliveryId("seed", "whisper", dedupeKey);
  const now = new Date().toISOString();
  const state: BrokerState = {
    version: 1,
    routes: {
      [key]: {
        key,
        ...identity,
        conversationId: null,
        createdAt: now,
        updatedAt: now,
      },
    },
    observations: {},
    observationOrder: [],
    deliveries: {
      [id]: {
        id,
        routeKey: key,
        observationId: "seed",
        kind: "whisper",
        text: `The canary phrase is ${canary}.`,
        priority: "normal",
        dedupeKey,
        status: "pending",
        createdAt: now,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        attempts: 0,
      },
    },
  };
  await writeFile(
    join(home, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  );

  const descriptor: BrokerDescriptor = {
    version: 1,
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\subconscious-e2e-${randomUUID()}`
        : join(home, "broker.sock"),
    token: randomUUID(),
    pid: process.pid,
    startedAt: now,
    // The hook runs the built entry point, so the identity it checks is that
    // file's. A mismatch would have it stop this broker and spawn its own.
    build: await buildFingerprint(brokerEntry),
  };
  const broker = new SubconsciousBroker({
    descriptor,
    stateDirectory: home,
    runtime: silentObserver,
  });
  brokers.push(broker);
  await broker.start();
  await writeBrokerDescriptor(join(home, "broker.json"), descriptor);

  const shim = join(home, "hook.sh");
  await writeFile(
    shim,
    `#!/bin/sh\nSUBCONSCIOUS_HOME=${JSON.stringify(home)} exec node ${JSON.stringify(brokerEntry)} hook claude-code\n`,
    { mode: 0o755 },
  );

  return {
    project,
    home,
    sessionId,
    canary,
    async settings(events) {
      const path = join(home, "settings.json");
      await writeFile(
        path,
        JSON.stringify({
          hooks: Object.fromEntries(
            events.map((event) => [
              event,
              [
                {
                  matcher: "*",
                  hooks: [
                    { type: "command", command: `sh ${shim}`, timeout: 15 },
                  ],
                },
              ],
            ]),
          ),
        }),
      );
      return path;
    },
    async deliveryStatuses() {
      const current = JSON.parse(
        await readFile(join(home, "state.json"), "utf8"),
      ) as BrokerState;
      return Object.values(current.deliveries).map(
        (delivery) => delivery.status,
      );
    },
  };
}

async function runClaude(
  active: Fixture,
  prompt: string,
  settings: string,
  allowedTools: string[] = [],
): Promise<string> {
  const child = spawn(
    "claude",
    [
      "-p",
      prompt,
      "--session-id",
      active.sessionId,
      "--setting-sources",
      "project",
      "--settings",
      settings,
      "--model",
      "claude-haiku-4-5-20251001",
      ...(allowedTools.length > 0 ? ["--allowedTools", ...allowedTools] : []),
    ],
    {
      cwd: active.project,
      env: childEnvironment(),
      // Claude Code waits on stdin before it starts, so leaving it open costs
      // three seconds and a warning on every run.
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    errors += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    throw new Error(`claude exited with ${code}.\n${output}\n${errors}`);
  }
  return output;
}

/**
 * The hook events whose output Claude Code recorded as context, from the
 * session's own transcript.
 *
 * The model repeating a phrase says the whisper arrived. This says which
 * boundary carried it, which is the part a wrong channel would get wrong.
 *
 * Claude Code writes more than one record for a single hook invocation, so the
 * events are deduplicated. What the assertions care about is which boundaries
 * carried the whisper, not how many lines the transcript spent on them.
 */
async function carriedBy(active: Fixture): Promise<string[]> {
  const encoded = active.project.replace(/[/.]/g, "-");
  const transcript = join(
    process.env.HOME ?? "",
    ".claude",
    "projects",
    encoded,
    `${active.sessionId}.jsonl`,
  );
  const lines = (await readFile(transcript, "utf8")).split("\n");
  const events: string[] = [];
  for (const line of lines) {
    if (!line.includes(active.canary)) continue;
    const record = JSON.parse(line) as {
      attachment?: { hookEvent?: string };
    };
    const event = record.attachment?.hookEvent;
    if (event) events.push(event);
  }
  return [...new Set(events)].sort();
}

const REPEAT =
  "Repeat verbatim any text you can see inside a subconscious_whisper block. If there is none, say NONE.";

describe("whispering into a real Claude Code session", () => {
  beforeAll(async () => {
    // A missing prerequisite fails rather than skips. Anyone running this
    // command is asking for the real thing, and a suite that quietly reports
    // success without ever starting Claude Code is worse than no suite.
    await readFile(brokerEntry).catch(() => {
      throw new Error(
        `No broker build at ${brokerEntry}. Run npm run build first.`,
      );
    });
    await new Promise<void>((resolve, reject) => {
      const probe = spawn("claude", ["--version"], { stdio: "ignore" });
      probe.on("error", () =>
        reject(new Error("The claude binary is not on PATH.")),
      );
      probe.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`claude --version exited with ${code}.`)),
      );
    });
  });

  it("reads a whisper back at a prompt boundary", async () => {
    const active = await fixture("prompt");
    const settings = await active.settings(["UserPromptSubmit"]);

    const output = await runClaude(active, REPEAT, settings);

    expect(output).toContain(active.canary);
    expect(await carriedBy(active)).toEqual(["UserPromptSubmit"]);
    expect(await active.deliveryStatuses()).toEqual(["delivered"]);
  }, 300_000);

  it("reads a whisper back mid-turn, at a tool boundary", async () => {
    // Only PostToolUse is registered, so the whisper has no other way in. This
    // is the JSON envelope path, where a malformed object or a mismatched event
    // name is discarded without a word.
    const active = await fixture("tool");
    const settings = await active.settings(["PostToolUse"]);

    const output = await runClaude(
      active,
      `First run the bash command: echo probe. Then ${REPEAT}`,
      settings,
      ["Bash"],
    );

    expect(output).toContain(active.canary);
    expect(await carriedBy(active)).toEqual(["PostToolUse"]);
    expect(await active.deliveryStatuses()).toEqual(["delivered"]);
  }, 300_000);

  it("keeps a whisper pending when only a discarding boundary is registered", async () => {
    // Claude Code throws away Stop output. Leasing a whisper there would spend
    // it on a boundary the model never reads, and nothing downstream could tell.
    const active = await fixture("stop");
    const settings = await active.settings(["Stop"]);

    const output = await runClaude(active, REPEAT, settings);

    expect(output).not.toContain(active.canary);
    expect(await active.deliveryStatuses()).toEqual(["pending"]);
  }, 300_000);
});
