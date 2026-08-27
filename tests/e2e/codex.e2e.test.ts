import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  RunObservationInput,
  RunObservationResult,
} from "../../packages/agent-runtime/index.js";
import { SubconsciousBroker } from "../../packages/cli/broker.js";
import {
  buildFingerprint,
  deliveryId,
  writeBrokerDescriptor,
  type BrokerDescriptor,
  type BrokerState,
  type HarnessEventType,
} from "../../packages/core/index.js";

/**
 * Live regression for the real Codex CLI (0.149.1) hook contract.
 *
 * codex-cli's hook surface was traced from source before writing this suite:
 * `codex features list` confirms `hooks` is a stable, default-on feature (not
 * gated), and `strings` on the installed binary surfaces the wire vocabulary
 * (`hookSpecificOutput`, `additionalContext`, `session_id`, `hook_event_name`,
 * `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`) -
 * the same event names and envelope shape `packages/adapter-codex/index.ts`
 * and `packages/core/channels.ts` already assume, one Claude-Code-compatible
 * hook contract reused wholesale. `$CODEX_HOME/hooks.json` in the same
 * `{ hooks: { EventName: [{ hooks: [{ type, command, timeout }] }] } }` shape
 * `packages/cli/install.ts` writes was independently confirmed live: a hand
 * written hooks.json under an isolated `CODEX_HOME` made a real, unmodified
 * `codex exec` invocation print `hook: <Event> Completed` and deliver the
 * exact JSON payload `packages/adapter-codex/index.ts` parses
 * (`session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`,
 * `prompt`).
 *
 * One real, reproducible gap surfaced in that same tracing, and is fixed on
 * `packages/adapter-codex/index.ts`'s `contextChannel`, not worked around
 * here: the shared `defaultContextChannel` (`packages/core/channels.ts`)
 * sends `SessionStart` and `UserPromptSubmit` context as bare stdout text,
 * which Claude Code and Letta Code genuinely read there, but codex-cli does
 * not - confirmed live, plain stdout on those two events completed the hook
 * normally ("Completed", not "Failed") while the delivered text never became
 * model-attended context, and the broker had no signal that anything went
 * wrong, so it marked the delivery `delivered` regardless and never retried
 * it. The Codex adapter now overrides those two events onto the same
 * `hookSpecificOutput.additionalContext` envelope `PreToolUse`/`PostToolUse`
 * already require, leaving the shared default untouched for the harnesses
 * that need it. "delivers a whisper at the prompt boundary via the envelope
 * channel" is the live proof the fix works; if it starts failing, the
 * channel override regressed.
 *
 * `codex exec` never lets a caller choose a session id (unlike Claude Code's
 * `--session-id`), so a route cannot be pre-seeded before the real session
 * exists, and piped (non-TTY) stdout never carries the human `session id:`
 * banner a terminal sees - both confirmed live - so every real run here goes
 * through `--json` and reads the session id from its `thread.started` event
 * instead. Every whisper-delivery test runs in two real passes: pass one
 * creates the session and its route (read back from the broker's own state
 * afterward); a whisper is then scheduled by session id through the broker's
 * in-process scripted observer (`createScriptedObserver`, not a direct
 * `state.json` edit - confirmed live that `StateStore` caches state in
 * memory after its first read and never reloads from disk, so an out-of-band
 * file edit after a broker's first observation is silently lost on its next
 * write); pass two resumes the same session (`codex exec resume <id>
 * <prompt>`, which unlike fresh `exec` accepts no `-C`/`--cd` of its own) to
 * turn the schedule into a pending delivery, and pass three leases that
 * delivery through the exact boundary under test. This matches production
 * hook order: lease first, then observe.
 *
 * Auth is reused, never generated or inspected: the real `~/.codex/auth.json`
 * is byte-copied into an isolated `CODEX_HOME` with `copyFile`, and this file
 * never reads, parses, or logs its content. Normal teardown deletes the 0700
 * temp root; a hard-killed test process can leave that copy in the system temp
 * directory, so this opt-in suite should run only on a trusted machine.
 * `HOME`, `CODEX_HOME`, and every XDG directory point at fixture-owned temp
 * paths, and the child receives an explicit environment allowlist rather than
 * the parent's credential variables. `SUBCONSCIOUS_HOME` points at a
 * broker started in-process on a fixture-owned socket, so this suite's
 * whispers can only reach the boundary each test registers even on a machine
 * running the real Subconscious plugin.
 *
 * Run directly, since this file intentionally owns its own npm entry:
 *   npx vitest run --config vitest.codex-e2e.config.ts
 * This spends real OpenAI turns through the operator's own Codex login and
 * needs the `codex` binary (0.149.1 traced here) on PATH.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const brokerEntry = join(repoRoot, "dist", "packages", "cli", "cli.js");
const realCodexHome = join(
  process.env.HOME ?? process.env.USERPROFILE ?? "",
  ".codex",
);

const roots: string[] = [];
const brokers: SubconsciousBroker[] = [];
const codexChildren = new Set<ReturnType<typeof spawn>>();

async function stopCodexChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  child.kill("SIGTERM");
  await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}

afterEach(async () => {
  await Promise.all([...codexChildren].map(stopCodexChild));
  codexChildren.clear();
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// Unix domain socket paths are capped well under 108 bytes on macOS/BSD, and
// this suite's home directories carry the broker's socket, so the mkdtemp
// prefix has to stay short - a descriptive one plus the tmpdir root and
// "/broker.sock" routinely overflows that limit.
async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), `sce2e-${prefix}-`));
  roots.push(value);
  return await realpath(value);
}

interface ScriptedObserver {
  run(input: RunObservationInput): Promise<RunObservationResult>;
  /**
   * Queue one whisper for the next observation this broker processes on the
   * given real Codex session id. Returns the dedupe key the eventual
   * `DeliveryRecord` carries, so a test can find it afterward by content
   * rather than by a precomputed id: the id embeds the id of whichever real
   * hook event actually triggers it, which is not known in advance.
   */
  schedule(sessionId: string, text: string): string;
  /**
   * The `transcript_path` from the latest real hook payload seen for this
   * session, captured while the observation is still being processed.
   * `state.json` cannot answer this after the fact: `applyRetention`
   * (`packages/core/retention.ts`) clears a processed observation's payload
   * back to `{}` as a storage-size policy, confirmed live to happen before a
   * test can ever read it back out.
   */
  transcriptPath(sessionId: string): string | undefined;
}

