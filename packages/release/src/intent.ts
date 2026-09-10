import { Schema } from "effect";

import { decodeJson, isJsonString } from "./json.ts";
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
export const verifiedBundleName = "verified-release.tgz";

const IntentDocument = Schema.Struct({
  schema: Schema.optionalKey(Schema.Json),
  owner: Schema.optionalKey(Schema.Json),
  channel: Schema.optionalKey(Schema.Json),
  version: Schema.optionalKey(Schema.Json),
  commit: Schema.optionalKey(Schema.Json),
});

function isCommit(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value);
}

export function assertCommit(commit: string): string {
  if (!isCommit(commit)) throw new Error(`Expected a full commit SHA; received ${commit}`);
  return commit;
}

export function releaseTag(intent: ReleaseIntent): string {
  return intent.channel === "stable" ? `v${intent.version}` : `canary-${intent.commit}`;
}

export function isReleaseTag(tag: string): boolean {
  if (tag.startsWith("v")) return isStableReleaseVersion(tag.slice(1));
  return tag.startsWith("canary-") && isCommit(tag.slice("canary-".length));
}

export function assertReleaseTag(tag: string): string {
  if (!isReleaseTag(tag)) throw new Error("Expected a stable or canary release record tag");
  return tag;
}

export function parseIntent(text: string): ReleaseIntent {
  const value = decodeJson(text, IntentDocument, "release intent");
  if (value.owner !== undefined && value.owner !== releaseRecordOwner) {
    throw new Error("Unsupported release intent");
  }
  if (value.schema !== 1 || (value.channel !== "stable" && value.channel !== "canary")) {
    throw new Error("Unsupported release intent");
  }
  if (!isJsonString(value.version)) throw new Error("version is not a string");
  if (!isJsonString(value.commit)) throw new Error("commit is not a string");
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
