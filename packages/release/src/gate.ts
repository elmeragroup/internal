import { Schema } from "effect";

import { readManifestVersion } from "./config.ts";
import { assertStableReleaseFiles } from "./files.ts";
import { GitHubPullRequest } from "./github.ts";
import type { GitHubClient } from "./github.ts";
import { changesetTrackedBranch } from "./plan.ts";
import { assertStableReleaseVersion } from "./version.ts";

/** Which release line the checked-out manifest puts a main commit on. */
export type ReleaseLine = { channel: "stable"; version: string } | { channel: "canary"; current: string };

/**
 * Reads the checked-out manifest and decides the line. A stable bump is returned only after every
 * condition holds, so the checks cannot be reordered apart by a later edit.
 */
export type StableReleaseGate = (commit: string, previous: string) => Promise<ReleaseLine>;

/** Only the merge of the generated release PR may raise the published stable version. */
async function assertMergedReleasePullRequest(
  client: GitHubClient,
  commit: string,
  trackedBranch: string
): Promise<void> {
  const pulls = await client.json(
    await client.request(`${client.root}/commits/${commit}/pulls?per_page=100`),
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
  packageDirectory: string
): StableReleaseGate {
  const trackedBranch = changesetTrackedBranch(root);
  return async (commit, previous) => {
    const current = assertStableReleaseVersion(readManifestVersion(packageDirectory));
    if (current === previous) return { channel: "canary", current };
    assertStableReleaseFiles(previous, current, root, packageDirectory);
    await assertMergedReleasePullRequest(client, commit, trackedBranch);
    return { channel: "stable", version: current };
  };
}
