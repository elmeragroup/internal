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
import type { GitHubClient, ReleaseEnvironment } from "./github.ts";
import { assertCommit } from "./intent.ts";
import type { CanaryIntent, CommitSha, ReleaseIntent, StableIntent, VerifiedRelease } from "./intent.ts";
import { createNpmPublisher, readRegistry } from "./npm.ts";
import { changesetBaseBranch, plannedCanaryBase, trackedBranchOf } from "./plan.ts";
import { decideCanary } from "./policy.ts";
import { publishVerifiedRelease } from "./publication.ts";
import type { PublicationDeps } from "./publication.ts";
import { assertReleaseTag, canaryRecordTag, releaseTag } from "./record.ts";
import { createReleaseStore } from "./store.ts";
import type { ReleaseStore, SavedRelease } from "./store.ts";
import type { StableVersion } from "./version.ts";

/**
 * Consumer seam: stamp packed identity, build, pack, verify, and return the archive bytes the
 * engine records. Retry never calls this.
 */
export type PackAndVerify = {
  pack: (intent: ReleaseIntent) => Uint8Array;
};

/**
 * Dependencies shared by preparation, retry, and publication: the record store, the ancestry
 * oracle, the registry, the npm publisher, and archive verification. Deliberately free of git,
 * the stable gate, and the Changesets base branch, so a retry never reads branch configuration.
 */
export type RetryDeps = PublicationDeps & {
  store: ReleaseStore;
  verifyArchive: (
    intent: ReleaseIntent,
    bytes: Uint8Array
  ) => Effect.Effect<VerifiedRelease, ReleaseError, Scope.Scope>;
  log: (message: string) => void;
};

/** The checked-commit path needs the branch-scoped ports on top of the shared dependencies. */
export type EngineDeps = RetryDeps & {
  git: GitPort;
  stableGate: StableReleaseGate;
  plannedCanaryBase: (current: StableVersion) => Effect.Effect<StableVersion, ReleaseError>;
};

type RecordedRelease = {
  saved: SavedRelease;
  release: VerifiedRelease;
};

/** Reserves the record, then packs, verifies, and uploads its archive. Resuming never repacks. */
function recordRelease(
  intent: ReleaseIntent,
  adapter: PackAndVerify,
  deps: RetryDeps
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
  deps: RetryDeps
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
  commit: CommitSha,
  deps: EngineDeps
): Effect.Effect<ReleaseIntent | undefined, ReleaseError> {
  return Effect.gen(function* () {
    const previous = yield* deps.git.stableVersionAt(`${commit}^1`);
    const line = yield* deps.stableGate(commit, previous);
    if (line.channel === "stable") {
      const stable: StableIntent = { channel: "stable", version: line.version, commit };
      return stable;
    }
    const recorded = yield* deps.store.find(canaryRecordTag(commit));
    if (recorded !== undefined) return recorded.intent;
    const base = yield* deps.plannedCanaryBase(line.current);
    const registry = yield* deps.readRegistry();
    const reserved = yield* deps.store.reservedCanaryVersions();
    const decision = yield* lift(() =>
      decideCanary({ commit, current: line.current, base }, registry, reserved, deps.ancestry)
    );
    if ("skip" in decision) {
      deps.log(decision.reason);
      return undefined;
    }
    const canary: CanaryIntent = { channel: "canary", version: decision.cut, commit };
    return canary;
  });
}

