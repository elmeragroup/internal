import { resolve } from "node:path";

import {
  assertReleaseVersion,
  readManifestVersion,
  resolveReleasePackage,
} from "../packages/release/src/index.ts";

const checkoutRoot = resolve(import.meta.dirname, "..");
export const releasePackage = resolveReleasePackage(
  checkoutRoot,
  resolve(checkoutRoot, "packages/internal"),
  "@elmeragroup/internal"
);
export const repoRoot = releasePackage.checkoutRoot;
export const packageDirectory = releasePackage.packageDirectory;
export const packageName = releasePackage.packageName;
export const manifestPath = resolve(releasePackage.packageDirectory, "package.json");
export const archiveDirectory = resolve(releasePackage.checkoutRoot, ".artifacts/release");

export function releaseVersion(): string {
  return assertReleaseVersion(readManifestVersion(packageDirectory));
}

export function archivePath(version = releaseVersion()): string {
  return resolve(archiveDirectory, `elmeragroup-internal-${version}.tgz`);
}
