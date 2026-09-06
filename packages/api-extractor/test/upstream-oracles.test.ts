import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertReactDivergenceEvidence,
  assertTs7DivergenceEvidence,
  canonicalDifferencePaths,
  readFixtureOracle,
} from "../scripts/fixture-evidence.ts";
import { referenceAvailable, upstreamFixtureRoot } from "../scripts/reference.ts";
import { extractFixture, fixtureRoot } from "./support/extract.ts";
import {
  callableFixtures,
  canonicalizationFixtures,
  containerFixtures,
  externalTypeFixtures,
  genericFixtures,
  mappedTypeFixtures,
  moduleSurfaceFixtures,
  objectApiFixtures,
  reactRecognitionFixtures,
  reactWrapperFixtures,
  typeOperatorFixtures,
} from "./support/fixture-suites.ts";

type Oracle = "immutable-upstream" | "reviewed-ts7";

type UpstreamFixture = {
  readonly fixture: string;
  readonly file: string;
  readonly oracle: Oracle;
  readonly family: string | undefined;
};

/**
 * One ported upstream fixture family. Every family shares the same evidence
 * contract: copied inputs and oracles stay byte-identical to the pinned
 * upstream commit, each extraction reproduces its oracle, immutable oracles
 * show zero canonical leaf differences, and every reviewed TS7 divergence
 * carries its evidence record. Issue-specific behaviour lives in the
 * behaviour-named suites, not here.
 */
type UpstreamSuite = {
  readonly label: string;
  readonly tsconfig: string;
  readonly fixtures: readonly UpstreamFixture[];
  /** Sorted family names the fixture set must cover; omitted when the view has no grouping. */
  readonly families?: readonly string[];
  readonly totals: { readonly total: number; readonly reviewedDivergences: number };
  /** Families whose fixtures emit structured warnings assert them in their own suite. */
  readonly recoverableWarnings: "none" | "asserted-elsewhere";
};

function normalize(
  records: readonly {
    readonly fixture: string;
    readonly file: string;
    readonly oracle?: Oracle;
    readonly family?: string;
    readonly container?: string;
  }[]
): readonly UpstreamFixture[] {
  return records.map((record) => ({
    fixture: record.fixture,
    file: record.file,
    oracle: record.oracle ?? "immutable-upstream",
    family: record.family ?? record.container,
  }));
}

const suites: readonly UpstreamSuite[] = [
  {
    label: "Object and enum API surfaces",
    tsconfig: "object-api-tsconfig.json",
    fixtures: normalize(objectApiFixtures),
    totals: { total: 5, reviewedDivergences: 0 },
    recoverableWarnings: "none",
  },
  {
    label: "Unions, intersections and canonical ordering",
    tsconfig: "canonicalization-tsconfig.json",
    fixtures: normalize(canonicalizationFixtures),
    totals: { total: 12, reviewedDivergences: 1 },
    recoverableWarnings: "none",
  },
  {
    label: "Containers",
    tsconfig: "containers-tsconfig.json",
    fixtures: normalize(containerFixtures),
    families: ["array", "indexSignature", "mappedKey", "readonlyArray", "record", "recursive", "tuple"],
    totals: { total: 25, reviewedDivergences: 0 },
    recoverableWarnings: "none",
  },
  {
    label: "Classes and callables",
    tsconfig: "classes-and-callables-tsconfig.json",
    fixtures: normalize(callableFixtures),
    families: ["callable", "class", "method", "overload"],
    totals: { total: 9, reviewedDivergences: 0 },
    recoverableWarnings: "asserted-elsewhere",
  },
  {
    label: "Generics and aliases",
    tsconfig: "generics-tsconfig.json",
    fixtures: normalize(genericFixtures),
    families: [
      "alias",
      "constraint",
      "deduplication",
      "default",
      "method",
      "renaming",
      "shadowing",
      "substitution",
    ],
    totals: { total: 14, reviewedDivergences: 1 },
    recoverableWarnings: "none",
  },
  {
    label: "Mapped types",
    tsconfig: "mapped-types-tsconfig.json",
    fixtures: normalize(mappedTypeFixtures),
    families: ["external", "modifiers", "openDomain"],
    totals: { total: 3, reviewedDivergences: 0 },
    recoverableWarnings: "none",
  },
  {
    label: "Preserved type operators",
    tsconfig: "type-operators-tsconfig.json",
    fixtures: normalize(typeOperatorFixtures),
    families: ["alias", "conditional", "indexedAccess", "keyof"],
    totals: { total: 5, reviewedDivergences: 1 },
    recoverableWarnings: "none",
  },
  {
    label: "Module surface",
    tsconfig: "module-surface-tsconfig.json",
    fixtures: normalize(moduleSurfaceFixtures),
    families: ["mergedDeclarations", "namespaces", "reexports"],
    totals: { total: 5, reviewedDivergences: 1 },
    recoverableWarnings: "none",
  },
  {
    label: "React component recognition",
    tsconfig: "react-recognition-tsconfig.json",
    fixtures: normalize(reactRecognitionFixtures),
    families: ["componentOverloads", "declaration", "hooks", "props", "returnTypes", "variable"],
    totals: { total: 10, reviewedDivergences: 0 },
    recoverableWarnings: "none",
  },
  {
    label: "Wrapped React components",
    tsconfig: "react-origin-tsconfig.json",
    fixtures: normalize(reactWrapperFixtures),
    totals: {
      total: 4,
      reviewedDivergences: reactWrapperFixtures.filter((f) => f.oracle === "reviewed-ts7").length,
    },
    recoverableWarnings: "asserted-elsewhere",
  },
  {
    label: "External types",
    tsconfig: "external-types-tsconfig.json",
    fixtures: normalize(externalTypeFixtures),
    families: [
      "componentUnions",
      "exportForms",
      "externalConditional",
      "externalUnions",
      "handlers",
      "heritageOmit",
      "hooks",
      "namespaceSpecialization",
      "overloadDeduplication",
      "reexportNamespaces",
      "reexportTracking",
      "refs",
      "renderCallbacks",
    ],
    totals: { total: 15, reviewedDivergences: 9 },
    recoverableWarnings: "asserted-elsewhere",
  },
];

