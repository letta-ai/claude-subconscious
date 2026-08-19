import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile, type KnownHarnessId } from "../core/index.js";

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

async function readJson(path: string): Promise<HooksFile> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed as HooksFile;
}

function addHook(
  config: HooksFile,
  event: "SessionStart" | "UserPromptSubmit" | "Stop",
  command: string,
  timeoutMultiplier: number,
  quiet: boolean,
): void {
  config.hooks ??= {};
  const matchers = (config.hooks[event] ??= []);
  for (const matcher of matchers) {
    if (matcher.hooks.some((hook) => hook.command.includes(MARKER))) return;
  }
  matchers.push({
    hooks: [
      {
        type: "command",
        command,
        timeout: (event === "Stop" ? 10 : 5) * timeoutMultiplier,
        ...(event === "Stop" && quiet ? { quiet: true } : {}),
      },
    ],
  });
}

async function installHooks(
  path: string,
  command: string,
  timeoutMultiplier: number,
  quiet: boolean,
): Promise<void> {
  const config = await readJson(path);
  addHook(config, "SessionStart", command, timeoutMultiplier, quiet);
  addHook(config, "UserPromptSubmit", command, timeoutMultiplier, quiet);
  addHook(config, "Stop", command, timeoutMultiplier, quiet);
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

export async function installAdapter(
  harness: KnownHarnessId,
  projectRoot = process.cwd(),
): Promise<string> {
  if (harness === "claude-code") {
    return "Install the bundled Claude Code plugin with /plugin install claude-subconscious@claude-subconscious.";
  }
  if (harness === "codex") {
    const codexHome =
      process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
    const path = join(codexHome, "hooks.json");
    await installHooks(path, "subconscious hook codex", 1, false);
    return `Installed Codex hooks in ${path}.`;
  }
  if (harness === "letta-code") {
    const path = join(resolve(projectRoot), ".letta", "settings.local.json");
    await installHooks(path, "subconscious hook letta-code", 1_000, true);
    return `Installed Letta Code hooks in ${path}.`;
  }
  throw new Error(`Unsupported harness adapter: ${harness}`);
}
