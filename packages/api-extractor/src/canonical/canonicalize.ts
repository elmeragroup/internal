import type { IntersectionNode, PropertyNode, SemanticType, TypeName, UnionNode } from "../model.ts";
import { definedFields } from "../optional-fields.ts";
import { areEquivalentStrictly, areFunctionsEquivalentIgnoringAny, containsAny } from "./equivalence.ts";
import { renderTypeName } from "./render.ts";

type CompoundKind = "union" | "intersection";

/**
 * Canonicalizes members before a union model is constructed.
 *
 * Flattening, boolean and `never` simplification, stable ordering, and
 * deduplication run in the upstream order because each step assumes the
 * previous one has already normalized the list.
 */
export function canonicalizeUnionMembers(types: readonly SemanticType[]): readonly SemanticType[] {
  const members = flattenCompoundMembers(types, "union");
  const withBoolean = simplifyBooleanLiterals(members);
  const withoutNever = removeRedundantNever(withBoolean);
  return deduplicateMembers(sortMembers(withoutNever));
}

/** Canonicalizes members before an intersection model is constructed. */
export function canonicalizeIntersectionMembers(types: readonly SemanticType[]): readonly SemanticType[] {
  return deduplicateMembers(sortMembers(flattenCompoundMembers(types, "intersection")));
}

/**
 * Builds a canonical union.
 *
 * A single authored member replaces the compound entirely, which is how one
 * resolved member collapses to its own model instead of a one-member union.
 * Members that merge away during canonicalization keep the union node, so a
 * declared compound never silently loses its identity.
 */
export function unionType(typeName: TypeName | undefined, types: readonly SemanticType[]): SemanticType {
  const single = types.length === 1 ? types[0] : undefined;
  if (single !== undefined) return single;
  const name = publicName(typeName);
  const node: UnionNode = {
    kind: "union",
    types: canonicalizeUnionMembers(types),
    ...definedFields({ typeName: name }),
  };
  return node;
}

/** Builds a canonical intersection with its merged aggregate property list. */
export function intersectionType(
  typeName: TypeName | undefined,
  types: readonly SemanticType[],
  properties: readonly PropertyNode[]
): SemanticType {
  const single = types.length === 1 ? types[0] : undefined;
  if (single !== undefined) return single;
  const name = publicName(typeName);
  const node: IntersectionNode = {
    kind: "intersection",
    types: canonicalizeIntersectionMembers(types),
    properties: [...properties],
    ...definedFields({ typeName: name }),
  };
  return node;
}

/**
 * Flattens nested unaliased compounds of the same kind. An aliased compound is
 * preserved because its public name is part of the API identity.
 */
function flattenCompoundMembers(types: readonly SemanticType[], kind: CompoundKind): readonly SemanticType[] {
  return types.flatMap((type) =>
    type.kind === kind && type.typeName === undefined ? flattenCompoundMembers(type.types, kind) : [type]
  );
}

/**
 * Keeps `null` and `undefined` at the end of a member list for stable rendering
 * while leaving the authored order of the remaining members intact. An aliased
 * `null` or `undefined` moves too: its position, unlike its name, is not part of
 * the public identity.
 */
function sortMembers(members: readonly SemanticType[]): readonly SemanticType[] {
  return moveIntrinsicToEnd(moveIntrinsicToEnd(members, "null"), "undefined");
}

function moveIntrinsicToEnd(
  members: readonly SemanticType[],
  intrinsic: "null" | "undefined"
): readonly SemanticType[] {
  const index = members.findIndex((member) => member.kind === "intrinsic" && member.intrinsic === intrinsic);
  if (index === -1) return members;
  const moved = members[index];
  if (moved === undefined) return members;
  return [...members.slice(0, index), ...members.slice(index + 1), moved];
}

/**
 * Removes structurally duplicate members while preserving order. Functions and
 * type operators use the equivalence checker; a concrete overload signature wins
 * over an otherwise identical signature containing an `any` fallback. Scalar
 * models use cheap stable keys and every other model keeps identity semantics.
 */
