import { Schema } from "effect";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import type { ExtractionResult, ExtractorOptions } from "../src/index.ts";
import { ModuleNodeSchema } from "../src/model.ts";
import type { ExportNode, PropertyNode, SemanticType } from "../src/model.ts";
import { ProvenanceSchema } from "../src/provenance.ts";
import { extractFixture } from "./support/extract.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/container-kinds-and-tuples");

let result: ExtractionResult;

beforeAll(async () => {
  result = await extractFixture(
    { tsconfigPath: resolve(fixtureDirectory, "tsconfig.json") },
    resolve(fixtureDirectory, "input.ts")
  );
});

function exportedType(name: string): SemanticType {
  const entry = result.module.exports.find((candidate: ExportNode) => candidate.name === name);
  if (entry === undefined) throw new Error(`The fixture does not export ${name}`);
  return entry.type;
}

function property(owner: string, name: string): PropertyNode {
  const type = exportedType(owner);
  const properties = type.kind === "object" ? type.properties : [];
  const found = properties.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`${owner} has no property ${name}`);
  return found;
}

function propertyType(owner: string, name: string): SemanticType {
  return property(owner, name).type;
}

function provenanceFor(path: readonly string[]): { readonly synthesized: boolean } {
  const entry = result.provenance.find(
    (candidate) =>
      candidate.path.length === path.length &&
      candidate.path.every((segment, index) => segment === path[index])
  );
  if (entry === undefined) throw new Error(`No provenance entry for ${path.join("/")}`);
  return entry;
}

