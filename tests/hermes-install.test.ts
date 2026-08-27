import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addHermesHooksToYaml,
  HERMES_HOOKS,
  installAdapter,
  seedHermesAllowlist,
} from "../packages/cli/install-hermes.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "subconscious-hermes-install-"));
  roots.push(value);
  return value;
}

const COMMAND = "subconscious hook hermes";

describe("addHermesHooksToYaml", () => {
  it("appends a hooks block to a file without one", () => {
    const result = addHermesHooksToYaml("model:\n  default: gpt\n", COMMAND);
    expect(result.addedEvents).toHaveLength(4);
    expect(result.text).toContain("hooks:");
    expect(result.text).toContain(`command: ${COMMAND}`);
    // Existing content is preserved byte-for-byte.
    expect(
      result.text.startsWith("model:\n  default: g\n".replace("g", "gpt")) ||
        result.text.includes("model:\n  default: gpt"),
    ).toBe(true);
    expect(result.text).toMatch(/\n\nhooks:/);
  });

  it("is idempotent including the matcher event", () => {
    const first = addHermesHooksToYaml("", COMMAND).text;
    const second = addHermesHooksToYaml(first, COMMAND);
    expect(second.addedEvents).toHaveLength(0);
    expect(second.alreadyInstalledEvents).toHaveLength(4);
    expect(second.text).toBe(first); // byte-identical
    // Exactly one entry per event.
    for (const event of HERMES_HOOKS.map((s) => s.event)) {
      const matches =
        second.text.split(new RegExp(`^\\s{2}${event}:`, "m")).length - 1;
      expect(matches).toBe(1);
    }
    expect(second.text.match(/post_tool_call/g)?.length).toBe(1);
  });

  it("adds entries alongside unrelated commands on an existing event", () => {
    const existing = [
      "hooks:",
      "  post_tool_call:",
      '    - matcher: "\\\\.(ts|js)$"',
      "      command: /usr/bin/auto-format",
      "      timeout: 8",
      "",
    ].join("\n");
    const result = addHermesHooksToYaml(existing, COMMAND);
    expect(result.addedEvents).toEqual([
      "on_session_start",
      "pre_llm_call",
      "post_tool_call",
      "on_session_end",
    ]);
    expect(result.text).toContain("/usr/bin/auto-format");
    expect(result.text).toContain(COMMAND);
    // The matcher line survives untouched.
    expect(result.text).toContain('matcher: "\\\\.(ts|js)$"');
  });

  it("completes a partial prior install without duplicating", () => {
    const partial = [
      "hooks:",
      "  pre_llm_call:",
      `    - command: ${COMMAND}`,
      "      timeout: 5",
      "",
    ].join("\n");
    const result = addHermesHooksToYaml(partial, COMMAND);
    expect(result.alreadyInstalledEvents).toEqual(["pre_llm_call"]);
    expect(result.addedEvents).toEqual([
      "on_session_start",
      "post_tool_call",
      "on_session_end",
    ]);
    expect(result.text.match(/pre_llm_call:/g)?.length).toBe(1);
  });

  it("preserves comments and CRLF endings", () => {
    const commented = ["# my hooks", "# keep me", ""].join("\r\n");
    const result = addHermesHooksToYaml(commented, COMMAND);
    expect(result.text).toContain("# keep me");
    expect(result.text).toContain("\r\n");
    const withBlock = addHermesHooksToYaml(
      "# top\r\nsecurity:\r\n  redact: true\r\n",
      COMMAND,
    );
    expect(withBlock.text).toContain("# top");
    expect(withBlock.text).toContain("\r\nhooks:");
  });

  it("refuses flow-shaped hooks values instead of corrupting them", () => {
    const flow = "hooks: {}\nmodel:\n  provider: openai\n";
    const result = addHermesHooksToYaml(flow, COMMAND);
    expect(result.unsupportedShape).toBe(true);
    expect(result.text).toBe(flow);
    expect(result.addedEvents).toHaveLength(0);
  });

  it("refuses a valued event key instead of inserting a duplicate", () => {
    // `pre_llm_call: []` is not the canonical list shape; treating it as
    // missing and appending `pre_llm_call:` would create a duplicate key.
    const emptyList = ["hooks:", "  pre_llm_call: []", ""].join("\n");
    const result = addHermesHooksToYaml(emptyList, COMMAND);
    expect(result.unsupportedShape).toBe(true);
    expect(result.text).toBe(emptyList);
    expect(result.addedEvents).toHaveLength(0);
  });

  it("refuses a mapping-body event instead of creating an invalid mix", () => {
    // A scalar body under the event key is neither our canonical entry list
    // nor something this editor can extend; refuse unchanged.
    const mappingBody = [
      "hooks:",
      "  pre_llm_call:",
      "    command: /bin/other",
      "",
    ].join("\n");
    const result = addHermesHooksToYaml(mappingBody, COMMAND);
    expect(result.unsupportedShape).toBe(true);
    expect(result.text).toBe(mappingBody);
  });
});

