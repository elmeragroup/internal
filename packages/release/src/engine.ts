import { Context, Effect, Layer } from "effect";
import type { Scope } from "effect";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

import type { PackAndVerify } from "./adapter.ts";
import { restoreVerifiedRelease } from "./bundle.ts";
import { packageManifestGitPath } from "./config.ts";
import type { ReleasePackage } from "./config.ts";
import { attempt, attemptPromise, ReleaseError } from "./errors.ts";
import { assertStableReleaseFiles } from "./files.ts";
import { createStableReleaseGate, Gate } from "./gate.ts";
import type { StableReleaseGate } from "./gate.ts";
import { createCommitAncestry, createGitPort, Git } from "./git.ts";
import type { GitPort } from "./git.ts";
import { assertCommit, assertReleaseTag, releaseTag } from "./intent.ts";
import type { ReleaseIntent, VerifiedRelease } from "./intent.ts";
import { asString, readJsonObject } from "./json.ts";
import { ReleaseLog } from "./log.ts";
import { Npm, readRegistry } from "./npm.ts";
import { changesetBaseBranch, plannedCanaryBase, Planner } from "./plan.ts";
import { allocateCanary, canaryEligibility } from "./policy.ts";
import type { CanaryEligibility } from "./policy.ts";
import { runCommand } from "./process.ts";
import { Publisher, publishVerifiedRelease } from "./publication.ts";
import type { PublicationServices } from "./publication.ts";
import type { Registry } from "./registry.ts";
import { createReleaseStore, githubClientFromEnv, Store } from "./store.ts";
import type { ReleaseStore, SavedRelease } from "./store.ts";
import { assertStableReleaseVersion } from "./version.ts";

export class Restorer extends Context.Service<
  Restorer,
  {
    restore: (
      intent: ReleaseIntent,
      bundle: Uint8Array
    ) => Effect.Effect<VerifiedRelease, ReleaseError, Scope.Scope>;
  }
>()("elmera/release/Restorer") {}

export type EngineServices = Git | Store | Npm | Planner | Gate | Publisher | ReleaseLog | Restorer;

export type RetryServices = Store | Publisher | ReleaseLog | Restorer;

export type EngineBindings = {
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
  adapter: PackAndVerify
): Effect.Effect<SavedRelease, ReleaseError, Store> {
  return Effect.gen(function* () {
    const store = yield* Store;
    const saved = yield* attemptPromise(() => store.create(intent));
    if (saved.asset.state === "uploaded") return saved;
    const bytes = yield* attempt(() => adapter.pack(intent));
    return yield* attemptPromise(() => store.upload(saved, bytes));
  });
}

function finishRelease(
  saved: SavedRelease,
  pkg: ReleasePackage
): Effect.Effect<void, ReleaseError, RetryServices | Scope.Scope> {
  return Effect.gen(function* () {
    const store = yield* Store;
    const publisher = yield* Publisher;
    const restorer = yield* Restorer;
    const log = yield* ReleaseLog;
    const bytes = yield* attemptPromise(() => store.download(saved));
    const release = yield* restorer.restore(saved.intent, bytes);
    const result = yield* publisher.publishVerified(release);
    if (result === "superseded") {
      log.log(`Skipping superseded canary ${saved.intent.version}; its draft record remains reserved`);
      return;
    }
    yield* attemptPromise(() => store.complete(saved));
    log.log(
      `Released ${pkg.packageName}@${saved.intent.version} from ${saved.intent.commit}. Record: ${releaseTag(saved.intent)}`
    );
  });
}

function mainReleaseIntent(
  commit: string
): Effect.Effect<ReleaseIntent | undefined, ReleaseError, Git | Store | Npm | Planner | Gate | ReleaseLog> {
  return Effect.gen(function* () {
    const git = yield* Git;
    const store = yield* Store;
    const npm = yield* Npm;
    const planner = yield* Planner;
    const gate = yield* Gate;
    const log = yield* ReleaseLog;
    const previous = yield* attempt(() => git.stableVersionAt(`${commit}^1`));
    const line = yield* attemptPromise(() => gate.decide(commit, previous));
    if (line.channel === "stable") return { channel: "stable", version: line.version, commit };
    const recorded = yield* attemptPromise(() => store.find(`canary-${commit}`));
    if (recorded !== undefined) return recorded.intent;
    const base = yield* attempt(() => planner.plannedCanaryBase(line.current));
    const registry = yield* attemptPromise(() => npm.read());
    const eligibility = yield* attempt(() =>
      canaryEligibility({ commit, current: line.current, base }, registry, git.isAncestor)
    );
    if (eligibility !== "eligible") {
      log.log(skipReason(eligibility));
      return undefined;
    }
    const reserved = yield* attemptPromise(() => store.reservedCanaryVersions());
    const version = yield* attempt(() => allocateCanary(base, [...registry.versions.keys(), ...reserved]));
    return { channel: "canary", version, commit };
  });
}

