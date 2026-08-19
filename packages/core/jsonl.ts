import { open, stat } from "node:fs/promises";
import type { SourceCursor } from "./types.js";

const MAX_DELTA_BYTES = 1024 * 1024;

export interface JsonlDelta {
  records: Record<string, unknown>[];
  nextCursor: SourceCursor;
  skippedBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonlDelta(
  path: string,
  cursor: SourceCursor | undefined,
): Promise<JsonlDelta> {
  const fileStat = await stat(path);
  const fileSize = fileStat.size;
  const previousOffset = cursor?.offset ?? 0;
  const validOffset = previousOffset <= fileSize ? previousOffset : 0;
  const boundedOffset = Math.max(validOffset, fileSize - MAX_DELTA_BYTES);
  const skippedBytes = boundedOffset - validOffset;
  const length = fileSize - boundedOffset;
  const bytes = Buffer.alloc(length);
  const handle = await open(path, "r");
  try {
    if (length > 0) await handle.read(bytes, 0, length, boundedOffset);
  } finally {
    await handle.close();
  }

  let start = 0;
  if (boundedOffset > validOffset) {
    const firstNewline = bytes.indexOf(0x0a);
    start = firstNewline >= 0 ? firstNewline + 1 : bytes.length;
  }
  const lastNewline = bytes.lastIndexOf(0x0a);
  const end = lastNewline >= start ? lastNewline + 1 : start;
  const chunk = bytes.subarray(start, end).toString("utf8");

  const records: Record<string, unknown>[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // Ignore a partial or malformed record. The next Stop event can include it again.
    }
  }

  return {
    records,
    nextCursor: { offset: boundedOffset + end },
    skippedBytes,
  };
}

export function truncateText(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  return `${text.slice(0, maximum)}\n[truncated]`;
}

export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
