import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { PackAndVerify } from "../packages/release/src/adapter.ts";
import { packReleaseBundle, verifyRelease } from "../packages/release/src/bundle.ts";
import type { ReleaseIntent } from "../packages/release/src/intent.ts";
import { verifiedBundleName } from "../packages/release/src/intent.ts";
import { readJsonObject } from "./lib/json-object.mjs";
import { archiveDirectory, archivePath, manifestPath, packageName, repoRoot, run } from "./release.ts";

const lockfilePath = resolve(repoRoot, "pnpm-lock.yaml");

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
    verifyRelease(bundleDirectory, intent, packageName);
  } finally {
    writeFileSync(manifestPath, manifestBytes);
    writeFileSync(lockfilePath, lockfileBytes);
  }
}

function packInternal(intent: ReleaseIntent): Uint8Array {
  const bundleDirectory = mkdtempSync(resolve(tmpdir(), "elmera-release-"));
  try {
    mkdirSync(archiveDirectory, { recursive: true });
    prepareArchive(intent, bundleDirectory);
    const bundlePath = resolve(bundleDirectory, verifiedBundleName);
    packReleaseBundle(bundleDirectory, bundlePath);
    return new Uint8Array(readFileSync(bundlePath));
  } finally {
    rmSync(bundleDirectory, { recursive: true, force: true });
  }
}

export function createInternalPackAndVerify(): PackAndVerify {
  return { pack: packInternal };
}
