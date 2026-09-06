import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { runIfMain } from "./cli.ts";

export function cleanPackageDist(distDirectory: string): void {
  rmSync(distDirectory, { recursive: true, force: true });
}

function buildPackage(): void {
  const packageDirectory = resolve(import.meta.dirname, "..");
  const distDirectory = join(packageDirectory, "dist");
  cleanPackageDist(distDirectory);

  const compilerScript = resolve(packageDirectory, "node_modules/typescript/bin/tsc");
  const result = spawnSync(
    process.execPath,
    [compilerScript, "--project", join(packageDirectory, "tsconfig.build.json"), "--incremental", "false"],
    { cwd: packageDirectory, stdio: "inherit" }
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

await runIfMain(import.meta.url, buildPackage);
