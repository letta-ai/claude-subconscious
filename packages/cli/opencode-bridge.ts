import {
  findProjectConfig,
  sendBrokerRequest,
  type BrokerDescriptor,
} from "../core/index.js";
import { getAdapter } from "./adapters.js";
import { ensureBroker } from "./hook.js";

/**
 * The hidden bridge between the generated OpenCode plugin and the broker.
 *
 * The plugin owns every native OpenCode hook, but it must never reuse
 * runHook's write-stdout-then-auto-acknowledge path: passive context there is
 * a mutation of `output.system` that only the plugin can perform, so delivery
 * splits into two operations — lease here, mutate in-process, acknowledge in a
 * second call — with no acknowledgement unless the mutation succeeded.
 *
 * The bridge is also where broker startup and build matching stay consistent
 * with every hook: it reuses the same bounded `ensureBroker`, so a stale or
 * foreign-build daemon is treated exactly as Claude Code's hooks treat one.
 *
 * Protocol: newline-delimited JSON over stdin/stdout, one response per
 * request. Every operation is bounded; a slow broker costs the single request,
 * never the host session.
 */

export interface BridgeTarget {
  harness: "opencode";
  sessionId: string;
  workingDirectory: string;
}

export type BridgeRequest =
  | { id: string; op: "info"; target: BridgeTarget }
  | { id: string; op: "delivery_window"; target: BridgeTarget }
  | { id: string; op: "ack"; deliveryIds: string[] }
  | { id: string; op: "observe"; event: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseRequest(raw: unknown): BridgeRequest | null {
  if (!isRecord(raw)) return null;
  const id = stringValue(raw.id);
  if (!id) return null;
  const target = isRecord(raw.target) ? raw.target : undefined;
  const resolvedTarget: BridgeTarget | null =
    target &&
    stringValue(target.harness) === "opencode" &&
    stringValue(target.sessionId) &&
    stringValue(target.workingDirectory)
      ? {
          harness: "opencode",
          sessionId: stringValue(target.sessionId)!,
          workingDirectory: stringValue(target.workingDirectory)!,
        }
      : null;
  switch (raw.op) {
    case "info":
      return resolvedTarget ? { id, op: "info", target: resolvedTarget } : null;
    case "delivery_window":
      return resolvedTarget
        ? { id, op: "delivery_window", target: resolvedTarget }
        : null;
    case "ack": {
      const ids = Array.isArray(raw.deliveryIds)
        ? raw.deliveryIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      return { id, op: "ack", deliveryIds: ids };
    }
    case "observe":
      return { id, op: "observe", event: raw.event };
    default:
      return null;
  }
}

/**
 * One bridge connection's worth of state: the broker descriptor this process
 * has already vetted. A failed request clears it so the next operation pays
 * for a fresh liveness check instead of retrying a dead socket forever.
 */
export class OpencodeBridge {
  private descriptor: BrokerDescriptor | null = null;

  private async broker(): Promise<BrokerDescriptor | null> {
    if (this.descriptor) return this.descriptor;
    this.descriptor = await ensureBroker();
    return this.descriptor;
  }

  async handle(raw: unknown): Promise<Record<string, unknown>> {
    const request = parseRequest(raw);
    if (!request)
      return { id: "", ok: false, error: "Invalid bridge request." };
    try {
      switch (request.op) {
        case "info": {
          // The project check decides whether the plugin fetches snapshots at
          // tool boundaries at all: an unconfigured project gets no fetches,
          // no enqueues, and no broker traffic from tool events.
          const project = await findProjectConfig(
            request.target.workingDirectory,
          );
          return {
            id: request.id,
            ok: true,
            project: Boolean(project?.config.agentId),
            midTurn: Boolean(project?.config.observer.midTurn),
          };
        }
        case "delivery_window": {
          const descriptor = await this.broker();
          if (!descriptor)
            return {
              id: request.id,
              ok: false,
              error: "No usable Subconscious broker.",
            };
          const statusResponse = await sendBrokerRequest(descriptor, {
            type: "claim_session_status",
            target: request.target,
          });
          const status =
            statusResponse.ok &&
            statusResponse.type === "session_status" &&
            statusResponse.status
              ? statusResponse.status
              : null;
          const leaseResponse = await sendBrokerRequest(descriptor, {
            type: "lease",
            target: request.target,
            kind: "whisper",
          });
          const deliveries =
            leaseResponse.ok && leaseResponse.type === "leased"
              ? leaseResponse.deliveries
              : [];
          return {
            id: request.id,
            ok: true,
            status,
            deliveries,
          };
        }
        case "ack": {
          const descriptor = await this.broker();
          if (!descriptor)
            return {
              id: request.id,
              ok: false,
              error: "No usable Subconscious broker.",
            };
          const response = await sendBrokerRequest(descriptor, {
            type: "ack",
            deliveryIds: request.deliveryIds,
          });
          if (!response.ok)
            return { id: request.id, ok: false, error: response.error };
          return { id: request.id, ok: true };
        }
        case "observe": {
          const descriptor = await this.broker();
          if (!descriptor)
            return {
              id: request.id,
              ok: false,
              error: "No usable Subconscious broker.",
            };
          // Normalization lives here, in package code the plugin cannot
          // drift from: the plugin forwards native identities and raw
          // snapshots, and the adapter decides what any of it means.
          const event = await getAdapter("opencode").normalizeHookInput(
            request.event,
          );
          if (!event)
            return {
              id: request.id,
              ok: true,
              accepted: false,
              reason: "The payload did not describe an observable event.",
            };
          const response = await sendBrokerRequest(descriptor, {
            type: "observe",
            event,
          });
          if (!response.ok)
            return { id: request.id, ok: false, error: response.error };
          return {
            id: request.id,
            ok: true,
            accepted: response.type === "observed" ? response.accepted : false,
          };
        }
      }
    } catch (error) {
      // A failed request invalidates the cached broker: the next operation
      // re-runs the bounded startup path rather than hammering a dead socket.
      this.descriptor = null;
      return {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * Serve bridge requests until stdin closes.
 *
 * Responses are written one line each, in request order. A malformed line gets
 * a structured rejection rather than killing the pipe: the plugin retries on
 * its next operation either way, but a clean answer keeps its log quiet.
 */
export async function runOpencodeBridge(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const bridge = new OpencodeBridge();
  let buffer = "";
  // Handlers run strictly in request order: every operation is bounded and
  // local, the host awaits hook callbacks sequentially anyway, and a single
  // ordered pipeline keeps stdout trivially well-formed.
  let chain = Promise.resolve();
  await new Promise<void>((resolve) => {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          parsed = null;
        }
        chain = chain
          .then(() =>
            bridge
              .handle(parsed)
              .then((response) =>
                writeLine(output, `${JSON.stringify(response)}\n`),
              )
              .catch(() => {}),
          )
          .catch(() => {});
      }
    });
    input.on("end", resolve);
    input.on("error", resolve);
    input.on("close", resolve);
  });
  await chain;
}

async function writeLine(output: NodeJS.WritableStream, line: string) {
  if (!output.write(line)) {
    await new Promise<void>((resolve) => output.once("drain", resolve));
  }
}
