import { Effect, Schema } from "effect";

const releasePorts = [
  "engine",
  "pack",
  "git",
  "store",
  "gate",
  "registry",
  "plan",
  "archive",
  "publication",
] as const;

/** The subsystem that raised a `ReleaseError`. */
export type ReleasePort = (typeof releasePorts)[number];

const failureFields = {
  port: Schema.Literals(releasePorts),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.String),
};

/** Expected failure of a public release operation, tagged with the port that raised it. */
export class ReleaseError extends Schema.TaggedError<ReleaseError>()("ReleaseError", failureFields) {}

type FailureDetails = { readonly message: string; readonly cause?: string };

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
function failureDetails(cause: unknown): FailureDetails {
  if (!(cause instanceof Error)) return { message: "Release operation failed" };
  const diagnostic = diagnosticCause(cause);
  return diagnostic === undefined
    ? { message: cause.message }
    : { message: cause.message, cause: diagnostic };
}

function portFailure(port: ReleasePort, cause: unknown): ReleaseError {
  return new ReleaseError({ port, ...failureDetails(cause) });
}

/** Lifts synchronous adapter code that throws into the operation error channel. */
export function lift<A>(port: ReleasePort, run: () => A): Effect.Effect<A, ReleaseError> {
  return Effect.try({ try: run, catch: (cause) => portFailure(port, cause) });
}

/** Lifts promise-returning adapter code that rejects into the operation error channel. */
export function liftPromise<A>(port: ReleasePort, run: () => Promise<A>): Effect.Effect<A, ReleaseError> {
  return Effect.tryPromise({ try: run, catch: (cause) => portFailure(port, cause) });
}