/**
 * An in-process stub observer whose only side effect is producing a
 * `DeliveryRecord` through the exact same `persistDelivery` callback the real
 * runtime uses, for a session id a test scheduled in advance.
 *
 * A whisper cannot be seeded by writing `state.json` directly once the
 * broker is already running: `StateStore.load()` (`packages/core/state.ts`)
 * caches state in memory after its first read and never reloads from disk,
 * so a broker whose first observation has already landed silently drops any
 * out-of-band file edit on its next write - confirmed live, the first
 * version of this fixture seeded deliveries that way and they vanished
 * between a session's first pass and its resumed second pass. Going through
 * `persistDelivery` instead means the delivery lands in the broker's own
 * in-memory state the same way a real observer turn would.
 */
function createScriptedObserver(): ScriptedObserver {
  const seeds = new Map<string, { text: string; dedupeKey: string }[]>();
  const transcriptPaths = new Map<string, string>();
  return {
    schedule(sessionId, text) {
      const dedupeKey = randomUUID();
      const queued = seeds.get(sessionId) ?? [];
      queued.push({ text, dedupeKey });
      seeds.set(sessionId, queued);
      return dedupeKey;
    },
    transcriptPath(sessionId) {
      return transcriptPaths.get(sessionId);
    },
    async run(input) {
      const path = input.event.payload.transcript_path;
      if (typeof path === "string" && path) {
        transcriptPaths.set(input.route.sessionId, path);
      }
      const queued = seeds.get(input.route.sessionId);
      const next = queued?.shift();
      if (next) {
        await input.persistDelivery({
          id: deliveryId(input.event.id, "whisper", next.dedupeKey),
          routeKey: input.route.key,
          observationId: input.event.id,
          kind: "whisper",
          text: next.text,
          priority: "normal",
          dedupeKey: next.dedupeKey,
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

/**
 * The environment one real `codex exec` invocation needs: an isolated
 * `CODEX_HOME` (real auth byte-copied in, `hooks.json` written alongside it -
 * codex-cli only ever reads hooks from `$CODEX_HOME/hooks.json`, confirmed
 * live: a hooks.json placed anywhere else, including this suite's own broker
 * state directory, is silently never read and no hook fires at all) and
 * isolated `HOME`/XDG dirs, so nothing touches the operator's real config.
 */
async function codexEnvironment(codexHome: string): Promise<NodeJS.ProcessEnv> {
  const isolatedHome = await root("ih");
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
    NO_COLOR: "1",
    CODEX_HOME: codexHome,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, "xdg-config"),
    XDG_DATA_HOME: join(isolatedHome, "xdg-data"),
    XDG_STATE_HOME: join(isolatedHome, "xdg-state"),
    XDG_CACHE_HOME: join(isolatedHome, "xdg-cache"),
  };
}

interface Fixture {
  project: string;
  home: string;
  codexHome: string;
  descriptor: BrokerDescriptor;
  /** Register the Subconscious hook on exactly these Codex-native events. */
  hooksJson(events: string[]): Promise<void>;
  state(): Promise<BrokerState>;
  /**
   * Queue one whisper for the next observation on this real Codex session id.
   * Returns the dedupe key to find the resulting `DeliveryRecord` by later.
   */
  scheduleWhisper(sessionId: string, text: string): string;
  /** The `transcript_path` from the latest real hook payload seen for this session. */
  transcriptPath(sessionId: string): string | undefined;
}

/**
 * A configured project, a broker running on a fixture-owned socket, and a
 * fixture-owned `CODEX_HOME` with real auth copied in - no route seeded up
 * front, since codex-cli assigns its own session id and the route this
 * fixture's whispers attach to is only known once a real session has
 * actually started.
 */
async function fixture(prefix: string): Promise<Fixture> {
  const project = await root(`${prefix}p`);
  const home = await root(`${prefix}h`);
  const codexHome = await root(`${prefix}c`);
  await copyFile(
    join(realCodexHome, "auth.json"),
    join(codexHome, "auth.json"),
  );
  const now = new Date().toISOString();
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
      "[observer]",
      "mid_turn = true",
      "mid_turn_min_tool_calls = 1",
      "mid_turn_min_seconds = 0",
      "",
    ].join("\n"),
  );

  const state: BrokerState = {
    version: 1,
    routes: {},
    observations: {},
    observationOrder: [],
    deliveries: {},
  };
  await writeFile(
    join(home, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  );

  const descriptor: BrokerDescriptor = {
    version: 1,
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\subconscious-codex-e2e-${randomUUID()}`
        : join(home, "broker.sock"),
    token: randomUUID(),
    pid: process.pid,
    startedAt: now,
    build: await buildFingerprint(brokerEntry),
  };
  const observer = createScriptedObserver();
  const broker = new SubconsciousBroker({
    descriptor,
    stateDirectory: home,
    runtime: observer,
  });
  brokers.push(broker);
  await broker.start();
  await writeBrokerDescriptor(join(home, "broker.json"), descriptor);

  const shim = join(home, "hook.sh");
  await writeFile(
    shim,
    `#!/bin/sh\nSUBCONSCIOUS_HOME=${JSON.stringify(home)} exec node ${JSON.stringify(brokerEntry)} hook codex\n`,
    { mode: 0o755 },
  );

  return {
    project,
    home,
    codexHome,
    descriptor,
    async hooksJson(events) {
      await writeFile(
        join(codexHome, "hooks.json"),
        JSON.stringify({
          hooks: Object.fromEntries(
            events.map((event) => [
              event,
              [
                {
                  hooks: [
                    { type: "command", command: `sh ${shim}`, timeout: 15 },
                  ],
                },
              ],
            ]),
          ),
        }),
      );
    },
    async state() {
      return JSON.parse(
        await readFile(join(home, "state.json"), "utf8"),
      ) as BrokerState;
    },
    scheduleWhisper(sessionId, text) {
      return observer.schedule(sessionId, text);
    },
    transcriptPath(sessionId) {
      return observer.transcriptPath(sessionId);
    },
  };
}

/** Find a scheduled whisper's resulting delivery by content, not by a precomputed id. */
function findDelivery(
  state: BrokerState,
  routeKeyValue: string,
  dedupeKey: string,
) {
  return Object.values(state.deliveries).find(
    (delivery) =>
      delivery.routeKey === routeKeyValue && delivery.dedupeKey === dedupeKey,
  );
}

interface CodexRunResult {
  output: string;
  sessionId: string;
}

/**
 * Run one real, non-interactive `codex exec` turn (or `resume` when
 * `resumeSessionId` is given) against the fixture's isolated environment.
 *
 * `--skip-git-repo-check` is required because fixture project directories are
 * never git repositories. `--dangerously-bypass-hook-trust` is required
 * because a freshly written `hooks.json` has no persisted trust decision and
 * this is a non-interactive run with nothing to approve it; codex's own help
 * text names this flag for exactly this kind of vetted automation.
 *
 * Piped stdout gets codex-cli's plain, TTY-detected output (just the agent's
 * final message, no session banner and no `hook: X Completed` lines) rather
 * than the rich human-readable transcript a real terminal sees - confirmed
 * live: an earlier version of this helper parsed a `session id:` banner line
 * that piped output never sent. `--json` prints one JSONL event per line
 * regardless of TTY-ness and is documented to include a `thread.started`
 * event carrying the session's own id, so this reads structured events
 * instead of screen-scraping a banner that only exists interactively.
 */
async function runCodex(
  codexHome: string,
  project: string,
  prompt: string,
  options: { resumeSessionId?: string } = {},
): Promise<CodexRunResult> {
  const environment = await codexEnvironment(codexHome);
  // `codex exec resume` has no `-C`/`--cd` option at all - confirmed against
  // its own `--help` and live, where passing one is a hard CLI parse error.
  // A resumed session already carries its own working directory; the fresh
  // `exec` path still needs `-C` because fixture project directories are
  // never the process's own cwd by default.
  const args = options.resumeSessionId
    ? [
        "exec",
        "resume",
        options.resumeSessionId,
        prompt,
        "--json",
        "--skip-git-repo-check",
        "--dangerously-bypass-hook-trust",
      ]
    : [
        "exec",
        prompt,
        "--json",
        "--skip-git-repo-check",
        "--dangerously-bypass-hook-trust",
        "-C",
        project,
      ];
  const child = spawn("codex", args, {
    cwd: project,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  codexChildren.add(child);
  let raw = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    raw += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    errors += chunk;
  });
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
  } finally {
    codexChildren.delete(child);
  }
  if (code !== 0) {
    throw new Error(`codex exited with ${code}.\n${raw}\n${errors}`);
  }
  let sessionId: string | null = null;
  const messages: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;
    if (
      record.type === "thread.started" &&
      typeof record.thread_id === "string"
    ) {
      sessionId = record.thread_id;
    }
    if (
      record.type === "item.completed" &&
      typeof record.item === "object" &&
      record.item !== null
    ) {
      const item = record.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") {
        messages.push(item.text);
      }
    }
  }
  if (!sessionId) {
    throw new Error(`codex JSON events carried no thread.started id.\n${raw}`);
  }
  return { output: messages.join("\n"), sessionId };
}

