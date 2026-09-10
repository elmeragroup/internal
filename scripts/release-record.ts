import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ReleaseIntent, VerifiedRelease } from "../packages/release/src/intent.ts";
import { asRecord, parseJsonObject } from "./lib/json-object.mjs";
import { validateReceipt } from "./packed-verification.ts";

const releaseBundleMembers = ["archive.json", "package.tgz", "verified.json"] as const;

export function verifyRelease(
  directory: string,
  intent: ReleaseIntent,
  packageName: string
): VerifiedRelease {
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