function assertCheckedCommit(commit: CommitSha, deps: EngineDeps): Effect.Effect<void, ReleaseError> {
  return Effect.gen(function* () {
    const baseBranchTip = yield* deps.git.baseBranchTip();
    const head = yield* deps.git.head();
    if (head !== commit) {
      return yield* new ReleaseError({
        message: `Checkout ${head} differs from the checked commit ${commit}`,
      });
    }
    if (!(yield* lift(() => deps.ancestry(commit, baseBranchTip)))) {
      return yield* new ReleaseError({
        message: `Release source ${commit} is not an ancestor of the tracked branch tip ${baseBranchTip}`,
      });
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

/** Finish a prepared record from its saved archive bytes. Does not pack or read branch config. */
export function executeRetry(
  pkg: ReleasePackage,
  recordTag: string,
  deps: RetryDeps
): Effect.Effect<void, ReleaseError, Scope.Scope> {
  return Effect.gen(function* () {
    const tag = yield* lift(() => assertReleaseTag(recordTag));
    const saved = yield* deps.store.find(tag);
    if (saved === undefined) {
      return yield* new ReleaseError({ message: `No prepared release exists for record tag ${tag}` });
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

/** Everything except git and the branch-scoped gate; the retry path builds only this set. */
function liveRetryDeps(
  pkg: ReleasePackage,
  environment: ReleaseEnvironment,
  client: GitHubClient = createGitHubClient(environment)
): RetryDeps {
  return {
    ancestry: createCommitAncestry(pkg.checkoutRoot),
    store: createReleaseStore(client, pkg.packageName),
    readRegistry: () => readRegistry(pkg.packageName, environment.fetch),
    npm: createNpmPublisher(pkg),
    confirmationInterval: 5_000,
    verifyArchive: (intent, bytes) => verifyReleaseArchive(intent, bytes, pkg.packageName),
    log: (message) => {
      console.log(message);
    },
  };
}

function liveDeps(pkg: ReleasePackage, environment: ReleaseEnvironment): EngineDeps {
  const client = createGitHubClient(environment);
  const baseBranch = changesetBaseBranch(pkg.checkoutRoot);
  return {
    ...liveRetryDeps(pkg, environment, client),
    git: liveGit(pkg, baseBranch),
    stableGate: createStableReleaseGate(
      client,
      pkg.checkoutRoot,
      pkg.packageDirectory,
      trackedBranchOf(baseBranch)
    ),
    plannedCanaryBase: (current) => plannedCanaryBase(current, pkg.packageName, pkg.checkoutRoot),
  };
}

function withLiveDeps<D, A>(
  build: () => D,
  run: (deps: D) => Effect.Effect<A, ReleaseError, Scope.Scope>
): Effect.Effect<A, ReleaseError> {
  return Effect.gen(function* () {
    const deps = yield* lift(build);
    return yield* run(deps);
  }).pipe(Effect.scoped);
}

function withEngineDeps<A>(
  pkg: ReleasePackage,
  environment: () => ReleaseEnvironment,
  run: (deps: EngineDeps) => Effect.Effect<A, ReleaseError, Scope.Scope>
): Effect.Effect<A, ReleaseError> {
  return withLiveDeps(() => liveDeps(pkg, environment()), run);
}

function withRetryDeps<A>(
  pkg: ReleasePackage,
  environment: () => ReleaseEnvironment,
  run: (deps: RetryDeps) => Effect.Effect<A, ReleaseError, Scope.Scope>
): Effect.Effect<A, ReleaseError> {
  return withLiveDeps(() => liveRetryDeps(pkg, environment()), run);
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
      withEngineDeps(pkg, environment, (deps) => executeCheckedCommit(pkg, adapter, commit, deps)),
    retryRelease: (pkg, recordTag) =>
      withRetryDeps(pkg, environment, (deps) => executeRetry(pkg, recordTag, deps)),
  };
}

const production = createReleaseOperations(releaseEnvironment);

/**
 * Asserts that the checkout is a complete stable release PR for the Changesets base branch:
 * the version advances, every changeset is consumed, and the changelog names the version.
 * Reads only the checkout; GitHub credentials are not required.
 */
export const checkReleasePr = production.checkReleasePr;

/**
 * Publishes the checked main-branch commit: verifies the checkout, plans the stable or canary
 * release, packs through the adapter, records and verifies the archive, then publishes to npm and
 * promotes the channel dist-tag. Requires `GITHUB_REPOSITORY` and `GH_TOKEN`, read when it runs.
 */
export const releaseCheckedCommit = production.releaseCheckedCommit;

/**
 * Finishes a prepared release record from its saved archive bytes, verifying them against the
 * recorded intent before publishing. Never packs and never reads the Changesets configuration.
 * Missing or incomplete records fail with the original Merge-job guidance.
 */
export const retryRelease = production.retryRelease;
