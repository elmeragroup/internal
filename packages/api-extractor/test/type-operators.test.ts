import { resolve } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { ExtractionResult } from "../src/index.ts";
import type { SemanticType, TypeOperatorResolutionKind } from "../src/model.ts";
import { extractFixture, fixtureRoot } from "./support/extract.ts";

const tsconfigPath = resolve(fixtureRoot, "type-operators-tsconfig.json");

describe("type operators on the ported upstream fixtures", () => {
  it("preserves the authored operator beside its resolved key set", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "type-literal-union-resolution", "input.ts")
    );
    const entry = result.module.exports.find((candidate) => candidate.name === "acceptsKeyofProp");
    if (entry === undefined) throw new Error("The fixture does not export acceptsKeyofProp");
    if (entry.type.kind !== "function") {
      throw new Error(`acceptsKeyofProp is a ${entry.type.kind}, not a function`);
    }
    const parameter = entry.type.callSignatures[0]?.parameters[0]?.type;
    expect(parameter).toMatchObject({
      kind: "typeOperator",
      operator: "keyof",
      type: { kind: "object", typeName: { name: "Params" }, properties: [] },
      resolutionKind: "exact",
    });
    // The operand keeps the authored expression; the checker's reduced key set
    // rides beside it — never instead of it.
    const operator = parameter?.kind === "typeOperator" ? parameter : undefined;
    expect(operator?.resolvedType).toBeDefined();
  });

  it("attaches a resolved key set to every preserved operator", async () => {
    const result = await extractFixture(
      { tsconfigPath },
      resolve(fixtureRoot, "type-literal-union-resolution", "input.ts")
    );
    const serialized = JSON.stringify(result.module);
    expect(serialized).toContain('"typeOperator"');
    expect(serialized.split('"typeOperator"').length).toBe(serialized.split('"resolutionKind"').length);
  });
});

describe("type operators in the model type", () => {
  it("a module requires a key set on every preserved operator", () => {
    type Operator = ExtractionResult["module"]["exports"][number]["type"] extends infer Member
      ? Member extends { readonly kind: "typeOperator" }
        ? Member
        : never
      : never;
    expectTypeOf<Operator["resolvedType"]>().toEqualTypeOf<SemanticType>();
    expectTypeOf<Operator["resolutionKind"]>().toEqualTypeOf<TypeOperatorResolutionKind>();
  });
});

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/type-operator-keyof-and-unique-symbols");

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

function expectKeyOperator(type: SemanticType, label: string) {
  if (type.kind !== "typeOperator") {
    throw new Error(`${label} is a ${type.kind}, not a preserved keyof`);
  }
  const { resolvedType } = type;
  if (type.resolutionKind !== "exact") {
    throw new Error(`${label} resolved as ${type.resolutionKind}, not exact`);
  }
  if (resolvedType.kind !== "union") {
    throw new Error(`${label}'s key set is a ${resolvedType.kind}, not a union`);
  }
  return { operand: type.type, members: resolvedType.types };
}

/** Exact member set; canonicalization orders key sets, so membership is unordered. */
function expectMembers(members: readonly SemanticType[], expected: readonly SemanticType[]) {
  expect(members).toHaveLength(expected.length);
  for (const candidate of expected) {
    expect(members).toContainEqual(candidate);
  }
}

describe("type-operator review regressions", () => {
  it("resolves a unique-symbol key to symbol instead of degrading to any", async () => {
    // A `unique symbol` member of a keyof key set carries TypeFlags.UniqueESSymbol.
    // Upstream's intrinsic resolver maps ESSymbol || UniqueESSymbol to the same
    // `symbol` intrinsic (`intrinsicTypeResolver.ts`), and its concrete-operator
    // rule re-enters session.resolve for such members — so `keyof` over an
    // object keyed by one reports `"named" | symbol` with no warning.
    const result = await extract("unique-symbols.ts");
    expect(result.warnings).toEqual([]);
    const { operand, members } = expectKeyOperator(exportType(result, "BrandedKeys"), "BrandedKeys");
    // The operand stays the named shallow object; only the key set is checked here.
    expect(operand).toMatchObject({ kind: "object", typeName: { name: "Branded" }, properties: [] });
    expectMembers(members, [
      { kind: "literal", value: '"named"' },
      // The symbol intrinsic carries the declaring constant's name, exactly as
      // upstream's IntrinsicNode('symbol', typeName) does.
      { kind: "intrinsic", intrinsic: "symbol", typeName: { name: "brand" } },
    ]);
  });

  it("reports an exported unique symbol constant as the symbol intrinsic", async () => {
    // The reviewer also asked about the bare shape: `declare const s: unique
    // symbol` exports a type whose only flag is UniqueESSymbol. It flows through
    // the same intrinsic mapping upstream applies, so it resolves to `symbol`
    // rather than an `any` fallback with a spurious warning.
    const result = await extract("unique-symbols.ts");
    expect(result.warnings).toEqual([]);
    // The intrinsic carries the constant's name, as upstream's
    // IntrinsicNode('symbol', typeName) does.
    expect(exportType(result, "bareSymbol")).toEqual({
      kind: "intrinsic",
      intrinsic: "symbol",
      typeName: { name: "bareSymbol" },
    });
  });

  it("preserves a local intersection operand with its exact key set", async () => {
    // `keyof (A & B)` keeps the authored intersection as its operand — the
    // checker reduces it, but the operator expression is what the model
    // preserves — and resolves both members' keys exactly.
    const result = await extract("intersection-keyof.ts");
    expect(result.warnings).toEqual([]);
    const { operand, members } = expectKeyOperator(exportType(result, "CombinedKeys"), "CombinedKeys");
    if (operand.kind !== "intersection") {
      throw new Error(`The operand is a ${operand.kind}, not the authored intersection`);
    }
    expect(
      operand.types.map((member) => (member.kind === "object" ? member.typeName?.name : undefined))
    ).toEqual(["Layout", "Style"]);
    expectMembers(members, [
      { kind: "literal", value: '"color"' },
      { kind: "literal", value: '"width"' },
    ]);
  });
});
