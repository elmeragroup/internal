import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PackAndVerify, ReleaseIntent } from "@elmeragroup/release";

import { readJsonObject } from "./lib/json-object.mjs";
import { runCommand } from "./lib/run-command.ts";
import { archiveDirectory, archivePath, manifestPath, repoRoot } from "./release.ts";

const lockfilePath = resolve(repoRoot, "pnpm-lock.yaml");

/**
 * Stamps the release version and source onto the published manifest, then builds, packs, and runs
 * the packed-consumer checks. The `finally` restore covers an ordinary failure, but this is meant
 * for the disposable CI checkout: a killed process leaves the manifest and lockfile rewritten.
 */
function prepareArchive(intent: ReleaseIntent): void {
  const manifestBytes = readFileSync(manifestPath);
  const lockfileBytes = readFileSync(lockfilePath);
  try {
    const manifest = readJsonObject(manifestPath);
    manifest.version = intent.version;
    manifest.elmeraRelease = { commit: intent.commit, channel: intent.channel };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    runCommand("pnpm", ["install", "--lockfile-only"], repoRoot);
    runCommand("pnpm", ["packages:pack"], repoRoot);
    runCommand("pnpm", ["test:packed-consumer"], repoRoot);
  } finally {
    writeFileSync(manifestPath, manifestBytes);
    writeFileSync(lockfilePath, lockfileBytes);
  }
}

function packInternal(intent: ReleaseIntent): Uint8Array {
  mkdirSync(archiveDirectory, { recursive: true });
  prepareArchive(intent);
  return new Uint8Array(readFileSync(archivePath(intent.version)));
}

export function createInternalPackAndVerify(): PackAndVerify {
  return { pack: packInternal };
}
