import { resolve } from "node:path";

import { asRecord, asString, isString, readJsonObject } from "./lib/json-object.mjs";
import { assertStableReleaseFiles } from "./release-files.ts";
import type { GitHubClient } from "./release-github-client.ts";
import { assertStableReleaseVersion } from "./release-version.ts";
import { repoRoot } from "./release.ts";

/** Which release line the checked-out manifest puts a main commit on. */
export type ReleaseLine = { channel: "stable"; version: string } | { channel: "canary"; current: string };

/**
 * Reads the checked-out manifest and decides the line. A stable bump is returned only after every
 * condition holds, so the checks cannot be reordered apart by a later edit.
 */
export type StableReleaseGate = (commit: string, previous: string) => Promise<ReleaseLine>;

/** Only the merge of the generated release PR may raise the published stable version. */
async function assertMergedReleasePullRequest(client: GitHubClient, commit: string): Promise<void> {
  const pulls = await client.items(
    await client.request(`${client.root}/commits/${commit}/pulls?per_page=100`),
    "commit pull requests"
  );
  const merged = pulls.some((pull) => {
    const head = asRecord(pull.head, "PR head");
    const base = asRecord(pull.base, "PR base");
    return (
      isString(pull.merged_at) &&
      pull.merge_commit_sha === commit &&
      head.ref === "changeset-release/main" &&
      base.ref === "main" &&
      asRecord(head.repo, "head repository").full_name === client.repository
    );
  });
  if (!merged) throw new Error("A stable version change must come from a merged changeset-release/main PR");
}

export function createStableReleaseGate(client: GitHubClient, root = repoRoot): StableReleaseGate {
  const manifestPath = resolve(root, "packages/internal/package.json");
  return async (commit, previous) => {
    const current = assertStableReleaseVersion(
      asString(readJsonObject(manifestPath).version, "package version")
    );
    if (current === previous) return { channel: "canary", current };
    assertStableReleaseFiles(previous, current, root);
    await assertMergedReleasePullRequest(client, commit);
    return { channel: "stable", version: current };
  };
}
