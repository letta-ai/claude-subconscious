import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installAdapter } from "../packages/cli/install.js";

const roots: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "subconscious-install-"));
  roots.push(value);
  return value;
}

describe("adapter installation", () => {
  it("preserves Codex hooks and installs once", async () => {
    const directory = await root();
    process.env.CODEX_HOME = directory;
    await writeFile(
      join(directory, "hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "existing", timeout: 5 }] },
          ],
        },
      }),
    );
    await installAdapter("codex");
    await installAdapter("codex");
    const config = JSON.parse(
      await readFile(join(directory, "hooks.json"), "utf8"),
    );
    const stopCommands = config.hooks.Stop.flatMap(
      (entry: { hooks: Array<{ command: string }> }) =>
        entry.hooks.map((hook) => hook.command),
    );
    expect(stopCommands).toContain("existing");
    expect(
      stopCommands.filter(
        (command: string) => command === "subconscious hook codex",
      ),
    ).toHaveLength(1);
    expect(config.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it("preserves Letta Code project settings", async () => {
    const directory = await root();
    const settingsDirectory = join(directory, ".letta");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(settingsDirectory, { recursive: true }),
    );
    await writeFile(
      join(settingsDirectory, "settings.local.json"),
      JSON.stringify({ theme: "dark" }),
    );
    await installAdapter("letta-code", directory);
    const config = JSON.parse(
      await readFile(join(settingsDirectory, "settings.local.json"), "utf8"),
    );
    expect(config.theme).toBe("dark");
    expect(config.hooks.Stop[0].hooks[0].command).toBe(
      "subconscious hook letta-code",
    );
    expect(config.hooks.Stop[0].hooks[0].timeout).toBe(10_000);
  });
});
