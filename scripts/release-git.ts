import { execFileSync, spawnSync } from "node:child_process";

import { assertCommit } from "../packages/release/src/intent.ts";
import type { CommitAncestry } from "../packages/release/src/policy.ts";
import { assertStableReleaseVersion } from "../packages/release/src/version.ts";
import { asString, parseJsonObject } from "./lib/json-object.mjs";

export type GitPort = {
  head: () => string;
  originMain: () => string;
  isClean: () => boolean;
  stableVersionAt: (revision: string) => string;
  isAncestor: CommitAncestry;
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

/**
 * Reads git for the release pipeline. `cwd` is the checkout to read; tests pass a fixture checkout.
 * `packageManifest` is the git path to package.json, derived from the resolved package directory.
 */
export function createGitPort(cwd: string, packageManifest: string): GitPort {
  const manifest = packageManifest.replaceAll("\\", "/");
  return {
    head: () => git(cwd, ["rev-parse", "HEAD"]),
    originMain: () => git(cwd, ["rev-parse", "origin/main"]),
    isClean: () => git(cwd, ["status", "--porcelain", "--untracked-files=no"]) === "",
    stableVersionAt: (revision) =>
      assertStableReleaseVersion(
        asString(
          parseJsonObject(git(cwd, ["show", `${revision}:${manifest}`]), "recorded manifest").version,
          "recorded manifest version"
        )
      ),
    isAncestor: (ancestor, descendant) => isAncestor(cwd, ancestor, descendant),
  };
}
