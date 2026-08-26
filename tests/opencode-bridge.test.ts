import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { RunObservationResult } from "../packages/agent-runtime/index.js";
import { SubconsciousBroker } from "../packages/cli/broker.js";
import {
  OpencodeBridge,
  runOpencodeBridge,
} from "../packages/cli/opencode-bridge.js";
import { OPENCODE_PLUGIN_SOURCE } from "../packages/cli/install-opencode.js";
import {
  createRouteRecord,
  deliveryId,
  sendBrokerRequest,
  writeProjectConfig,
  type BrokerDescriptor,
  type BrokerState,
  type DeliveryRecord,
} from "../packages/core/index.js";

const roots: string[] = [];
const brokers: SubconsciousBroker[] = [];
const pluginInstances: Array<{
  logPath: string;
  hooks: Record<string, unknown> & { dispose?: () => Promise<void> };
}> = [];
const originalPath = process.env.PATH;
const originalBridgeMode = process.env.BRIDGE_MODE;
const originalBridgeLog = process.env.BRIDGE_LOG_PATH;
const originalBridgeState = process.env.BRIDGE_STATE_PATH;

afterEach(async () => {
  const failures: string[] = [];
  for (const instance of pluginInstances.splice(0)) {
    try {
      await instance.hooks.dispose?.();
      const entries = await waitForLogs(
        instance.logPath,
        (logs) =>
          logs.some((entry) => entry.op === "child_exit") ||
          logs.length === 0 ||
          !logs.some(
            (entry) =>
              entry.op === "delivery_window" ||
              entry.op === "info" ||
              entry.op === "observe" ||
              entry.op === "ack",
          ),
      );
      if (
        entries.length > 0 &&
        entries.some(
          (entry) =>
            entry.op === "delivery_window" ||
            entry.op === "info" ||
            entry.op === "observe" ||
            entry.op === "ack",
        ) &&
        !entries.some((entry) => entry.op === "child_exit")
      ) {
        failures.push(
          `plugin cleanup: child did not exit for ${instance.logPath}`,
        );
      }
    } catch (error) {
      failures.push(
        `plugin cleanup: ${error instanceof Error ? error.message : String(error)}`,
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
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalBridgeMode === undefined) delete process.env.BRIDGE_MODE;
  else process.env.BRIDGE_MODE = originalBridgeMode;
  if (originalBridgeLog === undefined) delete process.env.BRIDGE_LOG_PATH;
  else process.env.BRIDGE_LOG_PATH = originalBridgeLog;
  if (originalBridgeState === undefined) delete process.env.BRIDGE_STATE_PATH;
  else process.env.BRIDGE_STATE_PATH = originalBridgeState;
  if (failures.length > 0) {
    throw new Error(`Cleanup failed:\n- ${failures.join("\n- ")}`);
  }
});

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(
    join(tmpdir(), `subconscious-opencode-${prefix}-`),
  );
  roots.push(value);
  return await realpath(value);
}

async function bridgeLogs(
  path: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function waitForLogs(
  path: string,
  predicate: (entries: Array<Record<string, unknown>>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const entries = await bridgeLogs(path);
    if (predicate(entries)) return entries;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

function toolPartUpdated(options: {
  sessionId: string;
  callId: string;
  tool: string;
  status: "completed" | "error";
}) {
  return {
    event: {
      type: "message.part.updated",
      properties: {
        sessionID: options.sessionId,
        part: {
          type: "tool",
          callID: options.callId,
          tool: options.tool,
          state: { status: options.status },
        },
      },
    },
  };
}

async function prepareGeneratedPlugin(options?: {
  mode?: string;
  executableName?: string;
  client?: {
    session: {
      messages: (input: Record<string, unknown>) => Promise<unknown>;
    };
  };
}) {
  const directory = await root("plugin");
  const binDirectory = join(directory, "bin");
  const pluginPath = join(directory, "subconscious.js");
  const logPath = join(directory, "bridge.log");
  const statePath = join(directory, "bridge-state.json");
  const executable = join(
    binDirectory,
    options?.executableName ?? "subconscious",
  );
  await mkdir(binDirectory, { recursive: true });
  await writeFile(pluginPath, OPENCODE_PLUGIN_SOURCE);
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.BRIDGE_MODE || "delivery";
const logPath = process.env.BRIDGE_LOG_PATH;
const statePath = process.env.BRIDGE_STATE_PATH;
function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}
function writeState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state));
}
function log(entry) {
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n");
}
process.on("exit", function () { log({ op: "child_exit" }); });
process.stdin.on("end", function () {
  log({ op: "stdin_end" });
  process.exit(0);
});
if (mode === "epipe") setInterval(function () {}, 1000);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) {
  buffer += chunk;
  var newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    var line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (!line) continue;
    var request = JSON.parse(line);
    log(request);
    var state = readState();
    if (mode === "epipe") {
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, status: null, deliveries: [] }) + "\\n");
      if (state.closed !== true) {
        state.closed = true;
        writeState(state);
        fs.closeSync(0);
      }
      continue;
    }
    if (mode === "false-then-true" && request.op === "info") {
      state.infoCalls = (state.infoCalls || 0) + 1;
      writeState(state);
      if (state.infoCalls === 1) {
        process.stdout.write(JSON.stringify({ id: request.id, ok: true, project: false, midTurn: false }) + "\\n");
        continue;
      }
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, project: true, midTurn: true }) + "\\n");
      continue;
    }
    if (mode === "slow-info-observe" && (request.op === "info" || request.op === "observe")) {
      setTimeout(function () {
        if (request.op === "info") {
          process.stdout.write(JSON.stringify({ id: request.id, ok: true, project: true, midTurn: true }) + "\\n");
          return;
        }
        process.stdout.write(JSON.stringify({ id: request.id, ok: true, accepted: true }) + "\\n");
      }, 300);
      continue;
    }
    if (request.op === "delivery_window") {
      var acked = state.acked === true;
      var known = request.target && request.target.sessionId === "session-1";
      writeState(state);
      process.stdout.write(JSON.stringify({
        id: request.id,
        ok: true,
        status: known && !acked ? { agentId: "agent-observer", conversationId: "conv-observer" } : null,
        deliveries: known && !acked ? [{ id: "delivery-1", text: "Speak now." }] : [],
      }) + "\\n");
      continue;
    }
    if (request.op === "ack") {
      state.acked = true;
      writeState(state);
      process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + "\\n");
      continue;
    }
    if (request.op === "info") {
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, project: true, midTurn: true }) + "\\n");
      continue;
    }
    if (request.op === "observe") {
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, accepted: true }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + "\\n");
  }
});
`,
  );
  await chmod(executable, 0o755);
  process.env.PATH = `${binDirectory}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
  process.env.BRIDGE_MODE = options?.mode ?? "delivery";
  process.env.BRIDGE_LOG_PATH = logPath;
  process.env.BRIDGE_STATE_PATH = statePath;
  const module = await import(
    `${pathToFileURL(pluginPath).href}?t=${Date.now()}`
  );
  const client = options?.client ?? {
    session: {
      messages: async () => ({
        data: [
          {
            info: { id: "m1", role: "assistant" },
            parts: [
              {
                id: "tool-1",
                type: "tool",
                callID: "call-1",
                tool: "Read",
                state: { status: "completed", output: "done" },
              },
            ],
          },
        ],
      }),
    },
  };
  const hooks = (await module.default({ client, directory })) as Record<
    string,
    unknown
  > & { dispose?: () => Promise<void> };
  pluginInstances.push({ hooks, logPath });
  return { hooks, directory, logPath };
}

