import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { parse } from "smol-toml";
import type {
  MidTurnObservationConfig,
  ProjectConfig,
  ResolvedProjectConfig,
} from "./types.js";

export const CONFIG_FILENAME = "subconscious.toml";
export const DEFAULT_MODEL = "letta/auto";

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

export function validateProjectConfig(raw: unknown): ProjectConfig {
  if (!isRecord(raw)) throw new Error("Configuration must be a TOML table.");
  if (raw.version !== 1) throw new Error("version must be 1.");

  const agentId = readOptionalString(raw, "agent_id");
  if (agentId && !agentId.startsWith("agent-")) {
    throw new Error("agent_id must start with 'agent-'.");
  }

  const model = readOptionalString(raw, "model") ?? DEFAULT_MODEL;
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
    model,
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

export function formatProjectConfig(config: ProjectConfig): string {
  const lines = [
    "version = 1",
    ...(config.agentId ? [`agent_id = ${tomlString(config.agentId)}`] : []),
    `model = ${tomlString(config.model)}`,
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
