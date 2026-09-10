import { Effect, Schema } from "effect";
import type { Scope } from "effect";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { attempt } from "./errors.ts";
import type { ReleaseError } from "./errors.ts";
import type { ReleaseIntent, VerifiedRelease } from "./intent.ts";
import { verifiedBundleName } from "./intent.ts";
import { decodeJson, readJson } from "./json.ts";
import { scratchDirectory } from "./scratch.ts";

const releaseBundleMembers = ["archive.json", "package.tgz", "verified.json"] as const;

const ArchiveReport = Schema.Struct({
  version: Schema.String,
  archive: Schema.Struct({
    name: Schema.String,
    sha256: Schema.String,
    bytes: Schema.Number,
  }),
});

const PackedReceipt = Schema.Struct({
  status: Schema.String,
  version: Schema.String,
  archiveReportSha256: Schema.String,
});

const PackedManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  elmeraRelease: Schema.Struct({
    commit: Schema.String,
    channel: Schema.Literals(["canary", "stable"] as const),
  }),
});

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertArchiveMatches(
  reportBytes: Buffer,
  archiveBytes: Buffer,
  version: string,
  packageName: string
): string {
  const reportSha256 = sha256Hex(reportBytes);
  const report = decodeJson(reportBytes.toString("utf8"), ArchiveReport, "archive report");
  if (
    report.version !== version ||
    report.archive.name !== packageName ||
    report.archive.sha256 !== sha256Hex(archiveBytes) ||
    report.archive.bytes !== archiveBytes.length
  ) {
    throw new Error("Packed consumer verification does not match this archive");
  }
  return reportSha256;
}

export function assertReceipt(directory: string, intent: ReleaseIntent, packageName: string): string {
  const archive = resolve(directory, "package.tgz");
  const reportPath = resolve(directory, "archive.json");
  const receiptPath = resolve(directory, "verified.json");
  const reportSha256 = assertArchiveMatches(
    readFileSync(reportPath),
    readFileSync(archive),
    intent.version,
    packageName
  );
  const verification = readJson(receiptPath, PackedReceipt);
  if (
    verification.status !== "pass" ||
    verification.version !== intent.version ||
    verification.archiveReportSha256 !== reportSha256
  ) {
    throw new Error("Packed consumer verification does not match this archive");
  }
  return archive;
}

export function verifyRelease(
  directory: string,
  intent: ReleaseIntent,
  packageName: string
): VerifiedRelease {
  const archive = assertReceipt(directory, intent, packageName);
  const manifest = decodeJson(
    execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }),
    PackedManifest,
    "packed manifest"
  );
  const source = manifest.elmeraRelease;
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

/** Unpacks saved bundle bytes into a scoped temp directory and verifies those exact bytes. */
export function restoreVerifiedRelease(
  intent: ReleaseIntent,
  bundle: Uint8Array,
  packageName: string
): Effect.Effect<VerifiedRelease, ReleaseError, Scope.Scope> {
  return Effect.gen(function* () {
    const directory = yield* scratchDirectory("elmera-release-");
    return yield* attempt(() => {
      const bundlePath = resolve(directory, verifiedBundleName);
      writeFileSync(bundlePath, bundle);
      unpackRelease(bundlePath, directory);
      return verifyRelease(directory, intent, packageName);
    });
  });
}
