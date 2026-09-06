import { readdirSync } from "node:fs";
import { join } from "node:path";

import { fixtureBudgets, fixtureEvidenceCatalog, fixtureTreeRoot } from "./fixture-catalog.ts";
import type {
  ConformanceDisposition,
  FixtureBudgets,
  FixtureEvidenceRecord,
  BoundaryTimingMetadata,
  TimingPlan,
  TypecheckStrategy,
} from "./fixture-catalog.ts";

/**
 * The ordered plans the gates run.
 *
 * Every plan is a projection of the derived catalog: which fixtures a timing
 * plan measures and under which ceilings, which fixtures the conformance and
 * type-check runs cover, and which warning oracles are refreshed together.
 * Nothing here restates the fixture tree, and nothing here re-validates it:
 * the catalog validates itself once when its module loads.
 */

export type TimingFixture = {
  readonly fixture: string;
  readonly file: string;
  readonly oracleFile: "output.json" | "output.tsgo.json";
  readonly warningOracle: "warnings.tsgo.json";
};

export type BoundaryTimingFixture = TimingFixture & {
  readonly maxFetchedToMaterializedRatio: number;
  readonly maxRequestCount: number;
  readonly maxBytesReceived: number;
  readonly bytesReceivedPathLengthHeadroom?: number;
};

export type ConformanceTimingFixture = TimingFixture;

export type ExternalSelectionTimingFixture = {
  readonly fixture: string;
  readonly file: string;
  readonly maxRequestCount: number;
  readonly maxBytesReceived: number;
};

type TimingPlanResult = {
  readonly issue02: BoundaryTimingFixture;
  readonly issue14: ConformanceTimingFixture;
  readonly externalSelection: ExternalSelectionTimingFixture;
};

/** Orders one plan's entries and rejects duplicate or negative positions. */
export function orderedView<T extends { readonly order: number }>(
  values: readonly T[],
  label: string
): readonly T[] {
  const result = [...values].sort((left, right) => left.order - right.order);
  if (
    result.some((entry) => !Number.isSafeInteger(entry.order) || entry.order < 0) ||
    new Set(result.map((entry) => entry.order)).size !== result.length
  ) {
    throw new Error(`${label} must have unique non-negative ordering.`);
  }
  return result;
}

export function boundaryTimingBudget(metadata: BoundaryTimingMetadata) {
  if (metadata.bytesReceivedPathLengthHeadroom === undefined) {
    return {
      maxFetchedToMaterializedRatio: metadata.maxFetchedToMaterializedRatio,
      maxRequestCount: metadata.maxRequestCount,
      maxBytesReceived: metadata.maxBytesReceived,
    };
  }
  return {
    maxFetchedToMaterializedRatio: metadata.maxFetchedToMaterializedRatio,
    maxRequestCount: metadata.maxRequestCount,
    maxBytesReceived: metadata.maxBytesReceived,
    bytesReceivedPathLengthHeadroom: metadata.bytesReceivedPathLengthHeadroom,
  };
}

export function deriveTimingPlan<Plan extends TimingPlan>(
  catalog: readonly FixtureEvidenceRecord[],
  plan: Plan
): readonly TimingPlanResult[Plan][] {
  const fixtures: Array<
    (BoundaryTimingFixture | ConformanceTimingFixture | ExternalSelectionTimingFixture) & { order: number }
  > = [];
  for (const record of catalog) {
    for (const entry of record.timing) {
      if (entry.plan !== plan) continue;
      if (entry.plan === "externalSelection") {
        fixtures.push({
          fixture: record.id,
          file: record.input.file,
          maxRequestCount: entry.maxRequestCount,
          maxBytesReceived: entry.maxBytesReceived,
          order: entry.order,
        });
        continue;
      }
      if (record.oracle.selectedFile === null || record.warnings.oracleFile === null) {
        throw new Error(`Fixture ${record.id} has incomplete ${entry.plan} timing evidence.`);
      }
      if (entry.plan === "issue02") {
        fixtures.push({
          fixture: record.id,
          file: record.input.file,
          oracleFile: record.oracle.selectedFile,
          warningOracle: record.warnings.oracleFile,
          ...boundaryTimingBudget(entry),
          order: entry.order,
        });
        continue;
      }
      fixtures.push({
        fixture: record.id,
        file: record.input.file,
        oracleFile: record.oracle.selectedFile,
        warningOracle: record.warnings.oracleFile,
        order: entry.order,
      });
    }
  }
  return orderedView(fixtures, `${plan} timing plan`).map(
    ({ order: _order, ...fixture }) =>
      // SAFETY: `plan` selects one TimingPlanResult member; the loop above only pushes that member.
      fixture as TimingPlanResult[Plan]
  );
}

export const boundaryTimingFixtures = deriveTimingPlan(fixtureEvidenceCatalog, "issue02");
export const conformanceTimingFixtures = deriveTimingPlan(fixtureEvidenceCatalog, "issue14");
export const externalSelectionTimingFixtures = deriveTimingPlan(fixtureEvidenceCatalog, "externalSelection");

