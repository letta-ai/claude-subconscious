import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import {
  AgentRuntime,
  type RunObservationResult,
} from "../../packages/agent-runtime/index.js";
import { lettaSessionRouteId } from "../../packages/adapter-letta-code/index.js";
import { installAdapter } from "../../packages/cli/install.js";
import {
  SubconsciousBroker,
  type BrokerRuntime,
} from "../../packages/cli/broker.js";
import {
  buildFingerprint,
  deliveryId,
  routeKey,
  sendBrokerRequest,
  writeBrokerDescriptor,
  writeProjectConfig,
  type BrokerDescriptor,
  type BrokerState,
  type DeliveryRecord,
  type RouteRecord,
} from "../../packages/core/index.js";

export type { BrokerState, DeliveryRecord, RouteRecord };

/**
 * Shared process isolation for the two opt-in Letta Code 0.30.32 live suites
 * (tests/e2e/letta-code-live.e2e.test.ts and
 * tests/e2e/letta-code-interactive.e2e.test.ts).
 *
 * Every suite that uses this owns a disposable `--backend local` store under
 * isolated HOME/XDG/TMPDIR/SUBCONSCIOUS_HOME/project directories, plus its own
 * broker socket, `subconscious` shim on PATH, and (optionally) its own local
 * App Server. Cloud `--new-agent` is never used: that path hits account
 * agent-cap and billing gates. Credentials found in DEVELOPERS_API_KEY,
 * LETTA_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, and GROQ_API_KEY are
 * remembered only so `scrub()` can strip them from any captured output; they
 * are never printed.
 *
 * Vitest gives each test file its own module registry, so the process
 * registries below (secrets, roots, brokers, children, sockets, agent ids) are
 * per-suite state, not shared between the two files.
 */

export const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const brokerEntry = join(repoRoot, "dist", "packages", "cli", "cli.js");
const LETTA_CODE_VERSION = "0.30.32";
export const AGENT_SDK_VERSION = "0.7.6";

const OUTPUT_TAIL_BYTES = 200_000;
const LISTENING_RE = /^Listening on\s+(ws:\/\/\S+)\s*$/m;

const secrets: string[] = [];
const roots: string[] = [];
const brokers: SubconsciousBroker[] = [];
const children: ChildProcess[] = [];
const disposableAgentIds = new Set<string>();
const sockets: string[] = [];

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

export interface OwnedChild {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  wait(): Promise<number | null>;
}

export interface HookSighting {
  eventType: string | null;
  keys: string[];
  conversationId: string | null;
  agentId: string | null;
  conversationIdPresent: boolean;
  agentIdPresent: boolean;
  sessionIdPresent: boolean;
  env: {
    CONVERSATION_ID: boolean;
    LETTA_CONVERSATION_ID: boolean;
    AGENT_ID: boolean;
    LETTA_AGENT_ID: boolean;
    LETTA_HOOK_EVENT: string | null;
  };
}

export interface LettaTurn {
  agentId: string;
  conversationId: string;
  resultText: string;
  stdout: string;
  stderr: string;
}

export interface Identity {
  agentId: string;
  conversationId: string;
}

export interface Fixture {
  root: string;
  project: string;
  home: string;
  subconsciousHome: string;
  localBackendDir: string;
  hookLog: string;
  env: NodeJS.ProcessEnv;
  descriptor: BrokerDescriptor;
  queueMessages: boolean;
  queueClient: LettaAgentClient | null;
  appServerChild: ChildProcess | null;
  appServerOwned: OwnedChild | null;
}

export interface ResolvedLetta {
  lettaJs: string;
  sourceRoot: string | null;
}

/**
 * Per-suite naming and delivery knobs. `label` is used verbatim in broker
 * observe-event ids and route-registration prompts, `tempPrefix` in the
 * mkdtemp/socket names, and `queuedMessageTimeoutMs` bounds production
 * `deliverQueuedMessage` so a suite can exercise the real timeout path.
 */
