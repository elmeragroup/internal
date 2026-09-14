import { Schema } from "effect";

import type { GitHubReleaseAsset } from "./github.ts";
import { assertCommit, isCommit } from "./intent.ts";
import type { ReleaseIntent } from "./intent.ts";
import { decodeJson } from "./json.ts";
import { assertCanaryReleaseVersion, assertStableReleaseVersion, isStableReleaseVersion } from "./version.ts";

/*
 * A Record is a GitHub release that this module owns, created as a draft: its tag is the lookup
 * key, its body carries the intent with an owner marker, and its single asset is the recorded
 * archive. This file holds the record's format rules: tag and owner identity, body parse and
 * serialize, the archive asset name, and record and asset classification. Asset classification
 * reads GitHub's asset state and size because GitHub drafts are the only record store (ADR 0005);
 * the store keeps transport and the catalog translation.
 */

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

export type ReleaseRecordClassification =
  | { kind: "ignored" }
  | { kind: "foreign" }
  | { kind: "owned"; intent: ReleaseIntent }
  | { kind: "legacy"; intent: ReleaseIntent };

const IntentProbe = Schema.Struct({
  schema: Schema.optionalKey(Schema.Json),
  owner: Schema.optionalKey(Schema.Json),
});
type IntentProbe = typeof IntentProbe.Type;

function tryParseBody(body: string): IntentProbe | undefined {
  try {
    return decodeJson(body, IntentProbe, "release body");
  } catch {
    return undefined;
  }
}

function intentMatchingTag(body: string, tag: string): ReleaseIntent {
  const intent = parseIntent(body);
  if (releaseTag(intent) !== tag) throw new Error("Release tag does not match its intent");
  return intent;
}

function clearlyForeignIdentity(parsed: IntentProbe | undefined): boolean {
  return parsed !== undefined && parsed.owner !== undefined && parsed.owner !== releaseRecordOwner;
}

/**
 * Ownership is recognized before intent validation (ADR 0002). An owned or legacy record with an
 * unreadable body throws so it is reported damaged rather than skipped as foreign.
 */
export function classifyReleaseRecord(
  tag: string,
  body: string,
  assetNames: readonly string[]
): ReleaseRecordClassification {
  if (!isReleaseTag(tag)) return { kind: "ignored" };
  const parsed = tryParseBody(body);
  if (parsed?.owner === releaseRecordOwner) {
    return { kind: "owned", intent: intentMatchingTag(body, tag) };
  }
  if (parsed?.schema === 1 && parsed.owner === undefined) {
    return { kind: "legacy", intent: intentMatchingTag(body, tag) };
  }
  if (assetNames.includes(releaseArchiveName) && !clearlyForeignIdentity(parsed)) {
    return { kind: "legacy", intent: intentMatchingTag(body, tag) };
  }
  return { kind: "foreign" };
}

export type ReleaseAsset = { state: "missing" } | { state: "starter" | "uploaded"; id: number };

/** `starterAllowed` records that an empty placeholder is only legal on a draft release. */
export function classifyReleaseAsset(
  starterAllowed: boolean,
  asset: GitHubReleaseAsset | undefined
): ReleaseAsset {
  if (asset === undefined) return { state: "missing" };
  if (asset.state === "starter") {
    if (!starterAllowed || asset.size !== 0) throw new Error("Unsupported starter release asset");
    return { state: "starter", id: asset.id };
  }
  if (asset.state !== "uploaded") throw new Error(`Unsupported release asset state ${asset.state}`);
  if (asset.size <= 0) throw new Error("Uploaded release asset has no bytes");
  return { state: "uploaded", id: asset.id };
}
