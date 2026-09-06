import { runIfMain } from "./cli.ts";
import { fixtureEvidenceCatalog } from "./fixture-catalog.ts";
import { packageFixtureExecutionPlan, packageFixtureTypecheckPlan } from "./fixture-plans.ts";

/** Importing the catalog validates it; this reports what the derivation found. */
export function checkFixtureCatalog() {
  if (packageFixtureExecutionPlan.length !== fixtureEvidenceCatalog.length) {
    throw new Error("Package fixture execution plan is incomplete.");
  }
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
