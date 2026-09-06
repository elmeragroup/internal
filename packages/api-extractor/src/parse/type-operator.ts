import type {
  BackendNodeReference,
  BackendSymbolHandle,
  BackendTypeFacts,
  BackendTypeHandle,
} from "../backend/contracts.ts";
import { unionType, canonicalizeUnionMembers } from "../canonical/canonicalize.ts";
import type { SemanticType, TypeName, TypeOperatorResolutionKind } from "../model.ts";
import { definedFields } from "../optional-fields.ts";
import type { TypeFlagName } from "../warnings.ts";
import { maxKeyofAliasHops, unwrapAuthoredNode } from "./authored-node.ts";
import type { ResolveSemanticType, ResolverContext } from "./contracts.ts";
import { externalTypeSelectionAllowsSymbol } from "./external-type-selection.ts";
import { unsupported } from "./fallback.ts";
import { isExternalSymbol, isTypeScriptToolchainDeclaration } from "./ownership.ts";

type Context = ResolverContext;

/**
 * Type-operator policy: authored `keyof` reconstruction, mode-resolved key
 * sets, and deferred-conditional dispatch.
 *
 * Upstream runs its operator resolvers BEFORE every broad shape resolver so an
 * operator is never replaced by its reduced result. The same ordering lives
 * here: the operand stays, the checker's key set rides on `resolvedType`, and
 * `resolutionKind` records how faithfully it was described. Every recursive
 * resolution enters through the caller-supplied `resolve` callback, exactly
 * like the container and mapped-type modules.
 */

export function authoredKeyofNode(
  type: BackendTypeHandle,
  sourceNode: BackendNodeReference,
  typeNameValue: TypeName | undefined,
  context: Context,
  resolve: ResolveSemanticType
): SemanticType | undefined {
  const unwrapped = unwrapAuthoredNode(sourceNode, context) ?? sourceNode;
  const facts = context.operations.nodeFacts(unwrapped);
  if (facts.kind !== "typeOperator" || facts.operator !== "keyof") return undefined;
  const operandNode = unwrapAuthoredNode(facts.children?.[0], context) ?? facts.children?.[0];
  if (operandNode === undefined) return undefined;
  const operandCheckerType = context.operations.typeAtNode(operandNode);
  if (operandCheckerType === undefined) return undefined;
  if (operandNamesUnselectedExternalType(operandNode, operandCheckerType, context)) {
    return undefined;
  }
  const operand = resolveTypeOperatorOperand(operandCheckerType, operandNode, context, resolve);
  const excludeUndefinedFromResult = hasFoldedUndefinedMember(type, context);
  const operatorNode = keyofNode(operand, {
    type,
    typeNameValue,
    context,
    excludeUndefinedFromResult,
    resolve,
  });
  if (!excludeUndefinedFromResult) return operatorNode;
  return wrapKeyofWithUndefined(operatorNode, type, context) ?? operatorNode;
}

/** Whether a `keyof` result folded an `undefined` member into its checker union. */
function hasFoldedUndefinedMember(type: BackendTypeHandle, context: Context): boolean {
  const facts = context.operations.typeFacts(type);
  if (facts.isUnion !== true) return false;
  return (facts.unionOrIntersectionTypes ?? []).some(
    (member) => context.operations.typeFacts(member).intrinsic === "undefined"
  );
}

/**
 * Wraps a resolved operator node with the `undefined` union member an optional
 * indexed access carries.
 *
 * `Params["callback?"]` under an optional property yields `keyof … | undefined`
 * semantically; upstream reports `[operatorNode, undefined]` so the optionality
 * is not silently lost. The wrapped node is the mode-resolved operator, so the
 * resolved key set (which excludes the folded-in member, as upstream's
 * `excludeUndefined` does) and the explicit wrapper stay structurally aligned
 * across both modes. A type that collapsed to `undefined` entirely wraps the
 * same way. Returns `undefined` when no `undefined` member exists.
 */
