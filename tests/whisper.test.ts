import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { RunObservationResult } from "../packages/agent-runtime/index.js";
import { SubconsciousBroker } from "../packages/cli/broker.js";
import { brokerBuild, runHook } from "../packages/cli/hook.js";
import {
  deliveryId,
  routeKey,
  sendBrokerRequest,
  writeBrokerDescriptor,
  writeProjectConfig,
  type BrokerDescriptor,
  type BrokerState,
  type DeliveryRecord,
} from "../packages/core/index.js";

/**
 * What the broker and the hook do with a whisper that is waiting to be sent.
 *
 * These are the decisions made on this side of the harness: which boundary a
 * whisper may go out on, what shape it takes there, when it is acknowledged,
 * and which session it belongs to. `runHook` runs for real against a live
 * broker over a real socket, and the assertions are the bytes that would reach
 * the harness.
 *
 * Two things are deliberately absent, and neither is stubbed in as a stand-in.
 * The observer is not here: a whisper is placed in the broker's state exactly
 * as a completed observer turn would leave it, so nothing below depends on a
 * fake agent deciding to speak. Claude Code is not here either, so these tests
 * cannot show that the harness accepts what is emitted. `tests/e2e` runs a real
 * `claude` process and asserts on what the model reads back; that is the file
 * that proves whispering works. This one covers the paths a live run is too
 * slow and too coarse to reach, such as a hook that dies mid-write.
 */

const roots: string[] = [];
const brokers: SubconsciousBroker[] = [];
const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
  delete process.env.SUBCONSCIOUS_HOME;
});

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), `subconscious-${prefix}-`));
  roots.push(value);
  return await realpath(value);
}

/**
 * An observer that never sends anything.
 *
 * The hook observes the events it delivers on, so a broker in these tests will
 * start turns. This one completes without producing a delivery, which keeps
 * every whisper below the one the test placed itself.
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
  }),
};

interface Session {
  /**
   * Run the real hook against one Claude Code payload, and capture stdout.
   *
   * With `breakStdout` the capture throws instead of collecting, which is the
   * only way to reach the ordering between emission and acknowledgement: the
   * hook has to fail while writing, not before it.
   */
  hook(
    payload: Record<string, unknown>,
    breakStdout?: boolean,
  ): Promise<string>;
  /** Take the session status banner, so a later assertion sees whispers only. */
  takeStatus(): Promise<void>;
  deliveries(): Promise<DeliveryRecord[]>;
  whisper: string;
}

/**
 * A configured project holding one pending whisper, and a broker serving it.
 *
 * The state file is written before the broker starts, which is how a real
 * broker finds the deliveries an earlier turn produced.
 *
 * The descriptor carries the build identity `brokerBuild` reports. Without it
 * the hook treats this broker as a stale daemon from another build, shuts it
 * down, and spawns a real one, which would leave the test passing against a
 * process it never meant to start.
 */
async function session(whisper: string, build?: string): Promise<Session> {
  const directory = await root("whisper");
  const home = await root("home");
  const sessionId = "session-whisper";
  await writeProjectConfig(directory, {
    version: 1,
    agentId: "agent-whisper",
    model: "letta/auto",
    delivery: { whispers: true, queueMessages: false },
    observer: {},
  });

  const identity = {
    configPath: join(directory, "subconscious.toml"),
    projectRoot: directory,
    agentId: "agent-whisper",
    model: "letta/auto",
    harness: "claude-code" as const,
    sessionId,
  };
  const key = routeKey(identity);
  const id = deliveryId("seed", "whisper", "seed");
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
        text: whisper,
        priority: "normal",
        dedupeKey: "seed",
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
        ? `\\\\.\\pipe\\subconscious-test-${randomUUID()}`
        : join(home, "broker.sock"),
    token: "test-token",
    pid: process.pid,
    startedAt: now,
    build: build ?? (await brokerBuild()),
  };
  const broker = new SubconsciousBroker({
    descriptor,
    stateDirectory: home,
    runtime: silentObserver,
  });
  brokers.push(broker);
  await broker.start();
  process.env.SUBCONSCIOUS_HOME = home;
  await writeBrokerDescriptor(join(home, "broker.json"), descriptor);

  async function deliveries(): Promise<DeliveryRecord[]> {
    const response = await sendBrokerRequest(descriptor, { type: "status" });
    if (!response.ok || response.type !== "status")
      throw new Error("Missing broker status.");
    return Object.values(response.state.deliveries);
  }

  return {
    whisper,
    async hook(payload, breakStdout = false) {
      const input = JSON.stringify({
        session_id: sessionId,
        cwd: directory,
        ...payload,
      });
      Object.defineProperty(process, "stdin", {
        value: Readable.from([input]),
        configurable: true,
      });
      const written: string[] = [];
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: unknown) => {
        if (breakStdout) throw new Error("EPIPE");
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      try {
        await runHook("claude-code");
      } finally {
        process.stdout.write = write;
      }
      return written.join("");
    },
    async takeStatus() {
      await sendBrokerRequest(descriptor, {
        type: "claim_session_status",
        target: {
          harness: "claude-code",
          sessionId,
          workingDirectory: directory,
        },
      });
    },
    deliveries,
  };
}

function envelope(output: string): Record<string, unknown> {
  // Claude Code parses tool-boundary output as JSON and drops anything it
  // cannot read, so the parse itself is the assertion.
  const parsed = JSON.parse(output.trim()) as {
    hookSpecificOutput?: Record<string, unknown>;
  };
  const inner = parsed.hookSpecificOutput;
  if (!inner) throw new Error("The envelope carried no hookSpecificOutput.");
  return inner;
}

