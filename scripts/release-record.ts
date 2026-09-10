import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { asRecord, asString, parseJsonObject } from "./lib/json-object.mjs";
import { validateReceipt } from "./packed-verification.ts";
import {
  assertCanaryReleaseVersion,
  assertStableReleaseVersion,
  isStableReleaseVersion,
} from "./release-version.ts";
import { packageName } from "./release.ts";

export type ReleaseIntent = {
  channel: "canary" | "stable";
  version: string;
  commit: string;
};

export type VerifiedRelease = ReleaseIntent & {
  archive: string;
  integrity: string;
};

export const verifiedBundleName = "verified-release.tgz";
const releaseBundleMembers = ["archive.json", "package.tgz", "verified.json"] as const;

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
  const value = parseJsonObject(text, "release intent");
  if (value.schema !== 1 || (value.channel !== "stable" && value.channel !== "canary")) {
    throw new Error("Unsupported release intent");
  }
  const version = asString(value.version, "version");
  if (value.channel === "stable") assertStableReleaseVersion(version);
  else assertCanaryReleaseVersion(version);
  return { channel: value.channel, version, commit: assertCommit(asString(value.commit, "commit")) };
}

export function verifyRelease(directory: string, intent: ReleaseIntent): VerifiedRelease {
  const archive = resolve(directory, "package.tgz");
  validateReceipt(
    {
      reportPath: resolve(directory, "archive.json"),
      receiptPath: resolve(directory, "verified.json"),
      archivePath: archive,
      version: intent.version,
    },
    packageName
  );
  const manifest = parseJsonObject(
    execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }),
    "packed manifest"
  );
  const source = asRecord(manifest.elmeraRelease, "packed source");
  if (
    manifest.name !== packageName ||
    manifest.version !== intent.version ||
    source.commit !== intent.commit ||
    source.channel !== intent.channel
  ) {
    throw new Error("Archive does not match the recorded release source");
  }
  return {
    ...intent,
    archive,
    integrity: `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`,
  };
}

export function packReleaseBundle(directory: string, bundle: string): void {
  execFileSync("tar", ["-czf", bundle, "-C", directory, ...releaseBundleMembers]);
}

export function unpackRelease(bundle: string, directory: string): void {
  const listed = execFileSync("tar", ["-tzf", bundle], { encoding: "utf8" }).trim().split("\n");
  const inventory = new Set(listed);
  if (
    listed.length !== releaseBundleMembers.length ||
    releaseBundleMembers.some((name) => !inventory.has(name))
  ) {
    throw new Error("Invalid release bundle inventory");
  }
  // Read each member as bytes; never extract archive-controlled paths or links.
  for (const name of releaseBundleMembers) {
    const bytes = execFileSync("tar", ["-xOzf", bundle, name], { maxBuffer: 100 * 1024 * 1024 });
    writeFileSync(resolve(directory, name), bytes);
  }
}
