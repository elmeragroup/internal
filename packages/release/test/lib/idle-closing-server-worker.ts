/**
 * Worker-thread entry for `startIdleClosingServer`. A GitHub- and npm-shaped server that closes a
 * connection once it has sat idle for `idleLimit` milliseconds; a 404 sends its headers before its
 * body. `/repos/acme/ui/...` serves the record calls the store makes, and `/@acme%2fui` is the
 * npm packument. Plain HTTP sends no `Keep-Alive` hint, as GitHub sends none. Over TLS it prefers
 * HTTP/2 through ALPN, as GitHub and npm do, and still accepts HTTP/1.1.
 */
import { Schema } from "effect";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createSecureServer, Http2ServerRequest, Http2ServerResponse } from "node:http2";
import { parentPort, workerData } from "node:worker_threads";

import { decodeJson } from "../../src/json.ts";
import { releaseArchiveName } from "../../src/record.ts";
import { ServerOptions } from "./idle-closing-server-protocol.ts";
import type { ServerListening } from "./idle-closing-server-protocol.ts";

const TagRequest = Schema.Struct({ ref: Schema.String, sha: Schema.String });
const ReleaseRequest = Schema.Record(Schema.String, Schema.Json);
const ListeningAddress = Schema.Struct({ port: Schema.Number });

type Json = Schema.Json;
type Request = IncomingMessage | Http2ServerRequest;
type Response = ServerResponse | Http2ServerResponse;

/** How a route answers: a body sent with its headers, or a 404 whose body trails its headers. */
type Reply = { kind: "json"; status: number; body: Json } | { kind: "late-not-found" };

const options = Schema.decodeUnknownSync(ServerOptions)(workerData);
const connections = new Int32Array(options.connections);
const records = new Map<string, Json>();
const idleTimers = new WeakMap<object, NodeJS.Timeout>();

function route(request: Request, body: string): Reply {
  const path = new URL(request.url ?? "/", "http://local").pathname;
  const key = `${request.method ?? ""} ${path}`;
  if (key === "GET /@acme%2fui") {
    return { kind: "json", status: 200, body: { versions: {}, "dist-tags": { canary: "0.2.0" } } };
  }
  if (key === "GET /@acme%2fmissing") return { kind: "late-not-found" };
  if (key === "GET /repos/acme/ui/releases") return { kind: "json", status: 200, body: [] };
  if (key.startsWith("GET /repos/acme/ui/git/ref/tags/")) {
    const ref = records.get(path);
    return ref === undefined ? { kind: "late-not-found" } : { kind: "json", status: 200, body: ref };
  }
  if (key === "POST /repos/acme/ui/git/refs") {
    const { ref, sha } = decodeJson(body, TagRequest, "tag request");
    const created = { object: { type: "commit", sha } };
    records.set(`/repos/acme/ui/git/ref/${ref.slice("refs/".length)}`, created);
    return { kind: "json", status: 201, body: created };
  }
  if (key === "POST /repos/acme/ui/releases") {
    const release = { ...decodeJson(body, ReleaseRequest, "release request"), id: 1, assets: [] };
    records.set("/repos/acme/ui/releases/1", release);
    return { kind: "json", status: 201, body: release };
  }
  if (key === "POST /repos/acme/ui/releases/1/assets") {
    return {
      kind: "json",
      status: 201,
      body: { id: 2, name: releaseArchiveName, state: "uploaded", size: 3 },
    };
  }
  const known = records.get(path);
  return {
    kind: "json",
    status: 200,
    body:
      request.method === "GET" && known !== undefined ? known : { path, httpVersion: request.httpVersion },
  };
}

const jsonHeaders = { "content-type": "application/json" };

function sendHeaders(response: Response, status: number): void {
  if (response instanceof Http2ServerResponse) {
    // An HTTP/2 response sends its HEADERS frame as soon as it is written.
    response.writeHead(status, jsonHeaders);
  } else {
    response.writeHead(status, jsonHeaders);
    response.flushHeaders();
  }
}

function reply(response: Response, answer: Reply): void {
  if (answer.kind === "late-not-found") {
    sendHeaders(response, 404);
    setTimeout(() => response.end(JSON.stringify({ message: "Not Found" })), 20);
    return;
  }
  // Holding each response briefly makes concurrent requests open separate connections.
  setTimeout(() => {
    sendHeaders(response, answer.status);
    response.end(JSON.stringify(answer.body));
  }, 20);
}

/** The connection a request arrived on, and how to close it; read before its stream finishes. */
function connectionOf(request: Request): { key: object; close: () => void } | undefined {
  if (request instanceof Http2ServerRequest) {
    const { session } = request.stream;
    return session === undefined ? undefined : { key: session, close: () => session.destroy() };
  }
  const { socket } = request;
  return { key: socket, close: () => socket.end() };
}

/** Closes the request's connection once it has sat idle for `idleLimit` after this response. */
function closeWhenIdle(request: Request, response: Response): void {
  const connection = connectionOf(request);
  if (connection === undefined) return;
  clearTimeout(idleTimers.get(connection.key));
  response.on("finish", () => {
    idleTimers.set(connection.key, setTimeout(connection.close, options.idleLimit));
  });
}

function handle(request: Request, response: Response): void {
  closeWhenIdle(request, response);
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    reply(response, route(request, body));
  });
}

function listen(): ReturnType<typeof createServer> | ReturnType<typeof createSecureServer> {
  if (options.transport._tag === "Http") {
    const server = createServer(handle);
    // No `Keep-Alive: timeout` hint, as GitHub sends none; idle connections are closed above.
    server.keepAliveTimeout = 0;
    return server;
  }
  const { key, cert } = options.transport;
  return createSecureServer({ key, cert, allowHTTP1: true }, handle);
}

const server = listen();
server.on("connection", () => {
  Atomics.add(connections, 0, 1);
});
server.listen(0, "127.0.0.1", () => {
  const { port } = Schema.decodeUnknownSync(ListeningAddress)(server.address());
  const listening: ServerListening = { _tag: "ServerListening", port };
  parentPort?.postMessage(listening);
});
