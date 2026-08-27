import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { parse } from "smol-toml";
import type { ReasoningEffort } from "@letta-ai/letta-agent-sdk";
import type {
  JsonValue,
  MidTurnObservationConfig,
  ModelOverride,
  ModelOverridesConfig,
  ModelOverrideKey,
  ProjectConfig,
  ResolvedModelSelection,
  ResolvedProjectConfig,
} from "./types.js";
import { MODEL_OVERRIDE_KEYS } from "./types.js";

export const CONFIG_FILENAME = "subconscious.toml";
export const DEFAULT_MODEL = "letta/auto";

/**
 * The reasoning tiers the Agent SDK accepts on session options.
 *
 * Kept as a literal list so configuration loading stays offline and
 * deterministic; the type import above pins it to the SDK's own union.
 */
const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/** Deepest nesting accepted inside `settings` before validation gives up. */
const MAX_SETTINGS_DEPTH = 16;

/**
 * Defaults for mid-turn observation, used only when a project turns it on.
 *
 * Five tool calls is the point where a turn has done something the observer
 * could not have predicted from the prompt. Below that the record is usually a
 * read or two that the next `Stop` delta carries anyway, so running it early
 * spends a Letta turn to say what the turn boundary would have said for free.
 *
 * Ninety seconds is the cadence bound. It holds a ten-minute turn to at most
 * six extra observer turns, and it is longer than a typical observer turn, so
 * the observer is never continuously busy on one route while the coding agent
 * works. Both are floors: the gate needs the count and the quiet period.
 */
export const DEFAULT_MID_TURN: MidTurnObservationConfig = {
  minToolCalls: 5,
  minSeconds: 90,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(
  source: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean.`);
  return value;
}

function readOptionalString(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value.trim();
}

/**
 * Read a whole-number setting.
 *
 * TOML distinguishes integers from floats, and smol-toml hands both back as
 * numbers, so the float and the out-of-range value have to be rejected here or
 * they reach the broker as a threshold that never passes. A rejected value
 * fails the whole configuration rather than falling back to the default: a
 * throttle silently reverting to something the file does not say is worse than
 * a startup error naming the key.
 */
function readNumber(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
): number {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number.`);
  }
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${key} must be a whole number of at least ${minimum}.`);
  }
  return value;
}

/**
 * Check one `settings` value tree.
 *
 * TOML cannot carry null, and a provider setting that silently loses null on
 * the file round trip would differ from what the user wrote, so null is
 * rejected outright. Negative zero and integers beyond the safe range are
 * rejected for the same reason: they do not survive a JSON or TOML round trip
 * unchanged. Finite fractional numbers are fine. The provider does the
 * authoritative shape check at runtime.
 */
function validateSettingsValue(key: string, value: unknown, depth: number) {
  if (value === null || value === undefined) {
    throw new Error(`${key} must not be null; TOML cannot represent it.`);
  }
  if (depth > MAX_SETTINGS_DEPTH) {
    throw new Error(
      `${key} is nested deeper than ${MAX_SETTINGS_DEPTH} levels.`,
    );
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${key} must be a finite number.`);
    }
    if (Object.is(value, -0)) {
      throw new Error(`${key} must not be negative zero.`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`${key} exceeds the safe integer range.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateSettingsValue(`${key}[${index}]`, item, depth + 1),
    );
    return;
  }
  if (isRecord(value)) {
    for (const [entryKey, entryValue] of Object.entries(value)) {
      validateSettingsValue(`${key}.${entryKey}`, entryValue, depth + 1);
    }
    return;
  }
  throw new Error(`${key} must be a string, number, boolean, array, or table.`);
}

function readModelOverride(
  harnessKey: string,
  raw: unknown,
): ModelOverride | undefined {
  const label = `model_overrides.${harnessKey}`;
  if (!isRecord(raw)) throw new Error(`${label} must be a TOML table.`);
  const allowed = [
    "model",
    "reasoning_effort",
    "context_window_limit",
    "settings",
  ];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `${label}.${key} is not a recognized key. Expected one of: ${allowed.join(", ")}.`,
      );
    }
  }
  const model = readOptionalString(raw, "model");
  const reasoningEffortRaw = raw.reasoning_effort;
  let reasoningEffort: ReasoningEffort | undefined;
  if (reasoningEffortRaw !== undefined) {
    if (
      typeof reasoningEffortRaw !== "string" ||
      !REASONING_EFFORTS.includes(reasoningEffortRaw as ReasoningEffort)
    ) {
      throw new Error(
        `${label}.reasoning_effort must be one of: ${REASONING_EFFORTS.join(", ")}.`,
      );
    }
    reasoningEffort = reasoningEffortRaw as ReasoningEffort;
  }
  let contextWindowLimit: number | undefined;
  if (raw.context_window_limit !== undefined) {
    const value = raw.context_window_limit;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      throw new Error(
        `${label}.context_window_limit must be a positive whole number within the safe integer range.`,
      );
    }
    contextWindowLimit = value;
  }
  if (reasoningEffort !== undefined && raw.settings !== undefined) {
    throw new Error(
      `${label} sets both reasoning_effort and settings. Pick one: reasoning_effort asks the normalized runtime for a tier, while settings replaces the provider's model settings directly, and applying both would make their precedence ambiguous.`,
    );
  }
  let settings: { [key: string]: JsonValue } | undefined;
  if (raw.settings !== undefined) {
    if (!isRecord(raw.settings)) {
      throw new Error(`${label}.settings must be a TOML table.`);
    }
    for (const [key, value] of Object.entries(raw.settings)) {
      validateSettingsValue(`${label}.settings.${key}`, value, 0);
    }
    settings = raw.settings as { [key: string]: JsonValue };
  }
  if (
    model === undefined &&
    reasoningEffort === undefined &&
    contextWindowLimit === undefined &&
    settings === undefined
  ) {
    return undefined;
  }
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(contextWindowLimit !== undefined ? { contextWindowLimit } : {}),
    ...(settings ? { settings } : {}),
  };
}

