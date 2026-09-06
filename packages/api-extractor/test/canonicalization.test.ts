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
import type { CallSignatureNode, SemanticType, TypeParameterNode } from "../src/index.ts";
import { definedFields } from "../src/optional-fields.ts";

const stringType: SemanticType = { kind: "intrinsic", intrinsic: "string" };
const numberType: SemanticType = { kind: "intrinsic", intrinsic: "number" };
const nullType: SemanticType = { kind: "intrinsic", intrinsic: "null" };
const undefinedType: SemanticType = { kind: "intrinsic", intrinsic: "undefined" };
const neverType: SemanticType = { kind: "intrinsic", intrinsic: "never" };
const anyType: SemanticType = { kind: "intrinsic", intrinsic: "any" };
const voidType: SemanticType = { kind: "intrinsic", intrinsic: "void" };
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

function keyofOperator(operand: SemanticType, resolvedType: SemanticType = stringType): SemanticType {
  return {
    kind: "typeOperator",
    operator: "keyof",
    type: operand,
    resolvedType,
    resolutionKind: "exact",
  };
}

function declaredParameter(
  name: string,
  options?: { readonly constraint?: SemanticType; readonly defaultValue?: SemanticType }
): TypeParameterNode {
  return {
    kind: "typeParameter",
    name,
    ...definedFields({
      constraint: options?.constraint,
      defaultValue: options?.defaultValue,
    }),
  };
}

function parameter(name: string): SemanticType {
  return { kind: "typeParameter", name };
}

function genericSignature(
  typeParameters: readonly TypeParameterNode[],
  value: SemanticType,
  returnValue: SemanticType = voidType
): SemanticType {
  return {
    kind: "function",
    callSignatures: [
      {
        typeParameters: [...typeParameters],
        parameters: [{ name: "value", type: value, optional: false }],
        returnValueType: returnValue,
      },
    ],
  };
}

function genericIdentity(
  name: string,
  options?: { readonly constraint?: SemanticType; readonly defaultValue?: SemanticType }
): SemanticType {
  return genericSignature([declaredParameter(name, options)], parameter(name), parameter(name));
}

function nestedGeneric(outer: string, inner: string, innerValue: string): SemanticType {
  return genericSignature(
    [declaredParameter(outer)],
    genericSignature([declaredParameter(inner)], parameter(innerValue), parameter(inner))
  );
}

function arrayOf(element: SemanticType): SemanticType {
  return { kind: "array", elementType: element };
}

function tupleOf(element: SemanticType): SemanticType {
  return { kind: "tuple", types: [element] };
}

function namedArgument(name: string, argument: SemanticType): SemanticType {
  return {
    kind: "external",
    typeName: { name, typeArguments: [{ type: argument, equalToDefault: false }] },
  };
}

function unionMembers(...types: SemanticType[]): SemanticType {
  return { kind: "union", types };
}

function intersectionMembers(...types: SemanticType[]): SemanticType {
  return { kind: "intersection", types, properties: [] };
}

function signature(
  typeParameters: readonly TypeParameterNode[],
  value: SemanticType,
  returnValue: SemanticType
): CallSignatureNode {
  return {
    typeParameters: [...typeParameters],
    parameters: [{ name: "value", type: value, optional: false }],
    returnValueType: returnValue,
  };
}

function expectEquivalent(left: SemanticType, right: SemanticType): void {
  expect(areEquivalentStrictly(left, right)).toBe(true);
  expect(areEquivalentStrictly(right, left)).toBe(true);
  expect(areEquivalentIgnoringAny(left, right)).toBe(true);
  expect(areEquivalentIgnoringAny(right, left)).toBe(true);
}

function expectDistinct(left: SemanticType, right: SemanticType): void {
  expect(areEquivalentStrictly(left, right)).toBe(false);
  expect(areEquivalentStrictly(right, left)).toBe(false);
  expect(areEquivalentIgnoringAny(left, right)).toBe(false);
  expect(areEquivalentIgnoringAny(right, left)).toBe(false);
}

function expectWildcardEquivalent(left: SemanticType, right: SemanticType): void {
  expect(areEquivalentIgnoringAny(left, right)).toBe(true);
  expect(areEquivalentIgnoringAny(right, left)).toBe(true);
  expect(areEquivalentStrictly(left, right)).toBe(false);
  expect(areEquivalentStrictly(right, left)).toBe(false);
}

