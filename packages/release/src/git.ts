import type { Effect } from "effect";
import { execFileSync, spawnSync } from "node:child_process";

import { lift } from "./errors.ts";
import type { ReleaseError } from "./errors.ts";
import { PackageManifest } from "./files.ts";
import { assertCommit } from "./intent.ts";
import { decodeJson } from "./json.ts";
import type { CommitAncestry } from "./policy.ts";
import { assertStableReleaseVersion } from "./version.ts";

export type GitPort = {
  head: () => Effect.Effect<string, ReleaseError>;
  originMain: () => Effect.Effect<string, ReleaseError>;
  isClean: () => Effect.Effect<boolean, ReleaseError>;
  stableVersionAt: (revision: string) => Effect.Effect<string, ReleaseError>;
};

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  assertCommit(ancestor);
  assertCommit(descendant);
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    stdio: "pipe",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error("Cannot establish release commit ancestry");
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
    head: () => lift("git", () => git(cwd, ["rev-parse", "HEAD"])),
    originMain: () => lift("git", () => git(cwd, ["rev-parse", remoteTrackingRef])),
    isClean: () => lift("git", () => git(cwd, ["status", "--porcelain", "--untracked-files=no"]) === ""),
    stableVersionAt: (revision) =>
      lift("git", () => {
        const recorded = decodeJson(
          git(cwd, ["show", `${revision}:${manifest}`]),
          PackageManifest,
          "recorded manifest"
        );
        return assertStableReleaseVersion(recorded.version);
      }),
  };
}
