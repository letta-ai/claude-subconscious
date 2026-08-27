import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  applyRetention,
  DEFAULT_RETENTION,
  type RetentionPolicy,
} from "./retention.js";
import type { BrokerState } from "./types.js";

export function createEmptyState(): BrokerState {
  return {
    version: 1,
    routes: {},
    observations: {},
    observationOrder: [],
    deliveries: {},
  };
}

function validateState(raw: unknown): BrokerState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("State must be a JSON object.");
  }
  const state = raw as Partial<BrokerState>;
  if (state.version !== 1) throw new Error("Unsupported state version.");
  if (!state.routes || !state.observations || !state.deliveries) {
    throw new Error("State is missing required maps.");
  }
  if (!Array.isArray(state.observationOrder)) {
    throw new Error("State is missing observationOrder.");
  }
  return state as BrokerState;
}

export async function atomicWriteFile(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class StateStore {
  readonly path: string;
  private readonly retention: RetentionPolicy;
  private state: BrokerState | null = null;
  private current: Promise<unknown> = Promise.resolve();

  constructor(
    stateDirectory: string,
    retention: RetentionPolicy = DEFAULT_RETENTION,
  ) {
    this.path = join(stateDirectory, "state.json");
    this.retention = retention;
  }

  async load(): Promise<BrokerState> {
    if (this.state) return this.state;
    if (!existsSync(this.path)) {
      this.state = createEmptyState();
      return this.state;
    }
    const text = await readFile(this.path, "utf8");
    this.state = validateState(JSON.parse(text));
    return this.state;
  }

  async snapshot(): Promise<BrokerState> {
    return structuredClone(await this.load());
  }

  /**
   * Read the live state without copying it.
   *
   * `select` runs synchronously against the store's own object, so it observes
   * exactly the instant a `snapshot()` clone would and still cannot interleave
   * with the serialized writer. The caller must neither change nor retain what
   * it is handed: clone whatever the selector returns.
   *
   * This exists because the drain loop asks for the next queued observation
   * once per iteration. Cloning the whole state each time made the cost of
   * draining one observation grow with the size of the entire state.
   */
  async read<T>(select: (state: BrokerState) => T): Promise<T> {
    return select(await this.load());
  }

  async update<T>(mutate: (state: BrokerState) => T | Promise<T>): Promise<T> {
    const previous = this.current.catch(() => undefined);
    let result!: T;
    this.current = previous.then(async () => {
      const state = await this.load();
      result = await mutate(state);
      // Retention runs on the writer's side of every write, so the file on disk
      // is always the pruned one. An oversized `state.json` inherited from an
      // older build is therefore repaired by the first write a broker makes,
      // which is `recoverInterrupted()` during start-up.
      applyRetention(state, this.retention);
      await atomicWriteFile(this.path, `${JSON.stringify(state, null, 2)}\n`);
    });
    await this.current;
    return result;
  }

  async recoverInterrupted(now = new Date().toISOString()): Promise<void> {
    await this.update((state) => {
      for (const observation of Object.values(state.observations)) {
        if (observation.status !== "processing") continue;
        observation.status = "needs_reconciliation";
        observation.error =
          "The broker stopped while this observation was in flight.";
        observation.updatedAt = now;
      }
    });
  }
}