function expectUnionMemberCount(members: readonly SemanticType[], count: number): void {
  const once = canonicalizeUnionMembers(members);
  expect(once).toHaveLength(count);
  expect(canonicalizeUnionMembers([...members].reverse())).toHaveLength(count);
  expect(canonicalizeUnionMembers(once)).toEqual(once);
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

describe("generic signature identity during canonicalization", () => {
  const stringIdentity = genericIdentity("T", { constraint: stringType });
  const numberIdentity = genericIdentity("T", { constraint: numberType });
  const stringDefault = genericIdentity("T", { constraint: stringType, defaultValue: stringType });
  const numberDefault = genericIdentity("T", { constraint: stringType, defaultValue: numberType });

  it("keeps direct generic constraints distinct and still alpha-renames one scope", () => {
    expectDistinct(stringIdentity, numberIdentity);
    expectEquivalent(genericIdentity("T"), genericIdentity("U"));
    expectEquivalent(stringIdentity, genericIdentity("U", { constraint: stringType }));
    expectUnionMemberCount([stringIdentity, numberIdentity], 2);
    expectUnionMemberCount([genericIdentity("T"), genericIdentity("U")], 1);
  });

  it("does not treat nested string and number constraints as identical", () => {
    const stringObject = object("fn", stringIdentity);
    const numberObject = object("fn", numberIdentity);
    expectDistinct(stringObject, numberObject);
    expectDistinct(callback(stringObject), callback(numberObject));
    expectDistinct(arrayOf(stringIdentity), arrayOf(numberIdentity));
    expectDistinct(tupleOf(stringIdentity), tupleOf(numberIdentity));
    expectDistinct(namedArgument("Box", stringIdentity), namedArgument("Box", numberIdentity));
    expectUnionMemberCount([callback(stringObject), callback(numberObject)], 2);
  });

  it("does not treat nested distinct generic defaults as identical", () => {
    expectDistinct(object("fn", stringDefault), object("fn", numberDefault));
    expectDistinct(callback(object("fn", stringDefault)), callback(object("fn", numberDefault)));
    expectDistinct(arrayOf(stringDefault), arrayOf(numberDefault));
    expectDistinct(tupleOf(stringDefault), tupleOf(numberDefault));
    expectDistinct(namedArgument("Box", stringDefault), namedArgument("Box", numberDefault));
    expectUnionMemberCount([callback(object("fn", stringDefault)), callback(object("fn", numberDefault))], 2);
  });

  it("compares nested operators by resolved keys, not by rendered operands", () => {
    const operand = object("a", stringType);
    const left = object("keys", keyofOperator(operand, literal("a")));
    const right = object("keys", keyofOperator(operand, literal("b")));
    expectDistinct(left, right);
    expectDistinct(callback(left), callback(right));
    expectUnionMemberCount([callback(left), callback(right)], 2);
  });

  it("keeps equivalent nested alpha-renaming and shadowing", () => {
    expectEquivalent(object("fn", genericIdentity("T")), object("fn", genericIdentity("U")));
    expectEquivalent(nestedGeneric("T", "T", "T"), nestedGeneric("U", "V", "V"));
    expectUnionMemberCount(
      [callback(object("fn", genericIdentity("T"))), callback(object("fn", genericIdentity("U")))],
      1
    );
    expectUnionMemberCount([nestedGeneric("T", "T", "T"), nestedGeneric("U", "V", "V")], 1);
  });

  it("treats an inner parameter as distinct from an outer parameter of the same spelling", () => {
    const innerBound = nestedGeneric("T", "T", "T");
    const outerBound = nestedGeneric("U", "V", "U");
    expectDistinct(innerBound, outerBound);
    expectUnionMemberCount([innerBound, outerBound], 2);
  });

  it("does not match a bound generic to a free parameter of the same name", () => {
    expectDistinct(
      genericSignature([declaredParameter("T")], parameter("T"), parameter("T")),
      genericSignature([declaredParameter("U")], parameter("T"), parameter("U"))
    );
    expectDistinct(
      genericSignature([declaredParameter("T")], parameter("T"), parameter("T")),
      genericSignature([declaredParameter("T")], parameter("U"), parameter("T"))
    );
  });

  it("compares constraints and defaults that refer to outer and earlier parameters", () => {
    const earlier = genericSignature(
      [declaredParameter("T"), declaredParameter("U", { constraint: parameter("T") })],
      parameter("U"),
      parameter("U")
    );
    const earlierRenamed = genericSignature(
      [declaredParameter("A"), declaredParameter("B", { constraint: parameter("A") })],
      parameter("B"),
      parameter("B")
    );
    const earlierConcrete = genericSignature(
      [declaredParameter("A"), declaredParameter("B", { constraint: stringType })],
      parameter("B"),
      parameter("B")
    );
    expectEquivalent(earlier, earlierRenamed);
    expectDistinct(earlier, earlierConcrete);

    const outerConstraint = genericSignature(
      [declaredParameter("T")],
      genericSignature(
        [declaredParameter("U", { constraint: parameter("T") })],
        parameter("U"),
        parameter("U")
      )
    );
    const outerConstraintRenamed = genericSignature(
      [declaredParameter("A")],
      genericSignature(
        [declaredParameter("B", { constraint: parameter("A") })],
        parameter("B"),
        parameter("B")
      )
    );
    const innerDefault = genericSignature(
      [declaredParameter("T")],
      genericSignature(
        [declaredParameter("U", { defaultValue: parameter("T") })],
        parameter("U"),
        parameter("U")
      )
    );
    const innerDefaultRenamed = genericSignature(
      [declaredParameter("A")],
      genericSignature(
        [declaredParameter("B", { defaultValue: parameter("A") })],
        parameter("B"),
        parameter("B")
      )
    );
    expectEquivalent(outerConstraint, outerConstraintRenamed);
    expectEquivalent(innerDefault, innerDefaultRenamed);
    expectDistinct(
      innerDefault,
      genericSignature(
        [declaredParameter("A")],
        genericSignature(
          [declaredParameter("B", { defaultValue: stringType })],
          parameter("B"),
          parameter("B")
        )
      )
    );
  });

  it("does not leak bindings across sibling signatures", () => {
    const left: SemanticType = {
      kind: "function",
      callSignatures: [
        signature([declaredParameter("T")], parameter("T"), parameter("T")),
        signature([declaredParameter("U")], parameter("T"), parameter("U")),
      ],
    };
    const right: SemanticType = {
      kind: "function",
      callSignatures: [
        signature([declaredParameter("V")], parameter("V"), parameter("V")),
        signature([declaredParameter("W")], parameter("T"), parameter("W")),
      ],
    };
    expectEquivalent(left, right);
  });

  it("treats reordered unions and intersections as equivalent under paired bindings", () => {
    const leftUnion = genericSignature([declaredParameter("T")], unionMembers(parameter("T"), stringType));
    const rightUnion = genericSignature([declaredParameter("U")], unionMembers(stringType, parameter("U")));
    expectEquivalent(leftUnion, rightUnion);
    expectWildcardEquivalent(
      genericSignature([declaredParameter("T")], unionMembers(parameter("T"), anyType)),
      genericSignature([declaredParameter("U")], unionMembers(stringType, parameter("U")))
    );

    const leftIntersection = genericSignature(
      [declaredParameter("T")],
      intersectionMembers(parameter("T"), stringType)
    );
    const rightIntersection = genericSignature(
      [declaredParameter("U")],
      intersectionMembers(stringType, parameter("U"))
    );
    expectEquivalent(leftIntersection, rightIntersection);
    expectUnionMemberCount([leftUnion, rightUnion], 1);
  });

  it("keeps concrete-over-any preference and does not equate any with a bound name by rendering", () => {
    const withAny = callback(anyType);
    const concrete = callback(stringType);
    expect(canonicalizeUnionMembers([withAny, concrete])).toEqual([concrete]);
    expect(canonicalizeUnionMembers([concrete, withAny])).toEqual([concrete]);
    expectWildcardEquivalent(withAny, concrete);
    expectWildcardEquivalent(
      genericSignature([declaredParameter("T")], parameter("T"), parameter("T")),
      genericSignature([declaredParameter("T")], anyType, parameter("T"))
    );
  });
});
