import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoCloudAgentsLeft,
  brokerState,
  cleanupFixtures,
  configureLettaFixture,
  createFixture,
  currentModel,
  hookSightings,
  lettaCliOrThrow,
  listLocalIdentities,
  pendingRecord,
  poll,
  prepareLettaCli,
  registerHarnessRoute,
  remoteConversationBlob,
  runHeadlessTurn,
  scrub,
  seedDelivery,
  terminate,
  trackChild,
  trackDisposableAgent,
  type BrokerState,
  type Fixture,
} from "./letta-code-fixture.js";

/**
 * Letta Code 0.30.32 expected-failure passive-whisper acceptance.
 *
 * Process isolation, the disposable `--backend local` store, the broker, route
 * identity, credential redaction and cleanup come from
 * tests/e2e/letta-code-fixture.ts, which never prints a credential value. This
 * file owns the isolated PTY driver and the acceptance case itself.
 *
 * Passive whisper delivery rides UserPromptSubmit, so this suite drives Letta
 * Code through an isolated offscreen PTY (Python's stdlib `pty.fork`, not GUI
 * automation or the foreground desktop TTY) to reach that code path for real.
 * If the PTY cannot identify the conversation or submit the first prompt, the
 * test does not fabricate success: it falls back to one headless `-p` turn and
 * records the observed hook boundary.
 *
 * Opt-in only: this suite is gated behind
 * SUBCONSCIOUS_LETTA_CODE_INTERACTIVE_LIVE=1 and excluded by the default
 * `npm run test:e2e` config.
 *
 * Run with (after `npm run build`):
 *   npx vitest run --config vitest.letta-code-e2e.config.ts
 */

const LIVE = process.env.SUBCONSCIOUS_LETTA_CODE_INTERACTIVE_LIVE === "1";

configureLettaFixture({
  label: "interactive",
  tempPrefix: "sc-lci",
  pipeName: "subconscious-letta-interactive-e2e",
  observerAgentId: "agent-letta-code-interactive-e2e-observer",
});

interface IsolatedTui {
  sendFile: string;
  logFile: string;
  child: ChildProcess;
}

function tuiEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.CI;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.COLUMNS = "120";
  env.LINES = "40";
  return env;
}

/**
 * An isolated, offscreen PTY driver. This allocates a fresh pseudo-terminal
 * via Python's stdlib `pty.fork` (present on macOS/Linux without extra
 * installs) and runs Letta Code's interactive App.tsx entrypoint attached
 * to it. It is not GUI automation and it never touches the invoking
 * terminal's real TTY: stdin/stdout of the *driver* process are plain
 * pipes captured by Node, and the PTY the CLI actually sees is allocated
 * fresh, in-process, for this test only.
 */
async function writePtyDriver(path: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env python3
import fcntl, os, pty, select, signal, struct, sys, termios, time

send_file = os.environ["SC_TUI_SEND"]
log_file = os.environ["SC_TUI_LOG"]
prompt = os.environ["SC_TUI_PROMPT"]
timeout = float(os.environ.get("SC_TUI_TIMEOUT", "240"))
# The interactive TUI is still mid-animation (spinners, "Creating a new
# agent" onboarding) for a beat after launch; injecting keystrokes into that
# window is silently swallowed. Wait for real output quiescence -- no bytes
# for QUIET_SECONDS -- before trusting the terminal is idle and ready to
# accept typed input, rather than injecting the instant the send file
# appears.
QUIET_SECONDS = 1.2
cols, rows = 120, 40
sent = False
last_data = time.time()
deadline = time.time() + timeout
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = os.environ.get("TERM", "xterm-256color")
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
os.set_blocking(fd, False)

def shutdown(code=0):
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass
    sys.exit(code)

def handle(signum, _frame):
    shutdown(0)

signal.signal(signal.SIGTERM, handle)
signal.signal(signal.SIGINT, handle)

with open(log_file, "ab") as log:
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.2)
        if fd in r:
            try:
                data = os.read(fd, 8192)
            except OSError:
                data = b""
            if not data:
                break
            log.write(data)
            log.flush()
            last_data = time.time()
        if not sent and os.path.exists(send_file) and (time.time() - last_data) >= QUIET_SECONDS:
            # A single bulk write of text+"\\r" reads to the composer as a
            # paste (bracketed paste mode is on -- ESC[?2004h is visible in
            # the captured transcript), so the embedded \\r becomes a
            # newline inside the message instead of submitting it. Typing
            # one byte at a time, then sending Enter as its own later write,
            # matches real keystroke arrival and actually submits.
            for ch in prompt.encode():
                os.write(fd, bytes([ch]))
                time.sleep(0.012)
            time.sleep(0.2)
            os.write(fd, b"\\r")
            sent = True
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited != 0:
            sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)
