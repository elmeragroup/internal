import { Effect } from "effect";
import type { Scope } from "effect";

import { verifyReleaseArchive } from "./archive.ts";
import { lift, ReleaseError } from "./errors.ts";
import { packageManifestGitPath } from "./files.ts";
import type { ReleasePackage } from "./files.ts";
import { assertStableBump, createStableReleaseGate, readStableVersion } from "./gate.ts";
import type { StableReleaseGate } from "./gate.ts";
import { createCommitAncestry, createGitPort } from "./git.ts";
import type { GitPort } from "./git.ts";
import { createGitHubClient, releaseEnvironment } from "./github.ts";
import type { ReleaseEnvironment } from "./github.ts";
import { assertCommit, assertReleaseTag, canaryRecordTag, releaseTag } from "./intent.ts";
import type { ReleaseIntent, VerifiedRelease } from "./intent.ts";
import { createNpmPublisher, readRegistry } from "./npm.ts";
import { changesetBaseBranch, plannedCanaryBase, trackedBranchOf } from "./plan.ts";
import { allocateCanary, canaryEligibility } from "./policy.ts";
import type { CanarySupersession } from "./policy.ts";
import { publishVerifiedRelease } from "./publication.ts";
import type { PublicationDeps } from "./publication.ts";
import { createReleaseStore } from "./store.ts";
import type { ReleaseStore, SavedRelease } from "./store.ts";

/**
 * Consumer seam: stamp packed identity, build, pack, verify, and return the archive bytes the
 * engine records. Retry never calls this.
 */
export type PackAndVerify = {
  pack: (intent: ReleaseIntent) => Uint8Array;
};

/** Engine dependencies; publication reads its own subset directly from these. */
export type EngineDeps = PublicationDeps & {
  git: GitPort;
  store: ReleaseStore;
  stableGate: StableReleaseGate;
  plannedCanaryBase: (current: string) => Effect.Effect<string, ReleaseError>;
  verifyArchive: (
    intent: ReleaseIntent,
    bytes: Uint8Array
  ) => Effect.Effect<VerifiedRelease, ReleaseError, Scope.Scope>;
  log: (message: string) => void;
};

function skipReason(status: Exclude<CanarySupersession, "owned">): string {
  return status === "canary-superseded"
    ? "Skipping a commit superseded by a published canary"
    : "Skipping a commit superseded by a stable release";
}

const regressedBaseSkip = "Skipping a commit superseded by a canary on a newer base";

type RecordedRelease = {
  saved: SavedRelease;
  release: VerifiedRelease;
};

/** Reserves the record, then packs, verifies, and uploads its archive. Resuming never repacks. */
function recordRelease(
  intent: ReleaseIntent,
  adapter: PackAndVerify,
  deps: EngineDeps
): Effect.Effect<RecordedRelease, ReleaseError, Scope.Scope> {
  return Effect.gen(function* () {
    const saved = yield* deps.store.create(intent);
    if (saved.asset.state === "uploaded") {
      const bytes = yield* deps.store.download(saved);
      const release = yield* deps.verifyArchive(intent, bytes);
      return { saved, release };
    }
    const bytes = yield* lift(() => adapter.pack(intent));
    const release = yield* deps.verifyArchive(intent, bytes);
    const uploaded = yield* deps.store.upload(saved, bytes);
    return { saved: uploaded, release };
  });
}

function finishRelease(
  saved: SavedRelease,
  release: VerifiedRelease,
  pkg: ReleasePackage,
  deps: EngineDeps
): Effect.Effect<void, ReleaseError> {
  return Effect.gen(function* () {
    const result = yield* publishVerifiedRelease(release, deps);
    if (result === "superseded") {
      deps.log(`Skipping superseded canary ${saved.intent.version}; its draft record remains reserved`);
      return;
    }
    yield* deps.store.complete(saved);
    deps.log(
      `Released ${pkg.packageName}@${saved.intent.version} from ${saved.intent.commit}. Record: ${releaseTag(saved.intent)}`
    );
  });
}

function mainReleaseIntent(
  commit: string,
  deps: EngineDeps
): Effect.Effect<ReleaseIntent | undefined, ReleaseError> {
  return Effect.gen(function* () {
    const previous = yield* deps.git.stableVersionAt(`${commit}^1`);
    const line = yield* deps.stableGate(commit, previous);
    if (line.channel === "stable") return { channel: "stable", version: line.version, commit } as const;
    const recorded = yield* deps.store.find(canaryRecordTag(commit));
    if (recorded !== undefined) return recorded.intent;
    const base = yield* deps.plannedCanaryBase(line.current);
    const registry = yield* deps.readRegistry();
    const status = yield* lift(() =>
      canaryEligibility({ commit, current: line.current, base }, registry, deps.ancestry)
    );
    if (status !== "owned") {
      deps.log(skipReason(status));
      return undefined;
    }
    const reserved = yield* deps.store.reservedCanaryVersions();
    const version = yield* lift(() => allocateCanary(base, [...registry.versions.keys(), ...reserved]));
    if (version === undefined) {
      deps.log(regressedBaseSkip);
      return undefined;
    }
    return { channel: "canary", version, commit } as const;
  });
}

