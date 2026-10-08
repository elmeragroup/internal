import { Effect } from "effect";
import type { Scope } from "effect";

import type { PackAndVerify } from "./archive.ts";
import { releaseEnvironment } from "./environment.ts";
import type { ReleaseEnvironment } from "./environment.ts";
import { lift, ReleaseError } from "./errors.ts";
import { packageManifestGitPath } from "./files.ts";
import type { ReleasePackage } from "./files.ts";
import { assertStableBump, createStableReleaseGate, readStableVersion } from "./gate.ts";
import type { StableReleaseGate } from "./gate.ts";
import { createCommitAncestry, createGitPort } from "./git.ts";
import type { GitPort } from "./git.ts";
import { createGitHubClient } from "./github.ts";
import { assertCommit } from "./intent.ts";
import type { CanaryIntent, CommitSha, ReleaseIntent, StableIntent } from "./intent.ts";
import { createNpmPublisher, readRegistry } from "./npm.ts";
import { changesetBaseBranch, plannedCanaryBase } from "./plan.ts";
import { decideCanary } from "./policy.ts";
import { liveConfirmation, publishVerifiedRelease } from "./publication.ts";
import type { PublicationDeps } from "./publication.ts";
import { createRecordStore } from "./store.ts";
import type { PreparedRecord, RecordStore } from "./store.ts";
import type { StableVersion } from "./version.ts";

/**
 * Dependencies shared by the retry and checked-commit paths: the Record store, the ancestry
 * oracle, the registry, the npm publisher, and the log. Deliberately free of git, the stable gate,
 * and the Changesets base branch, so a retry never reads branch configuration.
 */
type ReleaseDeps = PublicationDeps & {
  records: RecordStore;
  log: (message: string) => void;
};

/** `ReleaseDeps` plus the branch-scoped ports the checked-commit plan needs. */
type CheckedCommitDeps = ReleaseDeps & {
  git: GitPort;
  stableGate: StableReleaseGate;
  plannedCanaryBase: (current: StableVersion) => Effect.Effect<StableVersion, ReleaseError>;
};

/** Publishes a prepared record's release and completes the record only after npm has it. */
function finishRelease(
  record: PreparedRecord,
  pkg: ReleasePackage,
  deps: ReleaseDeps
): Effect.Effect<void, ReleaseError> {
  return Effect.gen(function* () {
    const result = yield* publishVerifiedRelease(record.release, deps);
    if (result === "superseded") {
      deps.log(`Skipping superseded canary ${record.intent.version}; its draft record remains reserved`);
      return;
    }
    yield* deps.records.complete(record);
    deps.log(
      `Released ${pkg.packageName}@${record.intent.version} from ${record.intent.commit}. Record: ${record.tag}`
    );
  });
}

function mainReleaseIntent(
  commit: CommitSha,
  deps: CheckedCommitDeps
): Effect.Effect<ReleaseIntent | undefined, ReleaseError> {
  return Effect.gen(function* () {
    const previous = yield* deps.git.stableVersionAt(`${commit}^1`);
    const line = yield* deps.stableGate(commit, previous);
    if (line.channel === "stable") {
      const stable: StableIntent = { channel: "stable", version: line.version, commit };
      return stable;
    }
    const recorded = yield* deps.records.recordedCanaryIntent(commit);
    if (recorded !== undefined) return recorded;
    const base = yield* deps.plannedCanaryBase(line.current);
    const registry = yield* deps.readRegistry();
    const reserved = yield* deps.records.reservedCanaryVersions();
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

function assertCheckedCommit(commit: CommitSha, deps: CheckedCommitDeps): Effect.Effect<void, ReleaseError> {
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
function executeCheckedCommit(
  pkg: ReleasePackage,
  adapter: PackAndVerify,
  commit: string,
  deps: CheckedCommitDeps
): Effect.Effect<void, ReleaseError, Scope.Scope> {
  return Effect.gen(function* () {
    const checked = yield* lift(() => assertCommit(commit));
    yield* assertCheckedCommit(checked, deps);
    const intent = yield* mainReleaseIntent(checked, deps);
    if (intent === undefined) return;
    const record = yield* deps.records.prepare(intent, adapter);
    yield* finishRelease(record, pkg, deps);
  });
}

/** Finish a prepared record from its recorded archive. Does not pack or read branch config. */
function executeRetry(
  pkg: ReleasePackage,
  recordTag: string,
  deps: ReleaseDeps
): Effect.Effect<void, ReleaseError, Scope.Scope> {
  return Effect.gen(function* () {
    const record = yield* deps.records.restore(recordTag);
    yield* finishRelease(record, pkg, deps);
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

/** Everything the retry path builds: no git, stable gate, or Changesets configuration. */
function liveReleaseDeps(pkg: ReleasePackage, environment: ReleaseEnvironment): ReleaseDeps {
  return {
    ancestry: createCommitAncestry(pkg.checkoutRoot),
    records: createRecordStore(createGitHubClient(environment), pkg.packageName),
    readRegistry: () => readRegistry(pkg.packageName, environment.fetch),
    npm: createNpmPublisher(pkg, environment.npm),
    ...liveConfirmation,
    log: environment.log,
  };
}

/** The checked-commit path reads the Changesets base branch and adds the branch-scoped ports. */
function liveCheckedCommitDeps(pkg: ReleasePackage, environment: ReleaseEnvironment): CheckedCommitDeps {
  // `liveReleaseDeps` builds its own client for the Record store: the client is stateless (it
  // captures only the environment), so one instance per port owner stays intentional.
  const client = createGitHubClient(environment);
  const baseBranch = changesetBaseBranch(pkg.checkoutRoot);
  return {
    ...liveReleaseDeps(pkg, environment),
    git: liveGit(pkg, baseBranch),
    stableGate: createStableReleaseGate(
      client,
      pkg.checkoutRoot,
      pkg.packageDirectory,
      // The branch Changesets tracks, without the `origin/` prefix.
      baseBranch.slice("origin/".length)
    ),
    plannedCanaryBase: (current) => plannedCanaryBase(current, pkg.packageName, pkg.checkoutRoot),
  };
}

/** Acquires the given deps and gives `run` their scope; every external failure stays in the channel. */
function withLiveDeps<D, A>(
  build: () => D,
  run: (deps: D) => Effect.Effect<A, ReleaseError, Scope.Scope>
): Effect.Effect<A, ReleaseError> {
  return Effect.gen(function* () {
    const deps = yield* lift(build);
    return yield* run(deps);
  }).pipe(Effect.scoped);
}

/** The shipped operations with a transport seam that is not part of the public package surface. */
type ReleaseOperations = {
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
      withLiveDeps(
        () => liveCheckedCommitDeps(pkg, environment()),
        (deps) => executeCheckedCommit(pkg, adapter, commit, deps)
      ),
    retryRelease: (pkg, recordTag) =>
      withLiveDeps(
        () => liveReleaseDeps(pkg, environment()),
        (deps) => executeRetry(pkg, recordTag, deps)
      ),
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
 * Finishes a prepared record from its recorded archive, verifying those bytes against the
 * recorded intent before publishing. Never packs and never reads the Changesets configuration.
 * A missing record fails naming the requested tag; an incomplete one keeps the Merge-job guidance.
 */
export const retryRelease = production.retryRelease;
