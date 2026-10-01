import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PackAndVerify, ReleaseIntent } from "@elmeragroup/release";

import { readJsonObject } from "./lib/json-object.mjs";
import { runCommand } from "./lib/run-command.ts";
import { archivePath, releaseLayout } from "./release.ts";

/**
 * Stamps the release version and source onto the published manifest, then builds, packs (which
 * recreates the archive directory), runs the packed-consumer checks, and returns the archive bytes.
 * The `finally` restore covers an ordinary failure, but this is meant for the disposable CI
 * checkout: a killed process leaves the manifest and lockfile rewritten.
 *
 * The layout and lockfile paths resolve inside the operation, so importing this adapter performs
 * no filesystem I/O.
 */
export const internalPackAndVerify: PackAndVerify = {
  pack: (intent: ReleaseIntent): Uint8Array => {
    const { checkoutRoot, manifestPath } = releaseLayout();
    const lockfilePath = resolve(checkoutRoot, "pnpm-lock.yaml");
    const manifestBytes = readFileSync(manifestPath);
    const lockfileBytes = readFileSync(lockfilePath);
    try {
      const manifest = readJsonObject(manifestPath);
      manifest.version = intent.version;
      manifest.elmeraRelease = { commit: intent.commit, channel: intent.channel };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      runCommand("pnpm", ["install", "--lockfile-only"], checkoutRoot);
      runCommand("pnpm", ["packages:pack"], checkoutRoot);
      runCommand("pnpm", ["test:packed-consumer"], checkoutRoot);
    } finally {
      writeFileSync(manifestPath, manifestBytes);
      writeFileSync(lockfilePath, lockfileBytes);
    }
    return new Uint8Array(readFileSync(archivePath(intent.version)));
  },
};
