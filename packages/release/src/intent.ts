import { Schema } from "effect";

import { decodeJson } from "./json.ts";
import { assertCanaryReleaseVersion, assertStableReleaseVersion, isStableReleaseVersion } from "./version.ts";

export type ReleaseIntent = {
  channel: "canary" | "stable";
  version: string;
  commit: string;
};

export type VerifiedRelease = ReleaseIntent & {
  archive: string;
  integrity: string;
};

export const releaseRecordOwner = "elmera-release";

/** Asset name of the recorded archive on its GitHub draft release. */
export const releaseArchiveName = "release.tgz";

const canaryRecordPrefix = "canary-";

const IntentDocument = Schema.Struct({
  schema: Schema.Literal(1),
  owner: Schema.optionalKey(Schema.Literal(releaseRecordOwner)),
  channel: Schema.Literals(["stable", "canary"]),
  version: Schema.String,
  commit: Schema.String,
});

function isCommit(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value);
}

export function assertCommit(commit: string): string {
  if (!isCommit(commit)) throw new Error(`Expected a full commit SHA; received ${commit}`);
  return commit;
}

/** Record tag for a canary release of `commit`. */
export function canaryRecordTag(commit: string): string {
  return `${canaryRecordPrefix}${commit}`;
}

export function releaseTag(intent: ReleaseIntent): string {
  return intent.channel === "stable" ? `v${intent.version}` : canaryRecordTag(intent.commit);
}

export function isReleaseTag(tag: string): boolean {
  if (tag.startsWith("v")) return isStableReleaseVersion(tag.slice(1));
  return tag.startsWith(canaryRecordPrefix) && isCommit(tag.slice(canaryRecordPrefix.length));
}

export function assertReleaseTag(tag: string): string {
  if (!isReleaseTag(tag)) throw new Error("Expected a stable or canary release record tag");
  return tag;
}

export function parseIntent(text: string): ReleaseIntent {
  const value = decodeJson(text, IntentDocument, "release intent");
  if (value.channel === "stable") assertStableReleaseVersion(value.version);
  else assertCanaryReleaseVersion(value.version);
  return { channel: value.channel, version: value.version, commit: assertCommit(value.commit) };
}

export function serializeIntent(intent: ReleaseIntent): string {
  return JSON.stringify({
    schema: 1,
    owner: releaseRecordOwner,
    channel: intent.channel,
    version: intent.version,
    commit: intent.commit,
  });
}