describe("Issue 05 container extraction through the public seam", () => {
  it("extracts mutable and readonly arrays with their element types and aliases", () => {
    const mutable = propertyType("Arrays", "mutable");
    expect(mutable).toMatchObject({
      kind: "array",
      elementType: { kind: "object", typeName: { name: "Element" } },
    });
    expect(mutable).not.toHaveProperty("isReadonly");
    expect(mutable).not.toHaveProperty("typeName");
    // `Array<T>` is the same anonymous container as `T[]`, so the authored
    // spelling never becomes a public name.
    expect(propertyType("Arrays", "mutableReference")).not.toHaveProperty("typeName");
    for (const name of ["readonlyOperator", "readonlyReference"]) {
      expect(propertyType("Arrays", name)).toMatchObject({ kind: "array", isReadonly: true });
    }
    expect(propertyType("Arrays", "nested")).toMatchObject({
      kind: "array",
      isReadonly: true,
      elementType: { kind: "array", isReadonly: true },
    });
    // Only an alias gives an array a public name.
    expect(propertyType("Arrays", "aliased")).toMatchObject({
      kind: "array",
      typeName: { name: "ElementList" },
    });
    expect(propertyType("Arrays", "aliased")).not.toHaveProperty("isReadonly");
  });

  it("extracts tuples with ordered elements, labels, optional and rest elements, and readonly state", () => {
    const plain = exportedType("Pair");
    expect(plain).toMatchObject({
      kind: "tuple",
      typeName: { name: "Pair" },
      types: [
        { kind: "intrinsic", intrinsic: "string" },
        { kind: "intrinsic", intrinsic: "number" },
      ],
    });
    // A label is authored metadata, not a distinct element type: the ordered
    // element list is identical with and without labels.
    expect(propertyType("Tuples", "labelled")).toEqual(propertyType("Tuples", "plain"));
    // An optional element carries `undefined` in its own element type.
    expect(propertyType("Tuples", "optional")).toMatchObject({
      kind: "tuple",
      types: [
        { kind: "intrinsic", intrinsic: "string" },
        {
          kind: "union",
          types: [
            { kind: "intrinsic", intrinsic: "number" },
            { kind: "intrinsic", intrinsic: "undefined" },
          ],
        },
      ],
    });
    // A rest element contributes its element type in the rest position.
    expect(propertyType("Tuples", "rest")).toMatchObject({
      kind: "tuple",
      types: [
        { kind: "intrinsic", intrinsic: "string" },
        { kind: "object", typeName: { name: "Element" } },
      ],
    });
    expect(propertyType("Tuples", "frozen")).toMatchObject({ kind: "tuple", isReadonly: true });
    expect(propertyType("Tuples", "plain")).not.toHaveProperty("isReadonly");
  });

  it("extracts records and finite mapped-key objects after canonicalization", () => {
    // An open `Record` stays an external reference with its arguments, exactly
    // as upstream reports it.
    expect(propertyType("Records", "open")).toMatchObject({
      kind: "external",
      typeName: { name: "Record" },
    });
    // A finite key domain is described by concrete properties, not a key type.
    const finite = exportedType("FiniteKeys");
    expect(finite).not.toHaveProperty("indexSignature");
    const finiteProperties = finite.kind === "object" ? finite.properties : [];
    expect(finiteProperties.map((entry) => [entry.name, entry.optional, entry.type.kind])).toEqual([
      ["a", true, "union"],
      ["b", true, "union"],
    ]);
    // A built-in utility over a finite key domain hides its library-declared
    // members, and still never manufactures a key type for them.
    const partial = propertyType("Records", "partial");
    expect(partial.kind).toBe("object");
    expect(partial).not.toHaveProperty("indexSignature");
    // An open mapped key domain is the case that becomes an index signature.
    expect(exportedType("SynthesizedKeys")).toMatchObject({
      kind: "object",
      properties: [],
      indexSignature: { keyName: "Name", keyType: "string" },
    });
  });

  it("extracts string and number index signatures and keeps optional value behavior", () => {
    expect(exportedType("StringIndexed")).toMatchObject({
      indexSignature: { keyName: "elementName", keyType: "string" },
    });
    expect(exportedType("NumberIndexed")).toMatchObject({
      indexSignature: { keyName: "position", keyType: "number" },
    });
    // An optional index value is representable, and reaches the model as the
    // union the checker produced.
    expect(exportedType("OptionalIndexed")).toMatchObject({
      indexSignature: {
        keyType: "string",
        valueType: {
          kind: "union",
          types: [{ kind: "object" }, { kind: "intrinsic", intrinsic: "undefined" }],
        },
      },
    });
    // A readonly index signature has no encoding in the semantic model, so it
    // reports the same shape as a mutable one rather than a different key.
    expect(exportedType("ReadonlyIndexed")).toEqual({
      ...exportedType("StringIndexed"),
      typeName: { name: "ReadonlyIndexed" },
    });
  });

  it("reports an unrepresentable symbol index signature as a structured warning", () => {
    expect(exportedType("SymbolIndexed")).not.toHaveProperty("indexSignature");
    const warnings = result.warnings.filter((warning) => warning.code === "omitted-index-signature");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "omitted-index-signature", keyTypes: ["symbol"] });
    expect(warnings[0]?.parsedSymbolStack).toContain("SymbolIndexed");
    expect(warnings[0]?.message).toContain("symbol");
  });

  it("keeps recursive containers reporting their own kind when the cycle is cut", () => {
    expect(propertyType("RecursiveNode", "children")).toMatchObject({
      kind: "array",
      typeName: { name: "RecursiveList" },
      elementType: { kind: "object", typeName: { name: "RecursiveNode" }, properties: [] },
    });
    expect(propertyType("RecursiveNode", "siblings")).toMatchObject({
      kind: "tuple",
      isReadonly: true,
      types: [
        { kind: "object", properties: [] },
        { kind: "object", properties: [] },
      ],
    });
  });

  it("preserves documentation for container members", () => {
    expect(property("Arrays", "mutable").documentation?.description).toBe("Written with array syntax.");
    expect(property("Tuples", "frozen").documentation?.description).toBe("A readonly tuple.");
    const indexed = exportedType("StringIndexed");
    const value = indexed.kind === "object" ? indexed.indexSignature?.valueType : undefined;
    const documented =
      value?.kind === "object"
        ? value.properties.find((entry) => entry.name === "id")?.documentation?.description
        : undefined;
    expect(documented).toBe("The element's identifier.");
  });

  it("records provenance for container members and synthesized keys without compiler handles", () => {
    // A container is transparent in the provenance grammar: a property reached
    // through an array, a tuple, or an index signature keeps the container's
    // own path.
    expect(provenanceFor(["Arrays", "properties", "mutable", "properties", "id"]).synthesized).toBe(false);
    expect(provenanceFor(["Tuples", "properties", "plain", "properties", "id"]).synthesized).toBe(false);
    expect(provenanceFor(["StringIndexed", "properties", "id"]).synthesized).toBe(false);
    // An authored key is declared; a mapped type's key is synthesized.
    expect(provenanceFor(["StringIndexed", "indexSignature", "key"]).synthesized).toBe(false);
    expect(provenanceFor(["SynthesizedKeys", "indexSignature", "key"]).synthesized).toBe(true);
    const serialized = JSON.stringify(result.provenance);
    expect(serialized).not.toMatch(/"session"|"__handle"|"kind":"(?:type|symbol|node|type-node)"/u);
  });

  it("keeps the semantic output and provenance independently schema-decodable", () => {
    expect(() =>
      Schema.decodeUnknownSync(ModuleNodeSchema)(JSON.parse(JSON.stringify(result.module)))
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ProvenanceSchema)(JSON.parse(JSON.stringify(result.provenance)))
    ).not.toThrow();
  });
});