function oracleFile(definition: UpstreamFixture): string {
  return definition.oracle === "immutable-upstream" ? "output.json" : "output.tsgo.json";
}

function readJson(fixture: string, file: string): Schema.Json {
  return Schema.decodeUnknownSync(Schema.Json)(
    JSON.parse(readFileSync(resolve(fixtureRoot, fixture, file), "utf8"))
  );
}

for (const suite of suites) {
  const tsconfigPath = resolve(fixtureRoot, suite.tsconfig);
  const extract = (definition: UpstreamFixture) =>
    extractFixture({ tsconfigPath }, resolve(fixtureRoot, definition.fixture, definition.file));

  describe(`${suite.label}: ported upstream fixtures`, () => {
    it("keeps every copied input and upstream oracle byte-identical to e145350", () => {
      if (!referenceAvailable) return;
      for (const definition of suite.fixtures) {
        for (const file of [definition.file, "output.json"]) {
          expect(readFileSync(resolve(fixtureRoot, definition.fixture, file), "utf8")).toBe(
            readFileSync(resolve(upstreamFixtureRoot, definition.fixture, file), "utf8")
          );
        }
      }
    });

    it.each(suite.fixtures.map((definition) => [definition] as const))(
      "matches the $0.oracle oracle for $0.fixture",
      async (definition) => {
        const result = await extract(definition);
        expect(result.module).toEqual(readFixtureOracle(definition.fixture, oracleFile(definition)));
      }
    );

    it("has an exact zero-leaf-difference record for every immutable upstream oracle", async () => {
      for (const definition of suite.fixtures) {
        if (definition.oracle !== "immutable-upstream") continue;
        const result = await extract(definition);
        const actual = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(result.module)));
        expect(canonicalDifferencePaths(readJson(definition.fixture, "output.json"), actual)).toEqual([]);
      }
    });

    it("keeps every reviewed TS7 divergence tied to its preserved upstream oracle", () => {
      const divergent = suite.fixtures.filter((definition) => definition.oracle === "reviewed-ts7");
      expect(divergent).toHaveLength(suite.totals.reviewedDivergences);
      for (const definition of divergent) {
        expect(() => assertTs7DivergenceEvidence(definition.fixture)).not.toThrow();
      }
    });

    if (suite.recoverableWarnings === "none") {
      it("emits no recoverable warnings for the ported family", async () => {
        for (const definition of suite.fixtures) {
          const result = await extract(definition);
          expect(result.warnings).toEqual([]);
        }
      });
    }

    it("covers every family with at least one ported fixture and reports the ported totals", () => {
      if (suite.families !== undefined) {
        const families = new Set(suite.fixtures.map((definition) => definition.family ?? "<none>"));
        expect([...families].sort((left, right) => left.localeCompare(right))).toEqual(suite.families);
      }
      const reviewed = suite.fixtures.filter((definition) => definition.oracle === "reviewed-ts7");
      expect({ total: suite.fixtures.length, reviewedDivergences: reviewed.length }).toEqual(suite.totals);
    });
  });
}

describe("Base UI compound divergence evidence", () => {
  it("keeps the reviewed React divergence digest tied to its preserved upstream oracle", () => {
    expect(() => assertReactDivergenceEvidence()).not.toThrow();
  });
});
