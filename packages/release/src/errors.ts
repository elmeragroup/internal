import { Effect, Schema } from "effect";

/** Expected failure of a release operation. Domain helpers still throw `Error`. */
export class ReleaseError extends Schema.TaggedError<ReleaseError>()("ReleaseError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.String),
}) {}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- thrown values are narrowed at this seam.
export function toReleaseError(cause: unknown): ReleaseError {
  if (cause instanceof ReleaseError) return cause;
  if (cause instanceof Error) return new ReleaseError({ message: cause.message });
  return new ReleaseError({ message: "Release operation failed" });
}

export function attempt<A>(try_: () => A): Effect.Effect<A, ReleaseError> {
  return Effect.try({ try: try_, catch: toReleaseError });
}

export function attemptPromise<A>(try_: () => Promise<A>): Effect.Effect<A, ReleaseError> {
  return Effect.tryPromise({ try: try_, catch: toReleaseError });
}
