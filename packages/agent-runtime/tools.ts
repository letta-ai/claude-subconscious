import { createHash } from "node:crypto";
import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";
import {
  deliveryId,
  type DeliveryInput,
  type DeliveryKind,
  type DeliveryRecord,
} from "../core/index.js";

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface DeliveryToolContext {
  observationId: string;
  routeKey: string;
  allowWhisper: boolean;
  allowQueuedMessage: boolean;
  persist(delivery: DeliveryRecord): Promise<void>;
  now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeInput(value: unknown): DeliveryInput {
  if (!isRecord(value)) throw new Error("Tool input must be an object.");
  if (typeof value.text !== "string" || value.text.trim().length === 0) {
    throw new Error("text must be a non-empty string.");
  }
  if (value.text.length > 20_000)
    throw new Error("text must not exceed 20,000 characters.");
  if (value.dedupeKey !== undefined && typeof value.dedupeKey !== "string") {
    throw new Error("dedupeKey must be a string.");
  }
  if (value.ttlSeconds !== undefined && typeof value.ttlSeconds !== "number") {
    throw new Error("ttlSeconds must be a number.");
  }
  if (
    value.priority !== undefined &&
    value.priority !== "normal" &&
    value.priority !== "high"
  ) {
    throw new Error("priority must be 'normal' or 'high'.");
  }
  return {
    text: value.text.trim(),
    ...(typeof value.dedupeKey === "string" && value.dedupeKey.trim()
      ? { dedupeKey: value.dedupeKey.trim() }
      : {}),
    ...(typeof value.ttlSeconds === "number"
      ? { ttlSeconds: value.ttlSeconds }
      : {}),
    ...(value.priority === "high" ? { priority: "high" } : {}),
  };
}

function fallbackDedupeKey(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function createDelivery(
  kind: DeliveryKind,
  input: DeliveryInput,
  context: DeliveryToolContext,
): DeliveryRecord {
  const now = context.now?.() ?? new Date();
  const ttlSeconds = Math.max(
    60,
    Math.min(
      MAX_TTL_SECONDS,
      Math.floor(input.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    ),
  );
  const dedupeKey = input.dedupeKey ?? fallbackDedupeKey(input.text);
  return {
    id: deliveryId(context.observationId, kind, dedupeKey),
    routeKey: context.routeKey,
    observationId: context.observationId,
    kind,
    text: input.text,
    priority: input.priority ?? "normal",
    dedupeKey,
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
    attempts: 0,
  };
}

function deliveryTool(
  kind: DeliveryKind,
  context: DeliveryToolContext,
): AnyAgentTool {
  const whisper = kind === "whisper";
  return {
    name: whisper ? "send_whisper" : "queue_message",
    label: whisper ? "Send Whisper" : "Queue Message",
    description: whisper
      ? "Send concise passive context at the start of the next supported harness turn. Use only when the guidance changes the next step."
      : "Queue one actionable message in the current harness session. Use only when the adapter exposes a verified queue.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 20_000 },
        dedupeKey: { type: "string" },
        ...(whisper
          ? {
              ttlSeconds: {
                type: "number",
                minimum: 60,
                maximum: MAX_TTL_SECONDS,
              },
              priority: { type: "string", enum: ["normal", "high"] },
            }
          : {}),
      },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, args) => {
      try {
        const input = normalizeInput(args);
        const delivery = createDelivery(kind, input, context);
        await context.persist(delivery);
        return {
          content: [
            { type: "text", text: `Accepted delivery ${delivery.id}.` },
          ],
          details: { deliveryId: delivery.id },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }
    },
  };
}

export function createDeliveryTools(
  context: DeliveryToolContext,
): AnyAgentTool[] {
  const tools: AnyAgentTool[] = [];
  if (context.allowWhisper) tools.push(deliveryTool("whisper", context));
  if (context.allowQueuedMessage)
    tools.push(deliveryTool("queued_message", context));
  return tools;
}
