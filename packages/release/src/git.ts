import { Context } from "effect";
import { execFileSync, spawnSync } from "node:child_process";

import { assertCommit } from "./intent.ts";
import { asString, parseJsonObject } from "./json.ts";
import type { CommitAncestry } from "./policy.ts";
import { assertStableReleaseVersion } from "./version.ts";

export type GitPort = {
  head: () => string;
  originMain: () => string;
  isClean: () => boolean;
  stableVersionAt: (revision: string) => string;
  isAncestor: CommitAncestry;
};

export class Git extends Context.Service<Git, GitPort>()("elmera/release/Git") {}

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

/** Ancestry used by publication planning; does not need a remote-tracking ref. */
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
    head: () => git(cwd, ["rev-parse", "HEAD"]),
    originMain: () => git(cwd, ["rev-parse", remoteTrackingRef]),
    isClean: () => git(cwd, ["status", "--porcelain", "--untracked-files=no"]) === "",
    stableVersionAt: (revision) =>
      assertStableReleaseVersion(
        asString(
          parseJsonObject(git(cwd, ["show", `${revision}:${manifest}`]), "recorded manifest").version,
          "recorded manifest version"
        )
      ),
    isAncestor: createCommitAncestry(cwd),
  };
}
