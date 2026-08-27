import { escapeXml } from "./jsonl.js";
import type { SessionStatus } from "./types.js";

/**
 * Render the session identity the harness would otherwise never see.
 *
 * Shared by every adapter because the banner is plain text in an XML tag; an
 * adapter only needs its own version if its harness wants a different shape.
 */
export function formatSessionStatus(status: SessionStatus): string {
  const conversation = status.conversationId
    ? ` conversation_id="${escapeXml(status.conversationId)}"`
    : "";
  return `<subconscious_status agent_id="${escapeXml(status.agentId)}"${conversation} />`;
}
