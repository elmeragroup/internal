import type { CallSignatureNode, FunctionNode, SemanticType, TypeName, TypeParameterNode } from "../model.ts";
import { renderType, typeNameOf } from "./render.ts";

/** Right-to-left generic parameter renames scoped to one signature comparison. */
type TypeParameterRenames = ReadonlyMap<string, string>;

/**
 * Compares model types structurally for canonicalization. An unaliased `any` is
 * a wildcard, which lets a generated overload union prefer a concrete signature
 * over an otherwise identical fallback signature containing `any`.
 */
export function areEquivalentIgnoringAny(
  left: SemanticType,
  right: SemanticType,
  renames?: TypeParameterRenames
): boolean {
  return areEquivalent(left, right, true, renames);
}

/** Compares model types structurally without wildcard `any` matching. */
export function areEquivalentStrictly(
  left: SemanticType,
  right: SemanticType,
  renames?: TypeParameterRenames
): boolean {
  return areEquivalent(left, right, false, renames);
}

/** Compares two function models, including generic constraints and defaults. */
export function areFunctionsEquivalentIgnoringAny(
  left: FunctionNode,
  right: FunctionNode,
  renames?: TypeParameterRenames
): boolean {
  return areFunctionsEquivalent(left, right, true, renames);
}

/** Detects an intrinsic `any` anywhere in the model. */
export function containsAny(type: SemanticType): boolean {
  if (type.kind === "intrinsic") return type.intrinsic === "any";
  if (type.kind === "function") return type.callSignatures.some(signatureContainsAny);
  if (type.kind === "union" || type.kind === "intersection" || type.kind === "tuple")
    return type.types.some(containsAny);
  if (type.kind === "array") return containsAny(type.elementType);
  if (type.kind === "typeOperator") return containsAny(type.type) || containsAny(type.resolvedType);
  if (type.kind === "object")
    return (
      type.properties.some((property) => containsAny(property.type)) ||
      (type.indexSignature !== undefined && containsAny(type.indexSignature.valueType))
    );
  if (type.kind === "external")
    return (type.typeName.typeArguments ?? []).some((argument) => containsAny(argument.type));
  return false;
}

function signatureContainsAny(signature: CallSignatureNode): boolean {
  return (
    signature.parameters.some((parameter) => containsAny(parameter.type)) ||
    containsAny(signature.returnValueType) ||
    (signature.typeParameters ?? []).some(
      (parameter) =>
        (parameter.constraint !== undefined && containsAny(parameter.constraint)) ||
        (parameter.defaultValue !== undefined && containsAny(parameter.defaultValue))
    )
  );
}

function isUnaliasedAny(type: SemanticType): boolean {
  return type.kind === "intrinsic" && type.intrinsic === "any" && type.typeName === undefined;
}

function areEquivalent(
  left: SemanticType,
  right: SemanticType,
  anyIsWildcard: boolean,
  renames?: TypeParameterRenames
): boolean {
  if (anyIsWildcard && (isUnaliasedAny(left) || isUnaliasedAny(right))) return true;

  // Type parameters compare by identity so `<T>(value: T)` and `<U>(value: U)`
  // remain equivalent under a scoped alpha-rename, while a type parameter named
  // `string` never matches the intrinsic `string`.
  if (left.kind === "typeParameter" && right.kind === "typeParameter")
    return left.name === (renames?.get(right.name) ?? right.name);
  if (left.kind === "typeParameter" || right.kind === "typeParameter") return false;

  // Render-identity is a safe fast path for kinds whose rendering is lossless.
  if (
    (renames === undefined || renames.size === 0) &&
    !isRenderFastPathExcluded(left) &&
    !isRenderFastPathExcluded(right) &&
    renderType(left) === renderType(right)
  )
    return true;

  // Alias identity wins over shape: equal names with equal arguments match, and
  // an aliased form never matches its inline expansion.
  const leftName = typeNameOf(left);
  const rightName = typeNameOf(right);
  if (leftName !== undefined || rightName !== undefined) {
    return leftName !== undefined && rightName !== undefined
      ? typeNamesAreEquivalent(leftName, rightName, anyIsWildcard, renames)
      : false;
  }

  if (left.kind === "function" && right.kind === "function")
    return areFunctionsEquivalent(left, right, anyIsWildcard, renames);

  if (left.kind === "union" && right.kind === "union")
    return membersAreEquivalentUnordered(left.types, right.types, anyIsWildcard, renames);

  if (left.kind === "intersection" && right.kind === "intersection")
    return membersAreEquivalentUnordered(left.types, right.types, anyIsWildcard, renames);

  if (left.kind === "array" && right.kind === "array")
    return (
      areEquivalent(left.elementType, right.elementType, anyIsWildcard, renames) &&
      left.isReadonly === right.isReadonly
    );

  if (left.kind === "tuple" && right.kind === "tuple") {
    if (left.types.length !== right.types.length || left.isReadonly !== right.isReadonly) return false;
    return left.types.every((member, index) => {
      const other = right.types[index];
      return other !== undefined && areEquivalent(member, other, anyIsWildcard, renames);
    });
  }

  if (left.kind === "typeOperator" && right.kind === "typeOperator") {
    // A resolved operator payload can carry hundreds of keys and this comparison
    // runs pairwise during canonicalization. Reject different operands before
    // traversing that result. `any` inside authored operator syntax is semantic
    // (`keyof any`), never a generated fallback. The model has one operator, so
    // only the resolution provenance and the operand can differ today.
    if (left.resolutionKind !== right.resolutionKind || !areEquivalent(left.type, right.type, false, renames))
      return false;
    return areEquivalent(left.resolvedType, right.resolvedType, false, renames);
  }

  if (left.kind === "external" && right.kind === "external")
    return typeNamesAreEquivalent(left.typeName, right.typeName, anyIsWildcard, renames);

  if (left.kind === "object" && right.kind === "object")
    return objectsAreEquivalent(left, right, anyIsWildcard, renames);

  // Leaf models without nested type parameters fall back to rendering identity.
  return renderType(left) === renderType(right);
}

