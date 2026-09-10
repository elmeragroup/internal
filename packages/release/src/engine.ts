import { Effect } from "effect";
import type { Scope } from "effect";
import { setTimeout } from "node:timers/promises";

import type { PackAndVerify } from "./adapter.ts";
import { restoreVerifiedRelease } from "./bundle.ts";
import { packageManifestGitPath, readManifestVersion } from "./config.ts";
import type { ReleasePackage } from "./config.ts";
import { attempt, attemptPromise, ReleaseError } from "./errors.ts";
import { assertStableReleaseFiles } from "./files.ts";
import { createStableReleaseGate } from "./gate.ts";
import type { StableReleaseGate } from "./gate.ts";
import { createCommitAncestry, createGitPort } from "./git.ts";
import type { GitPort } from "./git.ts";
import { assertCommit, assertReleaseTag, releaseTag } from "./intent.ts";
import type { ReleaseIntent, VerifiedRelease } from "./intent.ts";
import { readRegistry } from "./npm.ts";
import { changesetBaseBranch, plannedCanaryBase } from "./plan.ts";
import { allocateCanary, canaryEligibility } from "./policy.ts";
import type { CanaryEligibility } from "./policy.ts";
import { runCommand } from "./process.ts";
import { publishVerifiedRelease } from "./publication.ts";
import type { PublicationServices } from "./publication.ts";
import type { Registry } from "./registry.ts";
import { createReleaseStore, githubClientFromEnv } from "./store.ts";
import type { ReleaseStore, SavedRelease } from "./store.ts";
import { assertStableReleaseVersion } from "./version.ts";

export type EngineDeps = {
  git: GitPort;
  store: ReleaseStore;
  registry: () => Promise<Registry>;
  stableGate: StableReleaseGate;
  plannedCanaryBase: (current: string) => string;
  publishVerified: (release: VerifiedRelease) => Effect.Effect<"published" | "superseded", ReleaseError>;
  restore: (
    intent: ReleaseIntent,
    bundle: Uint8Array
  ) => Effect.Effect<VerifiedRelease, ReleaseError, Scope.Scope>;
  log: (message: string) => void;
};

function skipReason(eligibility: Exclude<CanaryEligibility, "eligible">): string {
  return eligibility === "canary-superseded"
    ? "Skipping a commit superseded by a published canary"
    : "Skipping a commit superseded by a stable release";
}

function recordRelease(
  intent: ReleaseIntent,
  adapter: PackAndVerify,
  deps: EngineDeps
): Effect.Effect<SavedRelease, ReleaseError> {
  return Effect.gen(function* () {
    const saved = yield* attemptPromise(() => deps.store.create(intent));
    if (saved.asset.state === "uploaded") return saved;
    const bytes = yield* attempt(() => adapter.pack(intent));
    return yield* attemptPromise(() => deps.store.upload(saved, bytes));
  });
}

function finishRelease(
  saved: SavedRelease,
  pkg: ReleasePackage,
  deps: EngineDeps
): Effect.Effect<void, ReleaseError, Scope.Scope> {
  return Effect.gen(function* () {
    const bytes = yield* attemptPromise(() => deps.store.download(saved));
    const release = yield* deps.restore(saved.intent, bytes);
    const result = yield* deps.publishVerified(release);
    if (result === "superseded") {
      deps.log(`Skipping superseded canary ${saved.intent.version}; its draft record remains reserved`);
      return;
    }
    yield* attemptPromise(() => deps.store.complete(saved));
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
    const previous = yield* attempt(() => deps.git.stableVersionAt(`${commit}^1`));
    const line = yield* attemptPromise(() => deps.stableGate(commit, previous));
    if (line.channel === "stable") return { channel: "stable", version: line.version, commit };
    const recorded = yield* attemptPromise(() => deps.store.find(`canary-${commit}`));
    if (recorded !== undefined) return recorded.intent;
    const base = yield* attempt(() => deps.plannedCanaryBase(line.current));
    const registry = yield* attemptPromise(() => deps.registry());
    const eligibility = yield* attempt(() =>
      canaryEligibility({ commit, current: line.current, base }, registry, deps.git.isAncestor)
    );
    if (eligibility !== "eligible") {
      deps.log(skipReason(eligibility));
      return undefined;
    }
    const reserved = yield* attemptPromise(() => deps.store.reservedCanaryVersions());
    const version = yield* attempt(() => allocateCanary(base, [...registry.versions.keys(), ...reserved]));
    return { channel: "canary", version, commit };
  });
}

