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

async function ensureBroker(): Promise<BrokerDescriptor> {
  const path = descriptorPath();
  const hookPath = fileURLToPath(import.meta.url);
  const cliPath = join(dirname(hookPath), `cli${extname(hookPath)}`);
  const build = await buildFingerprint(cliPath);

  const existing = await readBrokerDescriptor(path);
  if (existing && existing.build === build && (await ping(existing)))
    return existing;
  if (existing && existing.build !== build && (await ping(existing))) {
    // A live broker from another build answers every request with its own
    // behavior, so reusing it silently runs code this hook did not come from.
    await sendBrokerRequest(existing, { type: "shutdown" }).catch(() => {});
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && (await ping(existing))) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
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
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const descriptor = await readBrokerDescriptor(path);
    if (descriptor && (await ping(descriptor))) return descriptor;
  }
  throw new Error("The Subconscious broker did not start within 3 seconds.");
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
  if (!(await findProjectConfig(target.workingDirectory))) return;
  const descriptor = await ensureBroker();
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
  if (observation) {
    await sendBrokerRequest(descriptor, {
      type: "observe",
      event: observation,
    });
  }
}