describe("a whisper waiting in the broker", () => {
  it("goes out as plain text at a prompt boundary", async () => {
    const active = await session("The migration runs before the deploy.");
    await active.takeStatus();

    const output = await active.hook({
      hook_event_name: "UserPromptSubmit",
      prompt: "Ship the release.",
    });

    expect(output).toContain("<subconscious_whisper");
    expect(output).toContain(active.whisper);
    // A prompt boundary reads raw stdout. An envelope here would be injected as
    // literal JSON text for the model to read.
    expect(() => JSON.parse(output.trim())).toThrow();
  });

  it("goes out inside the envelope a tool boundary requires", async () => {
    const active = await session(
      "That approach already failed on this branch.",
    );
    await active.takeStatus();

    const output = await active.hook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { stdout: "ok" },
    });

    const inner = envelope(output);
    expect(inner.hookEventName).toBe("PostToolUse");
    expect(String(inner.additionalContext)).toContain(active.whisper);
  });

  it("names the boundary that carried it, on both tool events", async () => {
    // Claude Code matches the envelope's event name against the hook that
    // produced it and drops a mismatch without a word, which spends the whisper.
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const active = await session(`Whisper at ${event}.`);
      await active.takeStatus();
      const output = await active.hook({
        hook_event_name: event,
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      expect(envelope(output).hookEventName).toBe(event);
    }
  });

  it("shares one emission with the session status", async () => {
    // The envelope holds one object per event, so a status and a whisper that
    // land on the same boundary have to be emitted together. Writing twice
    // would give the harness two JSON documents and it would keep neither.
    const active = await session("Check the deployment order.");

    const output = await active.hook({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/example" },
    });

    const context = String(envelope(output).additionalContext);
    expect(context).toContain("<subconscious_status>");
    expect(context).toContain("agent-whisper");
    expect(context).toContain(active.whisper);
  });

  it("goes out once", async () => {
    const active = await session("Say this exactly once.");
    await active.takeStatus();

    const first = await active.hook({
      hook_event_name: "UserPromptSubmit",
      prompt: "Go.",
    });
    const second = await active.hook({
      hook_event_name: "UserPromptSubmit",
      prompt: "Go again.",
    });

    expect(first).toContain(active.whisper);
    expect(second).toBe("");
    expect(
      (await active.deliveries()).map((delivery) => delivery.status),
    ).toEqual(["delivered"]);
  });

  it("waits for a boundary that can carry it", async () => {
    // Claude Code discards Stop output. A lease there would acknowledge a
    // whisper the model never sees, so the adapter claims no channel for it.
    const active = await session("Wait for a boundary that reads context.");
    await active.takeStatus();

    expect(await active.hook({ hook_event_name: "Stop" })).toBe("");
    expect(await active.hook({ hook_event_name: "PreCompact" })).toBe("");
    expect(
      (await active.deliveries()).every(
        (delivery) => delivery.status === "pending",
      ),
    ).toBe(true);

    expect(
      await active.hook({
        hook_event_name: "UserPromptSubmit",
        prompt: "Continue.",
      }),
    ).toContain(active.whisper);
  });

  it("stays pending when the harness never receives it", async () => {
    // The acknowledgement follows the emission. A hook that dies while writing
    // has to leave the whisper pending, because the alternative is a delivery
    // marked delivered that no model ever read.
    const active = await session("Survive a broken pipe.");
    await active.takeStatus();

    await expect(
      active.hook({ hook_event_name: "UserPromptSubmit", prompt: "Go." }, true),
    ).rejects.toThrow("EPIPE");

    expect(
      (await active.deliveries()).map((delivery) => delivery.status),
    ).toEqual(["pending"]);

    expect(
      await active.hook({
        hook_event_name: "UserPromptSubmit",
        prompt: "Retry.",
      }),
    ).toContain(active.whisper);
  });

  it("never leaves a directory no project configures", async () => {
    const active = await session("Never leaves the configured project.");
    await active.takeStatus();
    const elsewhere = await root("unconfigured");

    expect(
      await active.hook({
        hook_event_name: "UserPromptSubmit",
        prompt: "Go.",
        cwd: elsewhere,
      }),
    ).toBe("");
    expect(
      (await active.deliveries()).every(
        (delivery) => delivery.status === "pending",
      ),
    ).toBe(true);
  });

  it("gives up rather than making the harness wait for a broker", async () => {
    // A broker from another build cannot be used, and replacing one can take
    // longer than the harness allows the hook to live: Claude Code drops a
    // tool-boundary hook after three seconds. Waiting there does not buy a late
    // whisper, it loses the boundary and the observation with it. So the hook
    // asks the old broker to stop, emits nothing, and lets the next boundary
    // use the replacement. The whisper is still pending for it.
    const active = await session(
      "Not worth a stalled session.",
      "another-build",
    );
    await active.takeStatus();

    const started = Date.now();
    const output = await active.hook({
      hook_event_name: "UserPromptSubmit",
      prompt: "Go.",
    });
    const elapsed = Date.now() - started;

    expect(output).toBe("");
    expect(
      (await active.deliveries()).map((delivery) => delivery.status),
    ).toEqual(["pending"]);
    // Well inside the tightest hook budget. The bound is loose on purpose: the
    // failure this catches is seconds long, not milliseconds.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("reaches only the session that earned it", async () => {
    // Deliveries are routed, not broadcast. A second Claude Code session in the
    // same project must not receive another session's context.
    const active = await session("Only for the first session.");
    await active.takeStatus();

    expect(
      await active.hook({
        hook_event_name: "UserPromptSubmit",
        prompt: "Go.",
        session_id: "session-other",
      }),
    ).toBe("");
    expect(
      (await active.deliveries()).map((delivery) => delivery.status),
    ).toEqual(["pending"]);
  });
});
