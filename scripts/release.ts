import { resolve } from "node:path";

import { assertReleaseVersion, readManifestVersion, resolveReleasePackage } from "@elmeragroup/release";
import type { ReleasePackage, ReleaseVersion } from "@elmeragroup/release";

const checkoutRoot = resolve(import.meta.dirname, "..");
const publishedPackageDirectory = resolve(checkoutRoot, "packages/internal");
const archiveDirectoryPath = resolve(checkoutRoot, ".artifacts/release");
let cachedReleaseLayout: ReleaseLayout | undefined;

/**
 * Everything a release script needs about this checkout's publish target: the
 * package identity plus the derived manifest and archive paths. `checkoutRoot`
 * is the repository root.
 */
export type ReleaseLayout = ReleasePackage & {
  readonly manifestPath: string;
  readonly archiveDirectory: string;
};

/**
 * Resolves the publish target for this checkout: the `@elmeragroup/internal`
 * package in `packages/internal`.
 *
 * The package identity is resolved on first use and cached, so importing this
 * module performs no filesystem I/O.
 *
 * @returns The resolved layout.
 */
export function releaseLayout(): ReleaseLayout {
  cachedReleaseLayout ??= {
    ...resolveReleasePackage(checkoutRoot, publishedPackageDirectory, "@elmeragroup/internal"),
    manifestPath: resolve(publishedPackageDirectory, "package.json"),
    archiveDirectory: archiveDirectoryPath,
  };
  return cachedReleaseLayout;
}

/**
 * Reads and parses the published package's current version.
 *
 * @returns The parsed release version.
 * @throws When the manifest cannot be read or its version does not match the release grammar; this
 *   is a script entry point, so the failure terminates the run.
 */
export function releaseVersion(): ReleaseVersion {
  return assertReleaseVersion(readManifestVersion(releaseLayout().packageDirectory));
}

/**
 * Builds the archive path for one release version.
 *
 * @param version - The parsed release version.
 * @returns The absolute archive path under the artifact directory.
 */
export function archivePath(version: string): string {
  return resolve(releaseLayout().archiveDirectory, `elmeragroup-internal-${version}.tgz`);
}
