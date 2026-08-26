import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  findProjectConfig,
  loadProjectConfig,
  resolveModelSelection,
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
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
  });

  it("keeps an explicit project model", () => {
    expect(
      validateProjectConfig({
        version: 1,
        agent_id: "agent-test",
        model: "anthropic/claude-sonnet-4-5",
      }).model,
    ).toBe("anthropic/claude-sonnet-4-5");
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

  it("omits the model line when the file names no model", async () => {
    const directory = await root();
    const path = await writeProjectConfig(directory, {
      version: 1,
      agentId: "agent-test",
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("model");
    expect(await loadProjectConfig(path).then((c) => c.model)).toBeUndefined();
  });

  it("parses a per-harness model override", () => {
    const config = validateProjectConfig({
      version: 1,
      agent_id: "agent-test",
      model_overrides: {
        claude_code: {
          model: "anthropic/claude-sonnet-5",
          reasoning_effort: "high",
        },
        codex: { context_window_limit: 200000 },
        letta_code: { model: "openai/gpt-5.2" },
        hermes: { model: "anthropic/claude-opus-4.6" },
      },
    });
    expect(config.modelOverrides?.claude_code).toEqual({
      model: "anthropic/claude-sonnet-5",
      reasoningEffort: "high",
    });
    expect(config.modelOverrides?.codex).toEqual({
      contextWindowLimit: 200000,
    });
    expect(config.modelOverrides?.letta_code).toEqual({
      model: "openai/gpt-5.2",
    });
    expect(config.modelOverrides?.hermes).toEqual({
      model: "anthropic/claude-opus-4.6",
    });
  });

  it("parses provider settings inside an override", () => {
    const config = validateProjectConfig({
      version: 1,
      model_overrides: {
        claude_code: {
          settings: {
            temperature: 0.2,
            thinking: { type: "enabled" },
            stop: ["a", "b"],
          },
        },
      },
    });
    expect(config.modelOverrides?.claude_code?.settings).toEqual({
      temperature: 0.2,
      thinking: { type: "enabled" },
      stop: ["a", "b"],
    });
  });

  it("rejects unknown harness keys in model_overrides", () => {
    expect(() =>
      validateProjectConfig({
        version: 1,
        model_overrides: { gemini_cli: { model: "x" } },
      }),
    ).toThrow(/model_overrides\.gemini_cli is not a recognized harness/);
  });

  it("rejects unknown keys and malformed values inside an override", () => {
    expect(() =>
      validateProjectConfig({
        version: 1,
        model_overrides: { codex: { models: "x" } },
      }),
    ).toThrow(/model_overrides\.codex\.models is not a recognized key/);
    expect(() =>
      validateProjectConfig({
        version: 1,
        model_overrides: { codex: { reasoning_effort: "maximum" } },
      }),
    ).toThrow(/reasoning_effort must be one of/);
    expect(() =>
      validateProjectConfig({
        version: 1,
        model_overrides: { codex: { context_window_limit: 0 } },
      }),
    ).toThrow(/context_window_limit must be a positive whole number/);
    expect(() =>
      validateProjectConfig({
        version: 1,
        model_overrides: { codex: { context_window_limit: 12.5 } },
      }),
    ).toThrow(/context_window_limit must be a positive whole number/);
    expect(() =>
      validateProjectConfig({
        version: 1,
        model_overrides: { codex: { model: "" } },
      }),
    ).toThrow(/must be a non-empty string/);
  });

  it("rejects reasoning_effort combined with settings", () => {
    expect(() =>
      validateProjectConfig({
        version: 1,
        model_overrides: {
          claude_code: {
            reasoning_effort: "high",
            settings: { temperature: 0.2 },
          },
        },
      }),
    ).toThrow(/both reasoning_effort and settings/);
  });

  it("rejects null and non-JSON values inside settings", () => {
    expect(() =>
      validateProjectConfig({
        version: 1,
        model_overrides: { codex: { settings: { temperature: null } } },
      }),
    ).toThrow(/settings\.temperature must not be null/);
    // smol-toml cannot produce undefined, NaN, or Infinity from a file, but a
    // programmatic caller can; those names fail validation all the same.
    expect(() =>
      validateProjectConfig({
        version: 1,
        model_overrides: { codex: { settings: { temperature: Number.NaN } } },
      }),
    ).toThrow(/settings\.temperature must be a finite number/);
    expect(() =>
      validateProjectConfig({
        version: 1,
        model_overrides: {
          codex: { settings: { temperature: Number.POSITIVE_INFINITY } },
        },
      }),
    ).toThrow(/settings\.temperature must be a finite number/);
  });

  it("rejects numbers that would not survive a lossless round trip", () => {
    expect(() =>
      validateProjectConfig({
        version: 1,
        model_overrides: { codex: { settings: { weight: -0 } } },
      }),
    ).toThrow(/settings\.weight must not be negative zero/);
    expect(() =>
      validateProjectConfig({
        version: 1,
        model_overrides: {
          codex: { settings: { seed: Number.MAX_SAFE_INTEGER + 1 } },
        },
      }),
    ).toThrow(/settings\.seed exceeds the safe integer range/);
    // Finite fractional values and safe integers remain valid.
    const config = validateProjectConfig({
      version: 1,
      model_overrides: {
        codex: {
          settings: {
            temperature: 0.5,
            top_k: Number.MAX_SAFE_INTEGER,
          },
        },
      },
    });
    expect(config.modelOverrides?.codex?.settings).toEqual({
      temperature: 0.5,
      top_k: Number.MAX_SAFE_INTEGER,
    });
  });

  it("rejects a context window beyond the safe integer range", () => {
    expect(() =>
      validateProjectConfig({
        version: 1,
        model_overrides: { codex: { context_window_limit: 2 ** 60 } },
      }),
    ).toThrow(
      /context_window_limit must be a positive whole number within the safe integer range/,
    );
    const config = validateProjectConfig({
      version: 1,
      model_overrides: {
        codex: { context_window_limit: Number.MAX_SAFE_INTEGER },
      },
    });
    expect(config.modelOverrides?.codex?.contextWindowLimit).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("round-trips a written configuration with overrides", async () => {
    const directory = await root();
    const config = validateProjectConfig({
      version: 1,
      agent_id: "agent-test",
      model: "letta/auto",
      model_overrides: {
        claude_code: {
          model: "anthropic/claude-sonnet-5",
          context_window_limit: 200000,
          settings: { temperature: 0.4, thinking: { budget_tokens: 2048 } },
        },
        codex: { reasoning_effort: "medium" },
      },
      delivery: { whispers: true, queueMessages: false },
      observer: {},
    });
    const path = await writeProjectConfig(directory, config);
    const text = await readFile(path, "utf8");
    expect(text).toContain("[model_overrides.claude_code]");
    expect(text).toContain("[model_overrides.claude_code.settings]");
    expect(await loadProjectConfig(path)).toEqual(config);
  });

  it("resolves harness overrides above the project model above inheritance", () => {
    const resolve = (raw: Record<string, unknown>, harness: string) =>
      resolveModelSelection(validateProjectConfig(raw), harness);
    expect(resolve({ version: 1 }, "claude-code")).toEqual({
      source: "agent_default",
    });
    expect(resolve({ version: 1, model: "letta/auto" }, "claude-code")).toEqual(
      { source: "project", model: "letta/auto" },
    );
    expect(
      resolve(
        {
          version: 1,
          model: "letta/auto",
          model_overrides: {
            claude_code: {
              model: "anthropic/claude-sonnet-5",
              reasoning_effort: "high",
            },
          },
        },
        "claude-code",
      ),
    ).toEqual({
      source: "harness",
      model: "anthropic/claude-sonnet-5",
      reasoningEffort: "high",
    });
    // A harness table that tunes only effort keeps the project model and says
    // so honestly.
    expect(
      resolve(
        {
          version: 1,
          model: "letta/auto",
          model_overrides: { codex: { reasoning_effort: "low" } },
        },
        "codex",
      ),
    ).toEqual({
      source: "project",
      model: "letta/auto",
      reasoningEffort: "low",
    });
    // An unrelated harness's override does not leak.
    expect(
      resolve(
        {
          version: 1,
          model_overrides: { codex: { model: "openai/gpt-5.2" } },
        },
        "claude-code",
      ),
    ).toEqual({ source: "agent_default" });
    // A harness table may tune effort alone while the project names no model;
    // the model still inherits.
    expect(
      resolve(
        {
          version: 1,
          model_overrides: { codex: { reasoning_effort: "low" } },
        },
        "codex",
      ),
    ).toEqual({ source: "agent_default", reasoningEffort: "low" });
  });

  it("maps harness identifiers to underscored override keys", () => {
    const config = validateProjectConfig({
      version: 1,
      model_overrides: { letta_code: { model: "openai/gpt-5.2" } },
    });
    expect(resolveModelSelection(config, "letta-code").model).toBe(
      "openai/gpt-5.2",
    );
  });
});
