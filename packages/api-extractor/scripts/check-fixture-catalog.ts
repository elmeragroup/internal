import { existsSync } from "node:fs";
import { join } from "node:path";

import { runIfMain } from "./cli.ts";
import { fixtureBudgets, fixtureEvidenceCatalog, fixtureTreeRoot } from "./fixture-catalog.ts";
import { packageFixtureExecutionPlan, packageFixtureTypecheckPlan } from "./fixture-plans.ts";

/**
 * Cross-checks the hand-maintained `fixtures.json` budgets against the derived
 * fixture inventory, so a rename or removal cannot silently drop a timing
 * ceiling, a virtual dependency, a generated-oracle exemption, or an exclusion.
 */
export function checkFixtureCatalog() {
  const records = new Map(fixtureEvidenceCatalog.map((record) => [record.id, record]));
  const budgetGroups = [
    ["timing.boundary", fixtureBudgets.timing.boundary.map((entry) => entry.fixture)],
    ["timing.externalSelection", fixtureBudgets.timing.externalSelection.map((entry) => entry.fixture)],
    ["virtualUpstreamDependency", fixtureBudgets.virtualUpstreamDependency],
    ["locallyGeneratedOracles", fixtureBudgets.locallyGeneratedOracles],
  ] as const;
  for (const [group, names] of budgetGroups) {
    for (const name of names) {
      if (!records.has(name))
        throw new Error(`fixtures.json ${group} names a fixture that does not exist: ${name}`);
    }
  }
  for (const project of fixtureBudgets.excludedTypecheckProjects) {
    if (!existsSync(join(fixtureTreeRoot, project))) {
      throw new Error(`fixtures.json excludes a type-check project that does not exist: ${project}`);
    }
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
