import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { asString, readJsonObject } from "./lib/json-object.mjs";
import { assertCanaryReleaseVersion, assertCoordinatedReleaseVersion } from "./release-version.ts";

export const repoRoot = resolve(import.meta.dirname, "..");
export const archiveDirectory = resolve(repoRoot, ".artifacts/canary");
export const packageNames = ["internal"] as const;

export function run(command: string, args: readonly string[], cwd = repoRoot): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${String(result.status)}`);
}

function manifestVersions(): string[] {
  return packageNames.map((name) =>
    asString(readJsonObject(resolve(repoRoot, "packages", name, "package.json")).version, "version")
  );
}

export function releaseVersion(): string {
  return assertCoordinatedReleaseVersion(manifestVersions());
}

export function canaryVersion(): string {
  return assertCanaryReleaseVersion(manifestVersions());
}

export function archivePath(name: (typeof packageNames)[number], version = releaseVersion()): string {
  return resolve(archiveDirectory, `elmeragroup-${name}-${version}.tgz`);
}
