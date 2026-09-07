import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { asString, readJsonObject } from "./lib/json-object.mjs";
import { assertCanaryReleaseVersion, assertReleaseVersion } from "./release-version.ts";

export const repoRoot = resolve(import.meta.dirname, "..");
export const archiveDirectory = resolve(repoRoot, ".artifacts/canary");
export const packageName = "@elmeragroup/internal";
export const packageDirectory = resolve(repoRoot, "packages/internal");
export const manifestPath = resolve(packageDirectory, "package.json");

export function run(command: string, args: readonly string[], cwd = repoRoot): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${String(result.status)}`);
}

export function releaseVersion(): string {
  return assertReleaseVersion(asString(readJsonObject(manifestPath).version, "version"));
}

export function canaryVersion(): string {
  return assertCanaryReleaseVersion(releaseVersion());
}

export function archivePath(version = releaseVersion()): string {
  return resolve(archiveDirectory, `elmeragroup-internal-${version}.tgz`);
}
