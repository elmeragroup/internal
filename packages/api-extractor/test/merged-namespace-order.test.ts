import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import type { ExtractionResult } from "../src/index.ts";
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

function exportedType(name: string) {
  const entry = result.module.exports.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`The fixture does not export ${name}`);
  return entry.type;
}

describe("Merged value and namespace exports", () => {
  it("contributes the value descriptor whichever declaration comes first", () => {
    // The only legal namespace-first merge is with an enum; function and class
    // merges must be declared value-first.
    expect(namesUnder("EnumNamespaceFirst")).toEqual(namesUnder("EnumValueFirst"));
    expect(namesUnder("EnumNamespaceFirst")).not.toEqual([]);
    expect(namesUnder("ValueFirst")).toContain(".member");
    expect(namesUnder("ClassValueFirst")).toContain(".member");

    expect(exportedType("EnumNamespaceFirst")).toMatchObject({ kind: "enum" });
    expect(exportedType("EnumValueFirst")).toMatchObject({ kind: "enum" });
    expect(exportedType("ValueFirst")).toMatchObject({ kind: "function" });
    expect(exportedType("ClassValueFirst")).toMatchObject({ kind: "class" });
  });
});
