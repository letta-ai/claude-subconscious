import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceCursor } from "../packages/core/index.js";
import {
  hermesAdapter,
  hermesHomeFor,
  summarizeRow,
  toolFailed,
  withHermesHome,
} from "../packages/adapter-hermes/index.js";
import { formatHookOutput } from "../packages/cli/hook.js";
import {
  PAGE_SIZE,
  readSqliteDelta,
} from "../packages/adapter-hermes/transcript.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "subconscious-hermes-"));
  roots.push(value);
  return value;
}

const HOME = "/tmp/hermes-profile";

/**
 * Source-faithful pre_llm_call payload.
 *
 * Verified against Hermes shell_hooks `_serialize_payload`: only
 * hook_event_name, tool_name, tool_input, session_id, cwd ride the top level;
 * everything else — including user_message — arrives under `extra`.
 */
function preLlmPayload(overrides: Record<string, unknown> = {}) {
  return {
    hook_event_name: "pre_llm_call",
    tool_name: null,
    tool_input: null,
    session_id: "20260825_120000_abcd12",
    cwd: "/Users/cameron/project",
    extra: {
      user_message: "Refactor the broker loop.",
      turn_id: "turn-1",
      task_id: "",
      model: "anthropic/claude-sonnet-4",
      platform: "cli",
      is_first_turn: false,
      conversation_history: [{ role: "user", content: "huge transcript" }],
    },
    _hermes_home: HOME,
    ...overrides,
  };
}

/** Source-faithful on_session_end payload (flags live in extra). */
function sessionEndPayload(overrides: Record<string, unknown> = {}) {
  return {
    hook_event_name: "on_session_end",
    tool_name: null,
    tool_input: null,
    session_id: "20260825_120000_abcd12",
    cwd: "/Users/cameron/project",
    extra: {
      turn_id: "turn-1",
      task_id: "",
      completed: true,
      interrupted: false,
      model: "anthropic/claude-sonnet-4",
      platform: "cli",
    },
    _hermes_home: HOME,
    ...overrides,
  };
}

/** Source-faithful post_tool_call payload (status/error fields in extra). */
function postToolPayload(overrides: Record<string, unknown> = {}) {
  return {
    hook_event_name: "post_tool_call",
    tool_name: "terminal",
    tool_input: { command: "ls" },
    session_id: "20260825_120000_abcd12",
    cwd: "/Users/cameron/project",
    extra: {
      result: "x".repeat(100_000),
      status: "error",
      error_type: "ValueError",
      error_message: "boom",
      duration_ms: 12,
      turn_id: "t9",
      tool_call_id: "c9",
    },
    _hermes_home: HOME,
    ...overrides,
  };
}