const reviewFixtureDirectory = resolve(import.meta.dirname, "fixtures/container-open-rest-and-shadowing");

function extractReview(options: ExtractorOptions, file = "input.ts"): Promise<ExtractionResult> {
  return extractFixture(
    { tsconfigPath: resolve(reviewFixtureDirectory, "tsconfig.json") },
    resolve(reviewFixtureDirectory, file),
    options
  );
}

let reviewResult: ExtractionResult;
let reviewExternal: ExtractionResult;
let reviewShadowed: ExtractionResult;

beforeAll(async () => {
  reviewResult = await extractReview({});
  reviewExternal = await extractReview({ includeExternalTypes: true });
  reviewShadowed = await extractReview({}, "shadowed.ts");
});

function reviewExportedType(extraction: ExtractionResult, name: string): SemanticType {
  const entry = extraction.module.exports.find((candidate: ExportNode) => candidate.name === name);
  if (entry === undefined) throw new Error(`The fixture does not export ${name}`);
  return entry.type;
}

function reviewTupleElements(name: string): readonly SemanticType[] {
  const type = reviewExportedType(reviewResult, name);
  if (type.kind !== "tuple") throw new Error(`${name} is a ${type.kind}, not a tuple`);
  return type.types;
}

function reviewPropertyType(extraction: ExtractionResult, owner: string, name: string): SemanticType {
  const type = reviewExportedType(extraction, owner);
  const properties = type.kind === "object" ? type.properties : [];
  const found = properties.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`${owner} has no property ${name}`);
  return found.type;
}

const keyofTarget = {
  kind: "typeOperator",
  operator: "keyof",
  type: { kind: "typeParameter", name: "Target" },
};

