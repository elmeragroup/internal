import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import type { ExtractionResult, SemanticType } from "../src/index.ts";
import { exportedType } from "./support/exports.ts";
import { extractFixture } from "./support/extract.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/inferred-array-of-object-literals");

let result: ExtractionResult;

beforeAll(async () => {
  result = await extractFixture(
    { tsconfigPath: resolve(fixtureDirectory, "tsconfig.json") },
    resolve(fixtureDirectory, "input.ts")
  );
});

function firstReturnValue(functionName: string): SemanticType {
  const type = exportedType(result, functionName);
  if (type.kind !== "function" || type.callSignatures[0] === undefined) {
    throw new Error(`${functionName} is not a callable export`);
  }
  return type.callSignatures[0].returnValueType;
}

describe("Inferred container element resolution", () => {
  it("describes an anonymous root-level array element like the same shape in return position", () => {
    const values = exportedType(result, "values");
    if (values.kind !== "array") throw new Error("values must resolve to an array");

    // The literal shape is the regression oracle: the element is a described
    // object, never the anonymous module-value fallback.
    expect(values.elementType).toEqual({
      kind: "object",
      properties: [{ name: "a", type: { kind: "intrinsic", intrinsic: "number" }, optional: false }],
    });

    // The same shape in return position resolves identically, so the container
    // position cannot drift from the return position.
    const returned = firstReturnValue("returnsArray");
    if (returned.kind !== "array") throw new Error("returnsArray must return an array");
    expect(values.elementType).toEqual(returned.elementType);
    expect(values.elementType).toEqual(firstReturnValue("returnsObject"));
    expect(result.warnings).toEqual([]);
  });
});