export interface LettaFixtureConfig {
  label: string;
  tempPrefix: string;
  pipeName: string;
  observerAgentId: string;
  queuedMessageTimeoutMs?: number;
}

/** How the owned local App Server is launched. */
export type AppServerMode = "deterministic" | "plain";

let config: LettaFixtureConfig | null = null;
let lettaCli: ResolvedLetta | null = null;
let runtimeApiKey = "local-no-cloud-key";
let liveModel = "openai/gpt-4.1-mini";

export function configureLettaFixture(next: LettaFixtureConfig): void {
  config = next;
}

function requireConfig(): LettaFixtureConfig {
  if (!config) throw new Error("configureLettaFixture() was not called.");
  return config;
}

export function lettaCliOrThrow(): ResolvedLetta {
  if (!lettaCli) throw new Error("Letta CLI was not resolved.");
  return lettaCli;
}

export function currentLettaCli(): ResolvedLetta | null {
  return lettaCli;
}

export function currentModel(): string {
  return liveModel;
}

function realHome(): string {
  try {
    const home = userInfo().homedir;
    if (home) return home;
  } catch {
    // Fall through to the login-directory guess.
  }
  return homedir();
}

function rememberSecret(value: string | undefined): void {
  if (value && value.length > 0 && !secrets.includes(value))
    secrets.push(value);
}

function rememberEnvSecrets(): void {
  for (const name of [
    "DEVELOPERS_API_KEY",
    "LETTA_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GROQ_API_KEY",
  ]) {
    rememberSecret(process.env[name]);
  }
}

/** Strip every remembered credential value from text before it is reported. */
export function scrub(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function trimTail(text: string): string {
  return text.slice(-OUTPUT_TAIL_BYTES);
}

function isCloudAgentId(agentId: string): boolean {
  return agentId.startsWith("agent-") && !agentId.startsWith("agent-local-");
}

export function trackDisposableAgent(agentId: string): void {
  disposableAgentIds.add(agentId);
}

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(`/tmp/${requireConfig().tempPrefix}-${prefix}-`);
  roots.push(value);
  return await realpath(value);
}

export function trackChild(child: ChildProcess): OwnedChild {
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

/**
 * Stop a tracked child. Detached children (the local App Server) are signalled
 * as a process group so their own children die too; for non-detached children
 * no such group exists and the direct kill is used instead.
 */
export async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signalChild = (signal: NodeJS.Signals): void => {
    const pid = child.pid;
    if (pid) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // No process group with that id; fall back to the child itself.
      }
    }
    child.kill(signal);
  };
  signalChild("SIGTERM");
  const killed = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    signalChild("SIGKILL");
  }, 2_000);
  killed.unref();
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  clearTimeout(killed);
}

function resolveLiveModel(): string {
  if (process.env.OPENAI_API_KEY?.trim()) return "openai/gpt-4.1-mini";
  return "ollama/qwen3.8:latest";
}

function resolveRuntimeApiKey(): string {
  const developers = process.env.DEVELOPERS_API_KEY?.trim();
  const letta = process.env.LETTA_API_KEY?.trim();
  return developers || letta || "local-no-cloud-key";
}

async function whichLetta(): Promise<string | null> {
  const owned = trackChild(
    spawn("which", ["letta"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: realHome() },
    }),
  );
  const code = await owned.wait();
  if (code !== 0) return null;
  const path = owned.stdout.trim().split("\n")[0]?.trim();
  return path || null;
}

