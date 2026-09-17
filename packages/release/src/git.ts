import type { Effect } from "effect";
import { execFileSync, spawnSync } from "node:child_process";

import { lift } from "./errors.ts";
import type { ReleaseError } from "./errors.ts";
import { PackageManifest } from "./files.ts";
import { assertCommit } from "./intent.ts";
import type { CommitSha } from "./intent.ts";
import { decodeJson } from "./json.ts";
import type { CommitAncestry } from "./policy.ts";
import { assertStableReleaseVersion } from "./version.ts";
import type { StableVersion } from "./version.ts";

/** Git reads the engine needs; failures surface as `ReleaseError` with the git error as `cause`. */
export type GitPort = {
  /** The commit currently checked out in the release checkout. */
  head: () => Effect.Effect<CommitSha, ReleaseError>;
  /** The tip of the remote-tracking ref Changesets names as its base branch. */
  baseBranchTip: () => Effect.Effect<CommitSha, ReleaseError>;
  /** Whether tracked files differ from `head`; untracked files are ignored. */
  isClean: () => Effect.Effect<boolean, ReleaseError>;
  /** The stable manifest version recorded at `revision`. */
  stableVersionAt: (revision: string) => Effect.Effect<StableVersion, ReleaseError>;
};

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function isAncestor(cwd: string, ancestor: CommitSha, descendant: CommitSha): boolean {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    stdio: "pipe",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`Cannot establish release commit ancestry between ${ancestor} and ${descendant}`);
  }
  return result.status === 0;
}

/** Ancestry used by the engine's preconditions and by publication planning. */
export function createCommitAncestry(cwd: string): CommitAncestry {
  return (ancestor, descendant) => isAncestor(cwd, ancestor, descendant);
}

/**
 * Reads git for the release pipeline. `cwd` is the checkout to read.
 * `packageManifest` is the git path to package.json.
 * `remoteTrackingRef` is the Changesets base branch (`origin/<branch>`). Required.
 */
export function createGitPort(cwd: string, packageManifest: string, remoteTrackingRef: string): GitPort {
  const manifest = packageManifest.replaceAll("\\", "/");
  return {
    head: () => lift(() => assertCommit(git(cwd, ["rev-parse", "HEAD"]))),
    baseBranchTip: () => lift(() => assertCommit(git(cwd, ["rev-parse", remoteTrackingRef]))),
    isClean: () => lift(() => git(cwd, ["status", "--porcelain", "--untracked-files=no"]) === ""),
    stableVersionAt: (revision) =>
      lift(() => {
        const recorded = decodeJson(
          git(cwd, ["show", `${revision}:${manifest}`]),
          PackageManifest,
          "recorded manifest"
        );
        return assertStableReleaseVersion(recorded.version);
      }),
  };
}
