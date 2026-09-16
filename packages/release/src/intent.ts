import type { Brand } from "effect";

import type { CanaryVersion, StableVersion } from "./version.ts";

/** A full 40-character lowercase hexadecimal git commit SHA. */
export type CommitSha = Brand.Branded<string, "CommitSha">;

/** Whether `value` is a full commit SHA; narrows to the parsed identity. */
export function isCommit(value: string): value is CommitSha {
  return /^[a-f0-9]{40}$/.test(value);
}

/** Parses a full commit SHA. Throws for branch names, abbreviated SHAs, and uppercase hex. */
export function assertCommit(commit: string): CommitSha {
  if (!isCommit(commit)) throw new Error(`Expected a full commit SHA; received ${commit}`);
  return commit;
}

/** A stable release of `commit`, cut at the version in the checked-out release PR. */
export type StableIntent = {
  readonly channel: "stable";
  readonly version: StableVersion;
  readonly commit: CommitSha;
};

/** A canary release of `commit`, numbered from its planned stable base. */
export type CanaryIntent = {
  readonly channel: "canary";
  readonly version: CanaryVersion;
  readonly commit: CommitSha;
};

/**
 * A release identity the engine records. The version grammar is tied to the channel, so a stable
 * intent cannot carry a canary version and the reverse. Construct one through `parseIntent` or the
 * engine's planning, never by hand.
 */
export type ReleaseIntent = StableIntent | CanaryIntent;

/** A release identity whose archive bytes were downloaded and verified against it. */
export type VerifiedRelease = ReleaseIntent & {
  readonly archive: string;
  readonly integrity: string;
};
