import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile, type KnownHarnessId } from "../core/index.js";
import { installAdapter as installHermesAdapter } from "./install-hermes.js";

interface CommandHook {
  type: "command";
  command: string;
  timeout: number;
  quiet?: boolean;
}

interface HookMatcher {
  hooks: CommandHook[];
  matcher?: string;
}

type HooksFile = Record<string, unknown> & {
  hooks?: Record<string, HookMatcher[]>;
};

const MARKER = "subconscious hook";

/**
 * One hook registration.
 *
 * `matcher` is set only for tool-level events, which is also what marks an
 * entry as a tool hook: the simple events reject the field in some harnesses,
 * and the matcher syntax differs per harness, so the caller supplies the literal
 * value rather than this file guessing one.
 */
export interface HookSpec {
  event: string;
  matcher?: string;
}

/**
 * The events the Codex adapter can act on.
 *
 * Codex reads context on SessionStart, UserPromptSubmit, PreToolUse, and
 * PostToolUse, and observes on Stop. Its matcher is an unanchored regex, so
 * `.*` is the value that reaches every tool.
 */
export const CODEX_HOOKS: HookSpec[] = [
  { event: "SessionStart" },
  { event: "UserPromptSubmit" },
  { event: "PreToolUse", matcher: ".*" },
  { event: "PostToolUse", matcher: ".*" },
  { event: "Stop" },
];

/**
 * The events the Letta Code adapter can act on.
 *
 * PreToolUse is deliberately absent: Letta Code consumes only updatedInput
 * there, so a whisper emitted on it would be acknowledged and never seen.
 * Letta Code special-cases the literal `"*"` ahead of its anchored-regex path,
 * which makes it the canonical "every tool" matcher.
 */
export const LETTA_CODE_HOOKS: HookSpec[] = [
  { event: "SessionStart" },
  { event: "UserPromptSubmit" },
  { event: "PostToolUse", matcher: "*" },
  { event: "PostToolUseFailure", matcher: "*" },
  { event: "Stop" },
];

async function readJson(path: string): Promise<HooksFile> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed as HooksFile;
}

/**
 * Seconds a hook may run before the harness gives up on it.
 *
 * Stop reads a whole transcript delta and fires once per turn, so it gets the
 * most room. Tool hooks fire on every tool call, where the budget is paid over
 * and over inside a single turn, so they get the least: 3 seconds, matching the
 * bundled Claude Code plugin's tool hooks.
 */
function timeoutSeconds(spec: HookSpec): number {
  if (spec.event === "Stop") return 10;
  return spec.matcher === undefined ? 5 : 3;
}

function addHook(
  config: HooksFile,
  spec: HookSpec,
  command: string,
  timeoutMultiplier: number,
  quiet: boolean,
): void {
  config.hooks ??= {};
  const matchers = (config.hooks[spec.event] ??= []);
  for (const matcher of matchers) {
    if (matcher.hooks.some((hook) => hook.command.includes(MARKER))) return;
  }
  matchers.push({
    ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
    hooks: [
      {
        type: "command",
        command,
        timeout: timeoutSeconds(spec) * timeoutMultiplier,
        ...(quiet ? { quiet: true } : {}),
      },
    ],
  });
}

async function installHooks(
  path: string,
  specs: HookSpec[],
  command: string,
  timeoutMultiplier: number,
  quiet: boolean,
): Promise<void> {
  const config = await readJson(path);
  for (const spec of specs) {
    addHook(config, spec, command, timeoutMultiplier, quiet);
  }
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

export async function installAdapter(
  harness: KnownHarnessId,
  projectRoot = process.cwd(),
): Promise<string> {
  const env: NodeJS.ProcessEnv = process.env;
  if (harness === "claude-code") {
    return "Install the bundled Claude Code plugin with /plugin install claude-subconscious@claude-subconscious.";
  }
  if (harness === "codex") {
    const codexHome =
      process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
    const path = join(codexHome, "hooks.json");
    await installHooks(path, CODEX_HOOKS, "subconscious hook codex", 1, false);
    return `Installed Codex hooks in ${path}.`;
  }
  if (harness === "letta-code") {
    const path = join(resolve(projectRoot), ".letta", "settings.local.json");
    await installHooks(
      path,
      LETTA_CODE_HOOKS,
      "subconscious hook letta-code",
      1_000,
      true,
    );
    return `Installed Letta Code hooks in ${path}.`;
  }
  if (harness === "hermes") {
    const result = await installHermesAdapter(harness, env);
    if (result.allowlist.kind === "malformed") {
      throw new Error(
        `${result.allowlistPath} is malformed or unreadable; no hooks were installed. Fix or remove the allowlist file, then rerun subconscious install hermes.`,
      );
    }
    const parts = [
      result.addedEvents.length > 0
        ? `Installed Hermes hooks (${result.addedEvents.join(", ")}) in ${result.configPath}.`
        : `Hermes hooks were already installed in ${result.configPath}.`,
      result.allowlist.added > 0
        ? `Seeded ${result.allowlist.added} shell-hook allowlist ${result.allowlist.added === 1 ? "entry" : "entries"} in ${result.allowlistPath}.`
        : `Allowlist entries already present in ${result.allowlistPath}.`,
    ];
    return parts.join("\n");
  }
  throw new Error(`Unsupported harness adapter: ${harness}`);
}
