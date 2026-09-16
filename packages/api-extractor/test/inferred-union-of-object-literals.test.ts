import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import type { ExtractionResult } from "../src/index.ts";
import { exportedType } from "./support/exports.ts";
import { extractFixture } from "./support/extract.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/inferred-union-of-object-literals");

let result: ExtractionResult;

beforeAll(async () => {
  result = await extractFixture(
    { tsconfigPath: resolve(fixtureDirectory, "tsconfig.json") },
    resolve(fixtureDirectory, "input.ts")
  );
});

describe("Inferred union member resolution", () => {
  it("describes anonymous object members instead of degrading them to any", () => {
    const union = exportedType(result, "union");
    if (union.kind !== "union") throw new Error("The union export did not resolve to a union");

    expect(union.types).toEqual([
      {
        kind: "object",
        properties: [
          { name: "a", type: { kind: "intrinsic", intrinsic: "number" }, optional: false },
          { name: "b", type: { kind: "intrinsic", intrinsic: "undefined" }, optional: true },
        ],
      },
      {
        kind: "object",
        properties: [
          { name: "a", type: { kind: "intrinsic", intrinsic: "undefined" }, optional: true },
          { name: "b", type: { kind: "intrinsic", intrinsic: "string" }, optional: false },
        ],
      },
    ]);
    expect(result.warnings).toEqual([]);
  });
});
