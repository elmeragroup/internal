import { Context, Effect } from "effect";

import { attempt, attemptPromise, ReleaseError } from "./errors.ts";
import type { VerifiedRelease } from "./intent.ts";
import { distTagFor, npmIdentity, planPublication } from "./policy.ts";
import type { CommitAncestry } from "./policy.ts";
import type { Registry } from "./registry.ts";

export type PublicationServices = {
  registry: () => Promise<Registry>;
  publish: (archive: string) => void;
  promote: (version: string, tag: string) => void;
  isAncestor: CommitAncestry;
  wait: () => Promise<void>;
};

export class Publisher extends Context.Service<
  Publisher,
  {
    publishVerified: (release: VerifiedRelease) => Effect.Effect<"published" | "superseded", ReleaseError>;
  }
>()("elmera/release/Publisher") {}

const propagationAttempts = 6;

const unverifiedPublication = "Publication could not be verified; retry the recorded release";

/** Uploads the archive and returns the first registry read that shows those exact bytes. */
function uploadAndConfirm(
  release: VerifiedRelease,
  services: PublicationServices
): Effect.Effect<Registry, ReleaseError> {
  return Effect.gen(function* () {
    let publishFailure: string | undefined;
    try {
      services.publish(release.archive);
    } catch (error) {
      if (!(error instanceof Error)) {
        return yield* new ReleaseError({ message: "Release operation failed" });
      }
      publishFailure = error.message;
    }
    for (let attemptNumber = 1; attemptNumber <= propagationAttempts; attemptNumber += 1) {
      const registry = yield* attemptPromise(() => services.registry());
      if ((yield* attempt(() => npmIdentity(release, registry))) === "match") return registry;
      if (attemptNumber < propagationAttempts) yield* attemptPromise(() => services.wait());
    }
    if (publishFailure === undefined) {
      return yield* new ReleaseError({ message: unverifiedPublication });
    }
    return yield* new ReleaseError({ message: unverifiedPublication, cause: publishFailure });
  });
}

function promoteAndConfirm(
  release: VerifiedRelease,
  services: PublicationServices
): Effect.Effect<void, ReleaseError> {
  return Effect.gen(function* () {
    const tag = distTagFor(release.channel);
    yield* attempt(() => services.promote(release.version, tag));
    const promoted = yield* attemptPromise(() => services.registry());
    if (promoted.tags.get(tag) !== release.version) {
      return yield* new ReleaseError({
        message: `npm ${tag} update is not visible; retry the recorded release`,
      });
    }
  });
}

export function publishVerifiedRelease(
  release: VerifiedRelease,
  services: PublicationServices
): Effect.Effect<"published" | "superseded", ReleaseError> {
  return Effect.gen(function* () {
    const registry = yield* attemptPromise(() => services.registry());
    const intended = yield* attempt(() => planPublication(release, registry, services.isAncestor));
    if (intended.kind === "superseded") return "superseded";
    const confirmed = intended.upload ? yield* uploadAndConfirm(release, services) : registry;
    const plan = intended.upload
      ? yield* attempt(() => planPublication(release, confirmed, services.isAncestor))
      : intended;
    if (plan.kind === "publish" && plan.promote) yield* promoteAndConfirm(release, services);
    return "published";
  });
}