describe("hermes adapter normalization", () => {
  it("maps the four supported events", async () => {
    const base = { session_id: "s1", cwd: "/p" };
    expect(
      (
        await hermesAdapter.normalizeHookInput({
          ...base,
          hook_event_name: "on_session_start",
          extra: { model: "m", platform: "cli" },
          _hermes_home: HOME,
        })
      )?.type,
    ).toBe("session_start");
    expect(
      (await hermesAdapter.normalizeHookInput(preLlmPayload()))?.type,
    ).toBe("user_prompt");
    expect(
      (await hermesAdapter.normalizeHookInput(postToolPayload()))?.type,
    ).toBe("tool_result");
    expect(
      (await hermesAdapter.normalizeHookInput(sessionEndPayload()))?.type,
    ).toBe("turn_stop");
    // Unsupported events normalize to null.
    expect(
      await hermesAdapter.normalizeHookInput({
        ...base,
        hook_event_name: "pre_tool_call",
      }),
    ).toBeNull();
  });

  it("lifts bounded extra fields and drops conversation_history", async () => {
    const event = await hermesAdapter.normalizeHookInput(preLlmPayload());
    expect(event).not.toBeNull();
    const payload = event!.payload;
    // The prompt was lifted out of extra and survives normalization.
    expect(payload.user_message).toBe("Refactor the broker loop.");
    expect(payload.turn_id).toBe("turn-1");
    expect(payload.model).toBe("anthropic/claude-sonnet-4");
    expect(payload.platform).toBe("cli");
    expect(payload._hermes_home).toBe(HOME);
    // The unbounded conversation history must never reach broker state.
    expect(JSON.stringify(payload)).not.toContain("huge transcript");
  });

  it("reads turn-stop flags from nested extra", async () => {
    const event = await hermesAdapter.normalizeHookInput(sessionEndPayload());
    expect(event!.payload).toMatchObject({
      completed: true,
      interrupted: false,
      failed: false,
      turn_id: "turn-1",
      _hermes_home: HOME,
    });
  });

  it("keeps mid-turn payloads minimal but preserves the home stamp and error flag", async () => {
    const event = await hermesAdapter.normalizeHookInput(postToolPayload());
    expect(event!.payload).toMatchObject({
      session_id: "20260825_120000_abcd12",
      cwd: "/Users/cameron/project",
      _hermes_home: HOME,
      tool_name: "terminal",
      tool_error: true,
      turn_id: "t9",
      tool_call_id: "c9",
    });
    expect(JSON.stringify(event!.payload)).not.toContain("x".repeat(1000));
  });

  it("separates two prompts of one kind with native identity", async () => {
    const first = await hermesAdapter.normalizeHookInput(preLlmPayload());
    const second = await hermesAdapter.normalizeHookInput(
      preLlmPayload({
        extra: {
          user_message: "Second prompt.",
          turn_id: "turn-2",
          task_id: "",
          model: "m",
          platform: "cli",
        },
      }),
    );
    expect(first!.id).not.toBe(second!.id);
  });
});

describe("tool failure classification", () => {
  it("reads Hermes status and falls back to legacy flags", () => {
    expect(toolFailed({ status: "error" })).toBe(true);
    expect(toolFailed({ status: "blocked" })).toBe(true);
    expect(toolFailed({ status: "ok" })).toBe(false);
    expect(toolFailed({})).toBe(false);
    expect(toolFailed({ success: false })).toBe(true);
    expect(toolFailed({ status: "weird" })).toBe(false);
  });
});

describe("context channel", () => {
  it("claims only pre_llm_call, on the bare context channel", () => {
    expect(hermesAdapter.contextChannel("pre_llm_call")).toBe("context");
    expect(hermesAdapter.contextChannel("post_tool_call")).toBeNull();
    expect(hermesAdapter.contextChannel("on_session_start")).toBeNull();
    expect(hermesAdapter.contextChannel("on_session_end")).toBeNull();
    expect(hermesAdapter.capabilities).toEqual({
      passiveContext: true,
      queuedMessage: false,
      transcript: "file",
    });
  });

  it("emits exact Hermes bytes for the context channel", () => {
    expect(formatHookOutput("pre_llm_call", "hello", "context")).toBe(
      JSON.stringify({ context: "hello" }),
    );
    expect(formatHookOutput("pre_llm_call", "", "context")).toBeNull();
    // The other channels keep their existing shapes.
    expect(formatHookOutput("e", "hi", "stdout")).toBe("hi");
    expect(formatHookOutput("e", "hi", "envelope")).toBe(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "e", additionalContext: "hi" },
      }),
    );
  });
});

