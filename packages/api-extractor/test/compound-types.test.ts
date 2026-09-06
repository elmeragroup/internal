import { Effect, Schema } from "effect";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ExtractionResultSchema, ProjectExtractor } from "../src/index.ts";
import type { ExtractionResult, PropertyNode, SemanticType } from "../src/index.ts";
import { extractFixture } from "./support/extract.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/canonical-cycles-and-ordering");
const tsconfigPath = resolve(fixtureDirectory, "tsconfig.json");
const inputPath = resolve(fixtureDirectory, "input.ts");

function runTwiceInOneProject(): Promise<readonly [ExtractionResult, ExtractionResult]> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const extractor = yield* ProjectExtractor;
        const first = yield* extractor.extractModule(inputPath);
        const second = yield* extractor.extractModule(inputPath);
        return [first, second] as const;
      }).pipe(Effect.provide(ProjectExtractor.live({ tsconfigPath })))
    )
  );
}

function exportedType(result: ExtractionResult, name: string): SemanticType {
  const entry = result.module.exports.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`Missing export: ${name}`);
  return entry.type;
}

/** The public name a compound member carries, if its model kind has one. */
function memberName(member: SemanticType): string | undefined {
  return "typeName" in member ? member.typeName?.name : undefined;
}

function property(properties: readonly PropertyNode[], name: string): PropertyNode {
  const found = properties.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing property: ${name}`);
  return found;
}

describe("Issue 04 compound type extraction through extractModule", () => {
  it("cuts a recursive union without losing its discriminant", async () => {
    const cycle = exportedType(await extractFixture({ tsconfigPath }, inputPath), "Cycle");
    expect(cycle.kind).toBe("union");
    if (cycle.kind !== "union") return;
    expect(cycle.typeName?.name).toBe("Cycle");
    expect(cycle.types).toHaveLength(2);
    for (const member of cycle.types) {
      expect(member.kind).toBe("object");
      if (member.kind !== "object") continue;
      expect(property(member.properties, "nested").type).toEqual({
        kind: "union",
        typeName: { name: "Cycle" },
        types: [],
      });
    }
  });

  it("cuts a recursive intersection without losing its discriminant", async () => {
    const cyclic = exportedType(await extractFixture({ tsconfigPath }, inputPath), "CyclicIntersection");
    expect(cyclic.kind).toBe("intersection");
    if (cyclic.kind !== "intersection") return;
    expect(property(cyclic.properties, "self").type).toEqual({
      kind: "intersection",
      typeName: { name: "CyclicIntersection" },
      types: [],
      properties: [],
    });
  });

  it("describes a callable intersection by its call signatures", async () => {
    expect(exportedType(await extractFixture({ tsconfigPath }, inputPath), "callable")).toMatchObject({
      kind: "function",
      callSignatures: [
        {
          parameters: [{ name: "param", type: { kind: "intrinsic", intrinsic: "number" } }],
          returnValueType: { kind: "intrinsic", intrinsic: "number" },
        },
      ],
    });
  });

  it("keeps an authored boolean as one intrinsic member of the optional union", async () => {
    const flags = exportedType(await extractFixture({ tsconfigPath }, inputPath), "Flags");
    expect(flags.kind).toBe("object");
    if (flags.kind !== "object") return;
    expect(property(flags.properties, "toggled")).toMatchObject({
      optional: true,
      type: {
        kind: "union",
        types: [
          { kind: "intrinsic", intrinsic: "boolean" },
          { kind: "intrinsic", intrinsic: "undefined" },
        ],
      },
    });
  });

  it("merges intersection properties while preserving members, optionality and documentation", async () => {
    const flags = exportedType(await extractFixture({ tsconfigPath }, inputPath), "Flags");
    if (flags.kind !== "object") throw new Error("Flags is not an object");
    const merged = property(flags.properties, "merged").type;
    expect(merged.kind).toBe("intersection");
    if (merged.kind !== "intersection") return;

    // Both authored members stay visible, including the conflicting optionality.
    expect(merged.types).toHaveLength(2);
    const [first, second] = merged.types;
    if (first?.kind !== "object" || second?.kind !== "object") throw new Error("Unexpected members");
    expect(property(first.properties, "count").optional).toBe(true);
    expect(property(second.properties, "count").optional).toBe(false);

    // The aggregate list merges each name once: a member that requires the
    // property makes the merged property required, and the documented
    // declaration keeps its documentation.
    expect(merged.properties.map((entry) => entry.name)).toEqual(["label", "count", "tags"]);
    expect(property(merged.properties, "count")).toEqual({
      name: "count",
      optional: false,
      type: { kind: "intrinsic", intrinsic: "number" },
    });
    expect(property(merged.properties, "tags").documentation?.description).toBe(
      "Documented once on the first declaring member."
    );
    // The merged list also preserves readonly container state.
    expect(property(merged.properties, "tags").type).toMatchObject({
      kind: "array",
      isReadonly: true,
      elementType: { kind: "intrinsic", intrinsic: "string" },
    });
  });

  it("names deduplicated intersection members after their own authored syntax", async () => {
    const duplicate = exportedType(
      await extractFixture({ tsconfigPath }, inputPath),
      "DuplicateIntersection"
    );
    expect(duplicate.kind).toBe("intersection");
    if (duplicate.kind !== "intersection") return;
    // The checker collapses `Alpha & Alpha` to `[Alpha, Beta]`. Pairing members
    // with authored syntax by position would label Beta's shape `Alpha`.
    expect(
      duplicate.types.map((member) => [
        memberName(member),
        member.kind === "object" ? member.properties.map((entry) => entry.name) : [],
      ])
    ).toEqual([
      ["Alpha", ["alpha"]],
      ["Beta", ["beta"]],
    ]);
  });

  it("does not mistake a generic reference's type arguments for intersection member syntax", async () => {
    const value = exportedType(await extractFixture({ tsconfigPath }, inputPath), "pair");
    expect(value.kind).toBe("intersection");
    if (value.kind !== "intersection") return;
    expect(value.typeName?.name).toBe("Pair");
    // `Pair<Left, Right>` has two structural members. Reading the reference's
    // arguments as member syntax would name them `Left` and `Right`.
    expect(
      value.types.map((member) => [
        memberName(member),
        member.kind === "object" ? member.properties.map((entry) => entry.name) : [],
      ])
    ).toEqual([
      [undefined, ["first"]],
      [undefined, ["second"]],
    ]);
  });

  it("keeps the authored member order of an instantiated generic alias union", async () => {
    const alias = exportedType(await extractFixture({ tsconfigPath }, inputPath), "instantiatedAlias");
    if (alias.kind !== "function") throw new Error("instantiatedAlias is not a function");
    const parameter = alias.callSignatures[0]?.parameters[0];
    expect(parameter?.type).toMatchObject({
      kind: "union",
      typeName: { name: "OptionalParameter" },
      // The alias body is `Value | string`, so the bound argument comes first.
      types: [
        { kind: "intrinsic", intrinsic: "number" },
        { kind: "intrinsic", intrinsic: "string" },
      ],
    });
  });

  it("keeps the authored position of a generic container member", async () => {
    const alias = exportedType(await extractFixture({ tsconfigPath }, inputPath), "genericContainer");
    if (alias.kind !== "function") throw new Error("genericContainer is not a function");
    const parameter = alias.callSignatures[0]?.parameters[0];
    // The alias body is `Value[] | string`. `Value[]` resolves to the
    // uninstantiated `Value[]`, so only matching it to `number[]` by reference
    // target keeps the authored container first instead of appending it.
    expect(parameter?.type).toMatchObject({
      kind: "union",
      typeName: { name: "GenericContainer" },
      types: [
        { kind: "array", elementType: { kind: "intrinsic", intrinsic: "number" } },
        { kind: "intrinsic", intrinsic: "string" },
      ],
    });
  });

  it("keeps an authored member that its sibling alias union also contains", async () => {
    const overlapping = exportedType(await extractFixture({ tsconfigPath }, inputPath), "OverlappingUnion");
    expect(overlapping).toEqual({
      kind: "union",
      typeName: { name: "OverlappingUnion" },
      types: [
        {
          kind: "union",
          typeName: { name: "SmallUnion" },
          types: [
            { kind: "literal", value: '"x"' },
            { kind: "literal", value: '"y"' },
          ],
        },
        { kind: "literal", value: '"x"' },
      ],
    });
  });

  it("moves an aliased null to the end of its union", async () => {
    expect(exportedType(await extractFixture({ tsconfigPath }, inputPath), "WithAliasedNull")).toEqual({
      kind: "union",
      typeName: { name: "WithAliasedNull" },
      types: [
        { kind: "intrinsic", intrinsic: "string" },
        { kind: "intrinsic", typeName: { name: "AliasedNull" }, intrinsic: "null" },
      ],
    });
  });

  it("records provenance for merged intersection properties", async () => {
    const result = await extractFixture({ tsconfigPath }, inputPath);
    const paths = result.provenance.map((entry) => JSON.stringify(entry.path));
    expect(paths).toContain(JSON.stringify(["Flags", "properties", "merged"]));
    expect(paths).toContain(JSON.stringify(["Flags", "properties", "merged", "properties", "count"]));
    expect(paths).toContain(JSON.stringify(["Flags", "properties", "merged", "properties", "tags"]));
    expect(
      result.provenance.every((entry) => entry.declarations.map((declaration) => declaration.path).length > 0)
    ).toBe(true);
  });

  it("produces identical output for repeated extractions and keeps the result decodable", async () => {
    const [first, second] = await runTwiceInOneProject();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const separateProject = await extractFixture({ tsconfigPath }, inputPath);
    expect(JSON.stringify(separateProject)).toBe(JSON.stringify(first));
    // SAFETY: the round-tripped JSON is unknown-shaped data that the schema decodes here.
    const encoded = JSON.parse(JSON.stringify(first)) as unknown;
    expect(Schema.decodeUnknownSync(ExtractionResultSchema)(encoded)).toEqual(first);
    expect(first.warnings).toEqual([]);
  });
});
