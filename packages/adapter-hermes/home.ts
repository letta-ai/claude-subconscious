import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Hermes home resolution shared by the adapter and the installer.
 *
 * Both need the same answer to "which profile directory does this Hermes
 * process use?" — the installer to edit the right config.yaml, and the hook
 * subprocess to stamp the right state.db path into every payload so a globally
 * shared broker reads the correct transcript. Keeping one implementation here
 * means they can never drift.
 *
 * Semantics mirror upstream `hermes_cli/main.py` (`_apply_profile_override`,
 * issue #22502) and `hermes_constants.py` (`_get_platform_default_hermes_home`,
 * `get_default_hermes_root`).
 */

/**
 * The platform-native Hermes root.
 *
 * `%LOCALAPPDATA%\hermes` on Windows (falling back to
 * `~/AppData/Local/hermes` when the variable is unset), otherwise `~/.hermes`.
 */
export function defaultHermesRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) return join(localAppData, "hermes");
    return join(homedir(), "AppData", "Local", "hermes");
  }
  return join(homedir(), ".hermes");
}

/** Hermes' own profile-name validation (main.py): lowercase, -, _ digits. */
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function readActiveProfile(root: string): string | undefined {
  try {
    const name = readFileSync(join(root, "active_profile"), "utf8").trim();
    return PROFILE_NAME_PATTERN.test(name) ? name : undefined;
  } catch {
    // Missing or unreadable marker: no active profile.
    return undefined;
  }
}

function isProfilePath(home: string): boolean {
  const segments = home.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.length >= 2 && segments[segments.length - 2] === "profiles";
}

/**
 * Resolve the Hermes home the running Hermes would use.
 *
 * Mirrors the profile override in `hermes_cli/main.py`: an explicit
 * HERMES_HOME whose immediate parent is named `profiles` is already a final
 * profile directory; any other HERMES_HOME — including the plain root — still
 * follows `<root>/active_profile`, because the user may have switched profiles
 * with `hermes profile use`. A non-default active profile resolves to
 * `<root>/profiles/<name>`. A missing, invalid, or `default` marker keeps an
 * explicit HERMES_HOME at that root; without HERMES_HOME, the platform-native
 * root is used.
 */
export function resolveHermesHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const nativeRoot = defaultHermesRoot(env);
  const envHome = env.HERMES_HOME?.trim();
  if (envHome) {
    if (isProfilePath(envHome)) return envHome;
    const root = envHome === nativeRoot ? nativeRoot : envHome;
    const active = readActiveProfile(root);
    if (active && active !== "default") {
      return join(root, "profiles", active);
    }
    return envHome;
  }
  const active = readActiveProfile(nativeRoot);
  if (active && active !== "default") {
    return join(nativeRoot, "profiles", active);
  }
  return nativeRoot;
}
