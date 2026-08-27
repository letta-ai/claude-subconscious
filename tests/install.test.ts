import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../packages/adapter-claude-code/index.js";
import { codexAdapter } from "../packages/adapter-codex/index.js";
import { lettaCodeAdapter } from "../packages/adapter-letta-code/index.js";
import {
  CODEX_HOOKS,
  installAdapter,
  LETTA_CODE_HOOKS,
} from "../packages/cli/install.js";
import { HERMES_HOOKS } from "../packages/cli/install-hermes.js";
import { hermesAdapter } from "../packages/adapter-hermes/index.js";

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
  it("ships the Claude Code plugin with every supported event", async () => {
    const config = JSON.parse(
      await readFile(join(process.cwd(), "hooks", "hooks.json"), "utf8"),
    );
    expect(Object.keys(config.hooks).sort()).toEqual(
      [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "Stop",
      ].sort(),
    );
    for (const event of Object.keys(config.hooks)) {
      const hook = config.hooks[event][0].hooks[0];
      expect(hook.command).toContain("hook claude-code");
      expect(config.hooks[event][0].matcher).toBe("*");
      if (event !== "Stop") {
        expect(claudeCodeAdapter.contextChannel(event)).not.toBeNull();
      }
    }
    expect(config.hooks.Stop[0].hooks[0].async).toBe(true);
  });

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
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
    ]) {
      expect(config.hooks[event]).toHaveLength(1);
    }
  });

  it("registers Codex tool events with a regex matcher", async () => {
    const directory = await root();
    process.env.CODEX_HOME = directory;
    await installAdapter("codex");
    const config = JSON.parse(
      await readFile(join(directory, "hooks.json"), "utf8"),
    );
    for (const event of ["PreToolUse", "PostToolUse"]) {
      expect(config.hooks[event]).toHaveLength(1);
      // Codex matches tools with an unanchored regex, where `.*` is every tool.
      expect(config.hooks[event][0].matcher).toBe(".*");
      expect(config.hooks[event][0].hooks[0].command).toBe(
        "subconscious hook codex",
      );
      expect(config.hooks[event][0].hooks[0].timeout).toBe(3);
    }
    // Simple events carry no matcher, and Codex reads no context before a tool
    // failure event it does not emit.
    expect(config.hooks.SessionStart[0].matcher).toBeUndefined();
    expect(config.hooks.Stop[0].matcher).toBeUndefined();
    expect(config.hooks.PostToolUseFailure).toBeUndefined();
  });

  it("registers Letta Code tool events but not PreToolUse", async () => {
    const directory = await root();
    await installAdapter("letta-code", directory);
    const config = JSON.parse(
      await readFile(join(directory, ".letta", "settings.local.json"), "utf8"),
    );
    for (const event of ["PostToolUse", "PostToolUseFailure"]) {
      expect(config.hooks[event]).toHaveLength(1);
      // Letta Code special-cases the literal "*" ahead of its anchored regex.
      expect(config.hooks[event][0].matcher).toBe("*");
      expect(config.hooks[event][0].hooks[0].timeout).toBe(3_000);
    }
    // The adapter reads no context on PreToolUse, so registering it would only
    // acknowledge whispers the model never sees.
    expect(config.hooks.PreToolUse).toBeUndefined();
    expect(config.hooks.UserPromptSubmit[0].matcher).toBeUndefined();
  });

  it("installs Letta Code hooks once when rerun", async () => {
    const directory = await root();
    await installAdapter("letta-code", directory);
    const configPath = join(directory, ".letta", "settings.local.json");
    const firstInstall = JSON.parse(await readFile(configPath, "utf8"));
    await installAdapter("letta-code", directory);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "PostToolUseFailure",
      "Stop",
    ]) {
      expect(config.hooks[event]).toHaveLength(1);
      expect(config.hooks[event]).toEqual(firstInstall.hooks[event]);
    }
  });

  it("marks every installed Letta Code Subconscious hook quiet by default", async () => {
    const directory = await root();
    await installAdapter("letta-code", directory);
    const config = JSON.parse(
      await readFile(join(directory, ".letta", "settings.local.json"), "utf8"),
    );
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "PostToolUseFailure",
      "Stop",
    ]) {
      const matchers = config.hooks[event];
      expect(matchers).toHaveLength(1);
      const hook = matchers[0].hooks[0];
      expect(hook.command).toBe("subconscious hook letta-code");
      expect(hook.quiet).toBe(true);
    }
  });

  it("preserves unrelated Letta Code hooks and installs once", async () => {
    const directory = await root();
    const settingsDirectory = join(directory, ".letta");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(settingsDirectory, { recursive: true }),
    );
    const settingsPath = join(settingsDirectory, "settings.local.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "existing", timeout: 5 }] },
          ],
        },
      }),
    );
    await installAdapter("letta-code", directory);
    await installAdapter("letta-code", directory);
    const config = JSON.parse(await readFile(settingsPath, "utf8"));
    const stopCommands = config.hooks.Stop.flatMap(
      (entry: { hooks: Array<{ command: string }> }) =>
        entry.hooks.map((hook) => hook.command),
    );
    expect(stopCommands).toContain("existing");
    expect(
      stopCommands.filter(
        (command: string) => command === "subconscious hook letta-code",
      ),
    ).toHaveLength(1);
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse"]) {
      expect(config.hooks[event]).toHaveLength(1);
    }
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