function deduplicateMembers(types: readonly SemanticType[]): readonly SemanticType[] {
  const result: SemanticType[] = [];
  const functionIndexes: number[] = [];
  const typeOperatorIndexes: number[] = [];
  const seenKeys = new Set<string>();
  const seenIdentities = new Set<SemanticType>();

  for (const type of types) {
    if (type.kind === "function") {
      const existingIndex = functionIndexes.find((index) => {
        const existing = result[index];
        return existing?.kind === "function" && areFunctionsEquivalentIgnoringAny(existing, type);
      });
      if (existingIndex === undefined) {
        functionIndexes.push(result.length);
        result.push(type);
        continue;
      }
      const existing = result[existingIndex];
      if (existing !== undefined && containsAny(existing) && !containsAny(type)) {
        result[existingIndex] = type;
      }
      continue;
    }

    if (type.kind === "typeOperator") {
      const alreadyIncluded = typeOperatorIndexes.some((index) => {
        const existing = result[index];
        return existing !== undefined && areEquivalentStrictly(existing, type);
      });
      if (!alreadyIncluded) {
        typeOperatorIndexes.push(result.length);
        result.push(type);
      }
      continue;
    }

    const key = scalarMemberKey(type);
    if (key === undefined) {
      if (!seenIdentities.has(type)) {
        seenIdentities.add(type);
        result.push(type);
      }
      continue;
    }
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      result.push(type);
    }
  }

  return result;
}

/**
 * Stable deduplication key for scalar members. Every other model keeps
 * identity-based deduplication, matching upstream behavior for object,
 * compound, array, tuple, class, and component members.
 */
function scalarMemberKey(type: SemanticType): string | undefined {
  if (type.kind === "literal") return `literal:${String(type.value)}`;
  if (type.kind === "external") return `external:${renderTypeName(type.typeName)}`;
  if (type.kind === "typeParameter") return `typeparam:${type.name}`;
  if (type.kind === "intrinsic")
    return `intrinsic:${type.typeName === undefined ? type.intrinsic : renderTypeName(type.typeName)}`;
  return undefined;
}

/** Replaces a `true`/`false` literal pair with the `boolean` intrinsic. */
function simplifyBooleanLiterals(members: readonly SemanticType[]): readonly SemanticType[] {
  const trueIndex = members.findIndex((member) => isBooleanLiteral(member, "true"));
  const falseIndex = members.findIndex((member) => isBooleanLiteral(member, "false"));
  if (trueIndex === -1 || falseIndex === -1) return members;
  const booleanNode: SemanticType = { kind: "intrinsic", intrinsic: "boolean" };
  const keptIndex = Math.min(trueIndex, falseIndex);
  const removedIndex = Math.max(trueIndex, falseIndex);
  return members.flatMap((member, index) =>
    index === removedIndex ? [] : index === keptIndex ? [booleanNode] : [member]
  );
}

/** Removes unaliased `never` members when another member remains. */
function removeRedundantNever(members: readonly SemanticType[]): readonly SemanticType[] {
  if (members.length <= 1) return members;
  const remaining = members.filter((member) => !isPlainIntrinsic(member, "never"));
  return remaining.length === 0 ? members : remaining;
}

/**
 * An unaliased intrinsic. Only `never` removal uses this: dropping an aliased
 * `never` would erase a public name, while reordering one does not.
 */
function isPlainIntrinsic(type: SemanticType, intrinsic: "never"): boolean {
  return type.kind === "intrinsic" && type.intrinsic === intrinsic && type.typeName === undefined;
}

/**
 * Upstream renders a boolean literal type as the string `"true"` or `"false"`,
 * and that authored form is what collapses to the `boolean` intrinsic. A raw
 * boolean value reaches the model only through the reviewed TypeScript 7
 * external-graph divergence, which is not re-interpreted here.
 */
function isBooleanLiteral(type: SemanticType, value: "true" | "false"): boolean {
  return type.kind === "literal" && type.value === value;
}

function publicName(typeName: TypeName | undefined): TypeName | undefined {
  return typeName === undefined || typeName.name === "" ? undefined : typeName;
}