function assertCheckedCommit(commit: string, deps: EngineDeps): Effect.Effect<void, ReleaseError> {
  return Effect.gen(function* () {
    const main = yield* deps.git.originMain();
    if ((yield* deps.git.head()) !== commit) {
      return yield* new ReleaseError({ message: "Checkout differs from the checked commit" });
    }
    if (!(yield* lift(() => deps.ancestry(commit, main)))) {
      return yield* new ReleaseError({ message: "Release source is not on main" });
    }
    if (!(yield* deps.git.isClean())) {
      return yield* new ReleaseError({ message: "Release requires a clean checkout" });
    }
  });
}

/** Shared engine for a checked-commit publication. Pack-and-verify is an argument, not a Layer. */
export function executeCheckedCommit(
  pkg: ReleasePackage,
  adapter: PackAndVerify,
  commit: string,
  deps: EngineDeps
): Effect.Effect<void, ReleaseError, Scope.Scope> {
  return Effect.gen(function* () {
    const checked = yield* lift(() => assertCommit(commit));
    yield* assertCheckedCommit(checked, deps);
    const intent = yield* mainReleaseIntent(checked, deps);
    if (intent === undefined) return;
    const recorded = yield* recordRelease(intent, adapter, deps);
    yield* finishRelease(recorded.saved, recorded.release, pkg, deps);
  });
}

/** Finish a prepared record from its saved archive bytes. Does not pack. */
export function executeRetry(
  pkg: ReleasePackage,
  recordTag: string,
  deps: EngineDeps
): Effect.Effect<void, ReleaseError, Scope.Scope> {
  return Effect.gen(function* () {
    const tag = yield* lift(() => assertReleaseTag(recordTag));
    const saved = yield* deps.store.find(tag);
    if (saved === undefined) {
      return yield* new ReleaseError({ message: "No prepared release exists for that tag" });
    }
    const bytes = yield* deps.store.download(saved);
    const release = yield* deps.verifyArchive(saved.intent, bytes);
    yield* finishRelease(saved, release, pkg, deps);
  });
}

function executeCheckReleasePr(
  pkg: ReleasePackage,
  git: GitPort,
  baseBranch: string
): Effect.Effect<void, ReleaseError> {
  return Effect.gen(function* () {
    const current = yield* readStableVersion(pkg.packageDirectory);
    const previous = yield* git.stableVersionAt(baseBranch);
    yield* assertStableBump(previous, current, pkg.checkoutRoot, pkg.packageDirectory);
  });
}

function liveGit(pkg: ReleasePackage, baseBranch: string): GitPort {
  return createGitPort(pkg.checkoutRoot, packageManifestGitPath(pkg), baseBranch);
}

function liveDeps(pkg: ReleasePackage, environment: ReleaseEnvironment): EngineDeps {
  const client = createGitHubClient(environment);
  const baseBranch = changesetBaseBranch(pkg.checkoutRoot);
  return {
    git: liveGit(pkg, baseBranch),
    ancestry: createCommitAncestry(pkg.checkoutRoot),
    store: createReleaseStore(client, pkg.packageName),
    readRegistry: () => readRegistry(pkg.packageName, environment.fetch),
    npm: createNpmPublisher(pkg),
    confirmationInterval: 5_000,
    stableGate: createStableReleaseGate(
      client,
      pkg.checkoutRoot,
      pkg.packageDirectory,
      trackedBranchOf(baseBranch)
    ),
    plannedCanaryBase: (current) => plannedCanaryBase(current, pkg.packageName, pkg.checkoutRoot),
    verifyArchive: (intent, bytes) => verifyReleaseArchive(intent, bytes, pkg.packageName),
    log: (message) => {
      console.log(message);
    },
  };
}

function withLiveDeps<A>(
  pkg: ReleasePackage,
  environment: () => ReleaseEnvironment,
  run: (deps: EngineDeps) => Effect.Effect<A, ReleaseError, Scope.Scope>
): Effect.Effect<A, ReleaseError> {
  return Effect.gen(function* () {
    const deps = yield* lift(() => liveDeps(pkg, environment()));
    return yield* run(deps);
  }).pipe(Effect.scoped);
}

/** The shipped operations with a transport seam that is not part of the public package surface. */
export type ReleaseOperations = {
  checkReleasePr: (pkg: ReleasePackage) => Effect.Effect<void, ReleaseError>;
  releaseCheckedCommit: (
    pkg: ReleasePackage,
    adapter: PackAndVerify,
    commit: string
  ) => Effect.Effect<void, ReleaseError>;
  retryRelease: (pkg: ReleasePackage, recordTag: string) => Effect.Effect<void, ReleaseError>;
};

/** Builds the operations against an injectable transport; production callers get `releaseEnvironment`. */
export function createReleaseOperations(environment: () => ReleaseEnvironment): ReleaseOperations {
  return {
    checkReleasePr: (pkg) =>
      Effect.gen(function* () {
        const baseBranch = yield* lift(() => changesetBaseBranch(pkg.checkoutRoot));
        yield* executeCheckReleasePr(pkg, liveGit(pkg, baseBranch), baseBranch);
      }),
    releaseCheckedCommit: (pkg, adapter, commit) =>
      withLiveDeps(pkg, environment, (deps) => executeCheckedCommit(pkg, adapter, commit, deps)),
    retryRelease: (pkg, recordTag) =>
      withLiveDeps(pkg, environment, (deps) => executeRetry(pkg, recordTag, deps)),
  };
}

const production = createReleaseOperations(releaseEnvironment);

export const checkReleasePr = production.checkReleasePr;
export const releaseCheckedCommit = production.releaseCheckedCommit;
export const retryRelease = production.retryRelease;