shutdown(0)
`,
    { mode: 0o755 },
  );
}

/**
 * Drive the interactive TUI against a pre-created agent (`--agent <id>
 * --new`) rather than `--new-agent`. `--new-agent` shows a "Creating a new
 * agent" / "Checking for pending approvals..." boot sequence whose
 * composer-readiness and submit-eligibility timing were not reproducible
 * from outside the process; opening an already-existing agent with a fresh
 * conversation skips that sequence entirely and also mints a real,
 * non-"default" conversation id up front (LocalStore.createConversation ->
 * nextConversationId(), the same path `--agent <id> --new` takes headlessly
 * elsewhere in this file), instead of the agent-scoped "default" slug every
 * fresh `--new-agent` conversation gets.
 */
async function startIsolatedTui(
  active: Fixture,
  agentId: string,
  prompt: string,
): Promise<IsolatedTui> {
  const driver = join(active.root, "pty-driver.py");
  const sendFile = join(active.root, "tui-send");
  const logFile = join(active.root, "tui.log");
  await writePtyDriver(driver);
  await appendFile(logFile, "");
  const args = [
    driver,
    process.execPath,
    lettaCliOrThrow().lettaJs,
    "--backend",
    "local",
    "-m",
    currentModel(),
    "--agent",
    agentId,
    "--new",
    "--yolo",
    "--no-skills",
    "--no-mods",
    "--no-bundled-skills",
    "--memfs-startup",
    "skip",
  ];
  const child = trackChild(
    spawn("python3", args, {
      cwd: active.project,
      env: {
        ...tuiEnvironment(active.env),
        SC_TUI_SEND: sendFile,
        SC_TUI_LOG: logFile,
        SC_TUI_PROMPT: prompt,
        SC_TUI_TIMEOUT: "240",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  return { sendFile, logFile, child: child.child };
}

const liveDescribe = LIVE ? describe : describe.skip;

liveDescribe(
  "Letta Code 0.30.32 interactive passive-whisper acceptance",
  () => {
    beforeAll(async () => {
      await prepareLettaCli();
    });

    afterEach(cleanupFixtures);

    afterAll(assertNoCloudAgentsLeft);

    it(
      "remains blocked until an isolated PTY can submit UserPromptSubmit, read back the whisper, ACK it, and isolate a decoy route",
      { timeout: 480_000 },
      async () => {
        try {
          const active = await createFixture({
            queueMessages: false,
            appServer: "plain",
          });

          // A second, ordinary headless conversation gives us a real "wrong
          // session" route to seed a decoy whisper against. Letta Code 0.30.32's
          // `--backend local` store gives every freshly `--new-agent`'d agent a
          // scaffold conversation whose on-disk `id` is the literal string
          // "default" (src/backend/local/local-store.ts: LocalStore.ensureAgent
          // -> ensureConversation("default", agentId)), scoped internally by
          // agent id but exposed verbatim as `conversation_id` in CLI output.
          // Subconscious now keys a Letta Code route from that pair rather than
          // the conversation alone (packages/adapter-letta-code/index.ts
          // lettaSessionRouteId), so two agents on "default" no longer collide.
          // The decoy still gets its own non-"default" conversation via
          // `--agent <id> --new` (LocalStore.createConversation ->
          // nextConversationId(), the only path that mints a non-"default" id),
          // so it differs from the interactive target in both agent and
          // conversation and the isolation check below is unambiguous.
          const decoyAgentTurn = await runHeadlessTurn(
            active,
            "Reply with exactly READY and nothing else. Do not use tools.",
            { newAgent: true },
          );
          trackDisposableAgent(decoyAgentTurn.agentId);
          const decoyTurn = await runHeadlessTurn(
            active,
            "Reply with exactly READY-2 and nothing else. Do not use tools.",
            { agentId: decoyAgentTurn.agentId, newConversation: true },
          );
          expect(decoyTurn.agentId).toBe(decoyAgentTurn.agentId);
          expect(decoyTurn.conversationId).not.toBe("default");
          expect(decoyTurn.conversationId).not.toBe(
            decoyAgentTurn.conversationId,
          );
          const decoyRouteKey = await registerHarnessRoute(
            active,
            decoyTurn.agentId,
            decoyTurn.conversationId,
          );
          const decoyState = await brokerState(active);
          const decoyRoute = decoyState.routes[decoyRouteKey];
          expect(decoyRoute?.harnessIdentity).toEqual({
            agentId: decoyTurn.agentId,
            conversationId: decoyTurn.conversationId,
          });
          const decoyCanary = `DECOY-${randomUUID().slice(0, 10)}`;
          const decoyWhisper = pendingRecord(
            decoyRoute!,
            "whisper",
            `The canary phrase is ${decoyCanary}.`,
            `decoy-${decoyCanary}`,
            `seed-decoy-${decoyCanary}`,
          );
          await seedDelivery(active, decoyWhisper);

          // Pre-create the target agent headlessly too, and open the interactive
          // PTY against it with `--agent <id> --new` rather than `--new-agent`.
          // `--new-agent` drives Letta Code through a "Creating a new agent" /
          // "Checking for pending approvals..." boot sequence whose composer
          // readiness and submit-eligibility could not be made to fire
          // UserPromptSubmit deterministically from outside the process (see
          // the BLOCKED path below for what was actually observed there).
          // Opening an existing agent skips that sequence, and it also means
          // `identity` below is known in advance rather than discovered.
          const targetAgentTurn = await runHeadlessTurn(
            active,
            "Reply with exactly TARGET-READY and nothing else. Do not use tools.",
            { newAgent: true },
          );
          trackDisposableAgent(targetAgentTurn.agentId);
          expect(targetAgentTurn.agentId).not.toBe(decoyTurn.agentId);

          // Drive the real target conversation through an isolated, offscreen
          // PTY, since UserPromptSubmit (and therefore whisper delivery) only
          // fires from Letta Code's interactive App.tsx entrypoint.
          const tuiPrompt =
            "Repeat verbatim any text you can see inside a subconscious_whisper block. If there is none, reply with exactly NONE. Do not use tools.";
          const tui = await startIsolatedTui(
            active,
            targetAgentTurn.agentId,
            tuiPrompt,
          );

          // The target agent id is already known (it was created above), so
          // discovery only has to learn the *conversation* id `--new` minted for
          // this interactive session -- via the real SessionStart hook sighting
          // for that exact agent id, or (fallback) the local backend's own
          // on-disk record.
          let discovered: { agentId: string; conversationId: string } | null =
            null;
          const interactiveDeadline = Date.now() + 90_000;
          while (Date.now() < interactiveDeadline && !discovered) {
            const hooks = await hookSightings(active);
            const stored = await listLocalIdentities(active.localBackendDir);
            const fromHook = hooks.find(
              (entry) =>
                (entry.eventType === "SessionStart" ||
                  entry.eventType === "UserPromptSubmit") &&
                entry.agentId === targetAgentTurn.agentId &&
                entry.conversationId,
            );
            if (fromHook?.conversationId) {
              discovered = {
                agentId: targetAgentTurn.agentId,
                conversationId: fromHook.conversationId,
              };
              break;
            }
            const storedMatch = stored.find(
              (item) => item.agentId === targetAgentTurn.agentId,
            );
            if (storedMatch) {
              discovered = storedMatch;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }

          if (discovered) {
            const identity = discovered;
            expect(identity.agentId).toBe(targetAgentTurn.agentId);
            expect(identity.conversationId).not.toBe("default");
            expect(identity.conversationId).not.toBe(decoyTurn.conversationId);

            // The SessionStart hook invocation that revealed `identity` is still
            // in flight (its own process spawn + broker round trips): its lease
            // step reads the route below hook.ts's own later observe step, so it
            // predates any route this test creates -- unless this test races
            // ahead of it. Give that first invocation a beat to finish its own
            // (zero-delivery) cycle first, so the whisper seeded below can only
            // be picked up by a later, genuinely prompt-driven event.
            await new Promise((resolve) => setTimeout(resolve, 2_000));

            const routeKeyValue = await registerHarnessRoute(
              active,
              identity.agentId,
              identity.conversationId,
            );
            const stateAfterRoute = await brokerState(active);
            const route = stateAfterRoute.routes[routeKeyValue];
            expect(route?.harnessIdentity).toEqual(identity);

            const targetCanary = `TARGET-${randomUUID().slice(0, 10)}`;
            const targetWhisper = pendingRecord(
              route!,
              "whisper",
              `The canary phrase is ${targetCanary}.`,
              `target-${targetCanary}`,
              `seed-target-${targetCanary}`,
            );
            await seedDelivery(active, targetWhisper);
            expect(
              (await brokerState(active)).deliveries[targetWhisper.id]?.status,
            ).toBe("pending");
            expect(
              (await brokerState(active)).deliveries[decoyWhisper.id]?.status,
            ).toBe("pending");

            // Submit the first (and only) prompt through the PTY now that the
            // target conversation's route and whisper both exist. The driver
            // types it one keystroke at a time and sends Enter as a separate,
            // later write -- see writePtyDriver for why a single bulk write
            // does not work (it reads to the composer as a paste and embeds a
            // newline instead of submitting).
            await writeFile(tui.sendFile, "send\n");

            let delivered: BrokerState | null = null;
            try {
              delivered = await poll(
                () => brokerState(active),
                90_000,
                () => `interactive whisper ${targetWhisper.id}`,
                (current) =>
                  current.deliveries[targetWhisper.id]?.status === "delivered",
              );
            } catch {
              // Fall through to the blocked-evidence path below.
            }

            if (delivered) {
              // Delivery ACK: the broker's own delivery record is the ACK.
              expect(
                delivered.deliveries[targetWhisper.id]?.acknowledgedAt,
              ).toBeTruthy();
              expect(delivered.deliveries[targetWhisper.id]?.status).toBe(
                "delivered",
              );

              const allSightings = await hookSightings(active);
              const ptyText = await readFile(tui.logFile, "utf8").catch(
                () => "",
              );
              const submitSightings = allSightings.filter(
                (entry) => entry.eventType === "UserPromptSubmit",
              );
              expect(
                submitSightings.some(
                  (entry) => entry.conversationId === identity.conversationId,
                ),
              ).toBe(true);

              // Model readback: the target canary appears in the live PTY
              // transcript (what the model actually said back).
              expect(ptyText).toContain(targetCanary);

              // Wrong-session isolation, both directions:
              //  - the decoy whisper (seeded on a different route) never reached
              //    this PTY transcript;
              //  - the target canary never reached the decoy's own conversation
              //    or the broker's route bookkeeping.
              expect(ptyText).not.toContain(decoyCanary);
              expect(decoyTurn.resultText).not.toContain(targetCanary);
              expect(
                await remoteConversationBlob(active, decoyTurn.conversationId),
              ).not.toContain(targetCanary);
              expect(JSON.stringify(delivered.routes)).not.toContain(
                targetCanary,
              );
              expect(delivered.deliveries[decoyWhisper.id]?.status).toBe(
                "pending",
              );
              expect(
                delivered.deliveries[decoyWhisper.id]?.acknowledgedAt,
              ).toBeFalsy();

              throw new Error(
                "Passive Letta Code acceptance now passes; update this test and the specification.",
              );
            }

            // The whisper was never delivered after a genuinely typed-and-
            // submitted prompt. Do not fabricate success: capture real evidence
            // of what happened instead.
            //
            // What is confirmed, from this same run:
            //  - SessionStart fired for real through the isolated PTY, with a
            //    real agent_id/conversation_id (that is `identity` above).
            //  - The prompt was genuinely composed keystroke-by-keystroke into
            //    the live TUI (see the transcript excerpt below) -- not just
            //    "sent", but visibly present in the composer.
            //  - Enter was sent as a distinct, later write, matching Letta
            //    Code's own PasteAwareTextInput contract for a real (not
            //    pasted) Enter keypress (src/cli/components/PasteAwareTextInput.tsx:195-215).
            //  - Despite that, the shim-observed hook log (unconditionally
            //    appended at the top of every invocation, hook or not) shows
            //    exactly one invocation for the whole run: the original
            //    SessionStart. No UserPromptSubmit ever reached the broker.
            //
            // Letta Code's own composer contract explains the shape of this:
            // `onSubmit` (src/cli/app/use-submit-handler.ts) returns
            // `{ submitted: false }` -- which restores the typed text instead of
            // clearing it, exactly what the transcript below shows -- from
            // several distinct early-return guards before a message is actually
            // sent (e.g. lines 779, 817), and `runUserPromptSubmitHooks` itself
            // (src/hooks/index.ts:197-228) is one specific call among those
            // guards. Which guard fires cannot be determined from outside the
            // process: this test cannot instrument Letta Code's internal state,
            // only observe its PTY output and hook invocations.
            await terminate(tui.child);
            const finalTrace = await readFile(
              `${active.hookLog}.trace`,
              "utf8",
            ).catch(() => "<missing>");
            const finalPtyTail = scrub(
              await readFile(tui.logFile, "utf8").catch(() => ""),
            ).slice(-3000);
            throw new Error(
              "BLOCKED: a prompt was genuinely typed and submitted through the isolated interactive PTY " +
                `(agent_id=${identity.agentId} conversation_id=${identity.conversationId}, confirmed live via a ` +
                "real SessionStart hook sighting), but no UserPromptSubmit hook invocation followed it within 90s " +
                "and the seeded whisper was never delivered. The composer's own submit contract " +
                "(src/cli/app/use-submit-handler.ts onSubmit, informed by src/hooks/index.ts:197-228 " +
                "runUserPromptSubmitHooks) can silently decline a submission and restore the typed text rather than " +
                "sending it, which is consistent with what was observed here -- but this test cannot see which " +
                "internal guard declined it. Real-process evidence follows.\n" +
                `--- unconditional invocation trace of the "subconscious" command (args + hookMode, logged before ` +
                `any parsing, for every call regardless of success) ---\n${finalTrace}\n` +
                `--- PTY transcript tail (shows the prompt genuinely composed in the input box) ---\n${finalPtyTail}`,
            );
          }

          // PTY automation could not deterministically identify the interactive
          // conversation within the deadline. Do not fabricate success: fall
          // back to one headless turn and record the real-process boundary.
          await terminate(tui.child);
          const blockerEvidence = await runHeadlessTurn(
            active,
            "Reply with exactly NONE. Do not use tools.",
            { newAgent: true },
          );
          const hooks = await hookSightings(active);
          const eventTypes = hooks
            .map((entry) => entry.eventType)
            .filter((event): event is string => Boolean(event));
          expect(eventTypes).not.toContain("SessionStart");
          expect(eventTypes).not.toContain("UserPromptSubmit");
          for (const sighting of hooks) {
            expect(sighting.conversationIdPresent).toBe(false);
            expect(sighting.sessionIdPresent).toBe(false);
          }
          throw new Error(
            "BLOCKED: interactive PTY automation could not deterministically identify the target Letta Code " +
              "conversation within 90s, so no passive whisper could be seeded against a real route. This run " +
              "instead reproduced and evidenced the documented headless limitation as a real-process fact: " +
              `agent_id=${blockerEvidence.agentId} conversation_id=${blockerEvidence.conversationId} completed a ` +
              "headless turn with zero SessionStart/UserPromptSubmit hook sightings, confirming whisper delivery " +
              "is unreachable through the headless entrypoint.",
          );
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.startsWith("BLOCKED:")
          ) {
            throw error;
          }
          expect(error.message).toContain("UserPromptSubmit");
        }
      },
    );
  },
);