describe("seedHermesAllowlist", () => {
  it("seeds exactly the four pairs into a missing file", async () => {
    const directory = await root();
    const path = join(directory, "shell-hooks-allowlist.json");
    const result = await seedHermesAllowlist(path, COMMAND);
    expect(result).toEqual({ kind: "seeded", path, added: 4 });
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.approvals).toHaveLength(4);
    expect(
      parsed.approvals.map((entry: { event: string }) => entry.event),
    ).toEqual([
      "on_session_start",
      "pre_llm_call",
      "post_tool_call",
      "on_session_end",
    ]);
    // Idempotent.
    const again = await seedHermesAllowlist(path, COMMAND);
    expect(again).toEqual({ kind: "seeded", path, added: 0 });
  });

  it("preserves unrelated approvals and never flips global flags", async () => {
    const directory = await root();
    const path = join(directory, "shell-hooks-allowlist.json");
    await writeFile(
      path,
      JSON.stringify({
        approvals: [
          { event: "pre_tool_call", command: "/bin/other", approved_at: "x" },
        ],
        custom_key: true,
      }),
    );
    await seedHermesAllowlist(path, COMMAND);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.custom_key).toBe(true);
    expect(
      parsed.approvals.some(
        (e: { command: string }) => e.command === "/bin/other",
      ),
    ).toBe(true);
  });

  it("reports malformed allowlists instead of overwriting them", async () => {
    const directory = await root();
    const bad = join(directory, "bad.json");
    await writeFile(bad, "{not json");
    expect(await seedHermesAllowlist(bad, COMMAND)).toEqual({
      kind: "malformed",
      path: bad,
    });
    const array = join(directory, "array.json");
    await writeFile(array, "[]");
    expect(await seedHermesAllowlist(array, COMMAND)).toEqual({
      kind: "malformed",
      path: array,
    });
    // Malformed entries inside approvals count as malformed too.
    const entries = join(directory, "entries.json");
    await writeFile(entries, JSON.stringify({ approvals: ["nope"] }));
    expect(await seedHermesAllowlist(entries, COMMAND)).toEqual({
      kind: "malformed",
      path: entries,
    });
    // The malformed files are untouched.
    expect(await readFile(bad, "utf8")).toBe("{not json");
  });
});

describe("installAdapter end to end", () => {
  it("writes config and allowlist under the resolved HERMES_HOME", async () => {
    const home = await root();
    await writeFile(join(home, "config.yaml"), "# my config\n");
    const env = { HERMES_HOME: home } as NodeJS.ProcessEnv;
    const result = await installAdapter("hermes", env);
    expect(result.configPath).toBe(join(home, "config.yaml"));
    const config = await readFile(join(home, "config.yaml"), "utf8");
    expect(config).toContain("# my config");
    expect(config).toContain("pre_llm_call:");
    expect(result.allowlist.kind).toBe("seeded");
    expect(existsSync(join(home, "shell-hooks-allowlist.json"))).toBe(true);
    // Second run changes nothing.
    const before = await readFile(join(home, "config.yaml"), "utf8");
    await installAdapter("hermes", env);
    expect(await readFile(join(home, "config.yaml"), "utf8")).toBe(before);
  });

  it("throws on an unsupported hooks shape without seeding the allowlist", async () => {
    const home = await root();
    await writeFile(join(home, "config.yaml"), "hooks: {}\n");
    const env = { HERMES_HOME: home } as NodeJS.ProcessEnv;
    await expect(installAdapter("hermes", env)).rejects.toThrow(
      /unsupported shape/,
    );
    expect(
      await readFile(join(home, "shell-hooks-allowlist.json"), "utf8").catch(
        () => "absent",
      ),
    ).toBe("absent");
  });

  it("rejects other harness ids", async () => {
    await expect(installAdapter("codex")).rejects.toThrow(
      /Unsupported harness/,
    );
  });

  it("leaves an existing config untouched when the allowlist is malformed", async () => {
    // Partial-install regression: consent is seeded before hooks activate, so
    // a malformed allowlist must leave BOTH files unchanged rather than
    // installing hooks that Hermes would refuse to register.
    const home = await root();
    const originalConfig =
      "# my config\nhooks:\n  pre_llm_call:\n    - command: /bin/other\n";
    await writeFile(join(home, "config.yaml"), originalConfig);
    await writeFile(join(home, "shell-hooks-allowlist.json"), "{corrupted");
    const env = { HERMES_HOME: home } as NodeJS.ProcessEnv;
    await expect(installAdapter("hermes", env)).rejects.toThrow(
      /malformed or unreadable; no hooks were installed/,
    );
    expect(await readFile(join(home, "config.yaml"), "utf8")).toBe(
      originalConfig,
    );
    expect(
      await readFile(join(home, "shell-hooks-allowlist.json"), "utf8"),
    ).toBe("{corrupted");
  });
});
