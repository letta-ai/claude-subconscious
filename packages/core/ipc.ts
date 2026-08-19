import { chmod, readFile, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { atomicWriteFile } from "./state.js";
import type { BrokerDescriptor } from "./paths.js";
import type {
  BrokerRequest,
  BrokerRequestWithoutToken,
  BrokerResponse,
} from "./protocol.js";

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function writeBrokerDescriptor(
  path: string,
  descriptor: BrokerDescriptor,
): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(descriptor, null, 2)}\n`);
}

export async function readBrokerDescriptor(
  path: string,
): Promise<BrokerDescriptor | null> {
  try {
    const parsed = JSON.parse(
      await readFile(path, "utf8"),
    ) as Partial<BrokerDescriptor>;
    if (
      parsed.version !== 1 ||
      typeof parsed.endpoint !== "string" ||
      typeof parsed.token !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return parsed as BrokerDescriptor;
  } catch {
    return null;
  }
}

export async function removeBrokerFiles(
  descriptor: BrokerDescriptor,
  path: string,
): Promise<void> {
  await rm(path, { force: true });
  if (process.platform !== "win32")
    await rm(descriptor.endpoint, { force: true });
}

export async function sendBrokerRequest(
  descriptor: BrokerDescriptor,
  request: BrokerRequestWithoutToken,
  timeoutMs = 2_000,
): Promise<BrokerResponse> {
  return await new Promise<BrokerResponse>((resolve, reject) => {
    const socket = createConnection(descriptor.endpoint);
    let settled = false;
    let response = "";
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      action();
    };
    const timeout = setTimeout(
      () =>
        finish(() =>
          reject(new Error("Timed out waiting for the Subconscious broker.")),
        ),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ ...request, token: descriptor.token })}\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_MESSAGE_BYTES) {
        finish(() =>
          reject(new Error("Broker response exceeded the size limit.")),
        );
      }
    });
    socket.on("end", () => {
      finish(() => {
        try {
          resolve(JSON.parse(response.trim()) as BrokerResponse);
        } catch (error) {
          reject(new Error(`Invalid broker response: ${errorMessage(error)}`));
        }
      });
    });
    socket.on("error", (error) => finish(() => reject(error)));
  });
}

export async function createBrokerServer(
  descriptor: BrokerDescriptor,
  handle: (request: BrokerRequest) => Promise<BrokerResponse>,
): Promise<Server> {
  if (process.platform !== "win32")
    await rm(descriptor.endpoint, { force: true });
  const server = createServer((socket) => {
    let input = "";
    let answered = false;
    socket.setEncoding("utf8");
    socket.on("data", async (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES) socket.destroy();
      if (answered || !input.includes("\n")) return;
      answered = true;
      let response: BrokerResponse;
      try {
        const request = JSON.parse(
          input.slice(0, input.indexOf("\n")).trim(),
        ) as BrokerRequest;
        if (request.token !== descriptor.token) {
          response = { ok: false, error: "Invalid broker token." };
        } else {
          response = await handle(request);
        }
      } catch (error) {
        response = { ok: false, error: errorMessage(error) };
      }
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(descriptor.endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") await chmod(descriptor.endpoint, 0o600);
  return server;
}
