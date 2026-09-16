import { assertCommit } from "../../src/intent.ts";
import type { CommitSha, ReleaseIntent, VerifiedRelease } from "../../src/intent.ts";
import {
  assertCanaryReleaseVersion,
  assertStableReleaseVersion,
  isCanaryReleaseVersion,
} from "../../src/version.ts";
import type { CanaryVersion, StableVersion } from "../../src/version.ts";

/** Full commit SHA from a repeated seed character: `commitSha("a")` is forty `a`s. */
export function commitSha(seed: string): CommitSha {
  return assertCommit(seed.repeat(40));
}

/** The commit most cases release. */
export const commit = commitSha("a");

/** A descendant of `commit` in the linear histories the doubles describe. */
export const newerCommit = commitSha("b");

/** A commit unrelated to `commit` in those histories. */
export const unrelatedCommit = commitSha("c");

/** Parses a stable version through the version parser. */
export function stableVersion(version: string): StableVersion {
  return assertStableReleaseVersion(version);
}

/** Parses a canary version through the version parser. */
export function canaryVersion(version: string): CanaryVersion {
  return assertCanaryReleaseVersion(version);
}

/** Builds a release intent through the parser that owns each channel's version grammar. */
export function releaseIntent(version: string, target: CommitSha = commit): ReleaseIntent {
  if (isCanaryReleaseVersion(version)) return { channel: "canary", version, commit: target };
  return { channel: "stable", version: assertStableReleaseVersion(version), commit: target };
}

/** A verified release for `version`; `integrity` is overridable to describe a published copy. */
export function verifiedRelease(
  version: string,
  target: CommitSha = commit,
  integrity = "sha512-test"
): VerifiedRelease {
  return {
    ...releaseIntent(version, target),
    archive: "/verified/package.tgz",
    integrity,
  };
}