function readModelOverrides(raw: unknown): ModelOverridesConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error("model_overrides must be a TOML table.");
  const overrides: ModelOverridesConfig = {};
  let populated = false;
  for (const harnessKey of Object.keys(raw)) {
    if (!MODEL_OVERRIDE_KEYS.includes(harnessKey as ModelOverrideKey)) {
      throw new Error(
        `model_overrides.${harnessKey} is not a recognized harness. Expected one of: ${MODEL_OVERRIDE_KEYS.join(", ")}.`,
      );
    }
    const override = readModelOverride(harnessKey, raw[harnessKey]);
    if (override) {
      overrides[harnessKey as ModelOverrideKey] = override;
      populated = true;
    }
  }
  return populated ? overrides : undefined;
}

/**
 * Apply the model precedence for one observation: the harness's
 * `[model_overrides]` table wins over the project-wide `model`, and silence at
 * both levels inherits the attached agent's default.
 *
 * Only the harness table can carry reasoning effort, context window, or raw
 * settings; those have no project-wide equivalent to fall back from.
 */
export function resolveModelSelection(
  config: ProjectConfig,
  harness: string,
): ResolvedModelSelection {
  const harnessKey = harness.replaceAll("-", "_") as ModelOverrideKey;
  const override = config.modelOverrides?.[harnessKey];
  if (override?.model) {
    return {
      source: "harness",
      model: override.model,
      ...(override.reasoningEffort
        ? { reasoningEffort: override.reasoningEffort }
        : {}),
      ...(override.contextWindowLimit !== undefined
        ? { contextWindowLimit: override.contextWindowLimit }
        : {}),
      ...(override.settings ? { settings: override.settings } : {}),
    };
  }
  if (config.model) {
    return {
      source: "project",
      model: config.model,
      ...(override?.reasoningEffort
        ? { reasoningEffort: override.reasoningEffort }
        : {}),
      ...(override?.contextWindowLimit !== undefined
        ? { contextWindowLimit: override.contextWindowLimit }
        : {}),
      ...(override?.settings ? { settings: override.settings } : {}),
    };
  }
  if (override) {
    return {
      source: "agent_default",
      ...(override.reasoningEffort
        ? { reasoningEffort: override.reasoningEffort }
        : {}),
      ...(override.contextWindowLimit !== undefined
        ? { contextWindowLimit: override.contextWindowLimit }
        : {}),
      ...(override.settings ? { settings: override.settings } : {}),
    };
  }
  return { source: "agent_default" };
}

export function validateProjectConfig(raw: unknown): ProjectConfig {
  if (!isRecord(raw)) throw new Error("Configuration must be a TOML table.");
  if (raw.version !== 1) throw new Error("version must be 1.");

  const agentId = readOptionalString(raw, "agent_id");
  if (agentId && !agentId.startsWith("agent-")) {
    throw new Error("agent_id must start with 'agent-'.");
  }

  // The project model is optional: a file without one inherits the attached
  // agent's default, so an explicit `model` line remains meaningful but no
  // longer required.
  const model = readOptionalString(raw, "model");
  const modelOverrides = readModelOverrides(raw.model_overrides);
  const deliveryRaw = raw.delivery ?? {};
  const observerRaw = raw.observer ?? {};
  if (!isRecord(deliveryRaw)) throw new Error("delivery must be a TOML table.");
  if (!isRecord(observerRaw)) throw new Error("observer must be a TOML table.");

  // The thresholds are validated whether or not the switch is on, so a typo in
  // a file that has mid-turn observation turned off is still reported. Only the
  // switch decides whether the settings reach the broker.
  const midTurn: MidTurnObservationConfig = {
    minToolCalls: readNumber(
      observerRaw,
      "mid_turn_min_tool_calls",
      DEFAULT_MID_TURN.minToolCalls,
      1,
    ),
    minSeconds: readNumber(
      observerRaw,
      "mid_turn_min_seconds",
      DEFAULT_MID_TURN.minSeconds,
      0,
    ),
  };

  return {
    version: 1,
    ...(agentId ? { agentId } : {}),
    ...(model ? { model } : {}),
    ...(modelOverrides ? { modelOverrides } : {}),
    delivery: {
      whispers: readBoolean(deliveryRaw, "whispers", true),
      queueMessages: readBoolean(deliveryRaw, "queue_messages", false),
    },
    observer: {
      ...(readOptionalString(observerRaw, "instructions")
        ? { instructions: readOptionalString(observerRaw, "instructions") }
        : {}),
      ...(readBoolean(observerRaw, "sandbox", false) ? { sandbox: true } : {}),
      ...(readBoolean(observerRaw, "mid_turn", false) ? { midTurn } : {}),
    },
  };
}

