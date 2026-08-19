import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
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
