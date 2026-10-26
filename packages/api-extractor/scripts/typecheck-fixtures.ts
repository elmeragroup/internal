import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { runIfMain } from "./cli.ts";
import { compilerScriptPath } from "./compiler.ts";
import { packageFixtureTypecheckPlan } from "./fixture-plans.ts";

const packageDirectory = resolve(import.meta.dirname, "..");

function typecheckFixtureProjects(): number {
  for (const entry of packageFixtureTypecheckPlan) {
    const result = spawnSync(
      process.execPath,
      [compilerScriptPath(), "--project", resolve(packageDirectory, entry.project), "--noEmit"],
      { cwd: packageDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    if (result.error !== undefined) throw result.error;
    const diagnostics = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const expectedStatus = entry.expectedDiagnostics.length === 0 ? 0 : 2;
    if (
      result.status !== expectedStatus ||
      result.stderr.length > 0 ||
      JSON.stringify(diagnostics) !== JSON.stringify(entry.expectedDiagnostics)
    ) {
      const detail = [result.stdout, result.stderr].filter((value) => value.length > 0).join("\n");
      throw new Error(`Fixture type-check failed for ${entry.project}.\n${detail}`);
    }
  }
  return packageFixtureTypecheckPlan.length;
}

await runIfMain(import.meta.url, () => {
  console.log(JSON.stringify({ projects: typecheckFixtureProjects(), status: "pass" }));
});
