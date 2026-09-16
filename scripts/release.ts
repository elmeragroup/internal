import { resolve } from "node:path";

import { assertReleaseVersion, readManifestVersion, resolveReleasePackage } from "@elmeragroup/release";
import type { ReleasePackage } from "@elmeragroup/release";

const checkoutRoot = resolve(import.meta.dirname, "..");
let cachedReleasePackage: ReleasePackage | undefined;

/**
 * The publish target for this checkout: the `@elmeragroup/internal` package.
 *
 * Resolved on first use so importing this module performs no filesystem I/O.
 *
 * @returns The resolved release package identity and directories.
 */
export function releasePackage(): ReleasePackage {
  cachedReleasePackage ??= resolveReleasePackage(
    checkoutRoot,
    resolve(checkoutRoot, "packages/internal"),
    "@elmeragroup/internal"
  );
  return cachedReleasePackage;
}

/**
 * The repository root of the release checkout.
 *
 * @returns The absolute checkout root path.
 */
export function repoRoot(): string {
  return releasePackage().checkoutRoot;
}

/**
 * The directory of the published package.
 *
 * @returns The absolute package directory path.
 */
export function packageDirectory(): string {
  return releasePackage().packageDirectory;
}

/**
 * The published package name.
 *
 * @returns The package name, always `@elmeragroup/internal`.
 */
export function packageName(): string {
  return releasePackage().packageName;
}

/**
 * The absolute path of the published package manifest.
 *
 * @returns The manifest path inside the package directory.
 */
export function manifestPath(): string {
  return resolve(packageDirectory(), "package.json");
}

/**
 * The directory where packed release archives are staged.
 *
 * @returns The absolute artifact directory path.
 */
export function archiveDirectory(): string {
  return resolve(repoRoot(), ".artifacts/release");
}

/**
 * Reads and parses the published package's current version.
 *
 * @returns The parsed release version, or throws `ReleaseError` when the manifest version is invalid.
 */
export function releaseVersion() {
  return assertReleaseVersion(readManifestVersion(packageDirectory()));
}

/**
 * Builds the archive path for one release version.
 *
 * @param version - The parsed release version.
 * @returns The absolute archive path under the artifact directory.
 */
export function archivePath(version: string): string {
  return resolve(archiveDirectory(), `elmeragroup-internal-${version}.tgz`);
}
