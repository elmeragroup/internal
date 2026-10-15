import { Effect } from "effect";
import type { Scope } from "effect";
import { Agent, fetch as undiciFetch } from "undici";

/** One request the engine sends; a subset of `RequestInit` that every fetch implementation accepts. */
export type TransportRequest = {
  readonly method: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Blob;
  readonly signal: AbortSignal;
};

/**
 * The engine's HTTP port: an absolute URL and a {@link TransportRequest}. The global `fetch`
 * satisfies it, which is what tests inject.
 */
export type ReleaseTransport = (url: string, init: TransportRequest) => Promise<Response>;

/**
 * Connection settings under which no connection carries a second request:
 * - `allowH2: false` offers only HTTP/1.1 through ALPN. GitHub and npm otherwise negotiate HTTP/2,
 *   which multiplexes every request over one long-lived session and ignores `pipelining`.
 * - `pipelining: 0` turns keep-alive off: each request is sent with `connection: close`, the
 *   connection counts as busy while it is in flight, and it is closed after the response.
 * Keep-alive timeouts and the per-origin connection limit only matter for reused connections.
 */
const singleUseConnections = { allowH2: false, pipelining: 0 } as const;

/**
 * Acquires the transport for one release operation: undici's `fetch` over an `Agent` the
 * operation owns, which speaks HTTP/1.1 only, never reuses a connection, and is destroyed when the
 * scope closes.
 *
 * The engine blocks its event loop while the adapter packs and while git, tar, Changesets, and npm
 * run, so a connection pool cannot notice that GitHub or npm closed an idle connection. A request
 * that reused such a connection failed with `EPIPE`, `UND_ERR_SOCKET` ("other side closed"), or,
 * over HTTP/2, `UND_ERR_INFO` (`GOAWAY`). This agent shares no pool with the global `fetch` and
 * opens a new connection for every request, so neither its own nor anyone else's idle connections
 * can be picked: a request after a blocking phase always reaches the server, whatever the phase's
 * length, and nothing is resent.
 */
export function acquireReleaseTransport(): Effect.Effect<ReleaseTransport, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => new Agent(singleUseConnections)),
    (agent) => Effect.promise(() => agent.destroy())
  ).pipe(
    Effect.map(
      (agent): ReleaseTransport =>
        (url, init) =>
          undiciFetch(url, { ...init, dispatcher: agent })
    )
  );
}
