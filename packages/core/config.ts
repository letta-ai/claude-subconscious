import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { parse } from "smol-toml";
import type { ProjectConfig, ResolvedProjectConfig } from "./types.js";

export const CONFIG_FILENAME = "subconscious.toml";
export const DEFAULT_MODEL = "letta/auto";

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
  const observer = [
    ...(config.observer.instructions
      ? [`instructions = ${tomlString(config.observer.instructions)}`]
      : []),
    ...(config.observer.sandbox ? ["sandbox = true"] : []),
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