export async function loadProjectConfig(path: string): Promise<ProjectConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new Error(`Invalid TOML in ${path}: ${(error as Error).message}`);
  }

  try {
    return validateProjectConfig(raw);
  } catch (error) {
    throw new Error(
      `Invalid configuration in ${path}: ${(error as Error).message}`,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function findProjectConfig(
  workingDirectory: string,
): Promise<ResolvedProjectConfig | null> {
  let current = resolve(workingDirectory);
  try {
    current = await realpath(current);
  } catch {
    return null;
  }

  while (true) {
    const path = join(current, CONFIG_FILENAME);
    if (await exists(path)) {
      return {
        path,
        projectRoot: current,
        config: await loadProjectConfig(path),
      };
    }
    const parent = dirname(current);
    if (parent === current || parsePath(current).root === current) return null;
    current = parent;
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlBareKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/**
 * Render one `settings` tree as a TOML inline table.
 *
 * Validation already rejected everything TOML cannot carry, so this only sees
 * strings, finite numbers, booleans, arrays, and tables.
 */
function tomlInlineValue(value: JsonValue): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(tomlInlineValue).join(", ")}]`;
  }
  const entries = Object.entries(value).map(
    ([key, item]) => `${tomlBareKey(key)} = ${tomlInlineValue(item)}`,
  );
  return `{ ${entries.join(", ")} }`;
}

function formatModelOverride(override: ModelOverride): string[] {
  const lines = [
    ...(override.model ? [`model = ${tomlString(override.model)}`] : []),
    ...(override.reasoningEffort
      ? [`reasoning_effort = ${tomlString(override.reasoningEffort)}`]
      : []),
    ...(override.contextWindowLimit !== undefined
      ? [`context_window_limit = ${override.contextWindowLimit}`]
      : []),
    ...(override.settings
      ? [
          `[settings]`,
          ...Object.entries(override.settings).map(
            ([key, value]) => `${tomlBareKey(key)} = ${tomlInlineValue(value)}`,
          ),
        ]
      : []),
  ];
  return lines;
}

export function formatProjectConfig(config: ProjectConfig): string {
  const lines = [
    "version = 1",
    ...(config.agentId ? [`agent_id = ${tomlString(config.agentId)}`] : []),
    ...(config.model ? [`model = ${tomlString(config.model)}`] : []),
    "",
    "[delivery]",
    `whispers = ${config.delivery.whispers}`,
    `queue_messages = ${config.delivery.queueMessages}`,
  ];
  const midTurn = config.observer.midTurn;
  const observer = [
    ...(config.observer.instructions
      ? [`instructions = ${tomlString(config.observer.instructions)}`]
      : []),
    ...(config.observer.sandbox ? ["sandbox = true"] : []),
    // The thresholds are written with the switch rather than only when they
    // differ from the default, because they are the whole cost control and a
    // project that turns mid-turn observation on should see what it costs.
    ...(midTurn
      ? [
          "mid_turn = true",
          `mid_turn_min_tool_calls = ${midTurn.minToolCalls}`,
          `mid_turn_min_seconds = ${midTurn.minSeconds}`,
        ]
      : []),
  ];
  if (observer.length > 0) lines.push("", "[observer]", ...observer);
  for (const harnessKey of MODEL_OVERRIDE_KEYS) {
    const override = config.modelOverrides?.[harnessKey];
    if (!override) continue;
    lines.push("", `[model_overrides.${harnessKey}]`);
    const overrideLines = formatModelOverride(override);
    if (override.settings) {
      // The nested [settings] table must come last inside its override, and
      // its header was already emitted by formatModelOverride.
      const settingsIndex = overrideLines.indexOf("[settings]");
      lines.push(...overrideLines.slice(0, settingsIndex));
      for (const settingLine of overrideLines.slice(settingsIndex)) {
        if (settingLine === "[settings]") {
          lines.push("", `[model_overrides.${harnessKey}.settings]`);
        } else {
          lines.push(settingLine);
        }
      }
    } else {
      lines.push(...overrideLines);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function writeProjectConfig(
  projectRoot: string,
  config: ProjectConfig,
): Promise<string> {
  const path = join(resolve(projectRoot), CONFIG_FILENAME);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatProjectConfig(config), {
    encoding: "utf8",
    flag: "wx",
  });
  return path;
}