function wrapKeyofWithUndefined(
  operatorNode: SemanticType,
  type: BackendTypeHandle,
  context: Context
): SemanticType | undefined {
  const facts = context.operations.typeFacts(type);
  if (facts.isUnion !== true) return undefined;
  const members = facts.unionOrIntersectionTypes ?? [];
  const hasUndefined = members.some((member) => {
    const memberFacts = context.operations.typeFacts(member);
    return memberFacts.intrinsic === "undefined";
  });
  if (!hasUndefined) return undefined;
  return unionType(undefined, [operatorNode, { kind: "intrinsic", intrinsic: "undefined" }]);
}

/** Whether an authored operand reaches an external symbol excluded by this request. */
function operandNamesUnselectedExternalType(
  operandNode: BackendNodeReference,
  operandType: BackendTypeHandle,
  context: Context
): boolean {
  const reference = unwrapAuthoredNode(operandNode, context) ?? operandNode;
  const nodeFacts = context.operations.nodeFacts(reference);
  const authoredSymbol = nodeFacts.kind === "typeReference" ? nodeFacts.typeName?.authoredSymbol : undefined;
  const typeFacts = context.operations.typeFacts(operandType);
  const semanticSymbol = typeFacts.aliasSymbol ?? typeFacts.symbol;
  const symbols = [authoredSymbol, semanticSymbol].filter(
    (symbol): symbol is BackendSymbolHandle => symbol !== undefined
  );
  return symbols.some(
    (symbol) =>
      (isExternalSymbol(symbol, context) || context.externalTypes.kind === "packages") &&
      !externalTypeSelectionAllowsSymbol(symbol, context.operations, context.externalTypes)
  );
}

/**
 * Resolves a `keyof` operand the way upstream's `resolveTypeOperatorOperand`
 * does: a `typeof` query keeps its authored expression, a named object shape
 * compacts to its public name plus index signature, and everything else
 * resolves in full.
 */
function resolveTypeOperatorOperand(
  operandType: BackendTypeHandle,
  operandNode: BackendNodeReference,
  context: Context,
  resolve: ResolveSemanticType
): SemanticType {
  const unwrapped = unwrapAuthoredNode(operandNode, context) ?? operandNode;
  const facts = context.operations.nodeFacts(unwrapped);
  if (facts.kind === "typeQuery" && facts.expressionName !== undefined) {
    return { kind: "typeQuery", expressionName: facts.expressionName };
  }
  const resolved = resolve(operandType, operandNode, undefined, context);
  if (resolved.kind === "object" && resolved.typeName !== undefined && !isShallowObjectOperand(resolved)) {
    return {
      kind: "object",
      typeName: resolved.typeName,
      properties: [],
      ...definedFields({ indexSignature: resolved.indexSignature }),
    };
  }
  return resolved;
}

/**
 * Whether a resolved object already IS the compact form — empty properties, as
 * upstream's shallow-object resolver reports for shapes whose expansion policy
 * declined to open them. Compacting those again would be a no-op.
 */
function isShallowObjectOperand(resolved: Extract<SemanticType, { kind: "object" }>): boolean {
  return resolved.properties.length === 0;
}

/**
 * Decides whether a deferred conditional was AUTHORED as TypeScript's built-in
 * `Extract` applied to an index-like check type (`Extract<keyof T, string>`).
 *
 * Upstream gates on the conditional root's alias symbol naming the lib `Extract`
 * declaration; the native seam does not expose a conditional's root, so the
 * authored alias body is followed instead until it names a `Extract` reference
 * declared in one of TypeScript's own library files. The index-like half of the
 * gate reads the conditional's check type exactly as upstream does.
 */
export function authoredExtractOverIndexLike(facts: BackendTypeFacts, context: Context): boolean {
  const checkType = facts.conditionalCheckType;
  if (checkType === undefined) return false;
  const checkFlags = context.operations.typeFacts(checkType).flags;
  if (!checkFlags.includes("Index") && !checkFlags.includes("IndexedAccess")) return false;
  return isBuiltInExtractAlias(facts.aliasSymbol, context, 0);
}

