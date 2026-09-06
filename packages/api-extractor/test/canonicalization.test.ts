import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  canonicalizeIntersectionMembers,
  canonicalizeUnionMembers,
  intersectionType,
  unionType,
} from "../src/canonical/canonicalize.ts";
import {
  areEquivalentIgnoringAny,
  areEquivalentStrictly,
  containsAny,
} from "../src/canonical/equivalence.ts";
import { renderType } from "../src/canonical/render.ts";
import { SemanticTypeSchema } from "../src/index.ts";
import type { SemanticType } from "../src/index.ts";

const stringType: SemanticType = { kind: "intrinsic", intrinsic: "string" };
const numberType: SemanticType = { kind: "intrinsic", intrinsic: "number" };
const nullType: SemanticType = { kind: "intrinsic", intrinsic: "null" };
const undefinedType: SemanticType = { kind: "intrinsic", intrinsic: "undefined" };
const neverType: SemanticType = { kind: "intrinsic", intrinsic: "never" };
const anyType: SemanticType = { kind: "intrinsic", intrinsic: "any" };
const trueLiteral: SemanticType = { kind: "literal", value: "true" };
const falseLiteral: SemanticType = { kind: "literal", value: "false" };

function literal(value: string): SemanticType {
  return { kind: "literal", value: `"${value}"` };
}

function object(name: string, type: SemanticType): SemanticType {
  return { kind: "object", properties: [{ name, type, optional: false }] };
}

function callback(parameterType: SemanticType): SemanticType {
  return {
    kind: "function",
    callSignatures: [
      {
        parameters: [{ name: "value", type: parameterType, optional: false }],
        returnValueType: { kind: "intrinsic", intrinsic: "void" },
      },
    ],
  };
}

function keyofOperator(operand: SemanticType): SemanticType {
  return {
    kind: "typeOperator",
    operator: "keyof",
    type: operand,
    resolvedType: { kind: "intrinsic", intrinsic: "string" },
    resolutionKind: "exact",
  };
}

/** Every permutation of a member list, used to state order-independence laws. */
function permutations(members: readonly SemanticType[]): readonly (readonly SemanticType[])[] {
  if (members.length <= 1) return [members];
  return members.flatMap((member, index) =>
    permutations([...members.slice(0, index), ...members.slice(index + 1)]).map((rest) => [member, ...rest])
  );
}

