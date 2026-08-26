import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * An App Server subprocess the test owns outright.
 *
 * The SDK's local client lazily starts a shared App Server for management
 * calls and exposes no public close for it, so a Vitest worker can exit while
 * that child lives on. Instead of reaching into SDK internals or sweeping the
 * process table, the suite starts the server here - same pinned CLI, same
 * arguments the SDK itself uses - hands the URL to the client through its
 * public `appServer.url` option, and terminates the child at teardown.
 */
export interface OwnedAppServer {
  url: string;
  /** Terminate the child; SIGKILL follows if SIGTERM is not enough. */
  close(): Promise<void>;
}

const LISTENING_RE = /^Listening on\s+(ws:\/\/\S+)\s*$/m;
const STARTUP_TIMEOUT_MS = 120_000;
/**
 * Both pipes are drained for as long as the child lives - a full pipe would
 * block the server - so the retained tail is what stays bounded.
 */
const OUTPUT_TAIL_BYTES = 8_000;

/**
 * Resolve this repo's pinned Letta Code CLI.
 *
 * This file lives at `<repo>/tests/e2e/`, so the repo root is exactly two
 * levels up; the resolved path is verified to exist rather than trusted,
 * because a wrong guess would otherwise surface as a confusing spawn error.
 */
function cliPath(): string {
  const candidate = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "node_modules",
    "@letta-ai",
    "letta-code",
    "letta.js",
  );
  if (!existsSync(candidate)) {
    throw new Error(
      `The pinned Letta Code CLI was not found at ${candidate}. Run npm install first.`,
    );
  }
  return candidate;
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const escalate = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 5_000);
  escalate.unref();
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        clearInterval(check);
        resolve();
      }
    }, 50);
    check.unref();
  });
}

export function startOwnedAppServer(): Promise<OwnedAppServer> {
  const child = spawn(
    process.execPath,
    [
      cliPath(),
      "--backend",
      "api",
      "app-server",
      "--listen",
      "ws://127.0.0.1:0",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  return new Promise<OwnedAppServer>((resolve, reject) => {
    let settled = false;
    let output = "";

    // Startup-scoped timer only. The error and exit listeners stay attached
    // for the child's whole life: `fail()` no-ops once settled, so they
    // consume any unexpected late events safely, and a ChildProcess must
    // never sit without an `error` listener.
    const timeout = setTimeout(() => {
      fail(
        new Error(
          `The owned App Server did not report a listening URL within ${STARTUP_TIMEOUT_MS}ms. Output so far: ${output}`,
        ),
      );
    }, STARTUP_TIMEOUT_MS);

    const onError = (error: Error) => fail(error);
    const onExit = (code: number | null, signal: string | null) => {
      fail(
        new Error(
          `The owned App Server exited before listening (code=${code ?? "null"}, signal=${signal ?? "null"}). Output so far: ${output}`,
        ),
      );
    };

    // Stream-scoped listener: both pipes are drained for as long as the child
    // lives, whatever happens around them. Only close() detaches these, once
    // the process is gone.
    const drain = (chunk: unknown) => {
      output = (output + String(chunk)).slice(-OUTPUT_TAIL_BYTES);
      const match = output.match(LISTENING_RE);
      if (match?.[1]) settle(match[1]);
    };

    function detachAll() {
      clearTimeout(timeout);
      child.stdout?.off("data", drain);
      child.stderr?.off("data", drain);
      child.off("error", onError);
      child.off("exit", onExit);
    }

    function settle(detectedUrl: string) {
      if (settled) return;
      settled = true;
      // Startup timer only; listeners stay until close() has finished.
      clearTimeout(timeout);
      resolve({
        url: detectedUrl,
        close: () => {
          terminate(child);
          return waitForExit(child).then(detachAll);
        },
      });
    }

    function fail(error: Error) {
      if (settled) return;
      settled = true;
      detachAll();
      terminate(child);
      reject(error);
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", drain);
    child.stderr?.on("data", drain);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}
