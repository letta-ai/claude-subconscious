import { createHash } from "node:crypto";
import type { HarnessId, RouteRecord } from "./types.js";

export interface RouteIdentity {
  configPath: string;
  projectRoot: string;
  agentId: string;
  harness: HarnessId;
  sessionId: string;
}

export function routeKey(identity: RouteIdentity): string {
  const input = [
    identity.configPath,
    identity.projectRoot,
    identity.agentId,
    identity.harness,
    identity.sessionId,
  ].join("\0");
  return createHash("sha256").update(input).digest("hex");
}

export function createRouteRecord(
  identity: RouteIdentity,
  now = new Date().toISOString(),
): RouteRecord {
  return {
    key: routeKey(identity),
    ...identity,
    conversationId: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function deliveryId(
  observationId: string,
  kind: "whisper" | "queued_message",
  dedupeKey: string,
): string {
  return createHash("sha256")
    .update(`${observationId}\0${kind}\0${dedupeKey}`)
    .digest("hex");
}

export function eventId(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
