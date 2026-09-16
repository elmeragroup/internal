import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import type { ExtractionResult, SemanticType } from "../src/index.ts";
import { extractFixture } from "./support/extract.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/inferred-array-of-object-literals");

let result: ExtractionResult;

beforeAll(async () => {
  result = await extractFixture(
    { tsconfigPath: resolve(fixtureDirectory, "tsconfig.json") },
    resolve(fixtureDirectory, "input.ts")
  );
});

function exportedType(name: string): SemanticType {
  const entry = result.module.exports.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`The fixture does not export ${name}`);
  return entry.type;
}

function firstReturnValue(functionName: string): SemanticType {
  const type = exportedType(functionName);
  if (type.kind !== "function" || type.callSignatures[0] === undefined) {
    throw new Error(`${functionName} is not a callable export`);
  }
  return type.callSignatures[0].returnValueType;
}

describe("Inferred container element resolution", () => {
  it("describes an anonymous root-level array element like the same shape in return position", () => {
    const values = exportedType("values");
    const returned = firstReturnValue("returnsArray");
    if (values.kind !== "array" || returned.kind !== "array") {
      throw new Error("Both shapes must resolve to arrays.");
    }
    expect(values.elementType).toEqual(returned.elementType);
    expect(values.elementType).toEqual(firstReturnValue("returnsObject"));
    expect(result.warnings).toEqual([]);
  });
});