function assertCheckedCommit(commit: string): Effect.Effect<void, ReleaseError, Git> {
  return Effect.gen(function* () {
    const git = yield* Git;
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
  commit: string
): Effect.Effect<void, ReleaseError, EngineServices | Scope.Scope> {
  return Effect.gen(function* () {
    const checked = yield* attempt(() => assertCommit(commit));
    yield* assertCheckedCommit(checked);
    const intent = yield* mainReleaseIntent(checked);
    if (intent === undefined) return;
    yield* finishRelease(yield* recordRelease(intent, adapter), pkg);
  });
}

/** Finish a prepared record from its saved bundle. Does not pack. */
export function executeRetry(
  pkg: ReleasePackage,
  recordTag: string
): Effect.Effect<void, ReleaseError, RetryServices | Scope.Scope> {
  return Effect.gen(function* () {
    const store = yield* Store;
    const tag = yield* attempt(() => assertReleaseTag(recordTag));
    const saved = yield* attemptPromise(() => store.find(tag));
    if (saved === undefined) {
      return yield* new ReleaseError({ message: "No prepared release exists for that tag" });
    }
    yield* finishRelease(saved, pkg);
  });
}

export function executeCheckReleasePr(pkg: ReleasePackage): Effect.Effect<void, ReleaseError, Git> {
  return Effect.gen(function* () {
    const git = yield* Git;
    const current = yield* attempt(() =>
      assertStableReleaseVersion(
        asString(readJsonObject(resolve(pkg.packageDirectory, "package.json")).version, "package version")
      )
    );
    const previous = yield* attempt(() => git.stableVersionAt(changesetBaseBranch(pkg.checkoutRoot)));
    yield* attempt(() => assertStableReleaseFiles(previous, current, pkg.checkoutRoot, pkg.packageDirectory));
  });
}

function contextFromBindings(bindings: EngineBindings) {
  return Context.make(Git, bindings.git).pipe(
    Context.add(Store, bindings.store),
    Context.add(Npm, { read: bindings.registry }),
    Context.add(Planner, { plannedCanaryBase: bindings.plannedCanaryBase }),
    Context.add(Gate, { decide: bindings.stableGate }),
    Context.add(Publisher, { publishVerified: bindings.publishVerified }),
    Context.add(Restorer, { restore: bindings.restore }),
    Context.add(ReleaseLog, { log: bindings.log })
  );
}

/** Unpublished test helper: bind the engine to injected ports. */
export function releaseLayer(bindings: EngineBindings): Layer.Layer<EngineServices> {
  return Layer.succeedContext(contextFromBindings(bindings));
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

export function liveGitLayer(pkg: ReleasePackage): Layer.Layer<Git, ReleaseError> {
  return Layer.effect(
    Git,
    attempt(() =>
      createGitPort(pkg.checkoutRoot, packageManifestGitPath(pkg), changesetBaseBranch(pkg.checkoutRoot))
    )
  );
}

function liveRetryLayer(pkg: ReleasePackage): Layer.Layer<RetryServices, ReleaseError> {
  return Layer.effectContext(
    attempt(() => {
      const client = githubClientFromEnv();
      return Context.make(Store, createReleaseStore(client, pkg.packageName)).pipe(
        Context.add(Publisher, {
          publishVerified: (release) => publishVerifiedRelease(release, livePublicationServices(pkg)),
        }),
        Context.add(Restorer, {
          restore: (intent, bundle) => restoreVerifiedRelease(intent, bundle, pkg.packageName),
        }),
        Context.add(ReleaseLog, {
          log: (message) => {
            console.log(message);
          },
        })
      );
    })
  );
}

function liveMainServicesLayer(pkg: ReleasePackage): Layer.Layer<Npm | Planner | Gate, ReleaseError> {
  return Layer.effectContext(
    attempt(() => {
      const client = githubClientFromEnv();
      return Context.make(Npm, { read: () => readRegistry(pkg.packageName) }).pipe(
        Context.add(Planner, {
          plannedCanaryBase: (current) => plannedCanaryBase(current, pkg.packageName, pkg.checkoutRoot),
        }),
        Context.add(Gate, {
          decide: createStableReleaseGate(client, pkg.checkoutRoot, pkg.packageDirectory),
        })
      );
    })
  );
}

export function liveReleaseLayer(pkg: ReleasePackage): Layer.Layer<EngineServices, ReleaseError> {
  return Layer.mergeAll(liveGitLayer(pkg), liveRetryLayer(pkg), liveMainServicesLayer(pkg));
}

export function checkReleasePr(pkg: ReleasePackage): Effect.Effect<void, ReleaseError> {
  return executeCheckReleasePr(pkg).pipe(Effect.provide(liveGitLayer(pkg)), Effect.scoped);
}

export function releaseCheckedCommit(
  pkg: ReleasePackage,
  adapter: PackAndVerify,
  commit: string
): Effect.Effect<void, ReleaseError> {
  return executeCheckedCommit(pkg, adapter, commit).pipe(
    Effect.provide(liveReleaseLayer(pkg)),
    Effect.scoped
  );
}

export function retryRelease(pkg: ReleasePackage, recordTag: string): Effect.Effect<void, ReleaseError> {
  return executeRetry(pkg, recordTag).pipe(Effect.provide(liveRetryLayer(pkg)), Effect.scoped);
}

/** Unpublished test helper. */
export function runEngine(
  effect: Effect.Effect<void, ReleaseError, EngineServices | Scope.Scope>,
  bindings: EngineBindings
): Promise<void> {
  return Effect.runPromise(effect.pipe(Effect.provide(releaseLayer(bindings)), Effect.scoped));
}
