import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, type KnownHarnessId } from "../core/index.js";
import {
  defaultHermesRoot,
  resolveHermesHome,
} from "../adapter-hermes/home.js";

// The Hermes home resolution lives in adapter-hermes/home.ts so the adapter
// and this installer share one implementation and can never drift apart. Both
// names are re-exported for existing consumers.
export {
  defaultHermesRoot,
  resolveHermesHome,
} from "../adapter-hermes/home.js";

/** One hook registration. Hermes matchers exist only on tool events. */
export interface HookSpec {
  event: string;
  matcher?: string;
  timeout?: number;
}

/**
 * The events the Hermes adapter can act on.
 *
 * Verified against Hermes 0.20.5 `agent/shell_hooks.py` and the fire sites in
 * `hermes_cli/plugins.py`:
 * - `on_session_start` fires once per brand-new session (conversation_loop.py).
 * - `pre_llm_call` fires once per turn prologue with the user message; it is
 *   both the prompt boundary and the only context-consuming event.
 * - `post_tool_call` fires after every tool call with status/error fields.
 * - `on_session_end` fires at the end of every turn despite the name.
 *
 * No matcher except post_tool_call: Hermes honors `matcher` only on
 * pre/post_tool_call and treats an absent one as every tool. Timeouts are
 * seconds; the hook only forwards a payload to the local broker, so the spec's
 * budgets carry over unchanged.
 */
export const HERMES_HOOKS: HookSpec[] = [
  { event: "on_session_start", timeout: 5 },
  { event: "pre_llm_call", timeout: 5 },
  { event: "post_tool_call", matcher: ".*", timeout: 3 },
  { event: "on_session_end", timeout: 10 },
];

/**
 * The platform-native Hermes root and profile resolution live in
 * `adapter-hermes/home.ts` — one implementation shared with the adapter so the
 * installer and the hook stamp can never disagree about the active profile.
 * Both names are re-exported here unchanged for existing consumers.
 */

export function hermesConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveHermesHome(env), "config.yaml");
}

export function hermesAllowlistPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveHermesHome(env), "shell-hooks-allowlist.json");
}

export function hermesHookCommand(): string {
  return "subconscious hook hermes";
}

function timeoutSeconds(spec: HookSpec): number {
  return spec.timeout ?? 5;
}

// ── YAML editing ────────────────────────────────────────────────────────────
//
// Hermes config files are YAML and users keep comments in them, so this edits
// text structurally instead of parse/dump round-tripping through a YAML
// library (which would strip comments repo-wide). The supported shape is a
// top-level mapping whose `hooks:` value is a mapping of event name to list of
// entries carrying `command`, optional `matcher`, optional `timeout`. Any
// other shape is reported rather than rewritten.

function indentOf(line: string): number {
  const match = /^(\s*)/.exec(line);
  return match ? match[1].length : 0;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isListEntry(line: string): boolean {
  return /^\s*-\s/.test(line);
}

function entryCommentIndex(line: string): number {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && index > 0 && /\s/.test(line[index - 1])) {
      return index;
    }
  }
  return line.length;
}

function entryField(line: string, field: string): string | undefined {
  const pattern = new RegExp(`\\b${field}\\s*:\\s*(.+)$`);
  const scope = line.slice(0, entryCommentIndex(line));
  const match = pattern.exec(scope);
  if (!match) return undefined;
  return unquote(match[1]);
}

interface EventRange {
  start: number;
  end: number;
  /** Whether any entry under this event carries our exact command. */
  installed: boolean;
}

interface ParsedHooks {
  /** Index of the top-level `hooks:` line, or -1 when absent. */
  hooksIndex: number;
  /** Index one past the hooks section (next sibling key or EOF). */
  endIndex: number;
  /** Per-event entry line ranges found under hooks. */
  events: Map<string, EventRange>;
  /** True when `hooks:` exists but its value is not an event mapping. */
  unsupportedShape: boolean;
}