describe("Issue 04 union and intersection canonicalization laws", () => {
  it("is idempotent for unions and intersections", () => {
    const members = [
      literal("b"),
      undefinedType,
      literal("a"),
      literal("b"),
      nullType,
      { kind: "union", types: [numberType, stringType] } satisfies SemanticType,
    ];
    const once = canonicalizeUnionMembers(members);
    expect(canonicalizeUnionMembers(once)).toEqual(once);

    const intersectionMembers = [
      object("a", stringType),
      { kind: "intersection", types: [object("b", numberType)], properties: [] } satisfies SemanticType,
    ];
    const intersectionOnce = canonicalizeIntersectionMembers(intersectionMembers);
    expect(canonicalizeIntersectionMembers(intersectionOnce)).toEqual(intersectionOnce);
  });

  it("places null and undefined last from every input order", () => {
    for (const members of permutations([stringType, nullType, undefinedType])) {
      expect(canonicalizeUnionMembers(members)).toEqual([stringType, nullType, undefinedType]);
    }
  });

  it("places an aliased null and undefined last as well", () => {
    const aliasedNull: SemanticType = {
      kind: "intrinsic",
      intrinsic: "null",
      typeName: { name: "Nullable" },
    };
    const aliasedUndefined: SemanticType = {
      kind: "intrinsic",
      intrinsic: "undefined",
      typeName: { name: "Missing" },
    };
    for (const members of permutations([stringType, aliasedNull, aliasedUndefined])) {
      expect(canonicalizeUnionMembers(members)).toEqual([stringType, aliasedNull, aliasedUndefined]);
    }
    // An aliased `never` still keeps its public name, unlike an unaliased one.
    const aliasedNever: SemanticType = {
      kind: "intrinsic",
      intrinsic: "never",
      typeName: { name: "Impossible" },
    };
    expect(canonicalizeUnionMembers([stringType, aliasedNever])).toEqual([stringType, aliasedNever]);
  });

  it("treats reordered members as equivalent for unions and intersections", () => {
    const left = unionType(undefined, [stringType, numberType]);
    const right = unionType(undefined, [numberType, stringType]);
    expect(areEquivalentStrictly(left, right)).toBe(true);

    const leftIntersection = intersectionType(
      undefined,
      [object("a", stringType), object("b", numberType)],
      []
    );
    const rightIntersection = intersectionType(
      undefined,
      [object("b", numberType), object("a", stringType)],
      []
    );
    expect(areEquivalentStrictly(leftIntersection, rightIntersection)).toBe(true);
  });

  it("serializes every permutation of an order-independent union identically", () => {
    const encoded = new Set(
      permutations([literal("a"), literal("b"), undefinedType]).map((members) =>
        JSON.stringify(unionType(undefined, canonicalizeUnionMembers(members)))
      )
    );
    expect([...encoded]).toHaveLength(2);
    expect(
      [...encoded].every((value) => value.includes('{"kind":"intrinsic","intrinsic":"undefined"}]}'))
    ).toBe(true);
  });

  it("removes equivalent duplicates by stable key and keeps distinct members", () => {
    expect(canonicalizeUnionMembers([literal("a"), literal("a"), literal("b")])).toEqual([
      literal("a"),
      literal("b"),
    ]);
    expect(canonicalizeUnionMembers([stringType, { kind: "intrinsic", intrinsic: "string" }])).toEqual([
      stringType,
    ]);
    expect(canonicalizeUnionMembers([keyofOperator(stringType), keyofOperator(stringType)])).toEqual([
      keyofOperator(stringType),
    ]);
    expect(canonicalizeUnionMembers([object("a", stringType), object("a", stringType)])).toHaveLength(2);
  });

  it("prefers a concrete overload over an equivalent signature containing any", () => {
    const withAny = callback(anyType);
    const concrete = callback(stringType);
    expect(canonicalizeUnionMembers([withAny, concrete])).toEqual([concrete]);
    expect(canonicalizeUnionMembers([concrete, withAny])).toEqual([concrete]);
    expect(containsAny(withAny)).toBe(true);
    expect(areEquivalentIgnoringAny(withAny, concrete)).toBe(true);
    expect(areEquivalentStrictly(withAny, concrete)).toBe(false);
  });

  it("flattens unaliased nested compounds and preserves aliased ones", () => {
    const nested: SemanticType = { kind: "union", types: [numberType, stringType] };
    expect(canonicalizeUnionMembers([nested, undefinedType])).toEqual([
      numberType,
      stringType,
      undefinedType,
    ]);

    const aliased: SemanticType = { kind: "union", typeName: { name: "Alias" }, types: [numberType] };
    expect(canonicalizeUnionMembers([aliased, undefinedType])).toEqual([aliased, undefinedType]);
  });

  it("collapses a boolean literal pair and removes redundant never members", () => {
    expect(canonicalizeUnionMembers([trueLiteral, falseLiteral])).toEqual([
      { kind: "intrinsic", intrinsic: "boolean" },
    ]);
    expect(canonicalizeUnionMembers([falseLiteral, stringType, trueLiteral])).toEqual([
      { kind: "intrinsic", intrinsic: "boolean" },
      stringType,
    ]);
    expect(canonicalizeUnionMembers([stringType, neverType, nullType])).toEqual([stringType, nullType]);
    expect(canonicalizeUnionMembers([neverType])).toEqual([neverType]);
    expect(canonicalizeUnionMembers([neverType, neverType])).toEqual([neverType]);
  });

  it("keeps a declared compound while collapsing one authored member", () => {
    expect(unionType(undefined, [stringType])).toEqual(stringType);
    expect(unionType({ name: "Alias" }, [neverType, stringType])).toEqual({
      kind: "union",
      typeName: { name: "Alias" },
      types: [stringType],
    });
    expect(intersectionType(undefined, [object("a", stringType)], [])).toEqual(object("a", stringType));
  });

  it("keeps canonical output schema-decodable and stable across repeated runs", () => {
    const value = unionType({ name: "Alias" }, [
      { kind: "union", types: [literal("a"), literal("a")] },
      nullType,
      undefinedType,
    ]);
    // SAFETY: JSON.parse returns unknown-shaped data that the schema decodes below.
    const encoded = JSON.parse(JSON.stringify(value)) as unknown;
    expect(Schema.decodeUnknownSync(SemanticTypeSchema)(encoded)).toEqual(value);
    expect(JSON.stringify(unionType({ name: "Alias" }, [literal("a"), nullType, undefinedType]))).toBe(
      JSON.stringify(value)
    );
  });

  it("renders compound members with the upstream string form", () => {
    expect(renderType(unionType(undefined, [stringType, undefinedType]))).toBe("(string | undefined)");
    expect(renderType(unionType({ name: "Alias" }, [stringType, numberType]))).toBe("Alias");
    expect(
      renderType(intersectionType(undefined, [object("a", stringType), object("b", numberType)], []))
    ).toBe("({ a: string } & { b: number })");
    expect(renderType(keyofOperator(object("a", stringType)))).toBe("keyof { a: string }");
    expect(renderType(literal("a"))).toBe('"\\"a\\""');
  });

  it("compares equivalent generic signatures under an alpha rename", () => {
    const identity = (name: string): SemanticType => ({
      kind: "function",
      callSignatures: [
        {
          parameters: [{ name: "value", type: { kind: "typeParameter", name }, optional: false }],
          returnValueType: { kind: "typeParameter", name },
          typeParameters: [{ kind: "typeParameter", name }],
        },
      ],
    });
    expect(areEquivalentStrictly(identity("T"), identity("U"))).toBe(true);
    expect(canonicalizeUnionMembers([identity("T"), identity("U")])).toEqual([identity("T")]);
    expect(areEquivalentStrictly({ kind: "typeParameter", name: "string" }, stringType)).toBe(false);
  });
});
