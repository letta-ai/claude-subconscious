import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type {
  RunObservationInput,
  RunObservationResult,
} from "../packages/agent-runtime/index.js";
import { SubconsciousBroker } from "../packages/cli/broker.js";
import { brokerBuild, runHook } from "../packages/cli/hook.js";
import {
  deliveryId,
  sendBrokerRequest,
  writeBrokerDescriptor,
  writeProjectConfig,
  type BrokerDescriptor,
  type DeliveryRecord,
} from "../packages/core/index.js";

/**
 * End-to-end whisper delivery into Claude Code.
 *
 * Every other test in this repository stops at a seam: the adapter formats a
 * whisper, the broker leases it, `formatHookOutput` shapes it. None of them
 * proves that a whisper a real observer turn produced comes out of a real hook
 * process in the shape Claude Code reads, and that is the failure this system
 * cannot detect at runtime. Claude Code drops output it cannot parse and says
 * nothing about it, while the broker has already handed the delivery over. A
 * wrong channel, a wrong event name, or an emission the harness discards spends
 * the whisper and leaves no trace anywhere.
 *
 * So these tests run `runHook` itself against a live broker over a real socket,
 * and assert on the bytes the harness would receive.
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

interface Session {
  /** The project the harness reports as its working directory. */
  directory: string;
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
  /** Produce one pending whisper through an observer turn. */
  whisper(text: string): Promise<void>;
  /** Take the session status banner, so a later assertion sees whispers only. */
  takeStatus(): Promise<void>;
  deliveries(): Promise<DeliveryRecord[]>;
}

/**
 * A configured project, a live broker, and a hook that will talk to it.
 *
 * The broker's descriptor carries the build identity `brokerBuild` reports.
 * Without it the hook treats this broker as a stale daemon from another build,
 * shuts it down, and spawns a real one, which would leave the test passing
 * against a process it never meant to start.
 */
