import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { SemanticType } from "../src/model.ts";
import { extractFixture } from "./support/extract.ts";

const fixtureDirectory = resolve(import.meta.dirname, "fixtures/generic-substitution-scope");

function extract(file: string) {
  return extractFixture(
    { tsconfigPath: resolve(fixtureDirectory, "tsconfig.json") },
    resolve(fixtureDirectory, file)
  );
}

function exportType(module: Awaited<ReturnType<typeof extract>>["module"], name: string): SemanticType {
  const entry = module.exports.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`Missing export ${name}`);
  return entry.type;
}

function expectKind<K extends SemanticType["kind"]>(
  type: SemanticType,
  kind: K
): Extract<SemanticType, { kind: K }> {
  if (type.kind !== kind) throw new Error(`Expected a ${kind} node, received ${type.kind}`);
  // SAFETY: the guard above just verified the discriminant matches `kind`.
  return type as Extract<SemanticType, { kind: K }>;
}

describe("generic substitutions and aliases", () => {
  it("represents class, method, call-signature, and alias parameters with constraints and defaults", async () => {
    const result = await extract("generic-class.ts");
    const repository = expectKind(exportType(result.module, "Repository"), "class");
    // Upstream's class model carries declaration parameters as names only;
    // the constrained/defaulted parameter NODES live on method and call
    // signature slots (asserted below) and on every occurrence.
    expect(repository.typeParameters).toEqual([{ name: "T" }]);
    const find = repository.methods.find((method) => method.name === "find");
    expect(find?.callSignatures[0]?.typeParameters?.[0]).toMatchObject({ name: "K" });
    // The reset method's parameter shares the CLASS parameter's name but is
    // its own declaration.
    const reset = repository.methods.find((method) => method.name === "reset");
    expect(reset?.callSignatures[0]?.typeParameters?.[0]).toMatchObject({ name: "T" });
    const validator = expectKind(exportType(result.module, "Validator"), "function");
    expect(validator.callSignatures[0]?.typeParameters?.[0]).toMatchObject({
      name: "V",
      constraint: { kind: "intrinsic", intrinsic: "string" },
    });
  });

  it("substitutes one instantiation through properties, callbacks, containers, unions, intersections, and returns", async () => {
    const result = await extract("substitution-scope.ts");
    const wrapper = expectKind(exportType(result.module, "useWrapper"), "function");
    const parameter = wrapper.callSignatures[0]?.parameters[0]?.type;
    expect(parameter?.kind).toBe("object");
    // oxlint-disable-next-line typescript/prefer-optional-chain -- the narrowing guard doubles as a type predicate for the semantic union.
    if (parameter === undefined || parameter.kind !== "object") return;
    const byName = new Map(parameter.properties.map((property) => [property.name, property.type] as const));

    const source: SemanticType = {
      kind: "object",
      typeName: { name: "Source" },
      properties: [
        { name: "id", type: { kind: "intrinsic", intrinsic: "string" }, optional: false },
        {
          name: "tags",
          type: { kind: "array", elementType: { kind: "intrinsic", intrinsic: "string" } },
          optional: false,
        },
      ],
    };
    expect(byName.get("direct")).toEqual(source);
    const callback = byName.get("callback");
    // oxlint-disable-next-line typescript/prefer-optional-chain -- the narrowing guard doubles as a type predicate for the semantic union.
    if (callback !== undefined && callback.kind === "function")
      expect(callback.callSignatures[0]?.returnValueType).toEqual(source);
    expect(byName.get("container")).toEqual({ kind: "array", elementType: source });
    expect(byName.get("union")).toMatchObject({
      types: [source, { kind: "intrinsic", intrinsic: "null" }],
    });
    const intersection = byName.get("intersection");
    expect(intersection?.kind).toBe("intersection");
    if (intersection?.kind === "intersection")
      expect(intersection.types.some((member) => JSON.stringify(member) === JSON.stringify(source))).toBe(
        true
      );
    const returns = byName.get("returns");
    expect(
      // oxlint-disable-next-line typescript/prefer-optional-chain -- the narrowing guard doubles as a type predicate for the semantic union.
      returns && returns.kind === "function" ? returns.callSignatures[0]?.returnValueType : undefined
    ).toEqual(source);
  });

  it("keeps same-named parameters distinct by declaration scope", async () => {
    const result = await extract("substitution-scope.ts");
    const outer = exportType(result.module, "Outer");
    if (outer.kind !== "object") return;
    const byName = new Map(outer.properties.map((property) => [property.name, property.type]));
    // `inner` binds Outer's T to Source; `rebind` declares its own T, so its
    // identity must stay a bare parameter of the rebind signature.
    const inner = byName.get("inner");
    // Outer is itself generic and unresolved here, so its own parameter is
    // the argument — a distinct declaration identity from rebind's T below.
    expect(inner).toMatchObject({
      kind: "object",
      typeName: {
        name: "Inner",
        typeArguments: [{ type: { kind: "typeParameter", name: "T" } }],
      },
    });
    const rebind = byName.get("rebind");
    if (rebind?.kind !== "function") return;
    const parameter = rebind.callSignatures[0]?.parameters[0]?.type;
    expect(parameter).toMatchObject({ kind: "typeParameter", name: "T" });
    expect(rebind.callSignatures[0]?.returnValueType).toEqual(parameter);
  });

  it("resolves chained aliases without losing explicit arguments", async () => {
    const result = await extract("substitution-scope.ts");
    const chainStart = exportType(result.module, "ChainStart");
    // The checker stops flattening at `ChainMiddle<Source>` (the outermost
    // generic alias application), so the public name is ChainMiddle while the
    // ARGUMENTS prove both hops preserved the written `Source`.
    expect(chainStart).toMatchObject({
      typeName: {
        name: "ChainMiddle",
        typeArguments: [{ type: { kind: "object", typeName: { name: "Source" } } }],
      },
    });
    if (chainStart.kind !== "object") throw new Error("ChainStart must resolve to an object");
    const end = chainStart.properties.find((property) => property.name === "end");
    expect(end?.type).toEqual({
      kind: "array",
      elementType: {
        kind: "object",
        typeName: { name: "Source" },
        properties: [
          { name: "id", type: { kind: "intrinsic", intrinsic: "string" }, optional: false },
          {
            name: "tags",
            type: { kind: "array", elementType: { kind: "intrinsic", intrinsic: "string" } },
            optional: false,
          },
        ],
      },
    });
  });

  it("bounds recursive generic aliases with a per-extraction cut instead of diverging", async () => {
    const result = await extract("substitution-scope.ts");
    for (const name of ["RecursiveHolder", "SelfLoop"] as const) {
      const holder = exportType(result.module, name);
      // The cycle is cut at whatever depth it re-enters, but every level keeps
      // describing the substituted value.
      let current: SemanticType | undefined = holder;
      let depth = 0;
      // oxlint-disable-next-line typescript/prefer-optional-chain -- the narrowing guard doubles as a type predicate for the semantic union.
      while (current !== undefined && current.kind === "object" && depth < 12) {
        const next: SemanticType | undefined = current.properties.find(
          (property) => property.name === "next"
        )?.type;
        // oxlint-disable-next-line typescript/prefer-optional-chain -- the narrowing guard doubles as a type predicate for the semantic union.
        current = next !== undefined && next.kind === "object" ? next : undefined;
        depth += 1;
      }
      expect(depth).toBeGreaterThan(0);
      expect(depth).toBeLessThan(12);
    }
    // The bound is per extraction: a second run over the same file starts
    // from empty caches and produces an identical module.
    const again = await extract("substitution-scope.ts");
    expect(again.module).toEqual((await extract("substitution-scope.ts")).module);
  });

  it("reports the structured fallback warning for an unresolvable recursive cycle", async () => {
    // `Loop<T> = Loop<T>` never produces a finite structure, so the checker
    // itself collapses it — there is nothing for the per-extraction cut to
    // keep. Criterion 5's contract degrades such a cycle through the typed
    // fallback instead of dropping the exports or diverging.
    const result = await extract("unresolvable-cycle.ts");
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "unsupported-type-fallback",
      "unsupported-type-fallback",
    ]);
    const bySource = new Map(
      result.warnings.map((warning) => [
        warning.code === "unsupported-type-fallback" ? warning.sourceText : undefined,
        warning,
      ])
    );
    const declaration = bySource.get("Loop<T>");
    const instantiation = bySource.get("Loop<string>");
    // One warning per unresolvable entry point, each anchored at the alias
    // body it expands from and naming its exporting symbol on the stack.
    expect(declaration).toMatchObject({
      code: "unsupported-type-fallback",
      typeText: "any",
      line: 4,
      column: 23,
    });
    expect(declaration?.parsedSymbolStack.at(-1)).toBe("Loop");
    expect(instantiation).toMatchObject({
      code: "unsupported-type-fallback",
      typeText: "any",
      line: 6,
      column: 21,
    });
    expect(instantiation?.parsedSymbolStack.at(-1)).toBe("Value");
    for (const warning of result.warnings) {
      if (warning.code !== "unsupported-type-fallback") continue;
      expect(warning.parsedSymbolStack[0]?.endsWith("unresolvable-cycle.ts")).toBe(true);
    }
    // The degradation replaces the type; it does not remove the export.
    expect(exportType(result.module, "Value")).toEqual({ kind: "intrinsic", intrinsic: "any" });
  });

  it("pairs a generic tuple alias spread through its rebound parameters", async () => {
    const result = await extract("spread-pairing.ts");
    const paired = exportType(result.module, "PairedSpread");
    if (paired.kind !== "tuple") return;
    expect(paired.types[0]).toEqual({ kind: "intrinsic", intrinsic: "boolean" });
    expect(paired.types[1]).toEqual({ kind: "intrinsic", intrinsic: "string" });
    expect(paired.types[2]).toEqual({ kind: "intrinsic", intrinsic: "number" });
    const indirect = exportType(result.module, "IndirectSpread");
    if (indirect.kind !== "tuple") return;
    // Indirect<number> -> Tail<number> -> [number, number], then boolean.
    expect(indirect.types).toEqual([
      { kind: "intrinsic", intrinsic: "number" },
      { kind: "intrinsic", intrinsic: "number" },
      { kind: "intrinsic", intrinsic: "boolean" },
    ]);
  });

  it("preserves concrete keyof arguments on the alias while its instances flatten", async () => {
    // Since Issue 09's operator-first reconstruction, an authored `keyof Obj`
    // argument keeps the operator expression with its reduced key set on
    // `resolvedType` (upstream replays authored keyof syntax wherever it is
    // written). The INSTANTIATED members that consume the argument still
    // resolve to the flattened union — both facts, never one instead of the
    // other.
    const result = await extract("keyof-arguments.ts");
    const direct = expectKind(exportType(result.module, "direct"), "function");
    const argument = direct.callSignatures[0]?.parameters[0]?.type;
    expect(argument).toMatchObject({
      kind: "object",
      typeName: {
        name: "Box",
        typeArguments: [
          {
            type: {
              kind: "typeOperator",
              operator: "keyof",
              type: { kind: "object", typeName: { name: "Obj" }, properties: [] },
              resolvedType: {
                kind: "union",
                types: [
                  { kind: "literal", value: '"a"' },
                  { kind: "literal", value: '"b"' },
                ],
              },
              resolutionKind: "exact",
            },
          },
        ],
      },
      properties: [
        {
          name: "value",
          type: {
            kind: "union",
            types: [
              { kind: "literal", value: '"a"' },
              { kind: "literal", value: '"b"' },
            ],
          },
        },
      ],
    });
    const aliased = expectKind(exportType(result.module, "aliased"), "function");
    const aliasedArgument = aliased.callSignatures[0]?.parameters[0]?.type;
    expect(aliasedArgument).toMatchObject({
      kind: "object",
      typeName: {
        name: "Box",
        typeArguments: [
          {
            type: {
              kind: "union",
              typeName: { name: "Keys" },
            },
          },
        ],
      },
    });
    expect(result.warnings).toEqual([]);
  });
});
