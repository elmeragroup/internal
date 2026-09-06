import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertFixtureOracle,
  assertSupplementalFixture,
  fixtureInputPath,
  boundarySupplementalFixtures,
  boundaryTimingFixtures,
} from "../scripts/fixture-evidence.ts";
import { extractFixture } from "./support/extract.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures");
const tsconfigPath = resolve(fixtureDirectory, "timing-boundary-tsconfig.json");

describe("Issue 02 ProjectExtractor conformance", () => {
  it.each(boundaryTimingFixtures.slice(0, 3))(
    "matches the immutable upstream oracle for $fixture",
    async (definition) => {
      assertFixtureOracle(definition, await extractFixture({ tsconfigPath }, fixtureInputPath(definition)));
    }
  );

  it("matches the complete reviewed TS7 component oracle and warning oracle", async () => {
    const definition = boundaryTimingFixtures[3];
    if (definition === undefined) throw new Error("Missing reviewed Issue 02 timing fixture.");
    const result = await extractFixture({ tsconfigPath }, fixtureInputPath(definition));
    assertFixtureOracle(definition, result);
  });

  it.each(boundarySupplementalFixtures)(
    "preserves the public module-resolution seam for $fixture",
    async (definition) => {
      const result = await extractFixture({ tsconfigPath }, fixtureInputPath(definition));
      assertSupplementalFixture(definition, result);
      expect(result.warnings).toEqual([]);
    }
  );
});