describe("container review regressions", () => {
  it.each([
    ["TwoEnvironments", "DirectEnvironments"],
    ["RenamedEnvironment", "DirectRenamedEnvironment"],
    ["RepeatedEnvironment", "DirectRepeatedEnvironment"],
  ])("keeps each donated tuple element's generic environment: %s", (spread, direct) => {
    expect(reviewTupleElements(spread)).toEqual(reviewTupleElements(direct));
    expect(
      reviewResult.warnings.filter(
        (warning) =>
          warning.code === "unsupported-type-fallback" && warning.parsedSymbolStack.includes(spread)
      )
    ).toEqual([]);
  });

  it("maps an open rest element to the array's element syntax, not to the array", () => {
    // `[string, ...(keyof Target)[]]` has two semantic elements and two authored
    // positions, but the rest position was written as the *array*. Attaching
    // that array to the `keyof Target` element used to re-enter the element type
    // and report an empty object with no warning at all.
    expect(reviewTupleElements("OpenRestKeys")[1]).toMatchObject(keyofTarget);
    // The built-in array reference spelling reaches the same element syntax.
    expect(reviewTupleElements("OpenRestKeysReference")[1]).toMatchObject(keyofTarget);
    expect(reviewTupleElements("OpenRestKeys")[1]).toEqual(reviewTupleElements("OpenRestKeysReference")[1]);
  });

  it("keeps a rest element of a nested array reporting the array it spreads", () => {
    // `[string, ...Element[][]]` spreads an array *of arrays*: one element down
    // is still an array, and the element syntax has to travel with it.
    expect(reviewTupleElements("NestedRest")[1]).toMatchObject({
      kind: "array",
      elementType: { kind: "object", typeName: { name: "Element" } },
    });
  });

  it("expands a finite inline spread into the authored elements it contributes", () => {
    // `[boolean, ...[keyof Target, number]]` is three semantic elements against
    // two authored positions; aligning by width recovers the exact syntax each
    // element was written as, which is what upstream's selection plan does.
    const elements = reviewTupleElements("FiniteSpreadKeys");
    expect(elements).toHaveLength(3);
    expect(elements[0]).toMatchObject({ kind: "intrinsic", intrinsic: "boolean" });
    expect(elements[1]).toMatchObject(keyofTarget);
    expect(elements[2]).toMatchObject({ kind: "intrinsic", intrinsic: "number" });
    // The spread reports the same elements as writing the tuple out directly.
    expect(elements.slice(1)).toEqual(reviewTupleElements("SpreadTail"));
  });

  it("replays a generic tuple alias spread through its rebound parameters", () => {
    // A generic tuple alias describes its elements in terms of its *own*
    // parameters. The resolver rebinds those parameters to the written
    // arguments — upstream's deriveTypeParameterBindings — so the spread
    // donates real element syntax (`SpreadTail<Target>` expands to the key set
    // and `number`) instead of falling back to an unlabelled open rest.
    const aliased = reviewTupleElements("AliasedSpread");
    expect(aliased[0]).toEqual({ kind: "intrinsic", intrinsic: "boolean" });
    expect(aliased[1]).toMatchObject(keyofTarget);
    expect(aliased[2]).toEqual({ kind: "intrinsic", intrinsic: "number" });
    // The uninstantiated declaration bodies themselves fall back honestly:
    // with no arguments written there is nothing to bind `Target` to, so the
    // checker cannot reduce `keyof Target`. Since Issue 09's index-like
    // fallback mirrors upstream's `resolveIndexLikeType`, that degradation is
    // silent (`any`, with no authored expression left to preserve) instead of
    // a structured warning.
    expect(
      reviewResult.warnings.filter(
        (warning) => warning.code === "unsupported-type-fallback" && warning.typeText === "keyof Target"
      ).length
    ).toBe(0);
  });

  it("never converts an index type into a silent empty object when its operator was not authored", () => {
    // `[Keys<Target>]` names an alias whose body is a `keyof`. Resolving the
    // element again would re-enter the type that is already being resolved and
    // hit the cycle cut, which reported `{}` with no warning.
    const element = reviewTupleElements("AliasedKeys")[0];
    expect(element).toMatchObject({ ...keyofTarget, typeName: { name: "Keys" } });
    expect(element).not.toMatchObject({ kind: "object", properties: [] });
  });

  it("keeps authored names on library interfaces when external types are included", () => {
    expect(reviewPropertyType(reviewExternal, "LibraryContainers", "promise")).toMatchObject({
      typeName: { name: "Promise", typeArguments: [{ type: { kind: "intrinsic", intrinsic: "string" } }] },
    });
    expect(reviewPropertyType(reviewExternal, "LibraryContainers", "lookup")).toMatchObject({
      typeName: { name: "Map" },
    });
    // A library *alias* the checker resolved away still has no public name: the
    // model describes the tuple it produced, not the alias that is gone.
    const parameters = reviewPropertyType(reviewExternal, "LibraryContainers", "parameters");
    expect(parameters.kind).toBe("tuple");
    expect(parameters).not.toHaveProperty("typeName");
    // The same names are reported when external members stay hidden.
    expect(reviewPropertyType(reviewResult, "LibraryContainers", "promise")).toMatchObject({
      kind: "external",
      typeName: { name: "Promise" },
    });
  });

  it("distinguishes an unrepresentable index key from a representable one that lost the single slot", () => {
    const omitted = reviewResult.warnings.filter((warning) => warning.code === "omitted-index-signature");
    expect(omitted.map((warning) => [warning.reason, warning.keyTypes])).toEqual([
      ["additional-signature", ["number"]],
      ["unrepresentable-key", ["symbol"]],
    ]);
    const [tieLoss, unrepresentable] = omitted;
    // A number key is representable; only the model's single signature slot is
    // not, and the message has to say so.
    expect(tieLoss?.message).toContain("output model supports one");
    expect(tieLoss?.message).toContain('key type "number"');
    expect(unrepresentable?.message).toContain('uses unsupported key type "symbol"');
    // The representable signature is the one the model kept.
    expect(reviewExportedType(reviewResult, "DualIndexed")).toMatchObject({
      indexSignature: { keyName: "name", keyType: "string" },
    });
  });

  it("never lets a non-built-in reference name an array's element", () => {
    // `type StringArray<Item> = string[]` is an array whose authored syntax
    // names `Item`. Handing that argument to the element used to publish a
    // string element called `Marker`, with no warning at all. Upstream gates the
    // same branch on `getBuiltInArrayReferenceName`.
    const elements = reviewExportedType(reviewShadowed, "MislabeledElements");
    expect(elements).toMatchObject({
      kind: "array",
      elementType: { kind: "intrinsic", intrinsic: "string" },
    });
    expect(elements.kind === "array" ? elements.elementType : undefined).not.toHaveProperty("typeName");
    // The array reached through a rest position reports the same element.
    const rest = reviewExportedType(reviewShadowed, "MislabeledRestElements");
    expect(rest).toMatchObject({
      kind: "tuple",
      types: [{ intrinsic: "boolean" }, { kind: "intrinsic", intrinsic: "string" }],
    });
    expect(rest.kind === "tuple" ? rest.types[1] : undefined).not.toHaveProperty("typeName");
  });

  it("verifies the built-in array reference through the checker instead of its name text", () => {
    // The fixture imports project declarations literally named `Array` and
    // `ReadonlyArray`, which shadow the global names in that file. A name-text
    // gate accepts them and replays element syntax belonging to another type;
    // the checker-verified fact (interface, declared in a TypeScript lib file)
    // does not. Both container paths use the same fact.
    const array = reviewExportedType(reviewShadowed, "ShadowedArrayElements");
    expect(array).toMatchObject({ kind: "array", elementType: { kind: "intrinsic", intrinsic: "string" } });
    expect(array.kind === "array" ? array.elementType : undefined).not.toHaveProperty("typeName");
    const rest = reviewExportedType(reviewShadowed, "ShadowedRestElements");
    expect(rest.kind === "tuple" ? rest.types[1] : undefined).toEqual({
      kind: "intrinsic",
      intrinsic: "string",
    });
  });

  it("never reports a container's elements as its alias name's type arguments", () => {
    // A parameterless alias has no type arguments, but its checker type is a
    // reference to the tuple or array target whose type arguments are its
    // ELEMENTS. Upstream guards with `if (type.aliasSymbol &&
    // !type.aliasTypeArguments) typeArguments = []` (common.ts).
    expect(reviewExportedType(reviewResult, "Pair")).toEqual({
      kind: "tuple",
      typeName: { name: "Pair" },
      types: [
        { kind: "intrinsic", intrinsic: "string" },
        { kind: "intrinsic", intrinsic: "number" },
      ],
    });
    // A *generic* alias does have arguments, and upstream reports the element
    // list as those arguments — the ported `mapped-tuple-rest-synthetic-key`
    // oracle pins `Rest<V> = [V, V]` with `typeArguments: [V, V]`.
    expect(reviewExportedType(reviewResult, "GenericPair")).toMatchObject({
      typeName: {
        name: "GenericPair",
        typeArguments: [{ type: { kind: "typeParameter", name: "Item" } }, { type: { intrinsic: "number" } }],
      },
    });
    // An authored reference to a different symbol than the alias keeps the
    // arguments it was written with, which is upstream's first branch and what
    // the ported `readonly-array-mapped-type-literal-key` oracle shows for
    // `DirectData = ReadonlyArray<{...}>`.
    expect(reviewExportedType(reviewResult, "Names")).toMatchObject({
      kind: "array",
      typeName: { name: "Names", typeArguments: [{ type: { intrinsic: "string" } }] },
    });
    expect(reviewExportedType(reviewResult, "InstantiatedPair")).toMatchObject({
      typeName: { name: "GenericPair", typeArguments: [{ type: { intrinsic: "string" } }] },
    });
  });

  it("resolves a keyof to its key set, not to its operand", () => {
    // Upstream's `resolveTypeOperatorResult` resolves the KEY SET: a generic
    // `keyof Target` has none, so its base constraint stands in and the result
    // says so. The upstream fixture `unresolved-indexed-access-fallback` pins
    // exactly this union and `resolutionKind`.
    expect(reviewExportedType(reviewResult, "Keys")).toEqual({
      kind: "typeOperator",
      operator: "keyof",
      type: { kind: "typeParameter", name: "Target" },
      resolvedType: {
        kind: "union",
        types: [
          { kind: "intrinsic", intrinsic: "string" },
          { kind: "intrinsic", intrinsic: "number" },
          { kind: "intrinsic", intrinsic: "symbol" },
        ],
      },
      resolutionKind: "baseConstraint",
    });
    // A concrete operand leaves the checker with a key set it can name, which
    // is reported exactly — as the operator's own `resolvedType` since Issue
    // 09's operator-first reconstruction (upstream runs `resolveTypeOperatorType`
    // before every broad resolver, so the authored expression survives with its
    // reduced key set attached instead of collapsing to the bare literal).
    expect(reviewExportedType(reviewResult, "ElementKeys")).toEqual({
      kind: "typeOperator",
      operator: "keyof",
      type: { kind: "object", typeName: { name: "Element" }, properties: [] },
      resolvedType: { kind: "literal", value: '"id"' },
      resolutionKind: "exact",
    });
  });

  it("keeps the reviewed output schema-decodable", () => {
    expect(() =>
      Schema.decodeUnknownSync(ModuleNodeSchema)(JSON.parse(JSON.stringify(reviewResult.module)))
    ).not.toThrow();
  });
});
