import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

import { resolveReleasePackage } from "../packages/release/src/config.ts";
import { assertReleaseVersion } from "../packages/release/src/version.ts";
import { asString, readJsonObject } from "./lib/json-object.mjs";

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
export const packageManifest = join(
  relative(releasePackage.checkoutRoot, releasePackage.packageDirectory),
  "package.json"
).replaceAll("\\", "/");
export const archiveDirectory = resolve(releasePackage.checkoutRoot, ".artifacts/release");

export function run(command: string, args: readonly string[], cwd = repoRoot): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${String(result.status)}`);
}

export function releaseVersion(): string {
  return assertReleaseVersion(asString(readJsonObject(manifestPath).version, "version"));
}

export function archivePath(version = releaseVersion()): string {
  return resolve(archiveDirectory, `elmeragroup-internal-${version}.tgz`);
}