function parseHooksSection(lines: string[], command: string): ParsedHooks {
  const parsed: ParsedHooks = {
    hooksIndex: -1,
    endIndex: lines.length,
    events: new Map(),
    unsupportedShape: false,
  };
  const hooksIndent = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^hooks\s*:(\s*(#.*)?)?$/.test(lines[index])) {
      parsed.hooksIndex = index;
      break;
    }
    // A flow-shaped or valued top-level hooks key (`hooks: {}`, `hooks: []`,
    // `hooks: true`) is recognized but not editable.
    if (/^hooks\s*:\s*\S/.test(lines[index])) {
      parsed.hooksIndex = index;
      parsed.endIndex = index + 1;
      parsed.unsupportedShape = true;
      return parsed;
    }
  }
  if (parsed.hooksIndex < 0) return parsed;

  let currentEvent: string | null = null;
  let currentRange: { start: number; end: number } | null = null;
  let currentEventHasListEntry = false;

  const closeEvent = (endIndex: number) => {
    if (currentEvent && currentRange) {
      parsed.events.set(currentEvent, {
        ...currentRange,
        end: endIndex,
        installed: rangeInstalled(lines, currentRange.start, endIndex, command),
      });
    }
    currentEvent = null;
    currentRange = null;
  };

  for (let index = parsed.hooksIndex + 1; index <= lines.length; index += 1) {
    const line = index < lines.length ? lines[index] : "";
    const blank = line.trim().length === 0 || /^\s*#/.test(line);
    const indent = blank ? Number.POSITIVE_INFINITY : indentOf(line);
    const eventMatch =
      !blank && indent === 2
        ? /^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:(\s*(#.*)?)?$/.exec(line)
        : null;
    // Same indentation but WITH a value (`event: []`, `event: {}`): a
    // flow-shaped event body. The canonical event regex above deliberately
    // fails to match it; recognize it here so the section is refused rather
    // than silently duplicated.
    const valuedEventMatch =
      !blank && !eventMatch && indent === 2
        ? /^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\S/.exec(line)
        : null;
    if (valuedEventMatch) {
      parsed.unsupportedShape = true;
      return parsed;
    }

    if (!blank && indent <= hooksIndent && !(eventMatch && indent === 2)) {
      // Next key at the hooks level (or shallower) ends the section.
      closeEvent(index);
      parsed.endIndex = index;
      break;
    }
    if (eventMatch) {
      closeEvent(index);
      currentEvent = eventMatch[1];
      currentRange = { start: index + 1, end: lines.length };
      currentEventHasListEntry = false;
      continue;
    }
    if (blank || currentEvent === null || indent <= 2) continue;
    // Inside an event body, the first content level (indent 4) must be a
    // list entry (`- command: ...`). A bare mapping field there —
    // `command: other` without a dash — is a foreign shape this editor cannot
    // extend; appending a `- command:` entry would produce an invalid
    // mapping/list mix.
    if (indent === 4) {
      if (!isListEntry(line)) {
        parsed.unsupportedShape = true;
        return parsed;
      }
      currentEventHasListEntry = true;
      continue;
    }
    // Deeper lines are continuation fields of a list entry (`command:` /
    // `timeout:` under `- matcher:`). They are only meaningful after such an
    // entry; anything else is a shape we do not edit.
    if (!currentEventHasListEntry) {
      parsed.unsupportedShape = true;
      return parsed;
    }
  }
  closeEvent(Math.min(parsed.endIndex, lines.length));

  return parsed;
}

// Helper so parseHooksSection stays readable without a class.
//
// Dedupe is per exact command string, matching what the allowlist and the
// hook registry key on. The installer writes one canonical bare command, and
// only that exact spelling counts as installed; any other registration is a
// distinct entry.
function rangeInstalled(
  lines: string[],
  start: number,
  end: number,
  command: string,
): boolean {
  for (let index = start; index < end; index += 1) {
    if (entryCommandOrEmpty(lines[index]) === command) return true;
  }
  return false;
}

/**
 * The command an entry line names, or null when the line carries none.
 *
 * Handles both entry shapes: `- command: x` and `- matcher: ".*"` followed by
 * an indented `command: x` continuation line.
 */
function entryCommandOrEmpty(line: string): string | null {
  if (!isListEntry(line)) {
    const indented = /^\s+[A-Za-z_][A-Za-z0-9_]*\s*:/.test(line);
    if (!indented) return null;
  }
  const command = entryField(line, "command");
  if (command !== undefined) return command;
  // Continuation line of a `- matcher:` entry: the field lives at a deeper
  // indent than the dash, which still counts.
  if (/^\s+command\s*:/.test(line)) {
    const scoped = line.replace(/^\s+/, "");
    const pattern = /command\s*:\s*(.+)$/;
    const scope = scoped.slice(0, entryCommentIndex(scoped));
    const match = pattern.exec(scope);
    return match ? unquote(match[1]) : "";
  }
  return null;
}

function renderEntry(
  spec: HookSpec,
  command: string,
  baseIndent: number,
): string[] {
  const pad = " ".repeat(baseIndent + 2);
  if (spec.matcher !== undefined) {
    return [
      `${pad}- matcher: "${spec.matcher}"`,
      `${pad}  command: ${command}`,
      `${pad}  timeout: ${timeoutSeconds(spec)}`,
    ];
  }
  return [
    `${pad}- command: ${command}`,
    `${pad}  timeout: ${timeoutSeconds(spec)}`,
  ];
}

function renderHooksBlock(command: string): string[] {
  const lines = ["hooks:"];
  for (const spec of HERMES_HOOKS) {
    lines.push(`  ${spec.event}:`);
    lines.push(...renderEntry(spec, command, 2));
  }
  return lines;
}

export interface HooksEditResult {
  text: string;
  addedEvents: string[];
  alreadyInstalledEvents: string[];
  /** True when a `hooks:` key exists in a shape this editor must not rewrite. */
  unsupportedShape: boolean;
}

/**
 * Add the Subconscious hook registrations to config.yaml text.
 *
 * Never rewrites unrelated content: everything outside inserted lines is
 * byte-preserved, including comments, quoting style, blank-line layout, and
 * CRLF endings. An existing event gains exactly one more list entry unless our
 * command is already registered there; dedupe is per `(event, exact command)`
 * so unrelated commands on the same event survive untouched.
 */
export function addHermesHooksToYaml(
  originalText: string,
  command: string,
): HooksEditResult {
  const usesCrlf = originalText.includes("\r\n");
  const text = usesCrlf ? originalText.replaceAll("\r\n", "\n") : originalText;
  const lines = text.split("\n");
  const parsed = parseHooksSection(lines, command);

  const result: HooksEditResult = {
    text: originalText,
    addedEvents: [],
    alreadyInstalledEvents: [],
    unsupportedShape: parsed.unsupportedShape,
  };
  if (parsed.unsupportedShape) return result;

  if (parsed.hooksIndex < 0) {
    const needsBlank =
      lines.length > 0 &&
      lines[lines.length - 1].trim() !== "" &&
      !/^\s*#/.test(lines[lines.length - 1]);
    const block = renderHooksBlock(command);
    const prefix = needsBlank ? [...lines, ""] : [...lines];
    const joined = `${[...prefix, ...block].join("\n")}\n`;
    result.text = usesCrlf ? joined.replaceAll("\n", "\r\n") : joined;
    result.addedEvents = HERMES_HOOKS.map((spec) => spec.event);
    return result;
  }

  const insertions: Array<{ atIndex: number; lines: string[] }> = [];
  for (const spec of HERMES_HOOKS) {
    const range = parsed.events.get(spec.event);
    if (!range) {
      insertions.push({
        atIndex: parsed.endIndex,
        lines: [`  ${spec.event}:`, ...renderEntry(spec, command, 2)],
      });
      result.addedEvents.push(spec.event);
      continue;
    }
    if (range.installed) {
      result.alreadyInstalledEvents.push(spec.event);
      continue;
    }
    // Append one entry inside this event's list, right after its last entry.
    insertions.push({
      atIndex: range.end,
      lines: renderEntry(spec, command, 2),
    });
    result.addedEvents.push(spec.event);
  }

  if (insertions.length === 0) return result;

  insertions.sort((a, b) => b.atIndex - a.atIndex);
  for (const insertion of insertions) {
    lines.splice(insertion.atIndex, 0, ...insertion.lines);
  }
  const joined = lines.join("\n");
  result.text = usesCrlf ? joined.replaceAll("\n", "\r\n") : joined;
  return result;
}

// ── Allowlist seeding ───────────────────────────────────────────────────────

export type AllowlistSeedResult =
  | { kind: "seeded"; path: string; added: number }
  | { kind: "malformed"; path: string };

/**
 * Seed exactly the consent allowlist entries these hooks need.
 *
 * Hermes refuses to register a shell hook until its `(event, command)` pair is
 * approved — interactively, via --accept-hooks, or by a matching allowlist
 * entry (`_is_allowlisted` matches exact event and command strings). Seeding
 * the four pairs here keeps a non-TTY install from silently no-oping without
 * flipping any global consent switch: `hooks_auto_accept` stays untouched, and
 * unrelated entries survive.
 *
 * Failure modes are distinguished: a missing file starts fresh; an unreadable
 * (EACCES/IO) or structurally invalid file — including malformed entries in
 * `approvals` — is reported as malformed and never overwritten, because
 * silently replacing security-relevant consent data is worse than asking the
 * user to look at it.
 */
export async function seedHermesAllowlist(
  path: string,
  command: string,
  now = new Date(),
): Promise<AllowlistSeedResult> {
  let rawText: string;
  try {
    rawText = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      rawText = "";
    } else {
      return { kind: "malformed", path };
    }
  }
  let file: Record<string, unknown> = {};
  if (rawText.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return { kind: "malformed", path };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "malformed", path };
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.approvals !== undefined &&
      !Array.isArray(candidate.approvals)
    ) {
      return { kind: "malformed", path };
    }
    if (Array.isArray(candidate.approvals)) {
      for (const entry of candidate.approvals) {
        if (
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          typeof (entry as Record<string, unknown>).event !== "string" ||
          typeof (entry as Record<string, unknown>).command !== "string"
        ) {
          return { kind: "malformed", path };
        }
      }
    }
    file = candidate;
  }
  const approvals = Array.isArray(file.approvals)
    ? (file.approvals as Array<Record<string, unknown>>)
    : [];

  const approvedAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  let added = 0;
  for (const spec of HERMES_HOOKS) {
    const exists = approvals.some(
      (entry) => entry.event === spec.event && entry.command === command,
    );
    if (!exists) {
      approvals.push({ event: spec.event, command, approved_at: approvedAt });
      added += 1;
    }
  }
  await atomicWriteFile(
    path,
    `${JSON.stringify({ ...file, approvals }, null, 2)}\n`,
  );
  return { kind: "seeded", path, added };
}

