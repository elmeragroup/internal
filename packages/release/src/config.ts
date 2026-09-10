import { Schema } from "effect";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { readJson } from "./json.ts";

export type ReleasePackage = {
  checkoutRoot: string;
  packageDirectory: string;
  packageName: string;
};

/** The fields the release pipeline reads from any package manifest it touches. */
export const PackageManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
});

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function assertDirectory(path: string, label: string): void {
  if (!isDirectory(path)) throw new Error(`${label} is not a directory`);
}

function isInsideCheckout(checkoutRoot: string, packageDirectory: string): boolean {
  const inside = relative(checkoutRoot, packageDirectory);
  return inside === "" || (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside));
}

export function resolveReleasePackage(
  checkoutRoot: string,
  packageDirectory: string,
  packageName: string
): ReleasePackage {
  const root = resolve(checkoutRoot);
  const directory = resolve(packageDirectory);
  assertDirectory(root, "Checkout root");
  if (!isInsideCheckout(root, directory)) {
    throw new Error("Package directory is outside the checkout root");
  }
  const manifestPath = resolve(directory, "package.json");
  if (!existsSync(manifestPath)) throw new Error("Package directory does not contain package.json");
  const { name } = readJson(manifestPath, PackageManifest);
  if (name !== packageName) {
    throw new Error(`Package name ${packageName} does not match ${name}`);
  }
  return { checkoutRoot: root, packageDirectory: directory, packageName };
}

/** The `version` field of `package.json` in `packageDirectory`. */
export function readManifestVersion(packageDirectory: string): string {
  return readJson(resolve(packageDirectory, "package.json"), PackageManifest).version;
}

/** Git path to the package manifest, always with forward slashes. */
export function packageManifestGitPath(pkg: ReleasePackage): string {
  return join(relative(pkg.checkoutRoot, pkg.packageDirectory), "package.json").replaceAll("\\", "/");
}
