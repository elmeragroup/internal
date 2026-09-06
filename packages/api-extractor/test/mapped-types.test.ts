import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { ExtractionResult, ProvenanceEntry } from "../src/index.ts";
import type { ObjectNode, SemanticType } from "../src/model.ts";
import { extractFixture } from "./support/extract.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/mapped-type-remaps");

async function extract(file: string): Promise<ExtractionResult> {
  return extractFixture(
    { tsconfigPath: resolve(fixtureDirectory, "tsconfig.json") },
    resolve(fixtureDirectory, file)
  );
}

function exportType(result: ExtractionResult, name: string): SemanticType {
  const entry = result.module.exports.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`Missing export ${name}`);
  return entry.type;
}

function expectObject(type: SemanticType): Extract<SemanticType, { kind: "object" }> {
  if (type.kind !== "object") throw new Error(`Expected an object node, received ${type.kind}`);
  // SAFETY: the guard above just verified the discriminant matches "object".
  return type as ObjectNode;
}

function property(owner: ObjectNode, name: string) {
  const found = owner.properties.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`${String(owner.typeName?.name)} has no property ${name}`);
  return found;
}

function provenanceFor(result: ExtractionResult, path: readonly string[]): ProvenanceEntry {
  const entry = result.provenance.find(
    (candidate) =>
      candidate.path.length === path.length && candidate.path.every((part, index) => part === path[index])
  );
  if (entry === undefined) throw new Error(`No provenance entry for ${path.join("/")}`);
  return entry;
}

describe("mapped-type resolution", () => {
  it("resolves filtered and conditionally remapped keys on plain objects", async () => {
    const result = await extract("mapped-remaps.ts");
    // An `as never` clause filters every key away.
    expect(expectObject(exportType(result, "Filtered")).properties).toEqual([]);
    // A conditional remap admits one key under its new name and drops the rest.
    const renamed = expectObject(exportType(result, "Renamed"));
    expect(renamed.properties.map((entry) => [entry.name, entry.optional])).toEqual([["renamed", false]]);
    expect(renamed.properties[0]?.type).toEqual({ kind: "intrinsic", intrinsic: "number" });
  });

  it("adds and strips optionality through modifier arithmetic on plain objects", async () => {
    const result = await extract("mapped-remaps.ts");
    // `+?` makes both members optional even though the template value cannot
    // be undefined; the model carries the optionality as `undefined` union arm.
    const plus = expectObject(exportType(result, "PlusOptional"));
    for (const name of ["a", "b"]) {
      expect(property(plus, name).optional).toBe(true);
      expect(property(plus, name).type).toMatchObject({
        kind: "union",
        types: [
          { kind: "intrinsic", intrinsic: "number" },
          { kind: "intrinsic", intrinsic: "undefined" },
        ],
      });
    }
    // `-?` strips the optionality the homomorphic map carried over from `b?`.
    const strip = expectObject(exportType(result, "StripOptional"));
    for (const name of ["a", "b"]) {
      expect(property(strip, name).optional).toBe(false);
      expect(property(strip, name).type).toEqual({ kind: "intrinsic", intrinsic: "number" });
    }
  });

  it("marks compiler-synthesized mapped members in provenance and keeps authored ownership", async () => {
    const result = await extract("mapped-remaps.ts");
    // A finite instantiated alias resolves through ordinary object resolution;
    // its members are invented by the mapped type, so they carry no
    // declaration ownership.
    for (const name of ["a", "b"]) {
      const entry = provenanceFor(result, ["Specialized", "properties", name]);
      expect(entry.synthesized).toBe(true);
      expect(entry.declarations.map((declaration) => declaration.path)).toEqual([]);
    }
    // A key invented by a conditional remap is synthesized the same way.
    const remappedKey = provenanceFor(result, ["Renamed", "properties", "renamed"]);
    expect(remappedKey.synthesized).toBe(true);
    expect(remappedKey.declarations.map((declaration) => declaration.path)).toEqual([]);
    // Authored source facts keep their declaration ownership, including
    // members reached only through a mapped alias instantiation whose
    // declaration the checker still associates them with.
    const authoredProperty = provenanceFor(result, ["Base", "properties", "a"]);
    expect(authoredProperty.synthesized).toBe(false);
    expect(authoredProperty.declarations.map((declaration) => declaration.path).length).toBeGreaterThan(0);
    // A homomorphic modifier keeps the member's own declaration associated,
    // so `+?`/`-?` members are not marked synthesized.
    expect(provenanceFor(result, ["PlusOptional", "properties", "a"]).synthesized).toBe(false);
    // The open-domain route keeps its synthesized-key mark.
    expect(provenanceFor(result, ["MapAlias", "indexSignature", "key"]).synthesized).toBe(true);
  });

  it("resolves a builtin utility alias without publishing its value template's alias names", async () => {
    const result = await extract("mapped-remaps.ts");
    // `MapAlias<'a' | 'b'>` leaves its open generic behind and reports the two
    // concrete members with their aliased intrinsic values unnamed.
    const specialized = expectObject(exportType(result, "Specialized"));
    expect(specialized.indexSignature).toBeUndefined();
    for (const name of ["a", "b"]) {
      expect(property(specialized, name)).toEqual({
        name,
        type: { kind: "intrinsic", intrinsic: "unknown" },
        optional: true,
      });
    }
  });
});
