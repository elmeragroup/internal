import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { readFixtureOracle } from "../scripts/fixture-evidence.ts";
import { extractFixture, fixtureRoot } from "./support/extract.ts";

const fixtureDirectory = resolve(fixtureRoot, "render-prop-union");
const tsconfigPath = resolve(fixtureDirectory, "tsconfig.json");
const inputPath = resolve(fixtureDirectory, "input.tsx");

describe("Base UI render-prop unions", () => {
  it("renders ComponentRenderFn | ReactElement members as external references, without falling back", async () => {
    const result = await extractFixture({ tsconfigPath }, inputPath);
    const entry = result.module.exports.find((candidate) => candidate.name === "Label");
    if (entry?.type.kind !== "component") throw new Error("Expected Label to be a component");
    const render = entry.type.props.find((property) => property.name === "render");
    if (render?.type.kind !== "union") throw new Error("Expected render to be a union");

    const memberNames = render.type.types.map((member) => {
      if (member.kind === "external") return member.typeName.name;
      if (member.kind === "intrinsic") return member.intrinsic;
      return member.kind;
    });
    expect(memberNames).toEqual(["ReactElement", "ComponentRenderFn", "undefined"]);
    expect(render.optional).toBe(true);
    expect(result.warnings.filter((warning) => warning.code === "unsupported-type-fallback")).toEqual([]);
    expect(result.module).toEqual(readFixtureOracle("render-prop-union", "output.json"));
  });
});
