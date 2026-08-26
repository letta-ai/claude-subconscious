import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFingerprint,
  descriptorPath,
  findProjectConfig,
  readBrokerDescriptor,
  removeBrokerFiles,
  sendBrokerRequest,
  type BrokerDescriptor,
  type ContextChannel,
  type DeliveryTarget,
  type HarnessId,
} from "../core/index.js";
import { getAdapter } from "./adapters.js";
import { withHermesHome } from "../adapter-hermes/index.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function enrichHookInput(
  input: Record<string, unknown>,
  harness: HarnessId,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const contextual = {
    ...input,
    working_directory:
      stringValue(input.working_directory) ??
      stringValue(input.cwd) ??
      stringValue(env.LETTA_WORKING_DIR) ??
      stringValue(env.USER_CWD),
  };
  if (harness === "hermes") {
    // The hook subprocess is the only witness of which Hermes profile spawned
    // it; stamp its resolved HERMES_HOME so a broker started by any other
    // harness still reads this session's transcript.
    return withHermesHome(contextual, env);
  }
  if (harness !== "letta-code") return contextual;
  return {
    ...contextual,
    conversation_id:
      stringValue(input.conversation_id) ??
      stringValue(env.CONVERSATION_ID) ??
      stringValue(env.LETTA_CONVERSATION_ID),
    agent_id:
      stringValue(input.agent_id) ??
      stringValue(env.AGENT_ID) ??
      stringValue(env.LETTA_AGENT_ID),
  };
}

async function readStdin(): Promise<unknown> {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input.trim() ? (JSON.parse(input) as unknown) : {};
}

function targetFor(
  harness: HarnessId,
  input: Record<string, unknown>,
): DeliveryTarget | null {
  const workingDirectory =
    stringValue(input.cwd) ?? stringValue(input.working_directory);
  const sessionId =
    stringValue(input.conversation_id) ??
    stringValue(input.session_id) ??
    stringValue(input.thread_id);
  if (!workingDirectory || !sessionId) return null;
  return { harness, sessionId, workingDirectory };
}

function nativeEvent(input: Record<string, unknown>): string | undefined {
  return stringValue(input.hook_event_name) ?? stringValue(input.event_type);
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

/**
 * Where this hook's broker entry point lives.
 *
 * The hook and the broker ship in one directory, so the entry point is the
 * hook's own sibling. Locating it here keeps the spawn path and the identity
 * check reading the same file.
 */
function brokerEntryPath(): string {
  const hookPath = fileURLToPath(import.meta.url);
  return join(dirname(hookPath), `cli${extname(hookPath)}`);
}

/**
 * The build identity a hook requires of the broker it talks to.
 *
 * Exported so an end-to-end test can stand up a broker this hook will accept.
 * Recomputing the rule in the test instead would let the two drift apart, and
 * the failure is silent in the wrong direction: the hook would quietly replace
 * the test's broker with a spawned daemon and the test would still pass.
 */
export async function brokerBuild(): Promise<string> {
  return await buildFingerprint(brokerEntryPath());
}

/**
 * How long a hook may spend getting hold of a usable broker.
 *
 * The harness is waiting on this process. Claude Code allows a tool-boundary
 * hook three seconds and drops it after that, so anything approaching that
 * budget does not buy a late whisper, it loses the whole boundary and the
 * observation with it. A ready broker answers in well under a tenth of that.
 * When one is not ready, giving up now and letting the next boundary use the
 * broker this call started costs one missed whisper, which is what whispers
 * are: passive context that the next boundary can carry just as well.
 */
const BROKER_READY_BUDGET_MS = 250;

/**
 * The broker this hook should talk to, or null to do nothing this time.
 *
 * Starting or replacing a broker is never waited out on the harness's clock.
 * The work is kicked off and this returns, because a broker that is not ready
 * yet is a reason to skip one boundary, not a reason to stall the session.
 */
async function ensureBroker(): Promise<BrokerDescriptor | null> {
  const path = descriptorPath();
  const cliPath = brokerEntryPath();
  const build = await buildFingerprint(cliPath);

  const existing = await readBrokerDescriptor(path);
  if (existing && existing.build === build && (await ping(existing)))
    return existing;

  if (existing && existing.build !== build && (await ping(existing))) {
    // A live broker from another build answers every request with its own
    // behavior, so reusing it silently runs code this hook did not come from.
    // The shutdown is sent without waiting for it: a broker finishing an
    // observer turn can take longer to exit than this hook is allowed to live.
    void sendBrokerRequest(existing, { type: "shutdown" }).catch(() => {});
    return null;
  }

  if (existing && !processExists(existing.pid))
    await removeBrokerFiles(existing, path);
  const child = spawn(
    process.execPath,
    [...process.execArgv, cliPath, "serve"],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    },
  );
  child.unref();
  const deadline = Date.now() + BROKER_READY_BUDGET_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const descriptor = await readBrokerDescriptor(path);
    if (descriptor && descriptor.build === build && (await ping(descriptor)))
      return descriptor;
  }
  return null;
}

