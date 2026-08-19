#!/usr/bin/env node
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import {
  brokerLockPath,
  buildFingerprint,
  createBrokerDescriptor,
  descriptorPath,
  findProjectConfig,
  readBrokerDescriptor,
  removeBrokerFiles,
  sendBrokerRequest,
  stateDirectory,
  StateStore,
  writeBrokerDescriptor,
  writeProjectConfig,
  DEFAULT_MODEL,
  type BrokerDescriptor,
  type KnownHarnessId,
} from "../core/index.js";
import { createObserverAgent } from "../agent-runtime/index.js";
import { listAdapters } from "./adapters.js";
import { SubconsciousBroker } from "./broker.js";
import { runHook } from "./hook.js";
import { installAdapter } from "./install.js";
import { createStatusReport, formatStatus, parseStatusArgs } from "./status.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ping(descriptor: BrokerDescriptor): Promise<boolean> {
  try {
    const response = await sendBrokerRequest(descriptor, { type: "ping" }, 500);
    return response.ok && response.type === "pong";
  } catch {
    return false;
  }
}

async function acquireBrokerLock(): Promise<() => Promise<void>> {
  const path = brokerLockPath();
  await mkdir(stateDirectory(), { recursive: true });
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    const fsError = error as NodeJS.ErrnoException;
    if (fsError.code !== "EEXIST") throw error;
    const lockPid = Number.parseInt(
      await readFile(path, "utf8").catch(() => ""),
      10,
    );
    if (Number.isFinite(lockPid) && processExists(lockPid)) {
      throw new Error(
        `The Subconscious broker is already starting or running as PID ${lockPid}.`,
      );
    }
    await rm(path, { force: true });
    handle = await open(path, "wx", 0o600);
  }
  await handle.writeFile(`${process.pid}\n`);
  return async () => {
    await handle.close();
    await rm(path, { force: true });
  };
}

async function serve(): Promise<void> {
  delete process.env.LETTA_BASE_URL;
  const releaseLock = await acquireBrokerLock();
  const old = await readBrokerDescriptor(descriptorPath());
  if (old && !processExists(old.pid))
    await removeBrokerFiles(old, descriptorPath());
  const descriptor = {
    ...createBrokerDescriptor(),
    build: await buildFingerprint(process.argv[1] as string),
  };
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const broker = new SubconsciousBroker({
    descriptor,
    stateDirectory: stateDirectory(),
    apiKey: process.env.LETTA_API_KEY,
    onShutdown: resolveShutdown,
  });
  try {
    await broker.start();
    await writeBrokerDescriptor(descriptorPath(), descriptor);
    const stop = () => resolveShutdown();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await shutdown;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  } finally {
    await broker.close();
    await removeBrokerFiles(descriptor, descriptorPath());
    await releaseLock();
  }
}

async function start(): Promise<void> {
  const existing = await readBrokerDescriptor(descriptorPath());
  if (existing && (await ping(existing))) {
    console.log(
      `Subconscious broker is already running as PID ${existing.pid}.`,
    );
    return;
  }
  const child = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1] as string, "serve"],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    },
  );
  child.unref();
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const descriptor = await readBrokerDescriptor(descriptorPath());
    if (descriptor && (await ping(descriptor))) {
      console.log(`Subconscious broker started as PID ${descriptor.pid}.`);
      return;
    }
  }
  throw new Error("The Subconscious broker did not start within 3 seconds.");
}

async function restart(): Promise<void> {
  await stop();
  await start();
}

/**
 * Wait for a broker process to leave, not for its socket to go quiet.
 *
 * A shutting-down broker closes its listener first and then waits for whatever
 * it already started, so it stops answering long before it exits. It still
 * holds the start-up lock for all of that time. Reading the closed socket as
 * "stopped" is what made `restart` report success and then fail to start,
 * leaving the session with no broker at all.
 */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processExists(pid);
}

async function stop(): Promise<void> {
  const descriptor = await readBrokerDescriptor(descriptorPath());
  if (!descriptor || !(await ping(descriptor))) {
    console.log("Subconscious broker is not running.");
    return;
  }
  await sendBrokerRequest(descriptor, { type: "shutdown" });
  if (!(await waitForExit(descriptor.pid, 30_000))) {
    // The broker only reaches this point with work in flight, because it does
    // not cut a delivery or an observer turn in half. Naming the process is
    // what lets the caller wait for it or end it, rather than being told the
    // broker stopped and then that one is already running.
    throw new Error(
      `The Subconscious broker is still finishing work and has not exited (PID ${descriptor.pid}).`,
    );
  }
  console.log("Subconscious broker stopped.");
}

