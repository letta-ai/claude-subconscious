import { createHash, randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export interface BrokerDescriptor {
  version: 1;
  endpoint: string;
  token: string;
  pid: number;
  startedAt: string;
  /**
   * Which build is serving. Absent on a descriptor written before this field
   * existed, which reads as stale.
   */
  build?: string;
}

/**
 * Identify the build behind a broker so a stale daemon can be replaced.
 *
 * The broker outlives the code that started it. Repointing the plugin, or
 * rebuilding while a daemon runs, leaves a process answering every request with
 * last week's behavior, and a liveness ping cannot tell the difference.
 *
 * Path plus modification time catches the cases that matter: a different
 * install location, an upgrade, and a rebuild. It does not catch editing a
 * source file that the entry point does not import directly, so `restart`
 * stays the explicit escape hatch during development.
 */
export async function buildFingerprint(entryPath: string): Promise<string> {
  try {
    const info = await stat(entryPath);
    return `${entryPath}@${info.mtimeMs}`;
  } catch {
    return entryPath;
  }
}

export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.SUBCONSCIOUS_HOME?.trim() || join(homedir(), ".letta", "subconscious")
  );
}

export function descriptorPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDirectory(env), "broker.json");
}

export function brokerLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDirectory(env), "broker.lock");
}

function userKey(): string {
  const source = `${userInfo().username}\0${homedir()}`;
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

export function brokerEndpoint(): string {
  const key = userKey();
  if (process.platform === "win32")
    return `\\\\.\\pipe\\letta-subconscious-${key}`;
  const uid = typeof process.getuid === "function" ? process.getuid() : key;
  return join(tmpdir(), `letta-subconscious-${uid}.sock`);
}

export function createBrokerDescriptor(): BrokerDescriptor {
  return {
    version: 1,
    endpoint: brokerEndpoint(),
    token: randomBytes(32).toString("base64url"),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
}
