import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { readJsonObject } from "./lib/json-object.mjs";
import { packReleaseBundle, unpackRelease, verifiedBundleName, verifyRelease } from "./release-record.ts";
import type { ReleaseIntent, VerifiedRelease } from "./release-record.ts";
import { archiveDirectory, archivePath, manifestPath, repoRoot, run } from "./release.ts";

const lockfilePath = resolve(repoRoot, "pnpm-lock.yaml");

export type ArchiveWorkshop = {
  pack: (intent: ReleaseIntent) => Uint8Array;
  restore: (intent: ReleaseIntent, bundle: Uint8Array) => VerifiedRelease;
};

/**
 * Stamps the release version and source onto the published manifest, packs, and verifies the result.
 * The `finally` restore covers an ordinary failure, but this is meant for the disposable CI checkout:
 * a killed process leaves the manifest and lockfile rewritten in the working tree.
 */
function prepareArchive(intent: ReleaseIntent, bundleDirectory: string): void {
  const manifestBytes = readFileSync(manifestPath);
  const lockfileBytes = readFileSync(lockfilePath);
  try {
    const manifest = readJsonObject(manifestPath);
    manifest.version = intent.version;
    manifest.elmeraRelease = { commit: intent.commit, channel: intent.channel };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    run("pnpm", ["install", "--lockfile-only"]);
    run("pnpm", ["packages:pack"]);
    run("pnpm", ["test:packed-consumer"]);
    copyFileSync(archivePath(intent.version), resolve(bundleDirectory, "package.tgz"));
    copyFileSync(resolve(archiveDirectory, "archive.json"), resolve(bundleDirectory, "archive.json"));
    copyFileSync(resolve(archiveDirectory, "verified.json"), resolve(bundleDirectory, "verified.json"));
    verifyRelease(bundleDirectory, intent);
  } finally {
    writeFileSync(manifestPath, manifestBytes);
    writeFileSync(lockfilePath, lockfileBytes);
  }
}

function createArchiveWorkshop(bundleDirectory: string): ArchiveWorkshop {
  const bundlePath = resolve(bundleDirectory, verifiedBundleName);
  return {
    pack: (intent) => {
      prepareArchive(intent, bundleDirectory);
      packReleaseBundle(bundleDirectory, bundlePath);
      return new Uint8Array(readFileSync(bundlePath));
    },
    restore: (intent, bundle) => {
      writeFileSync(bundlePath, bundle);
      unpackRelease(bundlePath, bundleDirectory);
      return verifyRelease(bundleDirectory, intent);
    },
  };
}

export async function withArchiveWorkshop(work: (workshop: ArchiveWorkshop) => Promise<void>): Promise<void> {
  const bundleDirectory = mkdtempSync(resolve(tmpdir(), "elmera-release-"));
  try {
    mkdirSync(archiveDirectory, { recursive: true });
    await work(createArchiveWorkshop(bundleDirectory));
  } finally {
    rmSync(bundleDirectory, { recursive: true, force: true });
  }
}