function areFunctionsEquivalent(
  left: FunctionNode,
  right: FunctionNode,
  anyIsWildcard: boolean,
  outerRenames?: TypeParameterRenames
): boolean {
  const leftName = left.typeName;
  const rightName = right.typeName;
  if ((leftName === undefined) !== (rightName === undefined)) return false;
  if (
    leftName !== undefined &&
    rightName !== undefined &&
    !typeNamesAreEquivalent(leftName, rightName, anyIsWildcard, outerRenames)
  )
    return false;

  if (left.callSignatures.length !== right.callSignatures.length) return false;

  return left.callSignatures.every((leftSignature, index) => {
    const rightSignature = right.callSignatures[index];
    return (
      rightSignature !== undefined &&
      signaturesAreEquivalent(leftSignature, rightSignature, anyIsWildcard, outerRenames)
    );
  });
}

function signaturesAreEquivalent(
  left: CallSignatureNode,
  right: CallSignatureNode,
  anyIsWildcard: boolean,
  outerRenames?: TypeParameterRenames
): boolean {
  const leftParameters = left.typeParameters ?? [];
  const rightParameters = right.typeParameters ?? [];
  const renames = signatureTypeParameterRenames(leftParameters, rightParameters, outerRenames);
  if (renames === undefined) return false;
  if (!typeParametersAreEquivalent(leftParameters, rightParameters, anyIsWildcard, renames)) return false;
  if (left.parameters.length !== right.parameters.length) return false;
  if (!areEquivalent(left.returnValueType, right.returnValueType, anyIsWildcard, renames)) return false;

  return left.parameters.every((leftParameter, index) => {
    const rightParameter = right.parameters[index];
    return (
      rightParameter !== undefined &&
      leftParameter.name === rightParameter.name &&
      leftParameter.optional === rightParameter.optional &&
      areEquivalent(leftParameter.type, rightParameter.type, anyIsWildcard, renames)
    );
  });
}

function typeParametersAreEquivalent(
  left: readonly TypeParameterNode[],
  right: readonly TypeParameterNode[],
  anyIsWildcard: boolean,
  renames: TypeParameterRenames
): boolean {
  return left.every((leftParameter, index) => {
    const rightParameter = right[index];
    if (rightParameter === undefined) return false;
    return (
      optionalTypesAreEquivalent(
        leftParameter.constraint,
        rightParameter.constraint,
        anyIsWildcard,
        renames
      ) &&
      optionalTypesAreEquivalent(
        leftParameter.defaultValue,
        rightParameter.defaultValue,
        anyIsWildcard,
        renames
      )
    );
  });
}

function optionalTypesAreEquivalent(
  left: SemanticType | undefined,
  right: SemanticType | undefined,
  anyIsWildcard: boolean,
  renames: TypeParameterRenames
): boolean {
  if (left !== undefined && right !== undefined) return areEquivalent(left, right, anyIsWildcard, renames);
  return left === undefined && right === undefined;
}

function signatureTypeParameterRenames(
  left: readonly TypeParameterNode[],
  right: readonly TypeParameterNode[],
  outerRenames?: TypeParameterRenames
): TypeParameterRenames | undefined {
  if (left.length !== right.length) return undefined;
  const renames = new Map<string, string>(outerRenames);
  for (const [index, parameter] of right.entries()) {
    const leftParameter = left[index];
    if (leftParameter !== undefined) renames.set(parameter.name, leftParameter.name);
  }
  return renames;
}

function typeNamesAreEquivalent(
  left: TypeName,
  right: TypeName,
  anyIsWildcard: boolean,
  renames?: TypeParameterRenames
): boolean {
  if (left.name !== right.name) return false;
  const leftNamespaces = left.namespaces ?? [];
  const rightNamespaces = right.namespaces ?? [];
  if (
    leftNamespaces.length !== rightNamespaces.length ||
    leftNamespaces.some((namespace, index) => namespace !== rightNamespaces[index])
  )
    return false;

  const leftArguments = left.typeArguments ?? [];
  const rightArguments = right.typeArguments ?? [];
  if (leftArguments.length !== rightArguments.length) return false;
  return leftArguments.every((argument, index) => {
    const other = rightArguments[index];
    return other !== undefined && areEquivalent(argument.type, other.type, anyIsWildcard, renames);
  });
}