/** Wait until the broker has recorded exactly one route for this session id. */
async function waitForRoute(
  active: Fixture,
  sessionId: string,
  deadlineMs = 60_000,
): Promise<{ key: string; configPath: string; projectRoot: string }> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const state = await active.state();
    const found = Object.values(state.routes).find(
      (route) => route.sessionId === sessionId,
    );
    if (found) {
      return {
        key: found.key,
        configPath: found.configPath,
        projectRoot: found.projectRoot,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `No route recorded for session ${sessionId} within ${deadlineMs}ms.`,
  );
}

/** Wait until every observation for this session id has left queued/processing. */
async function waitForObservationsSettled(
  active: Fixture,
  sessionId: string,
  expectedTypes: HarnessEventType[] = [],
  deadlineMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const state = await active.state();
    const relevant = Object.values(state.observations).filter(
      (observation) => observation.event.sessionId === sessionId,
    );
    const observedTypes = new Set(
      relevant.map((observation) => observation.event.type),
    );
    if (
      relevant.length > 0 &&
      expectedTypes.every((type) => observedTypes.has(type)) &&
      relevant.every(
        (observation) =>
          observation.status !== "queued" &&
          observation.status !== "processing",
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Observations for session ${sessionId} did not settle within ${deadlineMs}ms.`,
  );
}

function sessionTranscriptPath(active: Fixture, sessionId: string): string {
  const path = active.transcriptPath(sessionId);
  if (!path) {
    throw new Error(`No transcript_path recorded for session ${sessionId}.`);
  }
  return path;
}

/**
 * Every `developer`-role message text codex-cli's own rollout transcript
 * recorded for this session - the definitive proof of what actually reached
 * the model's input, independent of whether the model chose to relay any of
 * it back in its own reply. Confirmed live: `additionalContext` delivered
 * through `hookSpecificOutput` lands in the rollout as a `response_item`
 * whose `payload.role` is `"developer"`, which is also, plausibly, why the
 * model sometimes declines to repeat it verbatim ("I can't disclose hidden
 * developer messages") even when delivery genuinely succeeded.
 */
async function developerMessages(transcriptPath: string): Promise<string[]> {
  const text = await readFile(transcriptPath, "utf8");
  const messages: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const payload = (record as Record<string, unknown>).payload;
    if (typeof payload !== "object" || payload === null) continue;
    const payloadRecord = payload as Record<string, unknown>;
    if (payloadRecord.role !== "developer") continue;
    const content = payloadRecord.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        typeof part === "object" &&
        part !== null &&
        typeof (part as Record<string, unknown>).text === "string"
      ) {
        messages.push((part as Record<string, unknown>).text as string);
      }
    }
  }
  return messages;
}

// Framing this as "hidden"/"system" content, or asking for a verbatim
// repeat of a labeled block, reliably made codex-cli's model refuse
// ("I can't provide hidden system or developer messages") even on a real,
// successfully delivered whisper - confirmed live. Asking a plain factual
// question about ordinary conversation content does not trigger that
// refusal and still fails honestly (a plain "NONE") when nothing was
// delivered.
const REPEAT =
  "If your available context mentions a canary phrase starting with CANARY-, tell me that exact phrase. If it does not, say NONE.";
const REPEAT_WITH_TOOL = `First run the shell command: echo probe. Then ${REPEAT}`;

const liveDescribe =
  process.env.SUBCONSCIOUS_CODEX_LIVE === "1" ? describe : describe.skip;

liveDescribe(
  "Codex CLI hook contract, traced against real codex-cli 0.149.1",
  () => {
    beforeAll(async () => {
      await readFile(brokerEntry).catch(() => {
        throw new Error(
          `No broker build at ${brokerEntry}. Run npm run build first.`,
        );
      });
      await new Promise<void>((resolve, reject) => {
        const probe = spawn("codex", ["--version"], { stdio: "ignore" });
        probe.on("error", () =>
          reject(new Error("The codex binary is not on PATH.")),
        );
        probe.on("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`codex --version exited with ${code}.`)),
        );
      });
      await access(join(realCodexHome, "auth.json")).catch(() => {
        throw new Error(
          `No ${join(realCodexHome, "auth.json")} to reuse. Run \`codex login\` once first; this suite never generates credentials.`,
        );
      });
    });

    it("discovers the nearest project config from a subdirectory and observes the prompt", async () => {
      const active = await fixture("n");
      await active.hooksJson(["SessionStart", "UserPromptSubmit"]);
      const nested = join(active.project, "nested", "workdir");
      await mkdir(nested, { recursive: true });

      const run = await runCodex(
        active.codexHome,
        nested,
        "Say OK and nothing else.",
      );
      const route = await waitForRoute(active, run.sessionId);
      await waitForObservationsSettled(active, run.sessionId, [
        "session_start",
        "user_prompt",
      ]);

      // The only subconscious.toml lives at the project root, one level above
      // where codex actually ran; the broker must still find it.
      expect(route.projectRoot).toBe(active.project);
      expect(route.configPath).toBe(join(active.project, "subconscious.toml"));

      const state = await active.state();
      const observed = Object.values(state.observations).filter(
        (observation) => observation.event.sessionId === run.sessionId,
      );
      const types = new Set(
        observed.map((observation) => observation.event.type),
      );
      expect(types.has("session_start")).toBe(true);
      expect(types.has("user_prompt")).toBe(true);
      expect(
        observed.every((observation) => observation.status === "processed"),
      ).toBe(true);
    }, 120_000);

    it("delivers a whisper at the prompt boundary via the envelope channel", async () => {
      // `packages/adapter-codex/index.ts`'s `contextChannel` now sends
      // SessionStart/UserPromptSubmit through the same
      // `hookSpecificOutput.additionalContext` envelope PreToolUse/PostToolUse
      // already use, instead of the shared default's bare stdout. Fixed after
      // this exact scenario, run live, showed the previous behavior: the hook
      // completed normally but the delivered text never became model-attended
      // context.
      //
      // The definitive check here is codex-cli's own rollout transcript, not
      // the model's own willingness to relay a `developer`-role message back
      // verbatim - confirmed live and noted on the tool-boundary test below,
      // that can be an unreliable signal (an outright refusal, "I can't
      // disclose hidden developer messages", or a plain "NONE") even when
      // delivery genuinely succeeded, because codex-cli injects
      // `additionalContext` as a `developer`-role transcript entry and this
      // model does not always treat that role's content as safe to just
      // repeat. The transcript records what actually reached the model's
      // input regardless of what the model chose to say about it.
      const active = await fixture("pb");
      await active.hooksJson(["UserPromptSubmit"]);

      const first = await runCodex(
        active.codexHome,
        active.project,
        "Say OK and nothing else.",
      );
      const route = await waitForRoute(active, first.sessionId);
      await waitForObservationsSettled(active, first.sessionId);
      const canary = `CANARY-${randomUUID().slice(0, 8)}`;
      const dedupeKey = active.scheduleWhisper(
        first.sessionId,
        `The canary phrase is ${canary}.`,
      );
      const second = await runCodex(active.codexHome, active.project, REPEAT, {
        resumeSessionId: first.sessionId,
      });
      expect(second.sessionId).toBe(first.sessionId);
      await waitForObservationsSettled(active, second.sessionId);

      const prepared = await active.state();
      expect(findDelivery(prepared, route.key, dedupeKey)?.status).toBe(
        "pending",
      );
      const third = await runCodex(active.codexHome, active.project, REPEAT, {
        resumeSessionId: first.sessionId,
      });
      expect(third.sessionId).toBe(first.sessionId);
      await waitForObservationsSettled(active, third.sessionId);

      const delivered = await active.state();
      const delivery = findDelivery(delivered, route.key, dedupeKey);
      expect(delivery?.status).toBe("delivered");

      const transcriptPath = sessionTranscriptPath(active, first.sessionId);
      const developerText = (await developerMessages(transcriptPath)).join(
        "\n",
      );
      expect(developerText).toContain(canary);
    }, 180_000);

    it("delivers a whisper at a mid-turn tool boundary via the envelope channel", async () => {
      // UserPromptSubmit is deliberately not registered here: it fires before
      // PostToolUse on every resumed turn, so it would consume the scheduled
      // whisper at the prompt boundary before the tool boundary got a chance at
      // it. Registering only PostToolUse isolates the channel this case proves.
      const active = await fixture("td");
      await active.hooksJson(["PostToolUse"]);

      const first = await runCodex(
        active.codexHome,
        active.project,
        REPEAT_WITH_TOOL,
      );
      const route = await waitForRoute(active, first.sessionId);
      await waitForObservationsSettled(active, first.sessionId);

      const canary = `CANARY-${randomUUID().slice(0, 8)}`;
      const dedupeKey = active.scheduleWhisper(
        first.sessionId,
        `The canary phrase is ${canary}.`,
      );
      const second = await runCodex(
        active.codexHome,
        active.project,
        REPEAT_WITH_TOOL,
        { resumeSessionId: first.sessionId },
      );
      expect(second.sessionId).toBe(first.sessionId);
      await waitForObservationsSettled(active, second.sessionId);

      const prepared = await active.state();
      expect(findDelivery(prepared, route.key, dedupeKey)?.status).toBe(
        "pending",
      );
      const third = await runCodex(
        active.codexHome,
        active.project,
        REPEAT_WITH_TOOL,
        { resumeSessionId: first.sessionId },
      );
      expect(third.sessionId).toBe(first.sessionId);
      await waitForObservationsSettled(active, third.sessionId);

      // Definitive: codex-cli's own rollout transcript records what actually
      // reached the model's input. The model's own willingness to relay a
      // `developer`-role message back verbatim is not: confirmed live, this
      // exact envelope-delivered text sometimes triggers a refusal ("I can't
      // disclose hidden developer messages") or a plain "NONE" even though
      // delivery genuinely succeeded, because codex-cli injects
      // `additionalContext` as a `developer`-role transcript entry, and this
      // model does not treat that role's content as safe to just repeat.
      const transcriptPath = sessionTranscriptPath(active, first.sessionId);
      const developerText = (await developerMessages(transcriptPath)).join(
        "\n",
      );
      expect(developerText).toContain(canary);

      const state = await active.state();
      const delivery = findDelivery(state, route.key, dedupeKey);
      expect(delivery?.status).toBe("delivered");
      expect(state.routes[route.key]?.sourceCursor).toBeTruthy();
      const toolObservations = Object.values(state.observations).filter(
        (observation) =>
          observation.event.sessionId === first.sessionId &&
          observation.event.type === "tool_result",
      );
      expect(toolObservations.length).toBeGreaterThan(0);
      expect(
        toolObservations.every(
          (observation) => observation.status === "processed",
        ),
      ).toBe(true);
    }, 180_000);

    it("keeps two real sessions isolated: a whisper delivered to one session never reaches a different one", async () => {
      // UserPromptSubmit is deliberately not registered, for the same reason as
      // the tool-boundary test above: it would consume the scheduled whisper
      // before PostToolUse, which is the channel this isolation case exercises.
      const active = await fixture("iso");
      await active.hooksJson(["PostToolUse"]);

      const owner = await runCodex(
        active.codexHome,
        active.project,
        REPEAT_WITH_TOOL,
      );
      const ownerRoute = await waitForRoute(active, owner.sessionId);
      await waitForObservationsSettled(active, owner.sessionId);
      const canary = `CANARY-${randomUUID().slice(0, 8)}`;
      const dedupeKey = active.scheduleWhisper(
        owner.sessionId,
        `The canary phrase is ${canary}.`,
      );
      // Resuming the owner session with a tool call materializes the scheduled
      // whisper into a real, actually-delivered whisper on the owner's own
      // route through the working PostToolUse envelope channel - a genuinely
      // separate session below never observes this route at all, so it could
      // not have produced or touched this delivery itself.
      const ownerAgain = await runCodex(
        active.codexHome,
        active.project,
        REPEAT_WITH_TOOL,
        { resumeSessionId: owner.sessionId },
      );
      await waitForObservationsSettled(active, ownerAgain.sessionId);
      const prepared = await active.state();
      expect(findDelivery(prepared, ownerRoute.key, dedupeKey)?.status).toBe(
        "pending",
      );
      const ownerDelivered = await runCodex(
        active.codexHome,
        active.project,
        REPEAT_WITH_TOOL,
        { resumeSessionId: owner.sessionId },
      );
      await waitForObservationsSettled(active, ownerDelivered.sessionId);
      // Definitive: the owner's own rollout transcript, not the model's
      // willingness to relay a `developer`-role message back - see the
      // tool-boundary test above for why that can be an unreliable check on
      // this specific boundary even when delivery genuinely succeeded.
      const ownerTranscriptPath = sessionTranscriptPath(
        active,
        owner.sessionId,
      );
      const ownerDeveloperText = (
        await developerMessages(ownerTranscriptPath)
      ).join("\n");
      expect(ownerDeveloperText).toContain(canary);
      const beforeStranger = await active.state();
      const seededDelivery = findDelivery(
        beforeStranger,
        ownerRoute.key,
        dedupeKey,
      );
      expect(seededDelivery?.status).toBe("delivered");

      // A genuinely separate session, not a resume: codex assigns it its own
      // session id, distinct from `owner`.
      const stranger = await runCodex(
        active.codexHome,
        active.project,
        REPEAT_WITH_TOOL,
      );
      expect(stranger.sessionId).not.toBe(owner.sessionId);
      await waitForObservationsSettled(active, stranger.sessionId);

      expect(stranger.output).not.toContain(canary);
      const strangerTranscriptPath = sessionTranscriptPath(
        active,
        stranger.sessionId,
      );
      const strangerDeveloperText = (
        await developerMessages(strangerTranscriptPath)
      ).join("\n");
      expect(strangerDeveloperText).not.toContain(canary);
      const strangerRoute = await waitForRoute(active, stranger.sessionId);
      expect(strangerRoute.key).not.toBe(ownerRoute.key);
      const state = await active.state();
      // The owner's delivery is untouched by the stranger's own turn: still
      // exactly one record, still attributed to the owner's route, still
      // delivered - not duplicated, not reassigned, not somehow re-sent.
      const deliveriesForDedupeKey = Object.values(state.deliveries).filter(
        (delivery) => delivery.dedupeKey === dedupeKey,
      );
      expect(deliveriesForDedupeKey).toHaveLength(1);
      expect(deliveriesForDedupeKey[0]?.routeKey).toBe(ownerRoute.key);
      expect(deliveriesForDedupeKey[0]?.status).toBe("delivered");
    }, 180_000);
  },
);
