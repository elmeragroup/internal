import { Effect, Schema } from "effect";

const failureFields = {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Unknown),
};

/** Expected failure of a public release operation; `cause` retains the original thrown value. */
export class ReleaseError extends Schema.TaggedError<ReleaseError>()("ReleaseError", failureFields) {}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- thrown values are narrowed at this seam.
function failed(cause: unknown): ReleaseError {
  return cause instanceof Error
    ? new ReleaseError({ message: cause.message, cause })
    : new ReleaseError({ message: "Release operation failed", cause });
}

/** Lifts synchronous adapter code that throws into the operation error channel. */
export function lift<A>(run: () => A): Effect.Effect<A, ReleaseError> {
  return Effect.try({ try: run, catch: failed });
}

/** Lifts promise-returning adapter code that rejects into the operation error channel. */
export function liftPromise<A>(run: () => Promise<A>): Effect.Effect<A, ReleaseError> {
  return Effect.tryPromise({ try: run, catch: failed });
}