async function session(): Promise<Session> {
  const directory = await root("whisper");
  const home = await root("home");
  await writeProjectConfig(directory, {
    version: 1,
    agentId: "agent-whisper",
    model: "letta/auto",
    delivery: { whispers: true, queueMessages: false },
    observer: {},
  });

  let nextWhisper: string | null = null;
  const runtime = {
    run: async (input: RunObservationInput): Promise<RunObservationResult> => {
      if (nextWhisper) {
        await input.persistDelivery({
          id: deliveryId(input.event.id, "whisper", nextWhisper),
          routeKey: input.route.key,
          observationId: input.event.id,
          kind: "whisper",
          text: nextWhisper,
          priority: "normal",
          dedupeKey: nextWhisper,
          status: "pending",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          attempts: 0,
        });
      }
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

  const descriptor: BrokerDescriptor = {
    version: 1,
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\subconscious-test-${randomUUID()}`
        : join(home, "broker.sock"),
    token: "test-token",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    build: await brokerBuild(),
  };
  const broker = new SubconsciousBroker({
    descriptor,
    stateDirectory: home,
    runtime,
  });
  brokers.push(broker);
  await broker.start();
  process.env.SUBCONSCIOUS_HOME = home;
  await writeBrokerDescriptor(join(home, "broker.json"), descriptor);

  const sessionId = "session-whisper";
  const target = {
    harness: "claude-code" as const,
    sessionId,
    workingDirectory: directory,
  };

  async function deliveries(): Promise<DeliveryRecord[]> {
    const response = await sendBrokerRequest(descriptor, { type: "status" });
    if (!response.ok || response.type !== "status")
      throw new Error("Missing broker status.");
    return Object.values(response.state.deliveries);
  }

  return {
    directory,
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
    async whisper(text) {
      nextWhisper = text;
      const id = `observation-${randomUUID()}`;
      await sendBrokerRequest(descriptor, {
        type: "observe",
        event: {
          id,
          harness: "claude-code",
          type: "session_start",
          sessionId,
          workingDirectory: directory,
          occurredAt: new Date().toISOString(),
          payload: {},
        },
      });
      await waitFor(async () =>
        (await deliveries()).some(
          (delivery) => delivery.text === text && delivery.status === "pending",
        ),
      );
      nextWhisper = null;
    },
    async takeStatus() {
      await sendBrokerRequest(descriptor, {
        type: "claim_session_status",
        target,
      });
    },
    deliveries,
  };
}

function envelope(output: string): Record<string, unknown> {
  // Claude Code parses tool-boundary output as JSON and silently drops anything
  // it cannot read, so the parse itself is the assertion.
  const parsed = JSON.parse(output.trim()) as {
    hookSpecificOutput?: Record<string, unknown>;
  };
  const inner = parsed.hookSpecificOutput;
  if (!inner) throw new Error("The envelope carried no hookSpecificOutput.");
  return inner;
}

describe("whispering into Claude Code", () => {
  it("delivers a pending whisper as plain text at a prompt boundary", async () => {
    const active = await session();
    await active.whisper("The migration runs before the deploy.");
    await active.takeStatus();

    const output = await active.hook({
      hook_event_name: "UserPromptSubmit",
      prompt: "Ship the release.",
    });

    expect(output).toContain("<subconscious_whisper");
    expect(output).toContain("The migration runs before the deploy.");
    // A prompt boundary reads raw stdout. An envelope here would be injected as
    // literal JSON text for the model to read.
    expect(() => JSON.parse(output.trim())).toThrow();
  });

  it("delivers a pending whisper inside the envelope a tool boundary requires", async () => {
    const active = await session();
    await active.whisper("That approach already failed on this branch.");
    await active.takeStatus();

    const output = await active.hook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { stdout: "ok" },
    });

    const inner = envelope(output);
    expect(inner.hookEventName).toBe("PostToolUse");
    expect(String(inner.additionalContext)).toContain(
      "That approach already failed on this branch.",
    );
  });

  it("names the boundary that carried it, on both tool events", async () => {
    // Claude Code matches the envelope's event name against the hook that
    // produced it and drops a mismatch without a word, which spends the whisper.
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const active = await session();
      await active.whisper(`Whisper at ${event}.`);
      await active.takeStatus();
      const output = await active.hook({
        hook_event_name: event,
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      expect(envelope(output).hookEventName).toBe(event);
    }
  });

  it("carries the session status and a whisper in one emission", async () => {
    // The envelope holds one object per event, so a status and a whisper that
    // land on the same boundary have to be emitted together. Writing twice
    // would give the harness two JSON documents and it would keep neither.
    const active = await session();
    await active.whisper("Check the deployment order.");

    const output = await active.hook({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/example" },
    });

    const context = String(envelope(output).additionalContext);
    expect(context).toContain("<subconscious_status>");
    expect(context).toContain("agent-whisper");
    expect(context).toContain("Check the deployment order.");
  });

  it("sends one whisper once", async () => {
    const active = await session();
    await active.whisper("Say this exactly once.");
    await active.takeStatus();

    const first = await active.hook({
      hook_event_name: "UserPromptSubmit",
      prompt: "Go.",
    });
    const second = await active.hook({
      hook_event_name: "UserPromptSubmit",
      prompt: "Go again.",
    });

    expect(first).toContain("Say this exactly once.");
    expect(second).toBe("");
    expect(
      (await active.deliveries()).map((delivery) => delivery.status),
    ).toEqual(["delivered"]);
  });

  it("holds a whisper until a boundary that can carry it", async () => {
    // Claude Code discards Stop output. A lease there would acknowledge a
    // whisper the model never sees, so the adapter claims no channel for it.
    const active = await session();
    await active.whisper("Wait for a boundary that reads context.");
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
    ).toContain("Wait for a boundary that reads context.");
  });

  it("keeps a whisper pending when the harness never receives it", async () => {
    // The acknowledgement follows the emission. A hook that dies while writing
    // has to leave the whisper pending, because the alternative is a delivery
    // marked delivered that no model ever read.
    const active = await session();
    await active.whisper("Survive a broken pipe.");
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
    ).toContain("Survive a broken pipe.");
  });

  it("says nothing in a directory no project configures", async () => {
    const active = await session();
    await active.whisper("Never leaves the configured project.");
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

  it("sends a whisper only to the session that earned it", async () => {
    // Deliveries are routed, not broadcast. A second Claude Code session in the
    // same project must not receive another session's context.
    const active = await session();
    await active.whisper("Only for the first session.");
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
