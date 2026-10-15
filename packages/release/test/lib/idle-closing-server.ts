import { Schema } from "effect";
import { Worker } from "node:worker_threads";
import { onTestFinished } from "vitest";

import { ServerListening } from "./idle-closing-server-protocol.ts";
import type { ServerOptions, ServerTransport } from "./idle-closing-server-protocol.ts";

/** A running idle-closing server; it stops when the current test finishes. */
export type IdleClosingServer = {
  /** `http://127.0.0.1:<port>`, or `https://` for a TLS server. */
  origin: string;
  /** Connections the server has accepted so far. */
  connections: () => number;
};

/**
 * Starts the GitHub- and npm-shaped server from `idle-closing-server-worker.ts` in its own thread,
 * so it keeps serving while a test blocks the main thread's event loop. The thread is terminated
 * when the current test finishes, even when it fails before it listens.
 */
export async function startIdleClosingServer(
  idleLimit: number,
  transport: ServerTransport = { _tag: "Http" }
): Promise<IdleClosingServer> {
  const shared = new SharedArrayBuffer(4);
  const connections = new Int32Array(shared);
  const options: ServerOptions = { transport, idleLimit, connections: shared };
  const worker = new Worker(new URL("./idle-closing-server-worker.ts", import.meta.url), {
    workerData: options,
  });
  onTestFinished(async () => {
    await worker.terminate();
  });
  const listening = await new Promise<ServerListening>((resolve, reject) => {
    worker.once("message", (message) => {
      try {
        resolve(Schema.decodeUnknownSync(ServerListening)(message));
      } catch (error) {
        reject(error);
      }
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      reject(new Error(`Idle-closing server exited with code ${String(code)} before it listened`));
    });
  });
  return {
    origin: `${transport._tag === "Http" ? "http" : "https"}://127.0.0.1:${String(listening.port)}`,
    connections: () => Atomics.load(connections, 0),
  };
}
