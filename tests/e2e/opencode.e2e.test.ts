import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RunObservationResult } from "../../packages/agent-runtime/index.js";
import { installOpencode } from "../../packages/cli/install-opencode.js";
import { SubconsciousBroker } from "../../packages/cli/broker.js";
import {
  buildFingerprint,
  createRouteRecord,
  deliveryId,
  routeKey,
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
const OPENCODE_VERSION = "1.18.23";
const OPENCODE_MODEL = "opencode/mimo-v2.5-free";
const OUTPUT_TAIL_BYTES = 200_000;
const roots: string[] = [];
const brokers: SubconsciousBroker[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];
const preparedTexts: string[] = [];

interface FixtureRuntime {
  run(input: unknown): Promise<RunObservationResult>;
}

const silentObserver = {
  run: async (input: {
    prepared: { text: string };
  }): Promise<RunObservationResult> => {
    preparedTexts.push(input.prepared.text);
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

interface OwnedChild {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  wait(): Promise<number | null>;
  close(): Promise<void>;
}

interface ExportedMessage {
  info?: Record<string, unknown>;
  parts?: Array<Record<string, unknown>>;
}

interface ExportedSession {
  info: Record<string, unknown>;
  messages: ExportedMessage[];
}

interface Fixture {
  root: string;
  project: string;
  home: string;
  subconsciousHome: string;
  bin: string;
  bridgeLog: string;
  env: NodeJS.ProcessEnv;
  descriptor: BrokerDescriptor;
  serverUrl: string;
  server: OwnedChild;
  runtime: FixtureRuntime;
}

afterEach(async () => {
  const failures: string[] = [];
  preparedTexts.splice(0);
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
  for (const server of servers.splice(0)) {
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      failures.push(
        `server cleanup: ${error instanceof Error ? error.message : String(error)}`,
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
  const value = await mkdtemp(`/tmp/subconscious-opencode-e2e-${prefix}-`);
  roots.push(value);
  return value;
}

function trimTail(text: string): string {
  return text.slice(-OUTPUT_TAIL_BYTES);
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
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
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
    },
  };
}

async function openPort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine an OpenCode test port."));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function exactEnvironment(paths: {
  home: string;
  config: string;
  data: string;
  cache: string;
  state: string;
  tmp: string;
  subconsciousHome: string;
  bin: string;
}): NodeJS.ProcessEnv {
  return {
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    XDG_CACHE_HOME: paths.cache,
    XDG_STATE_HOME: paths.state,
    TMPDIR: paths.tmp,
    SUBCONSCIOUS_HOME: paths.subconsciousHome,
    PATH: `${paths.bin}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    NO_COLOR: "1",
  };
}

async function startBroker(
  subconsciousHome: string,
  descriptor: BrokerDescriptor,
  runtime: FixtureRuntime,
): Promise<SubconsciousBroker> {
  const broker = new SubconsciousBroker({
    descriptor,
    stateDirectory: subconsciousHome,
    runtime,
  });
  brokers.push(broker);
  await broker.start();
  await writeBrokerDescriptor(
    join(subconsciousHome, "broker.json"),
    descriptor,
  );
  return broker;
}

async function fixture(
  runtime: FixtureRuntime = silentObserver,
): Promise<Fixture> {
  const rootDir = await root("fixture");
  const project = join(rootDir, "project");
  const home = join(rootDir, "home");
  const subconsciousHome = join(rootDir, "subconscious-home");
  const bin = join(rootDir, "bin");
  const config = join(rootDir, "config");
  const data = join(rootDir, "data");
  const cache = join(rootDir, "cache");
  const state = join(rootDir, "state");
  const tmp = join(rootDir, "tmp");
  const bridgeLog = join(rootDir, "bridge.jsonl");
  for (const path of [
    project,
    home,
    subconsciousHome,
    bin,
    config,
    data,
    cache,
    state,
    tmp,
  ]) {
    await mkdir(path, { recursive: true });
  }
  await writeProjectConfig(project, {
    version: 1,
    agentId: "agent-opencode-e2e",
    delivery: { whispers: true, queueMessages: false },
    observer: { midTurn: { minToolCalls: 1, minSeconds: 0 } },
  });
  await installOpencode(project);
  await writeFile(
    join(bin, "subconscious"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const brokerEntry = ${JSON.stringify(brokerEntry)};
const bridgeLog = ${JSON.stringify(bridgeLog)};
const args = process.argv.slice(2);
const bridgeMode = args[0] === "opencode-bridge";
const child = spawn(process.execPath, [brokerEntry, ...args], {
  stdio: bridgeMode ? ["pipe", "pipe", "inherit"] : "inherit",
  env: process.env,
});
function append(entry) {
  fs.appendFileSync(bridgeLog, JSON.stringify(entry) + "\\n");
}
if (!bridgeMode) {
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    let newline = input.indexOf("\\n");
    while (newline >= 0) {
      const line = input.slice(0, newline).trim();
      input = input.slice(newline + 1);
      newline = input.indexOf("\\n");
      if (line) append({ direction: "in", line });
    }
    child.stdin.write(chunk);
  });
  process.stdin.on("end", () => child.stdin.end());
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    for (const line of text.split("\\n")) {
      const trimmed = line.trim();
      if (trimmed) append({ direction: "out", line: trimmed });
    }
    process.stdout.write(chunk);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}
`,
    { mode: 0o755 },
  );
  const env = exactEnvironment({
    home,
    config,
    data,
    cache,
    state,
    tmp,
    subconsciousHome,
    bin,
  });
  const descriptor: BrokerDescriptor = {
    version: 1,
    endpoint:
      process.platform === "win32"
        ? `\\.\pipe\subconscious-opencode-e2e-${randomUUID()}`
        : join(subconsciousHome, "broker.sock"),
    token: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    build: await buildFingerprint(brokerEntry),
  };
  await startBroker(subconsciousHome, descriptor, runtime);
  const port = await openPort();
  const server = trackChild(
    spawn(
      "opencode",
      ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  await poll(
    async () => server.stdout.includes(`http://127.0.0.1:${port}`),
    120_000,
    () => `server stdout=${server.stdout}\nserver stderr=${server.stderr}`,
  );
  return {
    root: rootDir,
    project,
    home,
    subconsciousHome,
    bin,
    bridgeLog,
    env,
    descriptor,
    serverUrl: `http://127.0.0.1:${port}`,
    server,
    runtime,
  };
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

function parseSessionId(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { sessionID?: unknown };
      if (typeof parsed.sessionID === "string" && parsed.sessionID.length > 0) {
        return parsed.sessionID;
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }
  throw new Error(`No sessionID found in OpenCode output:\n${output}`);
}

function parseExport(text: string): ExportedSession {
  for (
    let start = text.indexOf("{");
    start >= 0;
    start = text.indexOf("{", start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(
              text.slice(start, index + 1),
            ) as Partial<ExportedSession>;
            if (Array.isArray(parsed.messages) && parsed.info) {
              return parsed as ExportedSession;
            }
          } catch {
            // Keep scanning later objects.
          }
          break;
        }
      }
    }
  }
  throw new Error(
    `OpenCode export did not contain a session payload:\n${text}`,
  );
}

function textParts(message: ExportedMessage): string[] {
  return (message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text));
}

function assistantTexts(exported: ExportedSession): string[] {
  return exported.messages
    .filter((message) => message.info?.role === "assistant")
    .flatMap(textParts)
    .map((text) => text.trim())
    .filter(Boolean);
}

function terminalToolParts(
  exported: ExportedSession,
): Array<Record<string, unknown>> {
  return exported.messages.flatMap((message) =>
    (message.parts ?? []).filter((part) => {
      const state = part.state as Record<string, unknown> | undefined;
      return (
        part.type === "tool" &&
        (state?.status === "completed" || state?.status === "error")
      );
    }),
  );
}

async function exportSession(
  active: Fixture,
  sessionId: string,
): Promise<ExportedSession> {
  const result = await runCommand("opencode", ["export", sessionId], {
    cwd: active.project,
    env: active.env,
  });
  if (result.code !== 0) {
    throw new Error(
      `opencode export failed (${result.code}).\n${result.stdout}\n${result.stderr}`,
    );
  }
  return parseExport(result.stdout);
}

async function bridgeEntries(
  active: Fixture,
): Promise<Array<Record<string, unknown>>> {
  try {
    return (await readFile(active.bridgeLog, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function runTurn(
  active: Fixture,
  prompt: string,
  sessionId?: string,
): Promise<{ sessionId: string; stdout: string; stderr: string }> {
  const args = [
    "run",
    "--attach",
    active.serverUrl,
    "--dir",
    active.project,
    "--model",
    OPENCODE_MODEL,
    "--format",
    "json",
    "--auto",
    ...(sessionId ? ["--session", sessionId] : []),
    prompt,
  ];
  const result = await runCommand("opencode", args, {
    cwd: active.project,
    env: active.env,
  });
  if (result.code !== 0) {
    throw new Error(
      `opencode run failed (${result.code}).\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return {
    sessionId: parseSessionId(result.stdout),
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

function routeIdentity(active: Fixture, sessionId: string) {
  return {
    configPath: join(active.project, "subconscious.toml"),
    projectRoot: active.project,
    agentId: "agent-opencode-e2e",
    harness: "opencode" as const,
    sessionId,
  };
}

function routeKeyForSession(
  state: BrokerState,
  sessionId: string,
): string | null {
  for (const [key, route] of Object.entries(state.routes)) {
    if (route.harness === "opencode" && route.sessionId === sessionId)
      return key;
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
              routes: Object.values(last.state.routes).map((route) => ({
                harness: route.harness,
                sessionId: route.sessionId,
              })),
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
    id: deliveryId("seed-opencode", "whisper", `canary-${canary}`),
    routeKey: routeKeyValue,
    observationId: "seed-opencode",
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
  await startBroker(active.subconsciousHome, active.descriptor, active.runtime);
  return delivery.id;
}

function whisperingObserver(canary: string) {
  let seeded = false;
  return {
    run: async (input: {
      event: { id: string; sessionId: string; type: HarnessEventType };
      route: { key: string };
      prepared: { text: string };
      persistDelivery(delivery: DeliveryRecord): Promise<void>;
    }): Promise<RunObservationResult> => {
      preparedTexts.push(input.prepared.text);
      if (
        !seeded &&
        input.event.type === "tool_result" &&
        input.prepared.text.includes("[OpenCode tool call: bash]") &&
        input.prepared.text.includes("SUBCONSCIOUS_E2E_TOOL_OK")
      ) {
        seeded = true;
        await input.persistDelivery({
          id: deliveryId(input.event.id, "whisper", `midturn-${canary}`),
          routeKey: input.route.key,
          observationId: input.event.id,
          kind: "whisper",
          text: canary,
          priority: "normal",
          dedupeKey: `midturn-${canary}`,
          status: "pending",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
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
        effectiveModel: null,
      };
    },
  };
}

beforeAll(async () => {
  if (process.env.SUBCONSCIOUS_OPENCODE_LIVE !== "1") return;
  await access(brokerEntry).catch(() => {
    throw new Error(
      `No broker build at ${brokerEntry}. Run npm run build first.`,
    );
  });
  const version = await runCommand("opencode", ["--version"], {
    cwd: repoRoot,
    env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  if (version.code !== 0) {
    throw new Error(
      `opencode --version failed (${version.code}).\n${version.stdout}\n${version.stderr}`,
    );
  }
  expect(version.stdout.trim()).toBe(OPENCODE_VERSION);

  const models = await runCommand("opencode", ["models", "opencode"], {
    cwd: repoRoot,
    env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  if (models.code !== 0) {
    throw new Error(
      `opencode models opencode failed (${models.code}).\n${models.stdout}\n${models.stderr}`,
    );
  }
  expect(models.stdout.split("\n").map((line) => line.trim())).toContain(
    OPENCODE_MODEL,
  );
});

const liveDescribe =
  process.env.SUBCONSCIOUS_OPENCODE_LIVE === "1" ? describe : describe.skip;

liveDescribe("OpenCode live end-to-end", () => {
  it(
    "observes a real tool turn and then delivers one seeded whisper only into the same session",
    { timeout: 480_000 },
    async () => {
      const active = await fixture();
      const prompt =
        "Use exactly one Bash tool call with command: printf SUBCONSCIOUS_E2E_TOOL_OK. Use no other tools. At every step of this run, inspect the full context available to you, including system messages. If you ever see any <subconscious_whisper ...>TEXT</subconscious_whisper> block at any point in this run, remember exactly TEXT. After the required bash tool call, reply with exactly that remembered TEXT and nothing else. If you never see such a block at any point in this run, reply with exactly BASELINE and nothing else.";
      const canary = `CNY-${randomUUID().replaceAll("-", "").slice(0, 16)}`;

      const first = await runTurn(active, prompt);
      const sessionId = first.sessionId;
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
        firstObserved.state.routes[routeKeyValue!]?.sourceCursor?.marker,
      ).toBeTruthy();

      const firstExport = await exportSession(active, sessionId);
      expect(firstExport.info.version).toBe(OPENCODE_VERSION);
      expect(firstExport.info.model).toMatchObject({
        providerID: "opencode",
        id: "mimo-v2.5-free",
      });
      expect(assistantTexts(firstExport)).toContain("BASELINE");
      const firstTools = terminalToolParts(firstExport);
      expect(firstTools).toHaveLength(1);
      expect(firstTools[0]).toMatchObject({
        tool: "bash",
        state: {
          status: "completed",
          output: "SUBCONSCIOUS_E2E_TOOL_OK",
          input: { command: "printf SUBCONSCIOUS_E2E_TOOL_OK" },
        },
      });
      expect(JSON.stringify(firstExport)).not.toContain(canary);

      await sendBrokerRequest(active.descriptor, {
        type: "claim_session_status",
        target: {
          harness: "opencode",
          sessionId,
          workingDirectory: active.project,
        },
      });

      const deliveryIdSeeded = await seedPendingWhisper(
        active,
        routeKeyValue!,
        canary,
      );
      const preparedBeforeB = preparedTexts.length;
      const other = await runTurn(active, prompt);
      expect(other.sessionId).not.toBe(sessionId);
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
      const otherExport = await exportSession(active, other.sessionId);
      expect(assistantTexts(otherExport).at(-1)).toBe("BASELINE");
      const stateAfterB = await brokerState(active);
      expect(stateAfterB.deliveries[deliveryIdSeeded]?.status).toBe("pending");
      expect(
        stateAfterB.deliveries[deliveryIdSeeded]?.acknowledgedAt,
      ).toBeUndefined();
      expect(routeKeyForSession(stateAfterB, other.sessionId)).toBeTruthy();
      expect(routeKeyForSession(stateAfterB, other.sessionId)).not.toBe(
        routeKeyValue,
      );
      expect(otherObserved.key).not.toBe(routeKeyValue);
      expect(JSON.stringify(otherExport)).not.toContain(canary);
      expect(
        preparedTexts
          .slice(preparedBeforeB)
          .some((text) => text.includes(canary)),
      ).toBe(false);

      const second = await runTurn(active, prompt, sessionId);
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
                record.type === "tool_result" && record.status === "processed",
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

      const secondExport = await exportSession(active, sessionId);
      const outputs = assistantTexts(secondExport);
      if (outputs.at(-1) !== canary) {
        throw new Error(
          [
            `Expected final assistant text ${canary} but received ${outputs.at(-1) ?? "<none>"}.`,
            `Delivery state: ${JSON.stringify(secondState.deliveries[deliveryIdSeeded])}`,
            `Bridge log tail: ${JSON.stringify((await bridgeEntries(active)).slice(-20), null, 2)}`,
            `Second export tail: ${JSON.stringify(secondExport.messages.slice(-2), null, 2)}`,
          ].join("\n"),
        );
      }
      expect(outputs.at(-1)).toBe(canary);
      expect(outputs.filter((text) => text === "BASELINE")).toHaveLength(1);
      expect(outputs.filter((text) => text === canary)).toHaveLength(1);
      expect(
        preparedTexts.some((text) =>
          text.startsWith("OpenCode user prompt:\n"),
        ),
      ).toBe(true);
      expect(
        preparedTexts.some(
          (text) =>
            text.includes("[OpenCode tool call: bash]") &&
            text.includes("SUBCONSCIOUS_E2E_TOOL_OK"),
        ),
      ).toBe(true);
      expect(
        preparedTexts.some((text) => text.includes("OpenCode:\nBASELINE")),
      ).toBe(true);
      expect(
        preparedTexts.some((text) => text.includes(`OpenCode:\n${canary}`)),
      ).toBe(true);
      const allUserText = secondExport.messages
        .filter((message) => message.info?.role === "user")
        .flatMap((message) =>
          (message.parts ?? [])
            .filter(
              (part) =>
                part.type === "text" &&
                part.synthetic !== true &&
                typeof part.text === "string",
            )
            .map((part) => String(part.text)),
        )
        .join("\n");
      expect(allUserText).not.toContain(canary);
      const allToolText = JSON.stringify(terminalToolParts(secondExport));
      expect(allToolText).not.toContain(canary);
      const otherUserText = otherExport.messages
        .filter((message) => message.info?.role === "user")
        .flatMap((message) => textParts(message))
        .join("\n");
      expect(otherUserText).not.toContain(canary);
      const syntheticUserParts = secondExport.messages
        .filter((message) => message.info?.role === "user")
        .flatMap((message) => message.parts ?? [])
        .filter(
          (part) =>
            part.type === "text" &&
            part.synthetic === true &&
            typeof part.text === "string" &&
            String(part.text).includes(canary),
        );
      expect(syntheticUserParts).toHaveLength(1);
      const otherSyntheticCanary = otherExport.messages
        .filter((message) => message.info?.role === "user")
        .flatMap((message) => message.parts ?? [])
        .filter(
          (part) =>
            part.type === "text" &&
            part.synthetic === true &&
            typeof part.text === "string" &&
            String(part.text).includes(canary),
        );
      expect(otherSyntheticCanary).toHaveLength(0);
    },
  );

  it(
    "delivers a mid-turn whisper through experimental.chat.system.transform only after the real terminal bash observation",
    { timeout: 480_000 },
    async () => {
      const canary = `MID-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const active = await fixture(whisperingObserver(canary));
      const prompt =
        "Use exactly one Bash tool call with command: printf SUBCONSCIOUS_E2E_TOOL_OK. Use no other tools. After the tool call completes, inspect the full context available to you, including system messages. If you can see any <subconscious_whisper ...>TEXT</subconscious_whisper> block at that point, reply with exactly TEXT and nothing else. Otherwise reply with exactly BASELINE and nothing else.";

      const firstPreparedIndex = preparedTexts.length;
      const first = await runTurn(active, prompt);
      const sessionId = first.sessionId;
      const firstObserved = await waitForObservationSet(active, sessionId, {
        session_start: 1,
        user_prompt: 1,
        tool_result: 1,
        turn_stop: 1,
      });
      const routeKeyValue = firstObserved.key;
      expect(routeKeyValue).toBeTruthy();

      const firstExport = await exportSession(active, sessionId);
      expect(assistantTexts(firstExport).at(-1)).toBe(canary);
      const firstTools = terminalToolParts(firstExport);
      expect(firstTools).toHaveLength(1);
      expect(firstTools[0]).toMatchObject({
        tool: "bash",
        state: {
          status: "completed",
          output: "SUBCONSCIOUS_E2E_TOOL_OK",
          input: { command: "printf SUBCONSCIOUS_E2E_TOOL_OK" },
        },
      });

      const firstPrepared = preparedTexts.slice(firstPreparedIndex);
      expect(
        firstPrepared.some(
          (text) =>
            text.includes("[OpenCode tool call: bash]") &&
            text.includes("SUBCONSCIOUS_E2E_TOOL_OK"),
        ),
      ).toBe(true);
      expect(
        firstPrepared.some((text) => text.includes(`OpenCode:\n${canary}`)),
      ).toBe(true);

      const stateAfterA = await poll(
        async () => await brokerState(active),
        120_000,
        () => `broker state for ${sessionId}`,
        (state) =>
          Object.values(state.deliveries).some(
            (delivery) =>
              delivery.routeKey === routeKeyValue &&
              delivery.text === canary &&
              delivery.status === "delivered" &&
              Boolean(delivery.acknowledgedAt),
          ),
      );
      const canaryDelivery = Object.values(stateAfterA.deliveries).find(
        (delivery) =>
          delivery.routeKey === routeKeyValue && delivery.text === canary,
      );
      expect(canaryDelivery).toBeDefined();
      expect(canaryDelivery?.status).toBe("delivered");
      expect(canaryDelivery?.acknowledgedAt).toBeTruthy();

      const logs = await bridgeEntries(active);
      const parsedBridge = logs
        .filter(
          (entry) =>
            entry.direction === "out" && typeof entry.line === "string",
        )
        .map((entry) => {
          try {
            return JSON.parse(String(entry.line)) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is Record<string, unknown> => Boolean(entry));
      const windows = parsedBridge.filter((entry) => "deliveries" in entry);
      expect(windows.length).toBeGreaterThanOrEqual(2);
      expect(windows[0]?.deliveries).toEqual([]);
      expect(JSON.stringify(windows.slice(1))).toContain(canary);

      const otherPreparedIndex = preparedTexts.length;
      const other = await runTurn(active, prompt);
      expect(other.sessionId).not.toBe(sessionId);
      await waitForObservationSet(active, other.sessionId, {
        session_start: 1,
        user_prompt: 1,
        tool_result: 1,
        turn_stop: 1,
      });
      const otherExport = await exportSession(active, other.sessionId);
      expect(assistantTexts(otherExport).at(-1)).toBe("BASELINE");
      expect(JSON.stringify(otherExport)).not.toContain(canary);
      expect(
        preparedTexts
          .slice(otherPreparedIndex)
          .some((text) => text.includes(canary)),
      ).toBe(false);
      expect(
        routeKeyForSession(await brokerState(active), other.sessionId),
      ).not.toBe(routeKeyValue);

      const nonSyntheticPromptText = firstExport.messages
        .filter((message) => message.info?.role === "user")
        .flatMap((message) =>
          (message.parts ?? [])
            .filter(
              (part) =>
                part.type === "text" &&
                part.synthetic !== true &&
                typeof part.text === "string",
            )
            .map((part) => String(part.text)),
        )
        .join("\n");
      expect(nonSyntheticPromptText).not.toContain(canary);
      expect(JSON.stringify(firstTools)).not.toContain(canary);
    },
  );
});