describe("installed events match what the adapter claims", () => {
  // The installer's event lists and the adapter's contextChannel() are separate
  // sources of truth. When they drift the failure is silent: either a hook fires
  // on an event the adapter refuses to answer, or a claimed channel never gets
  // registered and can never deliver. That second case is why the tool events
  // were inert when the adapters first claimed them.
  const CANDIDATE_EVENTS = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PreCompact",
    "Notification",
    "SessionEnd",
    // Hermes' shell-hook event names.
    "on_session_start",
    "pre_llm_call",
    "post_tool_call",
    "on_session_end",
  ];

  const harnesses = [
    { name: "codex", specs: CODEX_HOOKS, adapter: codexAdapter },
    { name: "letta-code", specs: LETTA_CODE_HOOKS, adapter: lettaCodeAdapter },
    { name: "hermes", specs: HERMES_HOOKS, adapter: hermesAdapter },
  ];

  for (const { name, specs, adapter } of harnesses) {
    it(`registers every event ${name} claims a channel for`, () => {
      const registered = new Set(specs.map((spec) => spec.event));
      const claimed = CANDIDATE_EVENTS.filter(
        (event) => adapter.contextChannel(event) !== null,
      );
      for (const event of claimed) {
        expect(registered.has(event), `${name} claims ${event}`).toBe(true);
      }
    });

    if (name === "hermes") {
      // Hermes is deliberately different: post_tool_call is registered as an
      // observation-only boundary because its stdout is discarded at the fire
      // site — registering it while claiming no channel is the honest
      // statement of what the harness supports.
      it("registers pre_llm_call as its only context-carrying event", () => {
        const registered = new Set(specs.map((spec) => spec.event));
        expect(registered.has("pre_llm_call")).toBe(true);
        expect(adapter.contextChannel("pre_llm_call")).toBe("context");
      });
      it("registers post_tool_call observation-only with no claimed channel", () => {
        expect(adapter.contextChannel("post_tool_call")).toBeNull();
      });
      continue;
    }

    it(`claims a channel for every ${name} tool hook it registers`, () => {
      // Stop is observation-only and carries no matcher, so it is exempt.
      for (const spec of specs) {
        if (spec.matcher === undefined) continue;
        expect(
          adapter.contextChannel(spec.event),
          `${name} registers ${spec.event}`,
        ).not.toBeNull();
      }
    });
  }
});

describe("hermes installation through the public installer", () => {
  const originalHermesHome = process.env.HERMES_HOME;

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHermesHome;
  });

  it("installs idempotently and reports seeded allowlist entries", async () => {
    const home = await root();
    process.env.HERMES_HOME = home;
    const first = await installAdapter("hermes");
    expect(first).toContain("Installed Hermes hooks");
    expect(first).toContain("Seeded 4 shell-hook allowlist entries");
    expect(first).toContain(join(home, "config.yaml"));
    const config = await readFile(join(home, "config.yaml"), "utf8");
    expect(config).toContain("pre_llm_call:");
    expect(config).toContain("subconscious hook hermes");

    // Second run: byte-identical config, no duplicate allowlist entries.
    const second = await installAdapter("hermes");
    expect(second).toContain("already installed");
    expect(second).toContain("Allowlist entries already present");
    expect(await readFile(join(home, "config.yaml"), "utf8")).toBe(config);
    const approvals = JSON.parse(
      await readFile(join(home, "shell-hooks-allowlist.json"), "utf8"),
    ).approvals;
    expect(approvals).toHaveLength(4);
  });

  it("surfaces an unsupported hooks shape as an actionable error", async () => {
    const home = await root();
    process.env.HERMES_HOME = home;
    await writeFile(join(home, "config.yaml"), "hooks: {}\n");
    await expect(installAdapter("hermes")).rejects.toThrow(
      /unsupported shape.*Edit it by hand/s,
    );
  });

  it("surfaces a malformed allowlist without touching it", async () => {
    const home = await root();
    process.env.HERMES_HOME = home;
    const badAllowlist = join(home, "shell-hooks-allowlist.json");
    await writeFile(badAllowlist, "{not json");
    await expect(installAdapter("hermes")).rejects.toThrow(
      /malformed or unreadable/,
    );
    expect(await readFile(badAllowlist, "utf8")).toBe("{not json");
  });
});
