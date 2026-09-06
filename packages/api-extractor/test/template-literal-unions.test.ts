import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { readFixtureOracle } from "../scripts/fixture-evidence.ts";
import { extractFixture, fixtureRoot } from "./support/extract.ts";

const fixtureDirectory = resolve(fixtureRoot, "template-literal-union-prop");
const tsconfigPath = resolve(fixtureDirectory, "tsconfig.json");
const inputPath = resolve(fixtureDirectory, "input.tsx");

const autocompleteUnion = {
  kind: "union",
  types: [
    { kind: "literal", value: '"on"' },
    { kind: "literal", value: '"off"' },
    { kind: "literal", value: "`section-${string}`" },
    { kind: "literal", value: "`shipping ${string}`" },
  ],
} as const;

describe("template-literal string unions", () => {
  it("extracts a template-literal union prop as a union of template-literal strings in source order", async () => {
    const result = await extractFixture({ tsconfigPath }, inputPath);
    const entry = result.module.exports.find((candidate) => candidate.name === "PhoneField");
    if (entry?.type.kind !== "component") throw new Error("Expected PhoneField to be a component");
    const autocomplete = entry.type.props.find((property) => property.name === "autocomplete");

    expect(autocomplete).toEqual({
      name: "autocomplete",
      optional: false,
      type: autocompleteUnion,
    });
    expect(result.warnings.filter((warning) => warning.code === "unsupported-type-fallback")).toEqual([]);
    expect(result.module).toEqual(readFixtureOracle("template-literal-union-prop", "output.json"));
  });
});