function socket(directory: string, name: string): BrokerDescriptor {
  return {
    version: 1,
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\subconscious-opencode-${randomUUID()}`
        : join(directory, `${name}.sock`),
    token: "test-token",
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
}

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

async function seedState(
  directory: string,
  sessionId: string,
  deliveryText: string,
): Promise<{ descriptor: BrokerDescriptor; delivery: DeliveryRecord }> {
  await writeProjectConfig(directory, {
    version: 1,
    agentId: "agent-opencode",
    model: "letta/auto",
    delivery: { whispers: true, queueMessages: false },
    observer: { midTurn: { minToolCalls: 1, minSeconds: 0 } },
  });
  const now = new Date().toISOString();
  const route = createRouteRecord(
    {
      configPath: join(directory, "subconscious.toml"),
      projectRoot: directory,
      agentId: "agent-opencode",
      harness: "opencode",
      sessionId,
    },
    now,
  );
  const id = deliveryId("seed", "whisper", "seed");
  const delivery: DeliveryRecord = {
    id,
    routeKey: route.key,
    observationId: "seed",
    kind: "whisper",
    text: deliveryText,
    priority: "normal",
    dedupeKey: "seed",
    status: "pending",
    createdAt: now,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    attempts: 0,
  };
  const state: BrokerState = {
    version: 1,
    routes: { [route.key]: route },
    observations: {},
    observationOrder: [],
    deliveries: { [delivery.id]: delivery },
  };
  await writeFile(
    join(directory, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  );
  const descriptor = socket(directory, "bridge");
  return { descriptor, delivery };
}

describe("opencode bridge", () => {
  it("rejects malformed bridge input lines without crashing the pipe", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      text += chunk;
    });

    const running = runOpencodeBridge(input, output);
    input.write("{not json}\n");
    input.write('{"id":"1","op":"wat"}\n');
    input.end();
    await running;

    expect(
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { id: "", ok: false, error: "Invalid bridge request." },
      { id: "", ok: false, error: "Invalid bridge request." },
    ]);
  });

  it("uses a real broker for delivery windows, acknowledgements, and observations", async () => {
    const directory = await root("broker");
    const { descriptor, delivery } = await seedState(
      directory,
      "session-1",
      "Check the deploy order.",
    );
    const broker = new SubconsciousBroker({
      descriptor,
      stateDirectory: directory,
      runtime: silentObserver,
    });
    brokers.push(broker);
    await broker.start();

    const bridge = new OpencodeBridge();
    (bridge as unknown as { descriptor: BrokerDescriptor | null }).descriptor =
      descriptor;

    const window = await bridge.handle({
      id: "1",
      op: "delivery_window",
      target: {
        harness: "opencode",
        sessionId: "session-1",
        workingDirectory: directory,
      },
    });
    expect(window).toMatchObject({
      id: "1",
      ok: true,
      status: { agentId: "agent-opencode" },
      deliveries: [{ id: delivery.id, text: "Check the deploy order." }],
    });

    expect(
      await bridge.handle({ id: "2", op: "ack", deliveryIds: [delivery.id] }),
    ).toEqual({ id: "2", ok: true });

    const repeated = await bridge.handle({
      id: "3",
      op: "delivery_window",
      target: {
        harness: "opencode",
        sessionId: "session-1",
        workingDirectory: directory,
      },
    });
    expect(repeated).toEqual({
      id: "3",
      ok: true,
      status: null,
      deliveries: [],
    });

    const observed = await bridge.handle({
      id: "4",
      op: "observe",
      event: {
        event: "user_prompt",
        session_id: "session-1",
        cwd: directory,
        prompt_text: "Ship the patch.",
      },
    });
    expect(observed).toEqual({ id: "4", ok: true, accepted: true });

    const status = await sendBrokerRequest(descriptor, { type: "status" });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.type).toBe("status");
    if (status.type !== "status") return;
    expect(Object.values(status.state.observations)).toHaveLength(1);
    expect(Object.values(status.state.observations)[0]?.event).toMatchObject({
      harness: "opencode",
      type: "user_prompt",
      sessionId: "session-1",
    });
  });

  it("runs the generated plugin without dropping existing system entries and only ACKs after a successful append", async () => {
    const { hooks, logPath } = await prepareGeneratedPlugin({
      mode: "delivery",
    });
    const transform = hooks["experimental.chat.system.transform"] as (
      input: Record<string, unknown>,
      output: { system: string[] },
    ) => Promise<void>;

    const failingSystem = ["existing"] as string[];
    failingSystem.push = (() => {
      throw new Error("push failed");
    }) as typeof failingSystem.push;
    await transform({ sessionID: "session-1" }, { system: failingSystem });
    expect((await bridgeLogs(logPath)).map((entry) => entry.op)).toEqual([
      "delivery_window",
    ]);

    const output = { system: ["existing"] };
    await transform({ sessionID: "session-1" }, output);
    expect(output.system).toHaveLength(2);
    expect(output.system[0]).toBe("existing");
    expect(output.system[1]).toContain("<subconscious_whisper ");
    expect(output.system[1]).toContain("Speak now.");
    expect((await bridgeLogs(logPath)).map((entry) => entry.op)).toEqual([
      "delivery_window",
      "delivery_window",
      "ack",
    ]);

    const third = { system: ["keep"] };
    await transform({ sessionID: "session-1" }, third);
    expect(third.system).toEqual(["keep"]);
    expect((await bridgeLogs(logPath)).map((entry) => entry.op)).toEqual([
      "delivery_window",
      "delivery_window",
      "ack",
      "delivery_window",
    ]);

    const isolated = { system: ["base"] };
    await transform({}, isolated);
    expect(isolated.system).toEqual(["base"]);
    expect((await bridgeLogs(logPath)).map((entry) => entry.op)).toEqual([
      "delivery_window",
      "delivery_window",
      "ack",
      "delivery_window",
    ]);
  });

  it("appends one synthetic prompt-context part, observes only the original prompt, and does not redeliver on system transform after ACK", async () => {
    const { hooks, logPath } = await prepareGeneratedPlugin({
      mode: "delivery",
    });
    const chatMessage = hooks["chat.message"] as (
      input: Record<string, unknown>,
      output: {
        parts: Array<Record<string, unknown>>;
        message?: { id?: string };
      },
    ) => Promise<void>;
    const transform = hooks["experimental.chat.system.transform"] as (
      input: Record<string, unknown>,
      output: { system: string[] },
    ) => Promise<void>;

    const output = {
      parts: [{ type: "text", text: "Ship the fix." }],
      message: { id: "msg-out" },
    };
    await chatMessage(
      { sessionID: "session-1", messageID: "message-1" },
      output,
    );

    expect(output.parts).toHaveLength(2);
    expect(output.parts[0]).toEqual({ type: "text", text: "Ship the fix." });
    expect(output.parts[1]).toMatchObject({
      type: "text",
      synthetic: true,
      sessionID: "session-1",
      messageID: "message-1",
    });
    expect(String(output.parts[1]?.text)).toContain("<subconscious_status ");
    expect(String(output.parts[1]?.text)).toContain("<subconscious_whisper ");

    const entries = await bridgeLogs(logPath);
    expect(entries.map((entry) => entry.op)).toEqual([
      "observe",
      "delivery_window",
      "ack",
    ]);
    expect(entries[0]?.event).toMatchObject({
      event: "user_prompt",
      prompt_text: "Ship the fix.",
    });

    const midTurn = { system: ["existing"] };
    await transform({ sessionID: "session-1" }, midTurn);
    expect(midTurn.system).toEqual(["existing"]);
    expect((await bridgeLogs(logPath)).map((entry) => entry.op)).toEqual([
      "observe",
      "delivery_window",
      "ack",
      "delivery_window",
    ]);
  });

  it("re-reads project facts when the bridge flips from false to true", async () => {
    const messageCalls: Array<Record<string, unknown>> = [];
    const { hooks, logPath } = await prepareGeneratedPlugin({
      mode: "false-then-true",
      client: {
        session: {
          messages: async (input) => {
            messageCalls.push(input);
            return {
              data: [
                {
                  info: { id: "m1", role: "assistant" },
                  parts: [
                    { id: "p1", type: "text", text: "after flip" },
                    {
                      id: "tool-1",
                      type: "tool",
                      callID: "call-1",
                      tool: "Read",
                      state: { status: "completed", output: "done" },
                    },
                  ],
                },
              ],
            };
          },
        },
      },
    });
    const eventHook = hooks.event as (
      input: Record<string, unknown>,
    ) => Promise<void>;

    await eventHook({
      event: {
        type: "session.created",
        properties: { info: { id: "session-1", directory: "/project" } },
      },
    });

    await eventHook(
      toolPartUpdated({
        sessionId: "session-1",
        callId: "call-1",
        tool: "Read",
        status: "completed",
      }),
    );
    await waitForLogs(
      logPath,
      (logs) => logs.filter((entry) => entry.op === "info").length === 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await eventHook(
      toolPartUpdated({
        sessionId: "session-1",
        callId: "call-1",
        tool: "Read",
        status: "completed",
      }),
    );

    expect(
      (
        await waitForLogs(
          logPath,
          (logs) => logs.filter((entry) => entry.op === "observe").length === 2,
        )
      ).map((entry) => entry.op),
    ).toEqual(["observe", "info", "info", "observe"]);
    expect(messageCalls).toHaveLength(1);
    expect(messageCalls[0]?.query).toMatchObject({ limit: 120 });
  });

  it("aborts a timed-out snapshot request and leaves no preterminal observation behind", async () => {
    const messageCalls: Array<Record<string, unknown>> = [];
    let aborted = false;
    const { hooks, logPath } = await prepareGeneratedPlugin({
      mode: "delivery",
      client: {
        session: {
          messages: async (input) => {
            messageCalls.push(input);
            const signal = input.signal as AbortSignal;
            return await new Promise((_, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(new Error("aborted"));
                },
                { once: true },
              );
            });
          },
        },
      },
    });
    const eventHook = hooks.event as (
      input: Record<string, unknown>,
    ) => Promise<void>;

    await eventHook(
      toolPartUpdated({
        sessionId: "session-1",
        callId: "call-timeout",
        tool: "Read",
        status: "completed",
      }),
    );

    await waitForLogs(logPath, () => aborted);
    expect(aborted).toBe(true);
    expect(messageCalls[0]?.query).toMatchObject({ limit: 120 });
    const entries = await bridgeLogs(logPath);
    expect(entries.map((entry) => entry.op)).toEqual(["info"]);
  });

  it("ignores late status, prompt, tool, transform, and delete events after one session end", async () => {
    const { hooks, directory, logPath } = await prepareGeneratedPlugin({
      mode: "delivery",
    });
    const eventHook = hooks.event as (
      input: Record<string, unknown>,
    ) => Promise<void>;
    const chatMessage = hooks["chat.message"] as (
      input: Record<string, unknown>,
      output: { parts: Array<Record<string, unknown>>; system?: string[] },
    ) => Promise<void>;
    const transform = hooks["experimental.chat.system.transform"] as (
      input: Record<string, unknown>,
      output: { system: string[] },
    ) => Promise<void>;

    await eventHook({
      event: {
        type: "session.created",
        properties: { info: { id: "session-1", directory } },
      },
    });
    await eventHook({
      event: {
        type: "session.deleted",
        properties: { info: { id: "session-1", directory } },
      },
    });
    await eventHook({
      event: {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "busy" } },
      },
    });
    await eventHook({
      event: {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "idle" } },
      },
    });
    await chatMessage(
      { sessionID: "session-1", messageID: "late-message" },
      { parts: [{ type: "text", text: "late prompt" }] },
    );
    await eventHook(
      toolPartUpdated({
        sessionId: "session-1",
        callId: "late-call",
        tool: "Read",
        status: "completed",
      }),
    );
    const output = { system: ["keep"] };
    await transform({ sessionID: "session-1" }, output);
    await eventHook({
      event: {
        type: "session.deleted",
        properties: { info: { id: "session-1", directory } },
      },
    });
    await eventHook({
      event: { type: "server.instance.disposed", properties: {} },
    });

    expect(output.system).toEqual(["keep"]);
    const observed = (await bridgeLogs(logPath))
      .filter((entry) => entry.op === "observe")
      .map((entry) => entry.event);
    expect(observed).toEqual([
      { event: "session_created", session_id: "session-1", cwd: directory },
      { event: "session_end", session_id: "session-1", cwd: directory },
    ]);
  });

  it("gives empty or failed turn_stop observations a distinct per-turn identity while repeated idle still deduplicates", async () => {
    const { hooks, directory, logPath } = await prepareGeneratedPlugin({
      mode: "delivery",
      client: {
        session: {
          messages: async () => ({ error: "session messages unavailable" }),
        },
      },
    });
    const eventHook = hooks.event as (
      input: Record<string, unknown>,
    ) => Promise<void>;

    await eventHook({
      event: {
        type: "session.created",
        properties: { info: { id: "session-1", directory } },
      },
    });
    await eventHook({
      event: {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "busy" } },
      },
    });
    await eventHook({
      event: {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "idle" } },
      },
    });
    await eventHook({
      event: {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "idle" } },
      },
    });
    await eventHook({
      event: {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "busy" } },
      },
    });
    await eventHook({
      event: {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "idle" } },
      },
    });

    const turns = (await bridgeLogs(logPath))
      .filter(
        (entry) =>
          entry.op === "observe" &&
          (entry.event as Record<string, unknown>).event === "turn_stop",
      )
      .map((entry) => entry.event as Record<string, unknown>);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.snapshot).toEqual({
      messages: [],
      snapshot_error: "session messages unavailable",
    });
    expect(turns[1]?.snapshot).toEqual({
      messages: [],
      snapshot_error: "session messages unavailable",
    });
    expect(turns[0]?.turn_sequence).toBe(1);
    expect(turns[1]?.turn_sequence).toBe(2);
    expect(turns[0]?.turn_id).not.toBe(turns[1]?.turn_id);
  });

  it("returns from terminal part updates promptly while the bounded observation work continues in the background", async () => {
    const { hooks, logPath } = await prepareGeneratedPlugin({
      mode: "slow-info-observe",
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                info: { id: "m1", role: "assistant" },
                parts: [
                  {
                    id: "tool-1",
                    type: "tool",
                    callID: "call-1",
                    tool: "Read",
                    state: { status: "completed", output: "done" },
                  },
                ],
              },
            ],
          }),
        },
      },
    });
    const eventHook = hooks.event as (
      input: Record<string, unknown>,
    ) => Promise<void>;
    const dispose = hooks.dispose as () => Promise<void>;

    const started = Date.now();
    await eventHook(
      toolPartUpdated({
        sessionId: "session-1",
        callId: "call-1",
        tool: "Read",
        status: "completed",
      }),
    );
    expect(Date.now() - started).toBeLessThan(150);
    expect(await bridgeLogs(logPath)).toEqual([]);
    await dispose();
    const logs = await bridgeLogs(logPath);
    expect(logs.map((entry) => entry.op)).toEqual([
      "info",
      "observe",
      "observe",
      "stdin_end",
      "child_exit",
    ]);
    expect(
      logs
        .filter((entry) => entry.op === "observe")
        .map((entry) => (entry.event as Record<string, unknown>).event),
    ).toEqual(["tool_result", "session_end"]);
  });

  it("dispatches the full OpenCode lifecycle without duplicate stop or end events and closes the child on idempotent disposal", async () => {
    const messageCalls: Array<Record<string, unknown>> = [];
    const { hooks, directory, logPath } = await prepareGeneratedPlugin({
      mode: "delivery",
      client: {
        session: {
          messages: async (input) => {
            messageCalls.push(input);
            return {
              data: [
                {
                  info: { id: "m1", role: "assistant" },
                  parts: [
                    { id: "p1", type: "text", text: "assistant text" },
                    {
                      id: "tool-1",
                      type: "tool",
                      callID: "call-1",
                      tool: "Read",
                      state: { status: "completed", output: "done" },
                    },
                  ],
                },
              ],
            };
          },
        },
      },
    });
    const eventHook = hooks.event as (
      input: Record<string, unknown>,
    ) => Promise<void>;
    const chatMessage = hooks["chat.message"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) => Promise<void>;
    const afterTool = hooks["tool.execute.after"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) => Promise<void>;
    const dispose = hooks.dispose as () => Promise<void>;

    await eventHook({
      event: {
        type: "session.created",
        properties: { info: { id: "session-1", directory } },
      },
    });
    await chatMessage(
      { sessionID: "session-1", messageID: "message-1" },
      {
        parts: [{ type: "text", text: "Ship the fix." }],
        message: { id: "message-out" },
      },
    );
    await afterTool(
      { sessionID: "session-1", callID: "call-1", tool: "Read" },
      {},
    );
    await eventHook(
      toolPartUpdated({
        sessionId: "session-1",
        callId: "call-1",
        tool: "Read",
        status: "completed",
      }),
    );
    await waitForLogs(logPath, (logs) =>
      logs.some(
        (entry) =>
          entry.op === "observe" &&
          (entry.event as Record<string, unknown>).event === "tool_result",
      ),
    );
    await eventHook({
      event: {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "busy" } },
      },
    });
    await eventHook({
      event: {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "idle" } },
      },
    });
    await eventHook({
      event: {
        type: "session.status",
        properties: { sessionID: "session-1", status: { type: "idle" } },
      },
    });
    await eventHook({
      event: {
        type: "session.created",
        properties: {
          info: { id: "child-1", directory: join(directory, "child") },
        },
      },
    });
    await eventHook({
      event: {
        type: "session.deleted",
        properties: { info: { id: "session-1", directory } },
      },
    });
    await eventHook({
      event: { type: "server.instance.disposed", properties: {} },
    });
    await dispose();
    await dispose();

    const entries = await waitForLogs(logPath, (logs) =>
      logs.some((entry) => entry.op === "child_exit"),
    );
    const observed = entries
      .filter((entry) => entry.op === "observe")
      .map((entry) => entry.event);
    expect(observed).toEqual([
      { event: "session_created", session_id: "session-1", cwd: directory },
      {
        event: "user_prompt",
        session_id: "session-1",
        cwd: directory,
        message_id: "message-1",
        prompt_text: "Ship the fix.",
      },
      {
        event: "tool_result",
        session_id: "session-1",
        cwd: directory,
        call_id: "call-1",
        tool: "Read",
        snapshot: {
          messages: [
            {
              info: { id: "m1", role: "assistant" },
              parts: [
                { id: "p1", type: "text", text: "assistant text" },
                {
                  id: "tool-1",
                  type: "tool",
                  callID: "call-1",
                  tool: "Read",
                  state: { status: "completed", output: "done" },
                },
              ],
            },
          ],
        },
      },
      {
        event: "turn_stop",
        session_id: "session-1",
        cwd: directory,
        turn_id: "m1",
        turn_sequence: 1,
        snapshot: {
          messages: [
            {
              info: { id: "m1", role: "assistant" },
              parts: [
                { id: "p1", type: "text", text: "assistant text" },
                {
                  id: "tool-1",
                  type: "tool",
                  callID: "call-1",
                  tool: "Read",
                  state: { status: "completed", output: "done" },
                },
              ],
            },
          ],
        },
      },
      {
        event: "session_created",
        session_id: "child-1",
        cwd: join(directory, "child"),
      },
      { event: "session_end", session_id: "session-1", cwd: directory },
      {
        event: "session_end",
        session_id: "child-1",
        cwd: join(directory, "child"),
      },
    ]);
    expect(messageCalls).toHaveLength(2);
    for (const call of messageCalls) {
      expect(call.query).toMatchObject({ limit: 120, directory });
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
    expect(entries.filter((entry) => entry.op === "stdin_end")).toHaveLength(1);
    expect(entries.filter((entry) => entry.op === "child_exit")).toHaveLength(
      1,
    );
    expect(
      entries.filter(
        (entry) =>
          entry.op === "observe" &&
          (entry.event as Record<string, unknown>).event === "session_end",
      ),
    ).toHaveLength(2);
  });

  it("keeps prompt and transform delivery isolated to the target session", async () => {
    const { hooks, logPath } = await prepareGeneratedPlugin({
      mode: "delivery",
    });
    const chatMessage = hooks["chat.message"] as (
      input: Record<string, unknown>,
      output: {
        parts: Array<Record<string, unknown>>;
        message?: { id?: string };
      },
    ) => Promise<void>;
    const transform = hooks["experimental.chat.system.transform"] as (
      input: Record<string, unknown>,
      output: { system: string[] },
    ) => Promise<void>;

    const wrong = { parts: [{ type: "text", text: "Other prompt." }] };
    await chatMessage({ sessionID: "session-2", messageID: "other-1" }, wrong);
    expect(wrong.parts).toEqual([{ type: "text", text: "Other prompt." }]);

    const missing = { system: ["keep"] };
    await transform({}, missing);
    expect(missing.system).toEqual(["keep"]);

    const wrongTransform = { system: ["keep"] };
    await transform({ sessionID: "session-2" }, wrongTransform);
    expect(wrongTransform.system).toEqual(["keep"]);

    expect((await bridgeLogs(logPath)).map((entry) => entry.op)).toEqual([
      "observe",
      "delivery_window",
      "delivery_window",
    ]);
  });

  it("keeps tool.execute.after observation-free and deduplicates repeated terminal part updates", async () => {
    const { hooks, logPath } = await prepareGeneratedPlugin({
      mode: "delivery",
    });
    const afterTool = hooks["tool.execute.after"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) => Promise<void>;
    const eventHook = hooks.event as (
      input: Record<string, unknown>,
    ) => Promise<void>;

    await afterTool(
      { sessionID: "session-1", callID: "call-1", tool: "Read" },
      {},
    );
    expect(await bridgeLogs(logPath)).toEqual([]);

    await eventHook(
      toolPartUpdated({
        sessionId: "session-1",
        callId: "call-1",
        tool: "Read",
        status: "completed",
      }),
    );
    await eventHook(
      toolPartUpdated({
        sessionId: "session-1",
        callId: "call-1",
        tool: "Read",
        status: "completed",
      }),
    );

    expect(
      (
        await waitForLogs(
          logPath,
          (logs) => logs.filter((entry) => entry.op === "observe").length === 1,
        )
      ).map((entry) => entry.op),
    ).toEqual(["info", "observe"]);
  });

  it("guards current-child state so stale child events cannot tear down a replacement child", () => {
    expect(OPENCODE_PLUGIN_SOURCE).toContain(
      "if (self.child !== child) return;",
    );
  });

  it("handles generated bridge stdin EPIPE through explicit error and write-callback paths", () => {
    expect(OPENCODE_PLUGIN_SOURCE).toContain("child.stdin.on('error'");
    expect(OPENCODE_PLUGIN_SOURCE).toContain("child.stdin.on('close'");
    expect(OPENCODE_PLUGIN_SOURCE).toContain(
      "child.stdin.write(JSON.stringify(Object.assign({ id: id }, payload)) + '\\n', function (error) {",
    );
    expect(OPENCODE_PLUGIN_SOURCE).toContain("if (error) settle(null);");
  });
});
