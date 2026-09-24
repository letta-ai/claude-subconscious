import { escapeXml } from "./jsonl.js";
import type { DeliveryRecord } from "./types.js";

/**
 * The line every whisper carries, whatever the observer wrote.
 *
 * The observer is told to cite its sources, but the agent reading a whisper
 * should not depend on it having done so. This framing comes from the
 * harness side, so the agent always knows where the text came from and that
 * the code in front of it outranks it.
 */
export const WHISPER_PREAMBLE =
  "From Subconscious, a one-way channel carrying memory from outside this session. It may be stale: current source code and tool output take precedence, so verify before relying on it.";

/**
 * Render leased whispers as passive context.
 *
 * Shared by every adapter so the preamble cannot drift between harnesses; an
 * adapter only needs its own version if its harness wants a different shape.
 */
export function formatWhispers(deliveries: DeliveryRecord[]): string {
  return deliveries
    .map(
      (delivery) =>
        `<subconscious_whisper delivery_id="${escapeXml(delivery.id)}">\n${WHISPER_PREAMBLE}\n\n${escapeXml(delivery.text)}\n</subconscious_whisper>`,
    )
    .join("\n\n");
}
