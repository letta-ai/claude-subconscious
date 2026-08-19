import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  findProjectConfig,
  loadProjectConfig,
  validateProjectConfig,
  writeProjectConfig,
} from "../packages/core/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "subconscious-config-"));
  roots.push(value);
  return value;
}

describe("project configuration", () => {
  it("discovers the nearest configuration", async () => {
    const parent = await root();
    const nested = join(parent, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeProjectConfig(parent, {
      version: 1,
      agentId: "agent-parent",
      model: DEFAULT_MODEL,
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
    await writeProjectConfig(join(parent, "packages"), {
      version: 1,
      agentId: "agent-nearest",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: true },
      observer: { instructions: "Watch package decisions." },
    });

    const resolved = await findProjectConfig(nested);

    expect(resolved?.projectRoot).toBe(
      await realpath(join(parent, "packages")),
    );
    expect(resolved?.config.agentId).toBe("agent-nearest");
    expect(resolved?.config.delivery.queueMessages).toBe(true);
  });

  it("leaves unconfigured directories unobserved", async () => {
    expect(await findProjectConfig(await root())).toBeNull();
  });

  it("applies safe defaults", () => {
    expect(
      validateProjectConfig({ version: 1, agent_id: "agent-test" }),
    ).toEqual({
      version: 1,
      agentId: "agent-test",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
  });

  it("keeps the managed sandbox off unless a project asks for it", () => {
    expect(
      validateProjectConfig({ version: 1, agent_id: "agent-test" }).observer,
    ).toEqual({});
    expect(
      validateProjectConfig({
        version: 1,
        agent_id: "agent-test",
        observer: { sandbox: false },
      }).observer,
    ).toEqual({});
    expect(
      validateProjectConfig({
        version: 1,
        agent_id: "agent-test",
        observer: { sandbox: true, instructions: "Watch the build." },
      }).observer,
    ).toEqual({ sandbox: true, instructions: "Watch the build." });
    expect(() =>
      validateProjectConfig({
        version: 1,
        agent_id: "agent-test",
        observer: { sandbox: "yes" },
      }),
    ).toThrow("sandbox must be a boolean.");
  });

  it("writes the sandbox flag only when it is on", async () => {
    const directory = await root();
    const enabled = await writeProjectConfig(join(directory, "sandboxed"), {
      version: 1,
      agentId: "agent-test",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: { sandbox: true },
    });
    expect(await loadProjectConfig(enabled)).toMatchObject({
      observer: { sandbox: true },
    });

    const local = await writeProjectConfig(join(directory, "local"), {
      version: 1,
      agentId: "agent-test",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
    expect(await readFile(local, "utf8")).not.toContain("sandbox");
  });

  it("keeps mid-turn observation off unless a project asks for it", () => {
    expect(
      validateProjectConfig({
        version: 1,
        agent_id: "agent-test",
        observer: { mid_turn: false, mid_turn_min_tool_calls: 3 },
      }).observer,
    ).toEqual({});
    expect(
      validateProjectConfig({
        version: 1,
        agent_id: "agent-test",
        observer: { mid_turn: true },
      }).observer,
    ).toEqual({ midTurn: { minToolCalls: 5, minSeconds: 90 } });
    expect(
      validateProjectConfig({
        version: 1,
        agent_id: "agent-test",
        observer: {
          mid_turn: true,
          mid_turn_min_tool_calls: 3,
          mid_turn_min_seconds: 30,
        },
      }).observer,
    ).toEqual({ midTurn: { minToolCalls: 3, minSeconds: 30 } });
  });

  it("rejects a threshold that is not a whole number in range", () => {
    // A throttle that silently reverts to a value the file does not name is
    // worse than a startup error, so these fail the whole configuration.
    const observer = (value: unknown) => ({
      version: 1,
      agent_id: "agent-test",
      observer: { mid_turn: true, mid_turn_min_tool_calls: value },
    });
    expect(() => validateProjectConfig(observer("3"))).toThrow(
      "mid_turn_min_tool_calls must be a number.",
    );
    expect(() => validateProjectConfig(observer(2.5))).toThrow(
      "mid_turn_min_tool_calls must be a whole number of at least 1.",
    );
    expect(() => validateProjectConfig(observer(0))).toThrow(
      "mid_turn_min_tool_calls must be a whole number of at least 1.",
    );
    expect(() =>
      validateProjectConfig({
        version: 1,
        agent_id: "agent-test",
        observer: { mid_turn: true, mid_turn_min_seconds: -1 },
      }),
    ).toThrow("mid_turn_min_seconds must be a whole number of at least 0.");
  });

  it("writes the mid-turn thresholds only with the switch", async () => {
    const directory = await root();
    const enabled = await writeProjectConfig(join(directory, "mid-turn"), {
      version: 1,
      agentId: "agent-test",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: { midTurn: { minToolCalls: 3, minSeconds: 30 } },
    });
    expect(await loadProjectConfig(enabled)).toMatchObject({
      observer: { midTurn: { minToolCalls: 3, minSeconds: 30 } },
    });

    const off = await writeProjectConfig(join(directory, "edges"), {
      version: 1,
      agentId: "agent-test",
      model: "letta/auto",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
    expect(await readFile(off, "utf8")).not.toContain("mid_turn");
  });

  it("round-trips a written configuration", async () => {
    const directory = await root();
    const path = await writeProjectConfig(directory, {
      version: 1,
      agentId: "agent-test",
      model: "letta/auto",
      delivery: { whispers: false, queueMessages: true },
      observer: { instructions: "Send only proven corrections." },
    });
    expect(await loadProjectConfig(path)).toMatchObject({
      agentId: "agent-test",
      delivery: { whispers: false, queueMessages: true },
    });
  });
});
