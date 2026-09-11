import { Duration, Effect, Result, Schedule } from "effect";

import { lift, ReleaseError } from "./errors.ts";
import type { VerifiedRelease } from "./intent.ts";
import type { NpmPublisher, Registry } from "./npm.ts";
import { distTagFor, npmIdentity, planPublication, shouldPromote } from "./policy.ts";
import type { CommitAncestry } from "./policy.ts";

/** Everything publication reads from the engine; `EngineDeps` is a superset. */
export type PublicationDeps = {
  readRegistry: () => Effect.Effect<Registry, ReleaseError>;
  npm: NpmPublisher;
  ancestry: CommitAncestry;
  confirmationInterval: Duration.Input;
};

const propagationAttempts = 10;
/** Each retry doubles `confirmationInterval`, capped so a slow packument gets minutes, not seconds. */
const maxConfirmationDelay = Duration.seconds(30);

const unverifiedPublication = "Publication could not be verified; retry the recorded release";

function confirmationSchedule(interval: Duration.Input) {
  const base = Duration.fromInputUnsafe(interval);
  return Schedule.recurs(propagationAttempts - 1).pipe(
    Schedule.addDelay((metadata) =>
      Effect.succeed(Duration.min(Duration.times(base, 2 ** metadata.output), maxConfirmationDelay))
    )
  );
}

/** Polls the registry until `isVisible` holds or `propagationAttempts` is exhausted. */
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
      schedule: confirmationSchedule(deps.confirmationInterval),
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
