import { Effect } from "effect";
import type { Scope } from "effect";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { attempt } from "./errors.ts";
import type { ReleaseError } from "./errors.ts";
import type { ReleaseIntent, VerifiedRelease } from "./intent.ts";
import { verifiedBundleName } from "./intent.ts";
import { asRecord, asString, parseJsonObject, readJsonObject } from "./json.ts";
import { scratchDirectory } from "./scratch.ts";

const releaseBundleMembers = ["archive.json", "package.tgz", "verified.json"] as const;

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertReceipt(directory: string, intent: ReleaseIntent, packageName: string): string {
  const archive = resolve(directory, "package.tgz");
  const reportPath = resolve(directory, "archive.json");
  const receiptPath = resolve(directory, "verified.json");
  const reportBytes = readFileSync(reportPath);
  const reportSha256 = sha256Hex(reportBytes);
  const report = asRecord(parseJsonObject(reportBytes.toString("utf8"), "archive report"), "archive report");
  if (report.version !== intent.version) {
    throw new Error("Packed consumer verification does not match this archive");
  }
  const expected = asRecord(report.archive, "archive");
  if (expected.name !== packageName) {
    throw new Error("Packed consumer verification does not match this archive");
  }
  const archiveBytes = readFileSync(archive);
  if (
    asString(expected.sha256, "sha256") !== sha256Hex(archiveBytes) ||
    expected.bytes !== archiveBytes.length
  ) {
    throw new Error("Packed consumer verification does not match this archive");
  }
  const verification = readJsonObject(receiptPath);
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
