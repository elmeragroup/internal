import { execFileSync, spawnSync } from "node:child_process";

import { asString, parseJsonObject } from "./lib/json-object.mjs";
import type { CommitAncestry } from "./release-policy.ts";
import { assertCommit } from "./release-record.ts";
import { assertStableReleaseVersion } from "./release-version.ts";
import { repoRoot } from "./release.ts";

export type GitPort = {
  head: () => string;
  originMain: () => string;
  isClean: () => boolean;
  stableVersionAt: (revision: string) => string;
  isAncestor: CommitAncestry;
};

const packageManifest = "packages/internal/package.json";

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
 * Reads git for the release pipeline. `cwd` is the checkout to read, defaulting to this repository;
 * a caller passes a different one so the tests exercise the same code against a fixture checkout.
 */
export function createGitPort(cwd = repoRoot): GitPort {
  return {
    head: () => git(cwd, ["rev-parse", "HEAD"]),
    originMain: () => git(cwd, ["rev-parse", "origin/main"]),
    isClean: () => git(cwd, ["status", "--porcelain", "--untracked-files=no"]) === "",
    stableVersionAt: (revision) =>
      assertStableReleaseVersion(
        asString(
          parseJsonObject(git(cwd, ["show", `${revision}:${packageManifest}`]), "recorded manifest").version,
          "recorded manifest version"
        )
      ),
    isAncestor: (ancestor, descendant) => isAncestor(cwd, ancestor, descendant),
  };
}
