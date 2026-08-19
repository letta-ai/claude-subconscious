import { escapeXml } from "./jsonl.js";
import type { SessionStatus } from "./types.js";

const LETTA_APP_BASE = "https://app.letta.com";

function deliveryDescription(status: SessionStatus): string {
  const channels = [
    ...(status.whispers ? ["whispers into your context"] : []),
    ...(status.queuedMessages ? ["queued messages"] : []),
  ];
  if (channels.length === 0) {
    return "It is observing only; no delivery channel is enabled.";
  }
  return `It reaches you through ${channels.join(" and ")}.`;
}

/**
 * Render the session identity the harness would otherwise never see.
 *
 * Shared by every adapter because the banner is plain text in an XML tag; an
 * adapter only needs its own version if its harness wants a different shape.
 */
export function formatSessionStatus(status: SessionStatus): string {
  const lines = [
    "A Subconscious agent is watching this session.",
    deliveryDescription(status),
    `Agent ID: ${status.agentId}`,
    `Model: ${status.model}`,
    `Harness: ${status.harness}`,
    `Project: ${status.projectRoot}`,
  ];
  if (status.conversationId) {
    lines.push(`Conversation: ${status.conversationId}`);
    lines.push(
      `Supervise: ${LETTA_APP_BASE}/agents/${status.agentId}?conversation=${status.conversationId}`,
    );
  } else {
    lines.push(`Supervise: ${LETTA_APP_BASE}/agents/${status.agentId}`);
  }
  return `<subconscious_status>\n${escapeXml(lines.join("\n"))}\n</subconscious_status>`;
}