async function resolveLetta(): Promise<ResolvedLetta> {
  const wrapper = await whichLetta();
  let lettaJs: string | null = null;
  if (wrapper) {
    const info = await stat(wrapper);
    if (info.isFile()) {
      const text = await readFile(wrapper, "utf8");
      const match = text.match(/LETTA_JS="([^"]+)"/);
      if (match?.[1]) {
        lettaJs = match[1].replaceAll("$HOME", realHome());
      } else if (wrapper.endsWith(".js")) {
        lettaJs = wrapper;
      }
    }
  }
  if (!lettaJs) {
    const candidate = join(realHome(), "letta", "letta-code", "letta.js");
    await access(candidate);
    lettaJs = candidate;
  }
  const sourceRoot = join(dirname(lettaJs), "src");
  const hasSource = await access(join(sourceRoot, "hooks", "index.ts"))
    .then(() => true)
    .catch(() => false);
  return { lettaJs, sourceRoot: hasSource ? sourceRoot : null };
}

async function lettaVersion(lettaJs: string): Promise<string> {
  const owned = trackChild(
    spawn(process.execPath, [lettaJs, "--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: realHome(), NO_COLOR: "1" },
    }),
  );
  const code = await owned.wait();
  const text = `${owned.stdout}\n${owned.stderr}`.trim();
  if (code !== 0) {
    throw new Error(
      `letta --version failed (${code}). ${scrub(text) || "no output"}`,
    );
  }
  return owned.stdout.trim() || owned.stderr.trim();
}

/**
 * Shared `beforeAll` body: require a broker build, remember credentials for
 * redaction, pick the live model, and pin the Letta Code version actually on
 * disk (plus its package identity when source is next to the CLI).
 */
export async function prepareLettaCli(): Promise<ResolvedLetta> {
  await access(brokerEntry).catch(() => {
    throw new Error(
      `No broker build at ${brokerEntry}. Run npm run build first.`,
    );
  });
  rememberEnvSecrets();
  runtimeApiKey = resolveRuntimeApiKey();
  liveModel = resolveLiveModel();
  if (liveModel.startsWith("openai/") && !process.env.OPENAI_API_KEY?.trim()) {
    throw new Error(
      "The live suite needs OPENAI_API_KEY for openai/gpt-4.1-mini, or Ollama on 127.0.0.1:11434.",
    );
  }
  const resolved = await resolveLetta();
  const version = await lettaVersion(resolved.lettaJs);
  expect(version).toContain(LETTA_CODE_VERSION);
  if (resolved.sourceRoot) {
    const pkg = JSON.parse(
      await readFile(join(dirname(resolved.lettaJs), "package.json"), "utf8"),
    ) as { name?: string };
    expect(pkg.name).toBe("@letta-ai/letta-code");
  }
  lettaCli = resolved;
  return resolved;
}

function parseJsonObjects(text: string): unknown[] {
  const objects: unknown[] = [];
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
            objects.push(JSON.parse(text.slice(start, index + 1)));
          } catch {
            // Keep scanning later objects.
          }
          break;
        }
      }
    }
  }
  return objects;
}