function isBuiltInExtractAlias(
  symbol: BackendSymbolHandle | undefined,
  context: Context,
  hops: number
): boolean {
  if (symbol === undefined || hops > maxKeyofAliasHops) return false;
  const info = context.operations.symbolFacts(symbol);
  if (info.name === "Extract") {
    return info.declarations.every((declaration) => isTypeScriptToolchainDeclaration(declaration, context));
  }
  const declaration = info.declarations[0];
  if (declaration === undefined) return false;
  const declarationFacts = context.operations.nodeFacts(declaration);
  if (declarationFacts.kind !== "typeAlias") return false;
  const body = declarationFacts.type;
  if (body === undefined) return false;
  const bodyReference = context.operations.nodeFacts(body);
  if (bodyReference.kind !== "typeReference") return false;
  return isBuiltInExtractAlias(bodyReference.typeName?.authoredSymbol, context, hops + 1);
}

/**
 * Reports a deferred conditional through its two resolved branches, mirroring
 * upstream's `resolveConditionalType`.
 *
 * Both branches resolve into a plain union node — never collapsed to a single
 * member, because a one-branch conditional (`Extract<T, string>` over a naked
 * parameter is just `T`) keeps the compound its author wrote, and canonicalization
 * drops the redundant `never` arm. Returns `undefined` when the checker exposes
 * neither branch.
 */
export function conditionalBranches(
  facts: BackendTypeFacts,
  context: Context,
  resolve: ResolveSemanticType
): SemanticType | undefined {
  const trueType = facts.conditionalTrueType;
  const falseType = facts.conditionalFalseType;
  if (trueType === undefined || falseType === undefined) return undefined;
  const members = [
    resolve(trueType, undefined, undefined, context),
    resolve(falseType, undefined, undefined, context),
  ];
  return { kind: "union", types: canonicalizeUnionMembers(members) };
}

/**
 * Resolves an index type from the `keyof` the author wrote.
 *
 * The authored operand is preferred, because it is the only record of the
 * spelling the operator was applied to. When the source node is not a `keyof` —
 * an alias that resolves to one, or a rest position that names its array — the
 * semantic type is resolved on its own instead.
 */
export function typeOperatorNode(
  type: BackendTypeHandle,
  sourceNode: BackendNodeReference,
  typeNameValue: TypeName | undefined,
  context: Context,
  resolve: ResolveSemanticType
): SemanticType {
  const unwrapped = unwrapAuthoredNode(sourceNode, context) ?? sourceNode;
  const facts = context.operations.nodeFacts(unwrapped);
  const operandNode = facts.operator === "keyof" ? facts.children?.[0] : undefined;
  if (operandNode === undefined)
    return unauthoredKeyofNode(type, typeNameValue, sourceNode, context, resolve);
  return keyofNode(resolve(context.operations.typeAtNode(operandNode), operandNode, undefined, context), {
    type,
    typeNameValue,
    context,
    resolve,
  });
}

/**
 * Resolves an index type whose authored syntax does not spell out its operator.
 *
 * Resolving the type again is not available here: the type is already being
 * resolved further up this stack — the resolver marks it active before
 * dispatching — so re-entering it would hit the cycle cut and silently report
 * an empty object for a type the checker can describe perfectly well. The
 * operand is taken from the checker's own index target instead, and an index
 * type that has none is reported as a recoverable warning rather than dropped.
 */
function unauthoredKeyofNode(
  type: BackendTypeHandle,
  typeNameValue: TypeName | undefined,
  sourceNode: BackendNodeReference,
  context: Context,
  resolve: ResolveSemanticType
): SemanticType {
  const target = context.operations.typeFacts(type).indexTarget;
  if (target === undefined) return unsupported(context, type, undefined, sourceNode);
  return keyofNode(resolve(target, undefined, undefined, context), { type, typeNameValue, context, resolve });
}

function keyofNode(
  operand: SemanticType,
  {
    type,
    typeNameValue,
    context,
    excludeUndefinedFromResult = false,
    resolve,
  }: {
    type: BackendTypeHandle;
    typeNameValue: TypeName | undefined;
    context: Context;
    /** Drops folded-in `undefined` members from the resolved key set, mirroring upstream's `excludeUndefined`. */
    excludeUndefinedFromResult?: boolean;
    resolve: ResolveSemanticType;
  }
): SemanticType {
  const resolved = keyofResult(type, context, excludeUndefinedFromResult, resolve);
  return {
    kind: "typeOperator",
    operator: "keyof",
    type: operand,
    ...definedFields({ typeName: typeNameValue }),
    resolvedType: resolved.type,
    resolutionKind: resolved.resolutionKind,
  };
}

