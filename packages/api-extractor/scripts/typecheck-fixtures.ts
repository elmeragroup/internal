import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { runIfMain } from "./cli.ts";
import { packageFixtureTypecheckPlan } from "./fixture-plans.ts";

const packageDirectory = resolve(import.meta.dirname, "..");
const compilerScript = resolve(packageDirectory, "node_modules/typescript/bin/tsc");

export function typecheckFixtureProjects(): number {
  for (const entry of packageFixtureTypecheckPlan) {
    const result = spawnSync(
      process.execPath,
      [compilerScript, "--project", resolve(packageDirectory, entry.project), "--noEmit"],
      { cwd: packageDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      const detail = [result.stdout, result.stderr].filter((value) => value.length > 0).join("\n");
      throw new Error(`Fixture type-check failed for ${entry.project}.\n${detail}`);
    }
  }
  return packageFixtureTypecheckPlan.length;
}

await runIfMain(import.meta.url, () => {
  console.log(JSON.stringify({ projects: typecheckFixtureProjects(), status: "pass" }));
});
