import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import type { ExtractionResult } from "../src/index.ts";
import { exportedType } from "./support/exports.ts";
import { extractFixture } from "./support/extract.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/merged-namespace-order");

let result: ExtractionResult;

beforeAll(async () => {
  result = await extractFixture(
    { tsconfigPath: resolve(fixtureDirectory, "tsconfig.json") },
    resolve(fixtureDirectory, "input.ts")
  );
});

function namesUnder(prefix: string): readonly string[] {
  return result.module.exports
    .map((entry) => entry.name)
    .filter((name) => name === prefix || name.startsWith(`${prefix}.`))
    .map((name) => name.slice(prefix.length))
    .sort();
}

describe("Merged value and namespace exports", () => {
  it("contributes the value descriptor whichever declaration comes first", () => {
    // The only legal namespace-first merge is with an enum; function and class
    // merges must be declared value-first. Literal names are the oracle.
    expect(namesUnder("EnumNamespaceFirst")).toEqual(["", ".A", ".member"]);
    expect(namesUnder("EnumValueFirst")).toEqual(["", ".A", ".member"]);
    expect(namesUnder("ValueFirst")).toEqual(["", ".member"]);
    expect(namesUnder("ClassValueFirst")).toEqual(["", ".member", ".prototype"]);

    // The enum reports both its own member and the namespace's const, in the
    // checker's declaration order for each merge form.
    expect(exportedType(result, "EnumNamespaceFirst")).toMatchObject({
      kind: "enum",
      members: [
        { name: "member", value: 1 },
        { name: "A", value: 0 },
      ],
    });
    expect(exportedType(result, "EnumValueFirst")).toMatchObject({
      kind: "enum",
      members: [
        { name: "A", value: 0 },
        { name: "member", value: 1 },
      ],
    });
    expect(exportedType(result, "ValueFirst")).toMatchObject({ kind: "function" });
    expect(exportedType(result, "ClassValueFirst")).toMatchObject({ kind: "class" });
  });
});