/** A `keyof` result and how faithfully the checker could describe it. */
type KeyofResult = { readonly type: SemanticType; readonly resolutionKind: TypeOperatorResolutionKind };

/**
 * Resolves the KEY SET a `keyof` produces — never its operand.
 *
 * `keyof Target` over a concrete type is already a literal union or an intrinsic
 * and is reported exactly. Over a type parameter the checker has no key set to
 * give, so the base constraint (`string | number | symbol`) stands in and the
 * result says so; a type with neither is a recoverable `any`. This is upstream's
 * `resolveTypeOperatorResult` (`typeOperatorTypeResolver.ts`), including its
 * rule that a `fallback` anywhere beneath a base constraint stays a `fallback`.
 */
function keyofResult(
  type: BackendTypeHandle,
  context: Context,
  excludeUndefined: boolean,
  resolve: ResolveSemanticType
): KeyofResult {
  const facts = context.operations.typeFacts(type);
  if (facts.isUnion === true)
    return keyofUnionResult(
      unionKeySetMembers(facts.unionOrIntersectionTypes ?? [], excludeUndefined, context),
      type,
      context,
      resolve
    );
  if (isConcreteKeyType(facts)) {
    return { type: resolve(type, undefined, undefined, context), resolutionKind: "exact" };
  }
  const baseConstraint = context.operations.baseConstraintOfType(type);
  if (baseConstraint === undefined || baseConstraint === type) {
    return { type: unsupported(context, type, undefined, undefined), resolutionKind: "fallback" };
  }
  const constraint = keyofResult(baseConstraint, context, excludeUndefined, resolve);
  return {
    type: constraint.type,
    resolutionKind: constraint.resolutionKind === "fallback" ? "fallback" : "baseConstraint",
  };
}

/**
 * The union members a key set is resolved from, with folded-in `undefined`
 * members dropped when a wrapper will report them — but only while something
 * else remains, so a key set that collapsed to `undefined` entirely still
 * resolves to itself.
 */
function unionKeySetMembers(
  members: readonly BackendTypeHandle[],
  excludeUndefined: boolean,
  context: Context
): readonly BackendTypeHandle[] {
  if (!excludeUndefined) return members;
  const concrete = members.filter((member) => context.operations.typeFacts(member).intrinsic !== "undefined");
  return concrete.length === 0 ? members : concrete;
}

/** Resolves each key-set member and aggregates how faithful the whole set is. */
function keyofUnionResult(
  members: readonly BackendTypeHandle[],
  type: BackendTypeHandle,
  context: Context,
  resolve: ResolveSemanticType
): KeyofResult {
  const single = members.length === 1 ? members[0] : undefined;
  if (single !== undefined) return keyofResult(single, context, false, resolve);
  if (members.length === 0) {
    return { type: resolve(type, undefined, undefined, context), resolutionKind: "exact" };
  }
  const resolved = members.map((member) => keyofResult(member, context, false, resolve));
  return {
    type: unionType(
      undefined,
      resolved.map((member) => member.type)
    ),
    resolutionKind: resolved.some((member) => member.resolutionKind === "fallback")
      ? "fallback"
      : resolved.some((member) => member.resolutionKind === "baseConstraint")
        ? "baseConstraint"
        : "exact",
  };
}

/**
 * Whether the checker already reduced a key set to keys it can name.
 *
 * These are exactly the flags an index type collapses to once its operand is
 * concrete, and they mirror upstream's `resolveConcreteTypeOperatorResult`.
 */
function isConcreteKeyType(facts: BackendTypeFacts): boolean {
  return facts.flags.some((flag) => concreteKeyTypeFlags.has(flag));
}

const concreteKeyTypeFlags = new Set<TypeFlagName>([
  "Never",
  "String",
  "Number",
  "ESSymbol",
  "UniqueESSymbol",
  "StringLiteral",
  "NumberLiteral",
  "BigIntLiteral",
  "BooleanLiteral",
]);
