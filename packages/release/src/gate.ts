import { Effect, Schema } from "effect";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { lift, liftPromise } from "./errors.ts";
import type { ReleaseError } from "./errors.ts";
import { readManifestVersion } from "./files.ts";
import { GitHubPullRequest } from "./github.ts";
import type { GitHubClient } from "./github.ts";
import { assertStableReleaseVersion, compareStableVersions } from "./version.ts";

/** Which release line the checked-out manifest puts a main commit on. */
export type ReleaseLine = { channel: "stable"; version: string } | { channel: "canary"; current: string };

/** Reads the checked-out manifest's version and requires it to be a stable release version. */
export function readStableVersion(packageDirectory: string): Effect.Effect<string, ReleaseError> {
  return lift("gate", () => assertStableReleaseVersion(readManifestVersion(packageDirectory)));
}

/** The release PR is complete only when its stable bump, changelog, and consumed changesets agree. */
export function assertStableBump(
  previous: string,
  current: string,
  root: string,
  packageDirectory: string
): Effect.Effect<void, ReleaseError> {
  return lift("gate", () => {
    assertStableReleaseVersion(previous);
    assertStableReleaseVersion(current);
    if (compareStableVersions(current, previous) <= 0) throw new Error("Stable version must increase");
    const pending = readdirSync(resolve(root, ".changeset")).filter(
      (name) => name.endsWith(".md") && name !== "README.md"
    );
    if (pending.length !== 0)
      throw new Error("Release PR did not consume all changesets; refresh it against main before merging");
    const changelog = readFileSync(resolve(packageDirectory, "CHANGELOG.md"), "utf8");
    if (!changelog.split("\n").includes(`## ${current}`))
      throw new Error("Stable version is missing from the changelog");
  });
}

/**
 * Reads the checked-out manifest and decides the line. A stable bump is returned only after every
 * condition holds, so the checks cannot be reordered apart by a later edit.
 */
export type StableReleaseGate = (
  commit: string,
  previous: string
) => Effect.Effect<ReleaseLine, ReleaseError>;

/** Only the merge of the generated release PR may raise the published stable version. */
async function assertMergedReleasePullRequest(
  client: GitHubClient,
  commit: string,
  trackedBranch: string
): Promise<void> {
  const pulls = await client.jsonFrom(
    `${client.root}/commits/${commit}/pulls?per_page=100`,
    Schema.Array(GitHubPullRequest),
    "commit pull requests"
  );
  const releaseHead = `changeset-release/${trackedBranch}`;
  const merged = pulls.some(
    (pull) =>
      pull.merged_at !== null &&
      pull.merge_commit_sha === commit &&
      pull.head.ref === releaseHead &&
      pull.base.ref === trackedBranch &&
      pull.head.repo.full_name === client.repository
  );
  if (!merged) {
    throw new Error(`A stable version change must come from a merged ${releaseHead} PR`);
  }
}

export function createStableReleaseGate(
  client: GitHubClient,
  root: string,
  packageDirectory: string,
  trackedBranch: string
): StableReleaseGate {
  return (commit, previous) =>
    Effect.gen(function* () {
      const current = yield* readStableVersion(packageDirectory);
      if (current === previous) return { channel: "canary", current } as const;
      yield* assertStableBump(previous, current, root, packageDirectory);
      yield* liftPromise("gate", () => assertMergedReleasePullRequest(client, commit, trackedBranch));
      return { channel: "stable", version: current } as const;
    });
}
