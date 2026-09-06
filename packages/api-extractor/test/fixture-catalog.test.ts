import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { readIssue14ConformanceReport } from "../scripts/conformance/report.ts";
import {
  deriveFixtureCatalog,
  fixtureBudgets,
  fixtureDirectories,
  fixtureEvidenceCatalog,
  readFixtureBudgets,
  validateFixtureEvidenceCatalog,
} from "../scripts/fixture-catalog.ts";
import type { FixtureBudgets, FixtureEvidenceRecord } from "../scripts/fixture-catalog.ts";
import {
  deriveConformancePlan,
  deriveTypecheckProjects,
  externalSelectionTimingFixtures,
  boundaryTimingFixtures,
  conformanceFixtureManifest,
  conformanceTimingFixtures,
  conformanceTypecheckPlan,
  packageFixtureTypecheckPlan,
} from "../scripts/fixture-plans.ts";
import { createTemporaryRoot, fixtureRoot } from "./support/temp-dirs.ts";

const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

const emptyBudgets: FixtureBudgets = {
  timing: { boundary: [], externalSelection: [] },
  virtualUpstreamDependency: [],
  locallyGeneratedOracles: [],
  excludedTypecheckProjects: [],
};

/** Writes one fixture tree on disk: the input the catalog derives every record from. */
function writeFixtureTree(files: Readonly<Record<string, string>>): string {
  const root = createTemporaryRoot("api-extractor-fixture-tree-");
  temporaryRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(resolve(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

const warningOracle = JSON.stringify([
  { code: "unresolved-re-export", message: "first" },
  { code: "omitted-index-signature", message: "second" },
]);

describe("fixture catalog derivation", () => {
  it("derives a record for every directory holding an input file", () => {
    const root = writeFixtureTree({
      "plain-regression/input.ts": "export const value = 1;\n",
      "plain-regression/tsconfig.json": "{}",
      "ported-fixture/input.tsx": "export const component = 1;\n",
      "ported-fixture/output.json": "{}",
      "reviewed-divergence/input.ts": "export const value = 2;\n",
      "reviewed-divergence/output.json": "{}",
      "reviewed-divergence/output.tsgo.json": '{"kind":"module"}',
      "reviewed-divergence/ts7-oracle.json": "{}",
      "reviewed-divergence/warnings.tsgo.json": warningOracle,
      "not-a-fixture/notes.md": "no input file here\n",
      "fixtures.json": JSON.stringify(emptyBudgets),
    });

    const catalog = deriveFixtureCatalog(root, emptyBudgets);

    expect(fixtureDirectories(root).map((entry) => entry.id)).toEqual([
      "plain-regression",
      "ported-fixture",
      "reviewed-divergence",
    ]);
    expect(catalog.map((record) => [record.id, record.input.file])).toEqual([
      ["plain-regression", "input.ts"],
      ["ported-fixture", "input.tsx"],
      ["reviewed-divergence", "input.ts"],
    ]);
    expect(catalog.map((record) => record.conformance)).toEqual([
      false,
      { evidenceId: "ported-fixture/conformance", disposition: "unchanged" },
      { evidenceId: "reviewed-divergence/conformance", disposition: "reviewed-ts7" },
    ]);
    expect(catalog.map((record) => record.oracle.disposition)).toEqual([
      "not-applicable",
      "immutable-upstream",
      "reviewed-divergence",
    ]);
    expect(catalog.map((record) => record.oracle.selectedFile)).toEqual([
      null,
      "output.json",
      "output.tsgo.json",
    ]);
    expect(catalog.map((record) => record.typecheck.strategy)).toEqual([
      "not-applicable",
      "direct-input",
      "direct-input",
    ]);
    expect(catalog.at(-1)?.warnings).toEqual({
      oracleFile: "warnings.tsgo.json",
      codes: ["unresolved-re-export", "omitted-index-signature"],
    });
    expect(() => validateFixtureEvidenceCatalog(catalog)).not.toThrow();
  });

  it("takes ceilings, virtual dependencies and local oracles from the budgets file", () => {
    const budgets: FixtureBudgets = {
      timing: {
        boundary: [
          {
            fixture: "timed",
            maxFetchedToMaterializedRatio: 2,
            maxRequestCount: 10,
            maxBytesReceived: 20,
            bytesReceivedPathLengthHeadroom: 30,
          },
        ],
        externalSelection: [{ fixture: "selected", maxRequestCount: 40, maxBytesReceived: 50 }],
      },
      virtualUpstreamDependency: ["virtual"],
      locallyGeneratedOracles: ["local-oracle"],
      excludedTypecheckProjects: ["skipped/tsconfig.json"],
    };
    const root = writeFixtureTree({
      "fixtures.json": JSON.stringify(budgets),
      "timed/input.ts": "export const value = 1;\n",
      "timed/output.json": "{}",
      "timed/warnings.tsgo.json": "[]",
      "timed/tsconfig.json": "{}",
      "selected/input.ts": "export const value = 2;\n",
      "virtual/input.ts": "export const value = 3;\n",
      "virtual/output.json": "{}",
      "local-oracle/input.ts": "export const value = 4;\n",
      "local-oracle/output.json": "{}",
      "skipped/input.ts": "export const value = 5;\n",
      "skipped/tsconfig.json": "{}",
    });

    expect(readFixtureBudgets(root)).toEqual(budgets);
    const catalog = deriveFixtureCatalog(root, budgets);
    const byId = new Map(catalog.map((record) => [record.id, record]));

    expect(byId.get("timed")?.timing).toEqual([
      {
        plan: "issue02",
        order: 0,
        maxFetchedToMaterializedRatio: 2,
        maxRequestCount: 10,
        maxBytesReceived: 20,
        bytesReceivedPathLengthHeadroom: 30,
      },
      { plan: "issue14", order: 0 },
    ]);
    expect(byId.get("selected")?.timing).toEqual([
      { plan: "externalSelection", order: 0, maxRequestCount: 40, maxBytesReceived: 50 },
    ]);
    expect(byId.get("virtual")?.typecheck.strategy).toBe("virtual-upstream-dependency");
    expect(byId.get("local-oracle")?.conformance).toBe(false);
    expect(byId.get("local-oracle")?.oracle.disposition).toBe("generated");
    expect(deriveTypecheckProjects(root, budgets)).toEqual(["test/fixtures/timed/tsconfig.json"]);
  });

  it("rejects records that break the evidence contract", () => {
    const [first, second] = fixtureEvidenceCatalog;
    if (first === undefined || second === undefined) throw new Error("Missing catalog records.");

    const duplicate: FixtureEvidenceRecord = { ...second, id: first.id, evidence: first.evidence };
    expect(() => validateFixtureEvidenceCatalog([first, duplicate])).toThrow(/stable fixture-identity/u);
    expect(() => validateFixtureEvidenceCatalog([...fixtureEvidenceCatalog].reverse())).toThrow(
      /stable fixture-identity/u
    );

    const escapedInput: FixtureEvidenceRecord = {
      ...first,
      input: { id: `${first.id}/../input.ts`, file: "../input.ts" },
    };
    expect(() => validateFixtureEvidenceCatalog([escapedInput])).toThrow(/invalid fixture-local input file/u);

    const missingEvidence: FixtureEvidenceRecord = {
      ...first,
      evidence: { ...first.evidence, id: "missing/conformance" },
    };
    expect(() => validateFixtureEvidenceCatalog([missingEvidence])).toThrow(/missing conformance evidence/u);

    const reviewed = fixtureEvidenceCatalog.find(
      (record) => record.conformance !== false && record.conformance.disposition === "reviewed-ts7"
    );
    if (reviewed === undefined || reviewed.conformance === false) {
      throw new Error("Missing representative reviewed fixture.");
    }
    const incompatible: FixtureEvidenceRecord = {
      ...reviewed,
      conformance: { ...reviewed.conformance, disposition: "unchanged" },
    };
    expect(() => validateFixtureEvidenceCatalog([incompatible])).toThrow(/incompatible oracle disposition/u);
  });
});

describe("the package's own fixture catalog", () => {
  it("matches the stored conformance identity, classification and order", () => {
    const stored = readIssue14ConformanceReport();
    expect(deriveConformancePlan(fixtureEvidenceCatalog)).toEqual(
      stored.fixtures.map((fixture) => ({
        fixture: fixture.fixture,
        file: fixture.input,
        disposition: fixture.disposition,
      }))
    );
    expect(conformanceFixtureManifest).toHaveLength(116);
    expect(conformanceTypecheckPlan).toHaveLength(116);
    expect(
      fixtureEvidenceCatalog.filter((record) => record.oracle.disposition === "reviewed-divergence")
    ).toHaveLength(19);
    expect(
      fixtureEvidenceCatalog.filter((record) => record.evidence.origin === "pinned-upstream")
    ).toHaveLength(116);
  });

  it("derives every timing plan from the recorded ceilings", () => {
    const boundaryFixtures = fixtureBudgets.timing.boundary.map((entry) => entry.fixture);
    expect(boundaryTimingFixtures.map((entry) => entry.fixture)).toEqual(boundaryFixtures);
    expect(conformanceTimingFixtures.map((entry) => entry.fixture)).toEqual(boundaryFixtures);
    expect(externalSelectionTimingFixtures.map((entry) => entry.fixture)).toEqual(
      fixtureBudgets.timing.externalSelection.map((entry) => entry.fixture)
    );
    for (const entry of boundaryTimingFixtures) {
      const budget = fixtureBudgets.timing.boundary.find((row) => row.fixture === entry.fixture);
      expect(entry.maxRequestCount).toBe(budget?.maxRequestCount);
      expect(entry.maxBytesReceived).toBe(budget?.maxBytesReceived);
      expect(entry.maxFetchedToMaterializedRatio).toBe(budget?.maxFetchedToMaterializedRatio);
      expect(entry.oracleFile).toMatch(/^output(?:\.tsgo)?\.json$/u);
      expect(entry.warningOracle).toBe("warnings.tsgo.json");
    }
  });

  it("type-checks every fixture project except the recorded exclusions", () => {
    const projects = packageFixtureTypecheckPlan.map((entry) => entry.project);
    expect(projects).toEqual([...projects].sort());
    expect(new Set(projects).size).toBe(projects.length);
    expect(projects).toContain("test/fixtures/timing-boundary-tsconfig.json");
    for (const excluded of fixtureBudgets.excludedTypecheckProjects) {
      expect(projects).not.toContain(`test/fixtures/${excluded}`);
    }
    for (const project of projects) {
      expect(existsSync(resolve(fixtureRoot, "../..", project))).toBe(true);
    }
  });

  it("pairs every output.tsgo.json with a reviewed ts7-oracle.json reason", () => {
    const unpaired: string[] = [];
    const duplicates: string[] = [];
    for (const record of fixtureEvidenceCatalog) {
      const selected = join(fixtureRoot, record.id, "output.tsgo.json");
      if (!existsSync(selected)) continue;
      if (record.oracle.divergenceRecord !== "ts7-oracle.json") unpaired.push(record.id);
      const upstream = join(fixtureRoot, record.id, "output.json");
      if (existsSync(upstream) && readFileSync(upstream, "utf8") === readFileSync(selected, "utf8")) {
        duplicates.push(record.id);
      }
    }
    expect(unpaired).toEqual([]);
    expect(duplicates).toEqual([]);
  });
});
