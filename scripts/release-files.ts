import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { assertStableReleaseVersion, compareStableVersions } from "../packages/release/src/version.ts";

export function assertStableReleaseFiles(
  previous: string,
  current: string,
  root: string,
  packageDirectory: string
): void {
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
}
