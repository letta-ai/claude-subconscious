import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL } from "../packages/core/index.js";

const roots: string[] = [];
const createObserverAgent = vi.hoisted(() => vi.fn());

afterEach(async () => {
  delete process.env.LETTA_API_KEY;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.resetModules();
  createObserverAgent.mockReset();
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "subconscious-init-"));
  roots.push(value);
  return value;
}

async function importInit() {
  vi.doMock("../packages/agent-runtime/index.js", () => ({
    createObserverAgent,
    AgentRuntime: class {},
  }));
  const cli = await import("../packages/cli/cli.js");
  return cli.init as (args: string[]) => Promise<void>;
}

describe("subconscious init model selection", () => {
  it("creates a new agent on the default model but writes no model line", async () => {
    process.env.LETTA_API_KEY = "test-key";
    const directory = await root();
    createObserverAgent.mockResolvedValue("agent-created");
    const init = await importInit();

    await init([directory]);

    expect(createObserverAgent).toHaveBeenCalledWith({
      apiKey: "test-key",
      model: DEFAULT_MODEL,
    });
    const text = await readFile(join(directory, "subconscious.toml"), "utf8");
    expect(text).toContain('agent_id = "agent-created"');
    // No model anywhere: every conversation inherits the new agent's default.
    expect(text).not.toContain("model");
  });

  it("writes and applies an explicit model for a created agent", async () => {
    process.env.LETTA_API_KEY = "test-key";
    const directory = await root();
    createObserverAgent.mockResolvedValue("agent-created");
    const init = await importInit();

    await init([directory, "--model", "anthropic/claude-sonnet-5"]);

    expect(createObserverAgent).toHaveBeenCalledWith({
      apiKey: "test-key",
      model: "anthropic/claude-sonnet-5",
    });
    const text = await readFile(join(directory, "subconscious.toml"), "utf8");
    expect(text).toContain('model = "anthropic/claude-sonnet-5"');
  });

  it("attaches a supplied agent without touching any model", async () => {
    const directory = await root();
    createObserverAgent.mockRejectedValue(
      new Error("agent creation must not run"),
    );
    const init = await importInit();

    await init(["--agent", "agent-supplied", directory]);

    expect(createObserverAgent).not.toHaveBeenCalled();
    const text = await readFile(join(directory, "subconscious.toml"), "utf8");
    expect(text).toContain('agent_id = "agent-supplied"');
    expect(text).not.toContain("model");
  });

  it.each([
    [["--model"], "--model requires a non-empty value."],
    [["project", "--model"], "--model requires a non-empty value."],
    [["--model", ""], "--model requires a non-empty value."],
    [["--agent", ""], "--agent requires a non-empty value."],
    [
      ["--agent", "--model", "letta/auto"],
      "--agent requires a non-empty value.",
    ],
    // --agent is parsed first, so it names the offending flag here.
    [["--model", "--agent"], "--agent requires a non-empty value."],
  ])("rejects %j before any side effect", async (args, message) => {
    process.env.LETTA_API_KEY = "test-key";
    createObserverAgent.mockResolvedValue("agent-created");
    const init = await importInit();

    await expect(init([...args])).rejects.toThrow(message);
    // Nothing was created; the parser rejects before any file or network
    // side effect.
    expect(createObserverAgent).not.toHaveBeenCalled();
  });
});
