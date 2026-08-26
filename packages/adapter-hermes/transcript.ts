import { join } from "node:path";
import type { SourceCursor } from "../core/index.js";

/**
 * Read new session rows from a Hermes state.db, read-only.
 *
 * Hermes 0.20.5 persists the canonical transcript in
 * `$HERMES_HOME/state.db`, table `messages`, with an autoincrement `id` that
 * is a natural cursor — stronger than the file size/mtime markers the JSONL
 * harnesses need, because it never moves backward and survives rewrites.
 *
 * `node:sqlite` is imported lazily inside this function rather than at module
 * top level: the adapter registry loads for every hook of every harness, and
 * an eager experimental-module import would print an ExperimentalWarning to
 * stderr from Claude/Codex/Letta hooks that never touch Hermes.
 *
 * The database may be live (Hermes holds it open with WAL sidecars), so this
 * opens `readOnly` and never creates or migrates anything. Every failure mode
 * — missing file, missing table, locked schema — throws, and the adapter's
 * caller turns that into a labelled observation rather than a dropped one:
 * fail open, lose the delta, keep the session.
 */
export interface SqliteDelta {
  records: Record<string, unknown>[];
  nextCursor: SourceCursor;
  /** True when rows exist beyond this page; the next boundary reads them. */
  truncated: boolean;
  /** How many rows this page carries. */
  readRows: number;
}

export const PAGE_SIZE = 400;

export async function readSqliteDelta(
  hermesHome: string,
  sessionId: string,
  cursor: SourceCursor | undefined,
): Promise<SqliteDelta> {
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(hermesHome, "state.db");
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const requested =
      typeof cursor?.sequence === "number" ? cursor.sequence : null;
    // A cursor above every surviving row means the store was pruned or
    // replaced underneath us. Holding an unreachable cursor would replay
    // nothing forever, so reset to zero and let the new session report from
    // its beginning instead.
    if (requested !== null) {
      // Scoped to this session: message ids are global across Hermes sessions,
      // so an unscoped MAX(id) could hide a pruned/replaced target session
      // behind unrelated newer ones and leave its cursor unreachable forever.
      const highRow = database
        .prepare("SELECT MAX(id) AS id FROM messages WHERE session_id = ?")
        .get(sessionId) as { id: number | null } | undefined;
      const high = highRow?.id ?? null;
      if (high !== null && requested > high) {
        return await readFrom(database, sessionId, null);
      }
      // A cursor above every surviving row of a session that has no rows at
      // all is equally unreachable; treat it as reset too.
      if (high === null && requested > 0) {
        return await readFrom(database, sessionId, null);
      }
    }
    return await readFrom(database, sessionId, requested);
  } finally {
    database.close();
  }
}

async function readFrom(
  database: unknown,
  sessionId: string,
  after: number | null,
): Promise<SqliteDelta> {
  const db = database as {
    prepare(sql: string): {
      get(...args: unknown[]): unknown;
      all(...args: unknown[]): unknown[];
    };
  };
  const rows = db
    .prepare(
      `SELECT id, role, content, tool_calls, tool_name, timestamp, finish_reason
       FROM messages WHERE session_id = ? AND (? IS NULL OR id > ?)
       ORDER BY id ASC LIMIT ?`,
    )
    .all(sessionId, after, after, PAGE_SIZE + 1) as Array<
    Record<string, unknown>
  >;
  const truncated = rows.length > PAGE_SIZE;
  const kept = truncated ? rows.slice(0, PAGE_SIZE) : rows;
  const lastId =
    kept.length > 0 && typeof kept[kept.length - 1].id === "number"
      ? (kept[kept.length - 1].id as number)
      : // No rows in range: hold the cursor where it was rather than advancing
        // past rows a concurrent writer may still commit under an id we never
        // observed.
        (after ?? 0);
  return {
    records: kept,
    nextCursor: { sequence: lastId },
    truncated,
    readRows: kept.length,
  };
}