export interface InstallResult {
  configPath: string;
  allowlistPath: string;
  allowlist: AllowlistSeedResult;
  addedEvents: string[];
  alreadyInstalledEvents: string[];
}

/**
 * Install Hermes hooks through the active profile's config.yaml.
 *
 * Takes no project path: Hermes hooks are profile-global, not per-project, and
 * project scoping happens at observation time via the nearest
 * subconscious.toml. `env` is injectable for tests.
 */
export async function installAdapter(
  harness: KnownHarnessId,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InstallResult> {
  if (harness !== "hermes") {
    throw new Error(`Unsupported harness adapter: ${harness}`);
  }
  const command = hermesHookCommand();
  const configPath = hermesConfigPath(env);
  let existing: string;
  try {
    existing = await readFile(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      existing = "";
    } else {
      throw new Error(`Cannot read ${configPath}: ${(error as Error).message}`);
    }
  }
  const edit = addHermesHooksToYaml(existing, command);
  if (edit.unsupportedShape) {
    // A hooks block in a shape this editor cannot safely extend must not be
    // half-installed: report it without touching the file or the allowlist.
    throw new Error(
      `${configPath} has a hooks block in an unsupported shape (flow or scalar value). Edit it by hand to add these events: ${HERMES_HOOKS.map((spec) => spec.event).join(", ")} with command "${command}".`,
    );
  }
  // Seed consent BEFORE activating hooks. A malformed allowlist must leave
  // both files untouched: installing hooks that Hermes then refuses to
  // register (or, worse, an install error after activation) would leave the
  // user with configured-but-unapproved hooks and no clear recovery path. The
  // reverse — an allowlist entry whose hook is never written — is inert.
  const allowlistPath = hermesAllowlistPath(env);
  const allowlist = await seedHermesAllowlist(allowlistPath, command);
  if (allowlist.kind === "malformed") {
    throw new Error(
      `${allowlistPath} is malformed or unreadable; no hooks were installed. Fix or remove the allowlist file, then rerun subconscious install hermes.`,
    );
  }
  if (edit.text !== existing) {
    await atomicWriteFile(configPath, edit.text);
  }
  return {
    configPath,
    allowlistPath,
    allowlist,
    addedEvents: edit.addedEvents,
    alreadyInstalledEvents: edit.alreadyInstalledEvents,
  };
}
