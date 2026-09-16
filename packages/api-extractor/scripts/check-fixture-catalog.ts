import { runIfMain } from "./cli.ts";
import { packageFixtureExecutionPlan, packageFixtureTypecheckPlan } from "./fixture-plans.ts";

/**
 * Reports the derived fixture inventory. The catalog validates itself when it is derived, so
 * this entry point only summarizes what it found.
 */
export function checkFixtureCatalog() {
  return {
    fixtures: packageFixtureExecutionPlan.length,
    conformance: packageFixtureExecutionPlan.filter((entry) => entry.conformance).length,
    timed: packageFixtureExecutionPlan.filter((entry) => entry.timing.length > 0).length,
    warningEvidence: packageFixtureExecutionPlan.filter((entry) => entry.warningEvidence).length,
    typecheckProjects: packageFixtureTypecheckPlan.length,
  };
}

await runIfMain(import.meta.url, () => {
  console.log(JSON.stringify({ ...checkFixtureCatalog(), status: "pass" }));
});
