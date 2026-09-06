import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { asString, readJsonObject } from "./lib/json-object.mjs";

export const repoRoot = resolve(import.meta.dirname, "..");
export const archiveDirectory = resolve(repoRoot, ".artifacts/canary");
export const packageNames = ["api-extractor", "api-artifacts", "internal"] as const;

export function run(command: string, args: readonly string[], cwd = repoRoot): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${String(result.status)}`);
}

export function canaryVersion(): string {
  const versions = packageNames.map((name) =>
    asString(readJsonObject(resolve(repoRoot, "packages", name, "package.json")).version, "version")
  );
  const first = versions[0];
  if (
    first === undefined ||
    !/^\d+\.\d+\.\d+-canary\.\d+$/.test(first) ||
    versions.some((version) => version !== first)
  )
    throw new Error("All release packages must have the same x.y.z-canary.N version");
  return first;
}

export function archivePath(name: (typeof packageNames)[number], version = canaryVersion()): string {
  return resolve(archiveDirectory, `elmeragroup-${name}-${version}.tgz`);
}
