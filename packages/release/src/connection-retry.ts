import { Schema } from "effect";

/**
 * Failure codes of a request whose pooled keep-alive connection was already gone. GitHub drops
 * idle connections within a minute without a keep-alive hint, and the engine blocks its event
 * loop while the adapter packs and while npm runs, so the pool cannot notice before it reuses the
 * socket: the next request fails with `UND_ERR_SOCKET` ("other side closed") or `EPIPE`.
 */
const DROPPED_CONNECTION_CODES: ReadonlySet<string> = new Set(["UND_ERR_SOCKET", "EPIPE", "ECONNRESET"]);

/**
 * Methods the engine may send twice. GET, HEAD, PUT and DELETE are idempotent, and the engine's
 * only PATCH sets fixed fields on its own release. POST writes are never resent: each follows a
 * state read, so rerunning the Merge job resumes them instead.
 */
const RESENDABLE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "PUT", "DELETE", "PATCH"]);

/** The system error a failed fetch carries as its `cause`; only its code is read. */
const isCodedCause = Schema.is(Schema.Struct({ code: Schema.String }));

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- fetch rejects with arbitrary values.
function droppedConnection(error: unknown): boolean {
  return (
    error instanceof TypeError && isCodedCause(error.cause) && DROPPED_CONNECTION_CODES.has(error.cause.code)
  );
}

function requestMethod(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

/**
 * Wraps `fetcher` so a resendable request that fails on a dropped connection is sent once more,
 * which opens a fresh connection. HTTP error statuses, aborts, other network failures, a POST, and
 * a second drop all pass through unchanged.
 */
export function resendOnDroppedConnection(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    try {
      return await fetcher(input, init);
    } catch (error) {
      if (!droppedConnection(error) || !RESENDABLE_METHODS.has(requestMethod(input, init))) throw error;
      return fetcher(input, init);
    }
  };
}
