import { Effect, Schema } from "effect";

/** Expected failure of a release operation. Domain helpers still throw `Error`. */
export class ReleaseError extends Schema.TaggedError<ReleaseError>()("ReleaseError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.String),
}) {}

/** The deepest recorded diagnostic, so wrapped decode failures keep their detail. */
function diagnosticCause(error: Error): string | undefined {
  let current: unknown = error.cause;
  let message: string | undefined;
  while (current instanceof Error) {
    message = current.message;
    current = current.cause;
  }
  return message;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- thrown values are narrowed at this seam.
export function toReleaseError(cause: unknown): ReleaseError {
  if (cause instanceof ReleaseError) return cause;
  if (cause instanceof Error) {
    const diagnostic = diagnosticCause(cause);
    return diagnostic === undefined
      ? new ReleaseError({ message: cause.message })
      : new ReleaseError({ message: cause.message, cause: diagnostic });
  }
  return new ReleaseError({ message: "Release operation failed" });
}

export function attempt<A>(try_: () => A): Effect.Effect<A, ReleaseError> {
  return Effect.try({ try: try_, catch: toReleaseError });
}

export function attemptPromise<A>(try_: () => Promise<A>): Effect.Effect<A, ReleaseError> {
  return Effect.tryPromise({ try: try_, catch: toReleaseError });
}