function objectsAreEquivalent(
  left: Extract<SemanticType, { kind: "object" }>,
  right: Extract<SemanticType, { kind: "object" }>,
  anyIsWildcard: boolean,
  renames?: TypeParameterRenames
): boolean {
  if (left.properties.length !== right.properties.length) return false;
  const leftIndex = left.indexSignature;
  const rightIndex = right.indexSignature;
  if (leftIndex !== undefined && rightIndex !== undefined) {
    if (
      leftIndex.keyType !== rightIndex.keyType ||
      !areEquivalent(leftIndex.valueType, rightIndex.valueType, anyIsWildcard, renames)
    )
      return false;
  } else if (leftIndex !== undefined || rightIndex !== undefined) return false;

  const rightProperties = new Map(right.properties.map((property) => [propertyKey(property), property]));
  return left.properties.every((property) => {
    const other = rightProperties.get(propertyKey(property));
    return other !== undefined && areEquivalent(property.type, other.type, anyIsWildcard, renames);
  });
}

function propertyKey(property: { readonly name: string; readonly optional: boolean }): string {
  return `${property.name}:${String(property.optional)}`;
}

/**
 * Compares compound members as multisets. Canonicalized compounds normally
 * retain the same stable order on both sides, so the linear case is proven
 * first before building the bipartite graph reordered or wildcard-compatible
 * members require.
 */
function membersAreEquivalentUnordered(
  left: readonly SemanticType[],
  right: readonly SemanticType[],
  anyIsWildcard: boolean,
  renames?: TypeParameterRenames
): boolean {
  const size = left.length;
  if (size !== right.length) return false;
  if (size === 0) return true;

  const pairsAt = (index: number): readonly [SemanticType, SemanticType] | undefined => {
    const leftMember = left[index];
    const rightMember = right[index];
    return leftMember === undefined || rightMember === undefined ? undefined : [leftMember, rightMember];
  };
  let matchesInOrder = true;
  for (let index = 0; index < size; index += 1) {
    const pair = pairsAt(index);
    if (pair === undefined || !areEquivalent(pair[0], pair[1], anyIsWildcard, renames)) {
      matchesInOrder = false;
      break;
    }
  }
  if (matchesInOrder) return true;

  // A cheap key-multiset pre-check runs before the bipartite match, but only
  // when neither wildcard `any` nor a rename map can make the keys unsafe.
  const hasWildcard = anyIsWildcard && [...left, ...right].some(isUnaliasedAny);
  const hasRenames = renames !== undefined && renames.size > 0;
  if (!hasWildcard && !hasRenames && !structuralKeyMultisetsMatch(left, right)) return false;

  const adjacency = left.map((leftMember) =>
    right.flatMap((rightMember, index) =>
      areEquivalent(leftMember, rightMember, anyIsWildcard, renames) ? [index] : []
    )
  );
  return hasCompleteMatching(adjacency, size);
}

function hasCompleteMatching(adjacency: readonly (readonly number[])[], size: number): boolean {
  const matched = new Array<number>(size).fill(-1);
  const augment = (leftIndex: number, visited: boolean[]): boolean => {
    for (const rightIndex of adjacency[leftIndex] ?? []) {
      if (visited[rightIndex] === true) continue;
      visited[rightIndex] = true;
      const owner = matched[rightIndex];
      if (owner === undefined || owner === -1 || augment(owner, visited)) {
        matched[rightIndex] = leftIndex;
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < size; index += 1) {
    if (!augment(index, new Array<boolean>(size).fill(false))) return false;
  }
  return true;
}

function structuralKeyMultisetsMatch(left: readonly SemanticType[], right: readonly SemanticType[]): boolean {
  const leftCounts = countStructuralKeys(left);
  const rightCounts = countStructuralKeys(right);
  if (leftCounts.size !== rightCounts.size) return false;
  for (const [key, count] of leftCounts) {
    if (rightCounts.get(key) !== count) return false;
  }
  return true;
}

function countStructuralKeys(types: readonly SemanticType[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const type of types) {
    const key = memberStructuralKey(type);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function memberStructuralKey(type: SemanticType): string {
  const name = "name" in type ? type.name : "";
  const value = type.kind === "literal" ? String(type.value) : "";
  const intrinsic = type.kind === "intrinsic" ? `|${type.intrinsic}` : "";
  return `${type.kind}|${name}|${value}${intrinsic}`;
}

/**
 * Kinds whose rendering is lossy enough that equal text does not imply
 * equivalence: function signatures omit constraints and defaults, and compounds
 * plus type operators carry member identity the rendered form flattens away.
 */
function isRenderFastPathExcluded(type: SemanticType): boolean {
  return (
    type.kind === "function" ||
    type.kind === "typeOperator" ||
    type.kind === "union" ||
    type.kind === "intersection"
  );
}
