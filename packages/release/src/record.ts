import { Schema } from "effect";

import { releaseAssetId } from "./github.ts";
import type { GitHubReleaseAsset, ReleaseAssetId } from "./github.ts";
import { assertCommit, isCommit } from "./intent.ts";
import type { CommitSha, ReleaseIntent } from "./intent.ts";
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

/** Body marker that claims a record for this owner; read before intent validation (ADR 0002). */
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
export function canaryRecordTag(commit: CommitSha): string {
  return `${canaryRecordPrefix}${commit}`;
}

/** The record tag an intent is stored under: `v<version>` for stable, `canary-<commit>` otherwise. */
export function releaseTag(intent: ReleaseIntent): string {
  return intent.channel === "stable" ? `v${intent.version}` : canaryRecordTag(intent.commit);
}

/** Whether `tag` is a record tag this module owns. Non-record tags are ignored during discovery. */
export function isReleaseTag(tag: string): boolean {
  if (tag.startsWith("v")) return isStableReleaseVersion(tag.slice(1));
  return tag.startsWith(canaryRecordPrefix) && isCommit(tag.slice(canaryRecordPrefix.length));
}

/** Parses a record tag. Throws, naming nothing else, when the tag is not a record tag. */
export function assertReleaseTag(tag: string): string {
  if (!isReleaseTag(tag)) throw new Error("Expected a stable or canary release record tag");
  return tag;
}

/**
 * Parses a record body into an intent. Throws `release intent is invalid` for a body that does not
 * decode, and the channel-specific version error when the version does not match the channel.
 */
export function parseIntent(text: string): ReleaseIntent {
  const value = decodeJson(text, IntentDocument, "release intent");
  const commit = assertCommit(value.commit);
  if (value.channel === "stable") {
    return { channel: "stable", version: assertStableReleaseVersion(value.version), commit };
  }
  return { channel: "canary", version: assertCanaryReleaseVersion(value.version), commit };
}

/** Renders an intent as the record body, including the schema and owner marker. */
export function serializeIntent(intent: ReleaseIntent): string {
  return JSON.stringify({
    schema: 1,
    owner: releaseRecordOwner,
    channel: intent.channel,
    version: intent.version,
    commit: intent.commit,
  });
}

/**
 * How a GitHub release relates to this owner: `ignored` (not a record tag), `foreign` (someone
 * else's release), `owned` (marked by this owner), or `legacy` (unmarked schema 1, or an archive
 * carrier without a foreign marker).
 */
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

/** The recorded archive's presence on a release, with the asset identity when one exists. */
export type ReleaseAsset = { state: "missing" } | { state: "starter" | "uploaded"; id: ReleaseAssetId };

/** `starterAllowed` records that an empty placeholder is only legal on a draft release. */
export function classifyReleaseAsset(
  starterAllowed: boolean,
  asset: GitHubReleaseAsset | undefined
): ReleaseAsset {
  if (asset === undefined) return { state: "missing" };
  if (asset.state === "starter") {
    if (!starterAllowed || asset.size !== 0) throw new Error("Unsupported starter release asset");
    return { state: "starter", id: releaseAssetId(asset.id) };
  }
  if (asset.state !== "uploaded") throw new Error(`Unsupported release asset state ${asset.state}`);
  if (asset.size <= 0) throw new Error("Uploaded release asset has no bytes");
  return { state: "uploaded", id: releaseAssetId(asset.id) };
}