async function reconcile(args: string[]): Promise<void> {
  const eventId = args[0];
  const retry = args.includes("--retry");
  const discard = args.includes("--discard");
  if (!eventId || retry === discard) {
    fail("Usage: subconscious reconcile <event-id> (--retry | --discard)");
  }
  const descriptor = await readBrokerDescriptor(descriptorPath());
  if (!descriptor || !(await ping(descriptor))) {
    fail("The Subconscious broker is not running.");
  }
  const response = await sendBrokerRequest(
    descriptor,
    {
      type: "reconcile",
      eventId,
      action: retry ? "retry" : "discard",
    },
    10 * 60_000,
  );
  if (!response.ok) fail(response.error);
  if (response.type !== "reconciled")
    fail("The broker returned an invalid reconciliation response.");
  if (response.status === "already_recorded") {
    console.log(
      `Observation ${eventId} already exists in conversation ${response.conversationId}. Inspect it, then run subconscious reconcile ${eventId} --discard to continue.`,
    );
    return;
  }
  console.log(`Observation ${eventId} is ${response.status}.`);
}

async function init(args: string[]): Promise<void> {
  delete process.env.LETTA_BASE_URL;
  const consumed = new Set<number>();
  for (const name of ["--agent", "--model"]) {
    const index = args.indexOf(name);
    if (index >= 0) {
      consumed.add(index);
      consumed.add(index + 1);
    }
  }
  const projectRoot =
    args.find((arg, index) => !consumed.has(index) && !arg.startsWith("--")) ??
    process.cwd();
  if (await findProjectConfig(projectRoot)) {
    fail(`A ${"subconscious.toml"} file already applies to ${projectRoot}.`);
  }
  const apiKey = process.env.LETTA_API_KEY;
  const model = option(args, "--model") ?? DEFAULT_MODEL;
  let agentId = option(args, "--agent");
  if (!agentId) {
    if (!apiKey) fail("Set LETTA_API_KEY or pass --agent <agent-id>.");
    agentId = await createObserverAgent({ apiKey, model });
  }
  const path = await writeProjectConfig(projectRoot, {
    version: 1,
    agentId,
    model,
    delivery: { whispers: true, queueMessages: false },
    observer: {},
  });
  console.log(`Created ${path} for ${agentId}.`);
}

async function status(args: string[]): Promise<void> {
  const options = parseStatusArgs(args);
  const descriptor = await readBrokerDescriptor(descriptorPath());
  const online = Boolean(descriptor && (await ping(descriptor)));
  const project = await findProjectConfig(options.path);
  let state = await new StateStore(stateDirectory()).snapshot();
  if (descriptor && online) {
    const response = await sendBrokerRequest(descriptor, { type: "status" });
    if (response.ok && response.type === "status") state = response.state;
  }
  const context = {
    broker: online ? { online: true, pid: descriptor?.pid } : { online: false },
    requestedPath: options.path,
    project,
    state,
  };
  console.log(
    options.json
      ? JSON.stringify(createStatusReport(context), null, 2)
      : formatStatus(context, { detail: options.detail }),
  );
}

function version(command: string): string | null {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 2_000,
  });
  return result.status === 0
    ? result.stdout.trim() || result.stderr.trim()
    : null;
}

function adapters(): void {
  const versions: Record<string, string | null> = {
    "claude-code": version("claude"),
    codex: version("codex"),
    "letta-code": version("letta"),
  };
  console.log(
    JSON.stringify(
      listAdapters().map((adapter) => ({
        id: adapter.id,
        version: versions[adapter.id],
        capabilities: adapter.capabilities,
      })),
      null,
      2,
    ),
  );
}

function usage(): void {
  console.log(`Usage:
  subconscious init [path] [--agent <id>] [--model <handle>]
  subconscious start|stop|restart|adapters
  subconscious status [path] [--detail | --json]
  subconscious reconcile <event-id> (--retry | --discard)
  subconscious install <claude-code|codex|letta-code> [path]
  subconscious hook <claude-code|codex|letta-code>
`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "serve") return await serve();
  if (command === "start") return await start();
  if (command === "stop") return await stop();
  if (command === "restart") return await restart();
  if (command === "status") return await status(args);
  if (command === "reconcile") return await reconcile(args);
  if (command === "adapters") return adapters();
  if (command === "init") return await init(args);
  if (command === "hook") {
    if (
      !(["claude-code", "codex", "letta-code"] as string[]).includes(
        args[0] ?? "",
      )
    ) {
      fail("hook requires claude-code, codex, or letta-code.");
    }
    try {
      await runHook(args[0] as KnownHarnessId);
    } catch (error) {
      if (process.env.SUBCONSCIOUS_DEBUG === "1") {
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
    return;
  }
  if (command === "install") {
    if (
      !(["claude-code", "codex", "letta-code"] as string[]).includes(
        args[0] ?? "",
      )
    ) {
      fail("install requires claude-code, codex, or letta-code.");
    }
    const harness = args[0] as KnownHarnessId;
    console.log(await installAdapter(harness, args[1]));
    return;
  }
  usage();
}

main().catch((error) =>
  fail(error instanceof Error ? error.message : String(error)),
);
