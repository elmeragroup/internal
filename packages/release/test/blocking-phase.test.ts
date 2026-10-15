import { Effect, Exit, Redacted, Schema, Scope } from "effect";
import { describe, expect, it, onTestFinished } from "vitest";

import { createGitHubClient, releaseEnvironment } from "../src/github.ts";
import type { GitHubClient, ReleaseEnvironment } from "../src/github.ts";
import { readRegistry } from "../src/npm.ts";
import type { ReleaseTransport } from "../src/release-transport.ts";
import { createReleaseStore } from "../src/store.ts";
import type { ServerTransport } from "./lib/idle-closing-server-protocol.ts";
import { startIdleClosingServer } from "./lib/idle-closing-server.ts";
import type { IdleClosingServer } from "./lib/idle-closing-server.ts";
import { releaseIntent } from "./lib/release-fixtures.ts";
import { createTestCertificate, trustUntilTestFinishes } from "./lib/test-certificate.ts";

/** How long the server keeps an idle connection open; the blocking phase lasts several times longer. */
const idleLimitMs = 100;
const blockingPhaseMs = idleLimitMs * 4;

const RoutedPath = Schema.Struct({ path: Schema.String });
const ServedOver = Schema.Struct({ path: Schema.String, httpVersion: Schema.String });

/**
 * Blocks the event loop the way the adapter's `spawnSync` pack or `npm publish` does: no timer,
 * socket event, or pool housekeeping runs until it returns.
 */
function blockEventLoop(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Sends the GitHub and npm URLs the engine builds to `origin`, through `transport` unchanged.
 * The engine's transport takes URL strings only, so there is no `Request` to carry over.
 */
function routedTo(origin: string, transport: ReleaseTransport): ReleaseTransport {
  return (url, init) => {
    const { pathname, search } = new URL(url);
    return transport(`${origin}${pathname}${search}`, init);
  };
}

type Engine = {
  server: IdleClosingServer;
  environment: ReleaseEnvironment;
  client: GitHubClient;
};

/**
 * The production environment from `releaseEnvironment`, its transport routed to a new
 * idle-closing server (plain HTTP unless `transport` says otherwise). The transport is released when the current test finishes.
 */
async function startEngine(transport?: ServerTransport): Promise<Engine> {
  const server = await startIdleClosingServer(idleLimitMs, transport);
  const scope = Scope.makeUnsafe();
  onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const live = await Effect.runPromise(releaseEnvironment().pipe(Scope.provide(scope)));
  const environment: ReleaseEnvironment = {
    repository: "acme/ui",
    token: Redacted.make("token"),
    fetch: routedTo(server.origin, live.fetch),
  };
  return { server, environment, client: createGitHubClient(environment) };
}

describe("engine requests", () => {
  it("reach GitHub after a blocking phase however many connections were pooled", async () => {
    const { server, client } = await startEngine();
    await Promise.all(
      ["one", "two"].map((name) => client.jsonFrom(`${client.root}/warm/${name}`, RoutedPath, "warm-up"))
    );
    // A tag lookup that misses leaves its 404 body unread, as `find` and `create` do.
    expect(await client.request(`${client.root}/git/ref/tags/missing`, { allow404: true })).toBeUndefined();
    expect(server.connections()).toBeGreaterThanOrEqual(2);

    blockEventLoop(blockingPhaseMs);

    const read = await client.jsonFrom(`${client.root}/releases/7`, RoutedPath, "release");
    expect(read.path).toBe("/repos/acme/ui/releases/7");
  });

  it("reach GitHub after a blocking phase when other code pooled connections to the same host", async () => {
    const { server, client } = await startEngine();
    // An adapter or consumer in the same process, using the global fetch and its shared pool.
    await Promise.all(
      ["one", "two"].map(async (name) => (await globalThis.fetch(`${server.origin}/warm/${name}`)).text())
    );
    const missing = await globalThis.fetch(`${server.origin}/repos/acme/ui/git/ref/tags/missing`);
    expect(missing.status).toBe(404);
    expect(server.connections()).toBeGreaterThanOrEqual(2);

    blockEventLoop(blockingPhaseMs);

    const read = await client.jsonFrom(`${client.root}/releases/7`, RoutedPath, "release");
    expect(read.path).toBe("/repos/acme/ui/releases/7");
  });

  it("speak HTTP/1.1 on a connection per request, even to a server that prefers HTTP/2", async () => {
    const certificate = createTestCertificate();
    trustUntilTestFinishes(certificate);
    const { server, client } = await startEngine({ _tag: "Https", ...certificate });
    const warmed = await Promise.all(
      ["one", "two"].map((name) => client.jsonFrom(`${client.root}/warm/${name}`, ServedOver, "warm-up"))
    );
    expect(await client.request(`${client.root}/git/ref/tags/missing`, { allow404: true })).toBeUndefined();

    blockEventLoop(blockingPhaseMs);

    const written = await client.json(
      await client.request(`${client.root}/notes`, { method: "POST", body: "{}" }),
      ServedOver,
      "write"
    );
    const read = await client.jsonFrom(`${client.root}/releases/7`, ServedOver, "release");
    expect([...warmed, written, read].map((served) => served.httpVersion)).toEqual([
      "1.1",
      "1.1",
      "1.1",
      "1.1",
    ]);
    // Two warm-ups, the 404, the write, and the read: one connection each.
    expect(server.connections()).toBe(5);
  });

  it("reach the npm registry after a blocking phase however many connections were pooled", async () => {
    const { server, environment } = await startEngine();
    await Promise.all(
      ["@acme/ui", "@acme/ui"].map((name) => Effect.runPromise(readRegistry(name, environment.fetch)))
    );
    // An unpublished package's 404 leaves its body unread.
    const unpublished = await Effect.runPromise(readRegistry("@acme/missing", environment.fetch));
    expect(unpublished.versions.size).toBe(0);
    expect(server.connections()).toBeGreaterThanOrEqual(2);

    blockEventLoop(blockingPhaseMs);

    const registry = await Effect.runPromise(readRegistry("@acme/ui", environment.fetch));
    expect(registry.tags.get("canary")).toBe("0.2.0");
  });

  it("open one connection each, so no connection outlives its request", async () => {
    const { server, client } = await startEngine();
    for (const name of ["one", "two", "three"]) {
      await client.jsonFrom(`${client.root}/sequential/${name}`, RoutedPath, "sequential read");
    }
    expect(server.connections()).toBe(3);
  });

  it("upload the archive after a pack phase that outlasts the idle limit", async () => {
    const { client } = await startEngine();
    const store = createReleaseStore(client, "@acme/ui");
    const created = await Effect.runPromise(store.create(releaseIntent("0.2.0")));

    blockEventLoop(blockingPhaseMs);

    const uploaded = await Effect.runPromise(store.upload(created, new Uint8Array([1, 2, 3])));
    expect(uploaded.asset).toEqual({ state: "uploaded", id: 2 });
  });
});