function parseHeadlessResult(stdout: string, stderr: string): LettaTurn {
  const objects = parseJsonObjects(stdout);
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const value = objects[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.type !== "result") continue;
    const agentId = record.agent_id;
    const conversationId = record.conversation_id;
    if (typeof agentId !== "string" || agentId.length === 0) continue;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      continue;
    }
    return {
      agentId,
      conversationId,
      resultText: typeof record.result === "string" ? record.result : "",
      stdout,
      stderr,
    };
  }
  throw new Error(
    `Letta Code JSON result was missing agent_id/conversation_id.\n${scrub(stdout)}\n${scrub(stderr)}`,
  );
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
  localBackendDir: string;
}): NodeJS.ProcessEnv {
  const pathParts = [
    paths.bin,
    dirname(process.execPath),
    join(realHome(), ".bun", "bin"),
    join(realHome(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const openai = process.env.OPENAI_API_KEY;
  return {
    HOME: paths.home,
    USERPROFILE: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    XDG_CACHE_HOME: paths.cache,
    XDG_STATE_HOME: paths.state,
    TMPDIR: paths.tmp,
    SUBCONSCIOUS_HOME: paths.subconsciousHome,
    PATH: pathParts.join(":"),
    NO_COLOR: "1",
    LETTA_CODE_TELEM: "0",
    LETTA_SKIP_KEYCHAIN_CHECK: "1",
    LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
    LETTA_LOCAL_BACKEND_DIR: paths.localBackendDir,
    DISABLE_AUTOUPDATER: "1",
    ...(openai ? { OPENAI_API_KEY: openai } : {}),
    ...(liveModel.startsWith("ollama/")
      ? { OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1" }
      : {}),
  };
}

/**
 * A `subconscious` shim on PATH that records hook invocations (event type,
 * conversation/agent id presence, hook env vars) and forwards the call to the
 * real broker CLI entry point, so Letta Code's own hook wiring is exercised
 * unmodified. `<hookLog>.trace` is appended to unconditionally, on every
 * invocation regardless of arguments or JSON-parse success, so it is
 * authoritative evidence of exactly how many times Letta Code invoked this
 * command at all -- unlike `hookLog`, which only records ones that reached
 * hook mode. Neither log ever receives a credential value.
 */
async function writeSubconsciousShim(
  bin: string,
  hookLog: string,
): Promise<void> {
  await writeFile(
    join(bin, "subconscious"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const brokerEntry = ${JSON.stringify(brokerEntry)};
const hookLog = ${JSON.stringify(hookLog)};
const traceLog = hookLog + ".trace";
const args = process.argv.slice(2);
const hookMode = args[0] === "hook";
fs.appendFileSync(traceLog, JSON.stringify({ t: Date.now(), args, hookMode }) + "\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  if (hookMode) {
    let parsed = {};
    try { parsed = input.trim() ? JSON.parse(input) : {}; } catch {}
    const env = process.env;
    const entry = {
      args,
      eventType: typeof parsed.event_type === "string" ? parsed.event_type : typeof parsed.hook_event_name === "string" ? parsed.hook_event_name : null,
      keys: parsed && typeof parsed === "object" ? Object.keys(parsed) : [],
      conversationIdPresent: typeof parsed.conversation_id === "string" && parsed.conversation_id.length > 0,
      agentIdPresent: typeof parsed.agent_id === "string" && parsed.agent_id.length > 0,
      sessionIdPresent: typeof parsed.session_id === "string" && parsed.session_id.length > 0,
      conversationId: typeof parsed.conversation_id === "string" && parsed.conversation_id.length > 0 ? parsed.conversation_id : null,
      agentId: typeof parsed.agent_id === "string" && parsed.agent_id.length > 0 ? parsed.agent_id : null,
      env: {
        CONVERSATION_ID: Boolean(env.CONVERSATION_ID),
        LETTA_CONVERSATION_ID: Boolean(env.LETTA_CONVERSATION_ID),
        AGENT_ID: Boolean(env.AGENT_ID),
        LETTA_AGENT_ID: Boolean(env.LETTA_AGENT_ID),
        LETTA_HOOK_EVENT: env.LETTA_HOOK_EVENT || null,
      },
    };
    fs.appendFileSync(hookLog, JSON.stringify(entry) + "\\n");
  }
  const child = spawn(process.execPath, [brokerEntry, ...args], {
    stdio: ["pipe", "inherit", "inherit"],
    env: process.env,
  });
  child.stdin.write(input);
  child.stdin.end();
  child.on("exit", (code) => process.exit(code ?? 1));
  child.on("error", (error) => {
    fs.appendFileSync(hookLog, JSON.stringify({ spawnError: String(error) }) + "\\n");
    process.exit(1);
  });
});
`,
    { mode: 0o755 },
  );
}

export async function listLocalIdentities(
  localBackendDir: string,
): Promise<Identity[]> {
  const conversations = join(localBackendDir, "conversations");
  try {
    await access(conversations);
  } catch {
    return [];
  }
  const identities: Identity[] = [];
  for (const entry of await readdir(conversations, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = JSON.parse(
        await readFile(
          join(conversations, entry.name, "conversation.json"),
          "utf8",
        ),
      ) as { id?: unknown; agent_id?: unknown };
      if (typeof raw.id === "string" && typeof raw.agent_id === "string") {
        identities.push({ conversationId: raw.id, agentId: raw.agent_id });
      }
    } catch {
      // Ignore incomplete records while the TUI is still starting.
    }
  }
  return identities;
}

async function withTimeout<T>(
  action: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Map a headless turn onto a conversation the App Server can actually
 * retrieve, preferring the id the CLI reported and falling back to the local
 * store's own records for the same agent.
 */
export async function resolveWorkingIdentity(
  active: Fixture,
  turn: LettaTurn,
): Promise<Identity> {
  if (!active.queueClient) {
    throw new Error("Queue client was not started before identity lookup.");
  }
  const client = active.queueClient;
  const candidates = [
    { agentId: turn.agentId, conversationId: turn.conversationId },
    ...(await listLocalIdentities(active.localBackendDir)).filter(
      (item) => item.agentId === turn.agentId,
    ),
  ];
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.agentId}:${candidate.conversationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const conversation = await withTimeout(
        client.conversations.retrieve(candidate.conversationId),
        30_000,
        `conversations.retrieve ${candidate.conversationId}`,
      );
      if (conversation.agent_id === turn.agentId) return candidate;
      errors.push(
        `${candidate.conversationId} belongs to ${conversation.agent_id}`,
      );
    } catch (error) {
      errors.push(
        `${candidate.conversationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `No retrievable conversation for ${turn.agentId} (${turn.conversationId}). ${errors.join("; ")} stored=${JSON.stringify(await listLocalIdentities(active.localBackendDir))}`,
  );
}

export function appServerLogTail(active: Fixture | null | undefined): string {
  if (!active?.appServerOwned) return "(no app-server logs)";
  return `stdout:\n${scrub(active.appServerOwned.stdout)}\nstderr:\n${scrub(active.appServerOwned.stderr)}`;
}

function queueRuntime(client: LettaAgentClient | null): BrokerRuntime {
  if (!client) return { run: silentObserver.run };
  const timeoutMs = requireConfig().queuedMessageTimeoutMs;
  const agentRuntime = new AgentRuntime({
    apiKey: runtimeApiKey,
    client,
    ...(timeoutMs === undefined ? {} : { queuedMessageTimeoutMs: timeoutMs }),
  });
  return {
    run: silentObserver.run,
    deliverQueuedMessage: (input) => agentRuntime.deliverQueuedMessage(input),
  };
}

async function startBroker(
  subconsciousHome: string,
  descriptor: BrokerDescriptor,
  runtime: BrokerRuntime,
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

async function startOwnedLocalAppServer(
  active: Fixture,
  mode: AppServerMode,
): Promise<{ url: string; owned: OwnedChild }> {
  const deterministic = mode === "deterministic";
  const owned = trackChild(
    spawn(
      process.execPath,
      [
        lettaCliOrThrow().lettaJs,
        "--backend",
        "local",
        "app-server",
        "--listen",
        "ws://127.0.0.1:0",
      ],
      {
        ...(deterministic ? { cwd: active.project, detached: true } : {}),
        env: {
          ...active.env,
          // Deterministic local turns persist the user message and emit
          // turn_finished without usage_statistics. That is the SDK 0.7.6
          // ack gap the live suite records; it is not treated as delivery.
          ...(deterministic
            ? {
                LETTA_LOCAL_BACKEND_EXECUTOR: "deterministic",
                LETTA_DISABLE_CRON_SCHEDULER: "1",
                DEBUG: "1",
                LETTA_DEBUG: "1",
              }
            : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (owned.child.exitCode !== null || owned.child.signalCode !== null) {
      throw new Error(
        `Local App Server exited before listening (code=${owned.child.exitCode ?? "null"}, signal=${owned.child.signalCode ?? "null"}).\n${scrub(owned.stdout)}\n${scrub(owned.stderr)}`,
      );
    }
    const match = `${owned.stdout}\n${owned.stderr}`.match(LISTENING_RE);
    if (match?.[1]) return { url: match[1], owned };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Local App Server did not report a listening URL within 120s.\n${scrub(owned.stdout)}\n${scrub(owned.stderr)}`,
  );
}

/** Start (or restart) this fixture's own local App Server and SDK client. */
export async function startQueueClient(
  active: Fixture,
  mode: AppServerMode = "deterministic",
): Promise<void> {
  if (active.appServerChild) await terminate(active.appServerChild);
  const started = await startOwnedLocalAppServer(active, mode);
  active.appServerOwned = started.owned;
  active.appServerChild = started.owned.child;
  active.queueClient = new LettaAgentClient({
    backend: "local",
    appServer: {
      url: started.url,
      harnessBackend: "local",
      pinGlobalAgent: false,
    },
  });
}

export async function createFixture(options: {
  queueMessages: boolean;
  appServer?: AppServerMode;
}): Promise<Fixture> {
  const settings = requireConfig();
  lettaCliOrThrow();
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
  const localBackendDir = join(rootDir, "lc-local-backend");
  const hookLog = join(rootDir, "hooks.jsonl");
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
    localBackendDir,
    join(home, ".letta"),
  ]) {
    await mkdir(path, { recursive: true });
  }
  await writeProjectConfig(project, {
    version: 1,
    agentId: settings.observerAgentId,
    delivery: { whispers: true, queueMessages: options.queueMessages },
    observer: {},
  });
  await installAdapter("letta-code", project);
  await writeSubconsciousShim(bin, hookLog);
  await appendFile(hookLog, "");
  const env = exactEnvironment({
    home,
    config,
    data,
    cache,
    state,
    tmp,
    subconsciousHome,
    bin,
    localBackendDir,
  });
  const descriptor: BrokerDescriptor = {
    version: 1,
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\${settings.pipeName}-${randomUUID()}`
        : join(
            "/tmp",
            `${settings.tempPrefix}-${randomUUID().slice(0, 12)}.sock`,
          ),
    token: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    build: await buildFingerprint(brokerEntry),
  };
  if (process.platform !== "win32") sockets.push(descriptor.endpoint);
  const active: Fixture = {
    root: rootDir,
    project,
    home,
    subconsciousHome,
    hookLog,
    env,
    descriptor,
    queueMessages: options.queueMessages,
    queueClient: null,
    localBackendDir,
    appServerChild: null,
    appServerOwned: null,
  };
  if (options.appServer) await startQueueClient(active, options.appServer);
  await startBroker(
    subconsciousHome,
    descriptor,
    queueRuntime(active.queueClient),
  );
  return active;
}

export async function brokerState(active: Fixture): Promise<BrokerState> {
  const response = await sendBrokerRequest(active.descriptor, {
    type: "status",
  });
  if (!response.ok || response.type !== "status") {
    throw new Error(`Unexpected broker status: ${JSON.stringify(response)}`);
  }
  return response.state;
}

export async function poll<T>(
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms. ${scrub(await Promise.resolve(detail()))}`,
  );
}

/**
 * The route identity for one Letta Code session, keyed exactly the way
 * production keys it: `lettaSessionRouteId` scopes the conversation by agent
 * so two agents both sitting on the local `default` conversation stay on
 * separate routes. Tests must never synthesize a conversation-only key of
 * their own, or observe would create one route while lease and ack look up
 * another.
 */
export function sessionRouteId(
  agentId: string,
  conversationId: string,
): string {
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

export function observerIdentity(active: Fixture, sessionId: string) {
  return {
    configPath: join(active.project, "subconscious.toml"),
    projectRoot: active.project,
    agentId: requireConfig().observerAgentId,
    harness: "letta-code" as const,
    sessionId,
  };
}

/**
 * Register a real route by sending the broker the same UserPromptSubmit shape
 * a hook would. The payload and the resulting harness identity keep the raw
 * agent and conversation ids the Agent SDK addresses; only the route id is
 * agent-scoped.
 */
export async function registerHarnessRoute(
  active: Fixture,
  agentId: string,
  conversationId: string,
): Promise<string> {
  const label = requireConfig().label;
  const sessionId = sessionRouteId(agentId, conversationId);
  const event = {
    id: `${label}-${conversationId}-${randomUUID()}`,
    harness: "letta-code" as const,
    type: "user_prompt" as const,
    sessionId,
    workingDirectory: active.project,
    occurredAt: new Date().toISOString(),
    payload: {
      event_type: "UserPromptSubmit",
      working_directory: active.project,
      conversation_id: conversationId,
      agent_id: agentId,
      prompt: `Register the ${label} Letta Code conversation.`,
    },
  };
  await sendBrokerRequest(active.descriptor, { type: "observe", event });
  const key = routeKey(observerIdentity(active, sessionId));
  await poll(
    () => brokerState(active),
    30_000,
    () => `waiting for route ${key}`,
    (state) => Boolean(state.routes[key]?.harnessIdentity),
  );
  return key;
}

/**
 * Seed a pending delivery straight into persisted broker state, then bring the
 * broker back up so the production delivery path picks it up on its own.
 */
export async function seedDelivery(
  active: Fixture,
  record: DeliveryRecord,
): Promise<void> {
  for (const broker of brokers.splice(0)) {
    await broker.close();
  }
  const statePath = join(active.subconsciousHome, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as BrokerState;
  const route = state.routes[record.routeKey];
  if (!route) {
    throw new Error(
      `Cannot seed delivery; route ${record.routeKey} is missing.`,
    );
  }
  state.deliveries[record.id] = record;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await startBroker(
    active.subconsciousHome,
    active.descriptor,
    queueRuntime(active.queueClient),
  );
}

/**
 * Close the running broker and start a new one against the same socket and
 * state, so a later drain can pick up a still-pending queued message.
 */
export async function restartBroker(active: Fixture): Promise<void> {
  for (const broker of brokers.splice(0)) {
    await broker.close();
  }
  await startBroker(
    active.subconsciousHome,
    active.descriptor,
    queueRuntime(active.queueClient),
  );
}

export function pendingRecord(
  route: RouteRecord,
  kind: DeliveryRecord["kind"],
  text: string,
  dedupeKey: string,
  observationId = `seed-${kind}`,
): DeliveryRecord {
  const now = new Date().toISOString();
  return {
    id: deliveryId(observationId, kind, dedupeKey),
    routeKey: route.key,
    observationId,
    kind,
    text,
    priority: "normal",
    dedupeKey,
    status: "pending",
    createdAt: now,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    attempts: 0,
  };
}

function isHookSighting(value: unknown): value is HookSighting {
  return Boolean(
    value &&
      typeof value === "object" &&
      "env" in value &&
      (value as HookSighting).env &&
      typeof (value as HookSighting).env === "object",
  );
}

export async function hookSightings(active: Fixture): Promise<HookSighting[]> {
  try {
    return (await readFile(active.hookLog, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown)
      .filter(isHookSighting);
  } catch {
    return [];
  }
}

export async function runHeadlessTurn(
  active: Fixture,
  prompt: string,
  options: {
    newAgent?: boolean;
    agentId?: string;
    conversationId?: string;
    newConversation?: boolean;
  } = {},
): Promise<LettaTurn> {
  const args = [
    lettaCliOrThrow().lettaJs,
    "--backend",
    "local",
    "-m",
    liveModel,
    "--yolo",
    "--no-skills",
    "--no-mods",
    "--no-bundled-skills",
    "--memfs-startup",
    "skip",
    "--output-format",
    "json",
    "-p",
    ...(options.newAgent ? ["--new-agent"] : []),
    ...(options.agentId ? ["--agent", options.agentId] : []),
    ...(options.conversationId
      ? ["--conversation", options.conversationId]
      : []),
    ...(options.newConversation ? ["--new"] : []),
    prompt,
  ];
  const owned = trackChild(
    spawn(process.execPath, args, {
      cwd: active.project,
      env: active.env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const code = await owned.wait();
  if (code !== 0) {
    throw new Error(
      `letta -p exited with ${code}.\nstdout:\n${scrub(owned.stdout)}\nstderr:\n${scrub(owned.stderr)}`,
    );
  }
  const turn = parseHeadlessResult(owned.stdout, owned.stderr);
  disposableAgentIds.add(turn.agentId);
  return turn;
}

/** Raw on-disk transcript for one conversation in the local backend store. */
export async function localConversationBlob(
  active: Fixture,
  conversationId: string,
  agentId?: string,
): Promise<string> {
  const conversations = join(active.localBackendDir, "conversations");
  try {
    await access(conversations);
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const entry of await readdir(conversations, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(conversations, entry.name);
    try {
      const record = JSON.parse(
        await readFile(join(dir, "conversation.json"), "utf8"),
      ) as { id?: unknown; agent_id?: unknown };
      if (record.id !== conversationId) continue;
      if (agentId && record.agent_id !== agentId) continue;
      parts.push(await readFile(join(dir, "conversation.json"), "utf8"));
      try {
        parts.push(await readFile(join(dir, "messages.jsonl"), "utf8"));
      } catch {
        // Transcript may still be empty.
      }
    } catch {
      // Ignore incomplete records.
    }
  }
  return parts.join("\n");
}

/** Transcript for one conversation as the App Server itself reports it. */
export async function remoteConversationBlob(
  active: Fixture,
  conversationId: string,
): Promise<string> {
  if (!active.queueClient) {
    throw new Error("Queue client was not started before message lookup.");
  }
  const page = await active.queueClient.conversations.listMessages(
    conversationId,
    { order: "asc", limit: 100 },
  );
  return JSON.stringify(page.messages ?? []);
}

/**
 * Shared `afterEach` body: close brokers, stop every tracked child, and prove
 * the disposable roots and sockets are actually gone.
 */
export async function cleanupFixtures(): Promise<void> {
  const failures: string[] = [];
  for (const broker of brokers.splice(0)) {
    try {
      await broker.close();
    } catch (error) {
      failures.push(
        `broker cleanup: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const child of children.splice(0)) {
    try {
      await terminate(child);
    } catch (error) {
      failures.push(
        `child cleanup: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const removedPaths = [...roots.splice(0), ...sockets.splice(0)];
  const removed = await Promise.allSettled(
    removedPaths.map((path) => rm(path, { recursive: true, force: true })),
  );
  for (const [index, result] of removed.entries()) {
    if (result.status === "rejected") {
      failures.push(`fixture removal: ${String(result.reason)}`);
      continue;
    }
    try {
      await access(removedPaths[index]!);
      failures.push(
        `fixture still exists after cleanup: ${removedPaths[index]}`,
      );
    } catch {
      // Path is gone, as expected.
    }
  }
  if (failures.length > 0) {
    throw new Error(`Cleanup failed:\n- ${failures.join("\n- ")}`);
  }
}

/** Shared `afterAll` body: no cloud agent may survive a local-only suite. */
export function assertNoCloudAgentsLeft(): void {
  const leftover = [...disposableAgentIds].filter(isCloudAgentId);
  disposableAgentIds.clear();
  if (leftover.length > 0) {
    throw new Error(`Cleanup left cloud agent ids: ${leftover.join(", ")}`);
  }
}
