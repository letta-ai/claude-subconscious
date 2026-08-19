import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../packages/adapter-claude-code/index.js";
import { codexAdapter } from "../packages/adapter-codex/index.js";
import { lettaCodeAdapter } from "../packages/adapter-letta-code/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "subconscious-adapter-"));
  roots.push(value);
  return value;
}

describe("harness adapters", () => {
  it("reads only new Claude Code transcript records", async () => {
    const directory = await root();
    const transcript = join(directory, "transcript.jsonl");
    const first = `${JSON.stringify({ type: "user", message: { content: "first" } })}\n`;
    await writeFile(
      transcript,
      `${first}${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "second" }] } })}\n`,
    );
    const event = await claudeCodeAdapter.normalizeHookInput({
      hook_event_name: "Stop",
      session_id: "session",
      cwd: directory,
      transcript_path: transcript,
    });
    expect(event).not.toBeNull();
    const prepared = await claudeCodeAdapter.prepareObservation(event!, {
      offset: Buffer.byteLength(first),
    });
    expect(prepared.text).toContain("second");
    expect(prepared.text).not.toContain("first");
  });

  it("normalizes Codex hook identity", async () => {
    const directory = await root();
    const event = await codexAdapter.normalizeHookInput({
      hook_event_name: "SessionStart",
      session_id: "thread",
      cwd: directory,
    });
    expect(event).toMatchObject({
      harness: "codex",
      type: "session_start",
      sessionId: "thread",
    });
  });

  it("keeps transcript-less Codex Stop events distinct", async () => {
    const directory = await root();
    const first = await codexAdapter.normalizeHookInput({
      hook_event_name: "Stop",
      session_id: "thread",
      cwd: directory,
      last_assistant_message: "first",
    });
    const second = await codexAdapter.normalizeHookInput({
      hook_event_name: "Stop",
      session_id: "thread",
      cwd: directory,
      last_assistant_message: "second",
    });
    expect(first?.id).not.toBe(second?.id);
  });

  it("uses the Letta Code conversation as native session identity", async () => {
    const directory = await root();
    const event = await lettaCodeAdapter.normalizeHookInput({
      event_type: "Stop",
      working_directory: directory,
      conversation_id: "conv-parent",
      user_message: "question",
      assistant_message: "answer",
      stop_reason: "end_turn",
    });
    expect(event?.sessionId).toBe("conv-parent");
    expect(
      (await lettaCodeAdapter.prepareObservation(event!, undefined)).text,
    ).toContain("answer");
  });

  it("keeps identical Letta Code turns distinct without a native turn ID", async () => {
    const directory = await root();
    const input = {
      event_type: "Stop",
      working_directory: directory,
      conversation_id: "conv-parent",
      user_message: "same",
      assistant_message: "same",
      stop_reason: "end_turn",
    };
    const first = await lettaCodeAdapter.normalizeHookInput(input);
    const second = await lettaCodeAdapter.normalizeHookInput(input);
    expect(first?.id).not.toBe(second?.id);
  });

  it("observes Letta Code prompts with their conversation identity", async () => {
    const directory = await root();
    const event = await lettaCodeAdapter.normalizeHookInput({
      event_type: "UserPromptSubmit",
      working_directory: directory,
      conversation_id: "conv-parent",
      prompt: "Check the release order.",
    });
    expect(event).toMatchObject({
      harness: "letta-code",
      type: "user_prompt",
      sessionId: "conv-parent",
    });
    expect(
      (await lettaCodeAdapter.prepareObservation(event!, undefined)).text,
    ).toContain("Check the release order.");
  });

  it("skips Letta Code Stop events that have no conversation identity", async () => {
    await expect(
      lettaCodeAdapter.normalizeHookInput({
        event_type: "Stop",
        working_directory: await root(),
        user_message: "question",
        assistant_message: "answer",
      }),
    ).resolves.toBeNull();
  });
});
