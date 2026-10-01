import { Duration, Effect, Result, Schedule } from "effect";

import { lift, ReleaseError } from "./errors.ts";
import type { VerifiedRelease } from "./intent.ts";
import type { NpmPublisher, Registry } from "./npm.ts";
import { distTagFor, npmIdentity, planPublication, shouldPromote } from "./policy.ts";
import type { CommitAncestry } from "./policy.ts";

/**
 * Everything publication reads from the engine; `ReleaseDeps` is a superset, and
 * `CheckedCommitDeps` a superset of that.
 */
export type PublicationDeps = {
  readRegistry: () => Effect.Effect<Registry, ReleaseError>;
  npm: NpmPublisher;
  ancestry: CommitAncestry;
  /** Delay before the first re-read; it doubles per re-read up to `maxConfirmationDelay`. */
  confirmationInterval: Duration.Input;
  /**
   * Total time confirmation keeps re-reading the registry after the first read, separately for the
   * upload and the dist-tag. A zero `confirmationInterval` never re-reads, whatever the window.
   */
  confirmationWindow: Duration.Input;
};

/**
 * Live confirmation timing. npm processes a new version asynchronously ("may take a few minutes
 * to become available") and has taken longer than four minutes, so the window allows ten.
 */
export const liveConfirmation = {
  confirmationInterval: Duration.seconds(5),
  confirmationWindow: Duration.minutes(10),
} as const satisfies Pick<PublicationDeps, "confirmationInterval" | "confirmationWindow">;

/** Caps the doubling delay so a long window polls npm every 30 seconds rather than hammering it. */
const maxConfirmationDelay = Duration.seconds(30);

const unverifiedPublication = "Publication could not be verified; retry the recorded release";

function confirmationDelay(interval: Duration.Duration, retry: number): Duration.Duration {
  return Duration.min(Duration.times(interval, 2 ** retry), maxConfirmationDelay);
}

/**
 * The number of re-reads whose delays first cover `window`. Counting scheduled delays rather than
 * wall-clock time keeps the read count independent of registry latency, so the slept total is at
 * least the window and tests on a test clock see a deterministic schedule.
 */
function confirmationRetries(interval: Duration.Duration, window: Duration.Duration): number {
  if (!Duration.isPositive(interval)) return 0;
  let retries = 0;
  let waited = Duration.zero;
  while (Duration.isLessThan(waited, window)) {
    waited = Duration.sum(waited, confirmationDelay(interval, retries));
    retries += 1;
  }
  return retries;
}

function confirmationSchedule(deps: PublicationDeps) {
  const interval = Duration.fromInputUnsafe(deps.confirmationInterval);
  const window = Duration.fromInputUnsafe(deps.confirmationWindow);
  return Schedule.recurs(confirmationRetries(interval, window)).pipe(
    Schedule.addDelay((metadata) => Effect.succeed(confirmationDelay(interval, metadata.output)))
  );
}

/** Polls the registry until `isVisible` holds or the confirmation window is spent. */
function confirmRegistry(
  deps: PublicationDeps,
  isVisible: (registry: Registry) => boolean
): Effect.Effect<Registry | undefined, ReleaseError> {
  return Effect.gen(function* () {
    const registry = yield* deps.readRegistry();
    const visible = yield* lift(() => isVisible(registry));
    return visible ? registry : undefined;
  }).pipe(
    Effect.repeat({
      schedule: confirmationSchedule(deps),
      until: (registry) => registry !== undefined,
    })
  );
}

/** Uploads the archive and returns the first registry read that shows those exact bytes. */
function uploadAndConfirm(
  release: VerifiedRelease,
  deps: PublicationDeps
): Effect.Effect<Registry, ReleaseError> {
  return Effect.gen(function* () {
    const published = yield* Effect.result(deps.npm.publish(release.archive));
    const confirmed = yield* confirmRegistry(deps, (registry) => npmIdentity(release, registry) === "match");
    if (confirmed !== undefined) return confirmed;
    if (Result.isFailure(published)) {
      return yield* new ReleaseError({
        message: unverifiedPublication,
        cause: published.failure,
      });
    }
    return yield* new ReleaseError({ message: unverifiedPublication });
  });
}

function promoteAndConfirm(
  release: VerifiedRelease,
  deps: PublicationDeps
): Effect.Effect<void, ReleaseError> {
  return Effect.gen(function* () {
    const tag = distTagFor(release.channel);
    yield* deps.npm.promote(release.version, tag);
    const confirmed = yield* confirmRegistry(deps, (registry) => registry.tags.get(tag) === release.version);
    if (confirmed === undefined) {
      return yield* new ReleaseError({
        message: `npm ${tag} update is not visible; retry the recorded release`,
      });
    }
  });
}

/**
 * Publishes a verified release against the registry: uploads and confirms the archive when npm does
 * not have it, promotes the channel dist-tag when policy says so, and reports `"superseded"` when a
 * newer release owns the channel. A same-version identity mismatch and confirmation timeouts fail.
 */
export function publishVerifiedRelease(
  release: VerifiedRelease,
  deps: PublicationDeps
): Effect.Effect<"published" | "superseded", ReleaseError> {
  return Effect.gen(function* () {
    const registry = yield* deps.readRegistry();
    const intended = yield* lift(() => planPublication(release, registry, deps.ancestry));
    if (intended.kind === "superseded") return "superseded";
    const confirmed = intended.upload ? yield* uploadAndConfirm(release, deps) : registry;
    const promote = yield* lift(() => shouldPromote(release, confirmed, deps.ancestry));
    if (promote) yield* promoteAndConfirm(release, deps);
    return "published";
  });
}