describe("hermes home resolution", () => {
  it("stamps a resolved home even when HERMES_HOME is unset", () => {
    const stamped = withHermesHome({}, {});
    expect(typeof stamped._hermes_home).toBe("string");
    expect((stamped._hermes_home as string).length).toBeGreaterThan(0);
    // An existing stamp is never overwritten.
    expect(withHermesHome({ _hermes_home: "/custom" }, {})._hermes_home).toBe(
      "/custom",
    );
  });

  it("never trusts the broker environment when reading an event", () => {
    expect(hermesHomeFor({ _hermes_home: "/event/home" })).toBe("/event/home");
    // No stamp: platform default, not process.env.
    const before = process.env.HERMES_HOME;
    process.env.HERMES_HOME = "/broker/leak";
    try {
      expect(hermesHomeFor({})).not.toBe("/broker/leak");
    } finally {
      if (before === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = before;
    }
  });

  it("resolves profiles through active_profile with validated names", async () => {
    const directory = await root();
    const { resolveHermesHome } = await import(
      "../packages/cli/install-hermes.js"
    );
    // A HERMES_HOME already inside profiles/ is final.
    expect(
      resolveHermesHome({
        HERMES_HOME: join(directory, "root/profiles/coder"),
      }),
    ).toBe(join(directory, "root/profiles/coder"));
    // Otherwise active_profile is followed.
    await mkdir(join(directory, "root"), { recursive: true });
    await writeFile(join(directory, "root", "active_profile"), "coder\n");
    expect(resolveHermesHome({ HERMES_HOME: join(directory, "root") })).toBe(
      join(directory, "root/profiles/coder"),
    );
    // Invalid profile names are rejected.
    await writeFile(join(directory, "root", "active_profile"), "../evil\n");
    expect(resolveHermesHome({ HERMES_HOME: join(directory, "root") })).toBe(
      join(directory, "root"),
    );
  });

  it("stamps the active profile's home when HERMES_HOME names a plain root", async () => {
    // Regression: withHermesHome used to stamp raw env.HERMES_HOME, so a hook
    // fired by a non-default active profile (the gateway shape: HERMES_HOME at
    // the root, active_profile naming the real profile) stamped the root and
    // the broker read the wrong state.db.
    const directory = await root();
    await mkdir(join(directory, "root/profiles/coder"), { recursive: true });
    await writeFile(join(directory, "root", "active_profile"), "coder\n");

    // HERMES_HOME pointing at a plain root: active_profile must be honored
    // and the profile directory stamped.
    const stampedRoot = withHermesHome({}, {
      HERMES_HOME: join(directory, "root"),
    } as NodeJS.ProcessEnv);
    expect(stampedRoot._hermes_home).toBe(
      join(directory, "root/profiles/coder"),
    );

    // A payload that already carries a stamp is never rewritten.
    expect(withHermesHome({ _hermes_home: "/already/stamped" }, {})).toEqual({
      _hermes_home: "/already/stamped",
    });

    // Default marker ("default") resolves to the root itself, not profiles/.
    await mkdir(join(directory, "root2"), { recursive: true });
    await writeFile(join(directory, "root2", "active_profile"), "default\n");
    const stampedDefault = withHermesHome({}, {
      HERMES_HOME: join(directory, "root2"),
    } as NodeJS.ProcessEnv);
    expect(stampedDefault._hermes_home).toBe(join(directory, "root2"));

    // Invalid marker falls back to the named root.
    await writeFile(join(directory, "root2", "active_profile"), "../evil\n");
    const stampedInvalid = withHermesHome({}, {
      HERMES_HOME: join(directory, "root2"),
    } as NodeJS.ProcessEnv);
    expect(stampedInvalid._hermes_home).toBe(join(directory, "root2"));
  });
});

// ── Synthetic state.db tests ────────────────────────────────────────────────

async function makeDb(home: string): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  await mkdir(home, { recursive: true });
  const db = new DatabaseSync(join(home, "state.db"));
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    timestamp REAL NOT NULL DEFAULT 0,
    finish_reason TEXT
  )`);
  db.close();
}

async function insertRows(
  home: string,
  sessionId: string | null,
  count: number,
  startRole = "user",
): Promise<number[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(home, "state.db"), { readOnly: false });
  const ids: number[] = [];
  const stmt = db.prepare(
    `INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)`,
  );
  for (let index = 0; index < count; index += 1) {
    const result = stmt.run(
      sessionId ?? "other-session",
      `${startRole}${index}`,
      `row-${index}`,
    );
    ids.push(Number(result.lastInsertRowid));
  }
  db.close();
  return ids;
}

describe("readSqliteDelta (synthetic state.db)", () => {
  it("filters by session and returns row-id cursors", async () => {
    const home = await root();
    await makeDb(home);
    await insertRows(home, null, 3); // unrelated session rows must be skipped
    const mine = await insertRows(home, "s1", 2);
    const delta = await readSqliteDelta(home, "s1", undefined);
    expect(delta.records).toHaveLength(2);
    expect(delta.truncated).toBe(false);
    expect(delta.nextCursor.sequence).toBe(mine[mine.length - 1]);
    // Only this session's ids appear; the unrelated session's rows are gone.
    expect(delta.records.every((record) => Number(record.id) > 3)).toBe(true);
  });

  it("pages ascending without omission when backlog exceeds PAGE_SIZE", async () => {
    const home = await root();
    await makeDb(home);
    await insertRows(home, "s1", PAGE_SIZE + 30);
    let cursor: SourceCursor | undefined = undefined;
    const seen: string[] = [];
    let pages = 0;
    for (;;) {
      const delta = await readSqliteDelta(home, "s1", cursor);
      pages += 1;
      for (const record of delta.records) seen.push(String(record.content));
      if (!delta.truncated) break;
      cursor = delta.nextCursor;
      expect(pages).toBeLessThan(10); // safety bound
    }
    expect(pages).toBe(2);
    expect(seen).toHaveLength(PAGE_SIZE + 30);
    expect(seen[0]).toBe("row-0");
    expect(seen[seen.length - 1]).toBe(`row-${PAGE_SIZE + 29}`);
  });

  it("resets an unreachable cursor scoped to the target session", async () => {
    const home = await root();
    await makeDb(home);
    const mine = await insertRows(home, "s1", 3); // ids 1..3
    // Other-session rows get global ids 4..53 — above any cursor we hold.
    await insertRows(home, "other", 50);
    // Cursor sits between s1's max (3) and the global max: only a
    // session-scoped MAX(id) recognizes this as unreachable. An unscoped
    // check would see id 53 >= 20 and wrongly hold the dead cursor forever.
    const delta = await readSqliteDelta(home, "s1", { sequence: 20 });
    expect(delta.records.length).toBeGreaterThan(0);
    expect(delta.nextCursor.sequence).toBe(mine[mine.length - 1]);
  });

  it("holds the cursor when a session has no new rows", async () => {
    const home = await root();
    await makeDb(home);
    const ids = await insertRows(home, "s1", 2);
    const first = await readSqliteDelta(home, "s1", undefined);
    expect(first.records).toHaveLength(2);
    const again = await readSqliteDelta(home, "s1", first.nextCursor);
    expect(again.records).toHaveLength(0);
    expect(again.nextCursor.sequence).toBe(ids[ids.length - 1]);
  });

  it("fails open through prepareObservation when the DB is missing", async () => {
    const home = await root(); // no state.db at all
    const event = await hermesAdapter.normalizeHookInput(
      sessionEndPayload({ cwd: "/p", _hermes_home: home }),
    );
    const prepared = await hermesAdapter.prepareObservation(event!, undefined);
    // The observation still reports, labelled rather than dropped.
    expect(prepared.text).toContain("session store could not be read");
    // And no cursor advances past a store that was never read.
    expect(prepared.nextCursor).toBeUndefined();
  });
});

describe("transcript summarization", () => {
  it("summarizes text rows, tool rows, tool calls with args, and skips meta", () => {
    expect(summarizeRow({ role: "session_meta", content: "{}" })).toBeNull();
    expect(summarizeRow({ role: "user", content: "hello world" })).toContain(
      "hello world",
    );
    // Tool result row keeps its tool name alongside its output.
    const toolRow = summarizeRow({
      role: "tool",
      content: "output",
      tool_name: "terminal",
    });
    expect(toolRow).toContain("output");
    expect(toolRow).toContain("[tool:terminal]");
    // Assistant row with both text and tool calls reports both.
    const assistant = summarizeRow({
      role: "assistant",
      content: "Let me check.",
      tool_calls: JSON.stringify([
        { function: { name: "file_read", arguments: '{"path":"/a/b"}' } },
      ]),
    });
    expect(assistant).toContain("Let me check.");
    expect(assistant).toContain("file_read");
    expect(assistant).toContain("/a/b");
    // JSON-encoded content arrays decode.
    expect(
      summarizeRow({
        role: "assistant",
        content: '[{"type":"text","text":"decoded"}]',
      }),
    ).toContain("decoded");
  });
});
