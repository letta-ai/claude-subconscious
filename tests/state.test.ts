import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFingerprint,
  createEmptyState,
  createRouteRecord,
  routeKey,
  StateStore,
} from "../packages/core/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "subconscious-state-"));
  roots.push(value);
  return value;
}

describe("durable state", () => {
  it("serializes concurrent updates", async () => {
    const store = new StateStore(await root());
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.update((state) => {
          state.observationOrder.push(String(index));
        }),
      ),
    );
    expect((await store.snapshot()).observationOrder).toHaveLength(20);
    expect(JSON.parse(await readFile(store.path, "utf8"))).toMatchObject({
      version: 1,
    });
  });

  it("marks interrupted observations for reconciliation", async () => {
    const directory = await root();
    const store = new StateStore(directory);
    await store.update((state) => {
      state.observations.event = {
        event: {
          id: "event",
          harness: "claude-code",
          type: "turn_stop",
          sessionId: "session",
          workingDirectory: directory,
          occurredAt: new Date().toISOString(),
          payload: {},
        },
        routeKey: "route",
        config: {
          version: 1,
          agentId: "agent-test",
          model: "letta/auto",
          delivery: { whispers: true, queueMessages: false },
          observer: {},
        },
        status: "processing",
        attempts: 1,
        createdAt: "now",
        updatedAt: "now",
        otid: "event",
      };
    });
    await store.recoverInterrupted("later");
    expect((await store.snapshot()).observations.event?.status).toBe(
      "needs_reconciliation",
    );
  });

  it("includes project and session identity in route keys", () => {
    const base = {
      configPath: "/a/subconscious.toml",
      projectRoot: "/a",
      agentId: "agent-test",
      model: "letta/auto",
      harness: "claude-code" as const,
      sessionId: "one",
    };
    expect(routeKey(base)).not.toBe(routeKey({ ...base, sessionId: "two" }));
    expect(createRouteRecord(base).conversationId).toBeNull();
    expect(createEmptyState().version).toBe(1);
  });
});

describe("build fingerprint", () => {
  it("changes when the entry point is rebuilt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subconscious-build-"));
    try {
      const entry = join(directory, "cli.js");
      await writeFile(entry, "// first");
      const first = await buildFingerprint(entry);

      await writeFile(entry, "// second");
      await utimes(entry, new Date(), new Date(Date.now() + 1_000));
      const second = await buildFingerprint(entry);

      expect(first).not.toBe(second);
      expect(first).toContain(entry);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes two installs of the same file name", async () => {
    const left = await mkdtemp(join(tmpdir(), "subconscious-left-"));
    const right = await mkdtemp(join(tmpdir(), "subconscious-right-"));
    try {
      const leftEntry = join(left, "cli.js");
      const rightEntry = join(right, "cli.js");
      await writeFile(leftEntry, "// same bytes");
      await writeFile(rightEntry, "// same bytes");
      // Repointing the plugin at another checkout is the case that started this.
      expect(await buildFingerprint(leftEntry)).not.toBe(
        await buildFingerprint(rightEntry),
      );
    } finally {
      await rm(left, { recursive: true, force: true });
      await rm(right, { recursive: true, force: true });
    }
  });

  it("falls back to the path when the entry point is missing", async () => {
    expect(await buildFingerprint("/nope/cli.js")).toBe("/nope/cli.js");
  });
});