async function writeStdout(text: string): Promise<void> {
  if (!text) return;
  if (!process.stdout.write(`${text}\n`)) await once(process.stdout, "drain");
}

/**
 * Render context on the channel the harness accepts, or null when there is
 * nothing to say.
 *
 * A wrong shape fails silently: the harness drops the output and no context
 * reaches the model, so this stays a pure function that tests can pin. Which
 * events accept which channel is the adapter's to decide.
 */
export function formatHookOutput(
  event: string,
  text: string,
  channel: ContextChannel,
): string | null {
  if (!text) return null;
  if (channel === "stdout") return text;
  // Hermes' shell-hook contract for pre_llm_call is a bare {"context": ...}
  // object; its parser accepts no other shape there (shell_hooks.py
  // _parse_response). Emitting the Claude envelope would be silently dropped
  // and the whisper spent unacknowledged-never-seen.
  if (channel === "context") return JSON.stringify({ context: text });
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  });
}

/**
 * Put text in the model's context.
 *
 * The envelope carries one object per event, so every part of a delivery has
 * to be emitted together rather than written out as it is collected.
 */
async function emitContext(
  event: string,
  text: string,
  channel: ContextChannel,
): Promise<void> {
  const output = formatHookOutput(event, text, channel);
  if (output) await writeStdout(output);
}

export async function runHook(harness: HarnessId): Promise<void> {
  const adapter = getAdapter(harness);
  const raw = await readStdin();
  if (!isRecord(raw)) return;
  const input = enrichHookInput(raw, harness);
  const target = targetFor(harness, input);
  if (!target) return;
  const project = await findProjectConfig(target.workingDirectory);
  if (!project) return;
  const descriptor = await ensureBroker();
  if (!descriptor) return;
  const event = nativeEvent(input);

  const channel = event ? adapter.contextChannel(event) : null;
  if (event && channel) {
    // The route is created by SessionStart's observe, which runs below, so the
    // status lands on the first event after it rather than at session start.
    const parts: string[] = [];
    const statusResponse = await sendBrokerRequest(descriptor, {
      type: "claim_session_status",
      target,
    });
    if (
      statusResponse.ok &&
      statusResponse.type === "session_status" &&
      statusResponse.status
    ) {
      parts.push(adapter.formatStatus(statusResponse.status));
    }

    const response = await sendBrokerRequest(descriptor, {
      type: "lease",
      target,
      kind: "whisper",
    });
    const deliveries =
      response.ok && response.type === "leased" ? response.deliveries : [];
    if (deliveries.length > 0) parts.push(adapter.formatWhispers(deliveries));

    if (parts.length > 0) {
      await emitContext(event, parts.join("\n\n"), channel);
      // Acknowledge only after the context is out, so a crash mid-emit
      // redelivers rather than silently dropping the whisper.
      if (deliveries.length > 0) {
        await sendBrokerRequest(descriptor, {
          type: "ack",
          deliveryIds: deliveries.map((delivery) => delivery.id),
        });
      }
    }
  }

  const observation = await adapter.normalizeHookInput(input);
  // A tool boundary is observed only where the project asked for it. The broker
  // refuses the event anyway, so this is not the check that enforces the flag;
  // it keeps a project without the flag from paying a broker round trip on
  // every tool call to be told no.
  const wanted =
    observation?.type !== "tool_result" ||
    Boolean(project.config.observer.midTurn);
  if (observation && wanted) {
    await sendBrokerRequest(descriptor, {
      type: "observe",
      event: observation,
    });
  }
}