function assertCheckedCommit(commit: string, git: GitPort): Effect.Effect<void, ReleaseError> {
  return Effect.gen(function* () {
    if ((yield* attempt(() => git.head())) !== commit) {
      return yield* new ReleaseError({ message: "Checkout differs from the checked commit" });
    }
    if (!(yield* attempt(() => git.isAncestor(commit, git.originMain())))) {
      return yield* new ReleaseError({ message: "Release source is not on main" });
    }
    if (!(yield* attempt(() => git.isClean()))) {
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
    const checked = yield* attempt(() => assertCommit(commit));
    yield* assertCheckedCommit(checked, deps.git);
    const intent = yield* mainReleaseIntent(checked, deps);
    if (intent === undefined) return;
    yield* finishRelease(yield* recordRelease(intent, adapter, deps), pkg, deps);
  });
}

/** Finish a prepared record from its saved bundle. Does not pack. */
export function executeRetry(
  pkg: ReleasePackage,
  recordTag: string,
  deps: EngineDeps
): Effect.Effect<void, ReleaseError, Scope.Scope> {
  return Effect.gen(function* () {
    const tag = yield* attempt(() => assertReleaseTag(recordTag));
    const saved = yield* attemptPromise(() => deps.store.find(tag));
    if (saved === undefined) {
      return yield* new ReleaseError({ message: "No prepared release exists for that tag" });
    }
    yield* finishRelease(saved, pkg, deps);
  });
}

export function executeCheckReleasePr(pkg: ReleasePackage, git: GitPort): Effect.Effect<void, ReleaseError> {
  return Effect.gen(function* () {
    const current = yield* attempt(() =>
      assertStableReleaseVersion(readManifestVersion(pkg.packageDirectory))
    );
    const previous = yield* attempt(() => git.stableVersionAt(changesetBaseBranch(pkg.checkoutRoot)));
    yield* attempt(() => assertStableReleaseFiles(previous, current, pkg.checkoutRoot, pkg.packageDirectory));
  });
}

function livePublicationServices(pkg: ReleasePackage): PublicationServices {
  return {
    registry: () => readRegistry(pkg.packageName),
    publish: (tarball) =>
      runCommand(
        "npm",
        ["publish", tarball, "--access", "public", "--tag", "pending", "--ignore-scripts"],
        pkg.checkoutRoot
      ),
    promote: (version, tag) =>
      runCommand("npm", ["dist-tag", "add", `${pkg.packageName}@${version}`, tag], pkg.checkoutRoot),
    isAncestor: createCommitAncestry(pkg.checkoutRoot),
    wait: () => setTimeout(5_000),
  };
}

export function liveDeps(pkg: ReleasePackage): EngineDeps {
  const client = githubClientFromEnv();
  return {
    git: createGitPort(pkg.checkoutRoot, packageManifestGitPath(pkg), changesetBaseBranch(pkg.checkoutRoot)),
    store: createReleaseStore(client, pkg.packageName),
    registry: () => readRegistry(pkg.packageName),
    stableGate: createStableReleaseGate(client, pkg.checkoutRoot, pkg.packageDirectory),
    plannedCanaryBase: (current) => plannedCanaryBase(current, pkg.packageName, pkg.checkoutRoot),
    publishVerified: (release) => publishVerifiedRelease(release, livePublicationServices(pkg)),
    restore: (intent, bundle) => restoreVerifiedRelease(intent, bundle, pkg.packageName),
    log: (message) => {
      console.log(message);
    },
  };
}

export function checkReleasePr(pkg: ReleasePackage): Effect.Effect<void, ReleaseError> {
  return Effect.gen(function* () {
    const git = yield* attempt(() =>
      createGitPort(pkg.checkoutRoot, packageManifestGitPath(pkg), changesetBaseBranch(pkg.checkoutRoot))
    );
    yield* executeCheckReleasePr(pkg, git);
  }).pipe(Effect.scoped);
}

export function releaseCheckedCommit(
  pkg: ReleasePackage,
  adapter: PackAndVerify,
  commit: string
): Effect.Effect<void, ReleaseError> {
  return Effect.gen(function* () {
    const deps = yield* attempt(() => liveDeps(pkg));
    yield* executeCheckedCommit(pkg, adapter, commit, deps);
  }).pipe(Effect.scoped);
}

export function retryRelease(pkg: ReleasePackage, recordTag: string): Effect.Effect<void, ReleaseError> {
  return Effect.gen(function* () {
    const deps = yield* attempt(() => liveDeps(pkg));
    yield* executeRetry(pkg, recordTag, deps);
  }).pipe(Effect.scoped);
}