export type ConformanceFixture = {
  readonly fixture: string;
  readonly file: string;
  readonly disposition: ConformanceDisposition;
};

export function deriveConformancePlan(
  catalog: readonly FixtureEvidenceRecord[]
): readonly ConformanceFixture[] {
  return catalog.flatMap((record) =>
    record.conformance === false
      ? []
      : [{ fixture: record.id, file: record.input.file, disposition: record.conformance.disposition }]
  );
}

export const conformanceFixtureManifest = deriveConformancePlan(fixtureEvidenceCatalog);

export function deriveTypecheckPlan(catalog: readonly FixtureEvidenceRecord[]): readonly {
  readonly fixture: string;
  readonly file: string;
  readonly strategy: Exclude<TypecheckStrategy, "not-applicable">;
}[] {
  return catalog.flatMap((record) => {
    if (record.conformance === false) return [];
    if (record.typecheck.strategy === "not-applicable") {
      throw new Error(`Conformance fixture ${record.id} is missing its type-check strategy.`);
    }
    return [{ fixture: record.id, file: record.input.file, strategy: record.typecheck.strategy }];
  });
}

export const conformanceTypecheckPlan = deriveTypecheckPlan(fixtureEvidenceCatalog);

/** Every type-checkable fixture project, in path order, minus the recorded exclusions. */
export function deriveTypecheckProjects(root: string, budgets: FixtureBudgets): readonly string[] {
  const projects: string[] = [];
  const walk = (directory: string, relative: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(join(directory, entry.name), child);
        continue;
      }
      if (!entry.name.endsWith("tsconfig.json")) continue;
      if (budgets.excludedTypecheckProjects.includes(child)) continue;
      projects.push(`test/fixtures/${child}`);
    }
  };
  walk(root, "");
  return projects.sort();
}

/** Every fixture project the package type-check gate compiles, in path order. */
export const packageFixtureTypecheckPlan: readonly { readonly project: string }[] = deriveTypecheckProjects(
  fixtureTreeRoot,
  fixtureBudgets
).map((project) => ({ project }));

export function deriveWarningEvidencePlan(catalog: readonly FixtureEvidenceRecord[]): readonly {
  readonly fixture: string;
  readonly oracleFile: "warnings.tsgo.json";
  readonly codes: readonly string[];
}[] {
  return catalog.flatMap((record) =>
    record.warnings.oracleFile === null
      ? []
      : [{ fixture: record.id, oracleFile: record.warnings.oracleFile, codes: record.warnings.codes }]
  );
}

/**
 * The warning codes each fixture's oracle records, keyed by fixture.
 *
 * Every catalogued fixture has an entry: a fixture with no warning oracle
 * expects no warnings, and that absence is itself the evidence.
 */
export const expectedFixtureWarnings: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  fixtureEvidenceCatalog.map((record) => [record.id, record.warnings.codes])
);

export function expectedWarningCodes(
  plan: Readonly<Record<string, readonly string[]>>,
  fixture: string
): readonly string[] {
  const codes = plan[fixture];
  if (codes === undefined) throw new Error(`Missing warning evidence for fixture ${fixture}.`);
  return codes;
}

export type SupplementalBoundaryFixture = {
  readonly fixture: string;
  readonly file: string;
  readonly expectedExports: readonly string[];
};

/**
 * The boundary plan's public-seam regressions: module shapes with no upstream
 * oracle whose exported names are the assertion. The expectation is the
 * plan's, not the fixture tree's, so it is stated here.
 */
export const boundarySupplementalFixtures: readonly SupplementalBoundaryFixture[] = [
  {
    fixture: "module-dts-type-star",
    file: "input.d.ts",
    expectedExports: ["RuntimeValue", "Value", "OtherValue"],
  },
  { fixture: "module-resolution-alias", file: "input.d.ts", expectedExports: ["RuntimeValue", "AliasValue"] },
  {
    fixture: "module-resolution-package",
    file: "input.d.ts",
    expectedExports: ["RuntimeValue", "PackageValue"],
  },
];

export function derivePackageExecutionPlan(catalog: readonly FixtureEvidenceRecord[]): readonly {
  readonly fixture: string;
  readonly input: string;
  readonly conformance: boolean;
  readonly typecheck: TypecheckStrategy;
  readonly timing: readonly TimingPlan[];
  readonly warningEvidence: boolean;
}[] {
  return catalog.map((record) => ({
    fixture: record.id,
    input: record.input.file,
    conformance: record.conformance !== false,
    typecheck: record.typecheck.strategy,
    timing: record.timing.map((entry) => entry.plan),
    warningEvidence: record.warnings.oracleFile !== null,
  }));
}

export const packageFixtureExecutionPlan = derivePackageExecutionPlan(fixtureEvidenceCatalog);
