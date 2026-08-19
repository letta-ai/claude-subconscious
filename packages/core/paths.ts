import { createHash, randomBytes } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export interface BrokerDescriptor {
  version: 1;
  endpoint: string;
  token: string;
  pid: number;
  startedAt: string;
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
