import { describe, expect, it } from "vitest";
import {
  normalizeSnapshot,
  opencodeAdapter,
  renderDelta,
  type TranscriptRecord,
} from "../packages/adapter-opencode/index.js";

function snapshot(messages: unknown[]) {
  return { messages };
}

function textMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
  partId = `${id}-part`,
) {
  return {
    info: { id, role },
    parts: [{ id: partId, type: "text", text }],
  };
}

function toolMessage(options: {
  id: string;
  role?: "user" | "assistant";
  callId: string;
  tool: string;
  status: "completed" | "error";
  output?: string;
  error?: string;
}) {
  return {
    info: { id: options.id, role: options.role ?? "assistant" },
    parts: [
      {
        id: `${options.id}-tool`,
        type: "tool",
        callID: options.callId,
        tool: options.tool,
        state: {
          status: options.status,
          ...(options.output ? { output: options.output } : {}),
          ...(options.error ? { error: options.error } : {}),
        },
      },
    ],
  };
}

describe("opencode adapter", () => {
  it("maps the supported events and keeps native identities distinct", async () => {
    const directory = "/project/opencode";
    const shared = { session_id: "session-1", cwd: directory };
    const built = snapshot([
      textMessage("m1", "user", "Ship the fix."),
      toolMessage({
        id: "m2",
        callId: "call-1",
        tool: "Read",
        status: "completed",
        output: "done",
      }),
    ]);

    const created = await opencodeAdapter.normalizeHookInput({
      ...shared,
      event: "session_created",
    });
    const prompt = await opencodeAdapter.normalizeHookInput({
      ...shared,
      event: "user_prompt",
      message_id: "message-1",
      prompt_text: "Ship the fix.",
    });
    const tool = await opencodeAdapter.normalizeHookInput({
      ...shared,
      event: "tool_result",
      call_id: "call-1",
      tool: "Read",
      snapshot: built,
    });
    const stop = await opencodeAdapter.normalizeHookInput({
      ...shared,
      event: "turn_stop",
      snapshot: built,
    });
    const ended = await opencodeAdapter.normalizeHookInput({
      ...shared,
      event: "session_end",
    });

    expect(created?.type).toBe("session_start");
    expect(prompt?.type).toBe("user_prompt");
    expect(tool?.type).toBe("tool_result");
    expect(stop?.type).toBe("turn_stop");
    expect(ended?.type).toBe("session_end");
    expect(
      new Set([created?.id, prompt?.id, tool?.id, stop?.id, ended?.id]).size,
    ).toBe(5);
    await expect(
      opencodeAdapter.normalizeHookInput({ ...shared, event: "session.idle" }),
    ).resolves.toBeNull();
  });

  it("reports prompt boundaries directly and never advances the cursor", async () => {
    const event = await opencodeAdapter.normalizeHookInput({
      event: "user_prompt",
      session_id: "session-1",
      cwd: "/project/opencode",
      prompt_text: "Check the release order.",
    });

    expect(await opencodeAdapter.prepareObservation(event!, undefined)).toEqual(
      {
        text: "OpenCode user prompt:\nCheck the release order.",
      },
    );

    const missing = await opencodeAdapter.normalizeHookInput({
      event: "user_prompt",
      session_id: "session-1",
      cwd: "/project/opencode",
    });
    expect(
      (await opencodeAdapter.prepareObservation(missing!, undefined)).text,
    ).toBe("OpenCode user prompt submitted with no readable prompt text.");
  });

  it("keeps a bounded recent snapshot tail", () => {
    const records = normalizeSnapshot(
      snapshot(
        Array.from({ length: 40 }, (_, index) =>
          textMessage(`m${index}`, "assistant", `tail-${index}`),
        ),
      ),
    );

    expect(records).toHaveLength(30);
    expect(records[0]).toMatchObject({ key: "m10:m10-part", text: "tail-10" });
    expect(records[29]).toMatchObject({ key: "m39:m39-part", text: "tail-39" });
  });

  it("replays the visible tail when mutable content rewrites a same-key record", () => {
    const first = normalizeSnapshot(
      snapshot([textMessage("m1", "assistant", "draft")]),
    );
    const initial = renderDelta(first, undefined);
    const rewritten = normalizeSnapshot(
      snapshot([
        textMessage("m1", "assistant", "rewritten"),
        textMessage("m2", "assistant", "later"),
      ]),
    );

    const delta = renderDelta(rewritten, initial.nextCursor);
    expect(delta.text).toContain("replayed rather than skipped");
    expect(delta.text).toContain("rewritten");
    expect(delta.text).toContain("later");
    expect(delta.nextCursor?.marker).toMatch(/^tail:/);
  });

  it("replays the bounded tail when an earlier retained record rewrites and the final one does not", () => {
    const first = normalizeSnapshot(
      snapshot([
        textMessage("m1", "assistant", "draft"),
        textMessage("m2", "assistant", "stable"),
      ]),
    );
    const initial = renderDelta(first, undefined);

    const rewritten = normalizeSnapshot(
      snapshot([
        textMessage("m1", "assistant", "rewritten"),
        textMessage("m2", "assistant", "stable"),
      ]),
    );

    const delta = renderDelta(rewritten, initial.nextCursor);
    expect(delta.text).toContain("replayed rather than skipped");
    expect(delta.text).toContain("rewritten");
    expect(delta.text).toContain("stable");
  });

  it("keeps reading the earlier final-record-only cursor marker", () => {
    const records = normalizeSnapshot(
      snapshot([
        textMessage("m1", "assistant", "first"),
        textMessage("m2", "assistant", "second"),
      ]),
    );

    const delta = renderDelta(records, {
      marker: `${records[0]!.key}#${records[0]!.version}`,
    });
    expect(delta.text).toContain("second");
    expect(delta.text).not.toContain("first");
  });

  it("emits only the new suffix when an ordinary append slides the bounded window past MAX_RECORDS", () => {
    const first = normalizeSnapshot(
      snapshot(
        Array.from({ length: 30 }, (_, index) =>
          textMessage(`m${index}`, "assistant", `tail-${index}`),
        ),
      ),
    );
    const initial = renderDelta(first, undefined);
    expect(initial.text).not.toContain("replayed rather than skipped");

    // Three more messages append with nothing rewritten. The bounded window
    // now holds m3..m32, evicting m0..m2 - a plain slide, not a rewrite.
    const second = normalizeSnapshot(
      snapshot(
        Array.from({ length: 33 }, (_, index) =>
          textMessage(`m${index}`, "assistant", `tail-${index}`),
        ),
      ),
    );

    const delta = renderDelta(second, initial.nextCursor);
    expect(delta.text).not.toContain("replayed rather than skipped");
    // Exactly the three genuinely new records, in order, and nothing from
    // the 27-record overlap the window kept from the previous report.
    expect(delta.text.split("\n\n")).toEqual([
      "OpenCode:\ntail-30",
      "OpenCode:\ntail-31",
      "OpenCode:\ntail-32",
    ]);
    expect(delta.nextCursor?.marker).toMatch(/^tail:/);
  });

  it("replays the bounded tail when a window slide also rewrites an overlapping record", () => {
    const first = normalizeSnapshot(
      snapshot(
        Array.from({ length: 30 }, (_, index) =>
          textMessage(`m${index}`, "assistant", `tail-${index}`),
        ),
      ),
    );
    const initial = renderDelta(first, undefined);

    // m30 is a genuinely new message, but m5 - still inside the surviving
    // window (m1..m30) - was rewritten in place. No overlap length can be
    // safe here: every candidate spans either the rewritten record or the
    // evicted m0, so this must fall back to a full replay, not a partial one
    // that would hide the m5 rewrite.
    const messages = Array.from({ length: 30 }, (_, index) =>
      textMessage(`m${index}`, "assistant", `tail-${index}`),
    );
    messages[5] = textMessage("m5", "assistant", "tail-5-rewritten");
    messages.push(textMessage("m30", "assistant", "tail-30"));
    const second = normalizeSnapshot(snapshot(messages));

    const delta = renderDelta(second, initial.nextCursor);
    expect(delta.text).toContain("replayed rather than skipped");
    expect(delta.text).toContain("tail-5-rewritten");
    expect(delta.text).toContain("tail-30");
    expect(delta.text).toContain("tail-29");
  });

  it("resolves the overlap deterministically even when a marker repeats inside the previous tail", () => {
    // Hand-built records rather than normalizeSnapshot: a real session can
    // never repeat a `key`, since it is a part identity OpenCode never
    // reuses, so this exercises overlapLength's defensive path directly
    // rather than relying on a producible-in-practice snapshot.
    const record = (key: string, text: string): TranscriptRecord => ({
      key,
      version: "v1",
      role: "assistant",
      kind: "text",
      text,
    });
    const previous = [
      record("a", "alpha"),
      record("b", "beta"),
      record("a", "alpha"),
      record("c", "gamma"),
    ];
    const initial = renderDelta(previous, undefined);
    expect(initial.nextCursor?.marker).toMatch(/^tail:/);

    const current = [...previous, record("d", "delta")];
    const delta = renderDelta(current, initial.nextCursor);

    expect(delta.text).not.toContain("replayed rather than skipped");
    expect(delta.text).toContain("delta");
    expect(delta.text).not.toContain("alpha");
    expect(delta.text).not.toContain("beta");
    expect(delta.text).not.toContain("gamma");
  });

  it("derives completed and failed tool states from the snapshot", async () => {
    const completed = await opencodeAdapter.normalizeHookInput({
      event: "tool_result",
      session_id: "session-1",
      cwd: "/project/opencode",
      call_id: "call-ok",
      tool: "Read",
      snapshot: snapshot([
        toolMessage({
          id: "m1",
          callId: "call-ok",
          tool: "Read",
          status: "completed",
          output: "done",
        }),
      ]),
    });
    const failed = await opencodeAdapter.normalizeHookInput({
      event: "tool_result",
      session_id: "session-1",
      cwd: "/project/opencode",
      call_id: "call-fail",
      tool: "Bash",
      snapshot: snapshot([
        toolMessage({
          id: "m2",
          callId: "call-fail",
          tool: "Bash",
          status: "error",
          error: "exit 1",
        }),
      ]),
    });

    expect(completed?.payload.tool_error).toBe(false);
    expect(failed?.payload.tool_error).toBe(true);
    expect(
      (await opencodeAdapter.prepareObservation(completed!, undefined)).text,
    ).toContain("OpenCode tool call: Read");
    expect(
      (await opencodeAdapter.prepareObservation(failed!, undefined)).text,
    ).toContain("OpenCode tool error: Bash");
  });

  it("surfaces snapshot fetch failures from the generated plugin payload", async () => {
    const event = await opencodeAdapter.normalizeHookInput({
      event: "turn_stop",
      session_id: "session-1",
      cwd: "/project/opencode",
      snapshot: {
        messages: [],
        snapshot_error: "session messages unavailable",
      },
    });

    expect(event?.payload.snapshot_error).toBe("session messages unavailable");
    expect(
      (await opencodeAdapter.prepareObservation(event!, undefined)).text,
    ).toContain(
      "The session transcript could not be read (session messages unavailable).",
    );
  });

  it("uses turn identity and sequence to keep empty turn_stop events distinct", async () => {
    const first = await opencodeAdapter.normalizeHookInput({
      event: "turn_stop",
      session_id: "session-1",
      cwd: "/project/opencode",
      turn_id: "turn-a",
      turn_sequence: 1,
      snapshot: {
        messages: [],
        snapshot_error: "session messages unavailable",
      },
    });
    const second = await opencodeAdapter.normalizeHookInput({
      event: "turn_stop",
      session_id: "session-1",
      cwd: "/project/opencode",
      turn_id: "turn-b",
      turn_sequence: 2,
      snapshot: {
        messages: [],
        snapshot_error: "session messages unavailable",
      },
    });

    expect(first?.id).not.toBe(second?.id);
    expect(first?.sequence).toBe(1);
    expect(second?.sequence).toBe(2);
    expect(first?.payload.turn_id).toBe("turn-a");
    expect(second?.payload.turn_id).toBe("turn-b");
  });

  it("reports capabilities and formatting exactly", () => {
    const delivery = {
      id: "d<1>",
      routeKey: "route-1",
      observationId: "obs-1",
      kind: "whisper" as const,
      text: 'Use "quoted" & safe text.',
      priority: "normal" as const,
      dedupeKey: "seed",
      status: "pending" as const,
      createdAt: "2026-08-25T00:00:00.000Z",
      expiresAt: "2026-08-25T00:10:00.000Z",
      attempts: 0,
    };
    expect(opencodeAdapter.capabilities).toEqual({
      passiveContext: true,
      queuedMessage: false,
      transcript: "events",
    });
    expect(opencodeAdapter.contextChannel("session.created")).toBeNull();
    expect(opencodeAdapter.formatWhispers([delivery])).toBe(
      '<subconscious_whisper delivery_id="d&lt;1&gt;">\nUse &quot;quoted&quot; &amp; safe text.\n</subconscious_whisper>',
    );
    expect(
      opencodeAdapter.formatStatus({
        agentId: "agent-1",
        conversationId: "conv-1",
        harness: "opencode",
        sessionId: "session-1",
        projectRoot: "/project/opencode",
        whispers: true,
        queuedMessages: false,
        modelOverrideSource: "project",
      }),
    ).toBe(
      '<subconscious_status agent_id="agent-1" conversation_id="conv-1" />',
    );
  });
});
