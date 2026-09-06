import type { BackendNodeReference, BackendSymbolHandle, BackendTypeHandle } from "../backend/contracts.ts";
import { intersectionType, unionType } from "../canonical/canonicalize.ts";
import type { SemanticType, TypeName } from "../model.ts";
import { definedFields } from "../optional-fields.ts";
import { unwrapAuthoredNode } from "./authored-node.ts";
import type { ResolveSemanticType, ResolverContext } from "./contracts.ts";
import { resolveObjectNode, resolveSignatureNode } from "./object-resolver.ts";
import { aliasInstantiationArguments, applySubstitutions, bindAliasParameters } from "./substitutions.ts";
import type { Substitutions } from "./substitutions.ts";

type Context = ResolverContext;

/**
 * Whether the authored syntax at a node is a union that spells out
 * `undefined` as one of its members, stepping over transparent parentheses.
 * A union whose alias side absorbs into `any` or `unknown` collapses on the
 * checker side to that single intrinsic, so the written syntax is the only
 * remaining record that an aliased member and `undefined` were spelled out.
 */
export function authoredUndefinedUnionSyntax(
  node: BackendNodeReference | undefined,
  context: Context
): boolean {
  if (node === undefined) return false;
  const direct = unwrapAuthoredNode(node, context) ?? node;
  const facts = context.operations.nodeFacts(direct);
  if (facts.kind !== "union") return false;
  return (facts.children ?? []).some((child) => {
    const unwrapped = unwrapAuthoredNode(child, context) ?? child;
    const childFacts = context.operations.nodeFacts(unwrapped);
    return childFacts.text === "undefined";
  });
}

/** Authored union syntax plus the alias bindings its member nodes need. */
type AuthoredUnion = {
  readonly nodes: readonly BackendNodeReference[];
  readonly substitutions?: Substitutions;
};

/**
 * Resolves a union by matching authored member syntax back to the checker's
 * flattened members, then handing the result to the canonical smart
 * constructor. Ordering, boolean collapsing, `never` removal, and duplicate
 * removal are canonicalization policy and deliberately do not live here.
 */
export function unionNode(
  type: BackendTypeHandle,
  sourceNode: BackendNodeReference | undefined,
  typeNameValue: TypeName | undefined,
  context: Context,
  resolve: ResolveSemanticType
): SemanticType {
  const members = context.operations.typeFacts(type).unionOrIntersectionTypes ?? [];
  const authored = authoredUnionMembers(type, sourceNode, context);
  // A union the checker absorbed into a single intrinsic (`AliasedAny |
  // undefined` is just `any`) reports no members at all. The written member
  // nodes are then the only remaining record of the union, and each resolves
  // from its own syntax exactly as an authored member does above.
  if (members.length === 0 && authored.nodes.length > 0) {
    const resolvedMembers: SemanticType[] = [];
    for (const node of authored.nodes) {
      const nodeType = applySubstitutions(
        context.operations.typeAtNode(node),
        context.substitutions,
        context.operations
      );
      if (nodeType === undefined) continue;
      // A member whose checker type is the very collapse being walked is
      // already active; its cycle cut keeps this node's authored name.
      resolvedMembers.push(resolve(nodeType, node, undefined, context));
    }
    return unionType(typeNameValue, resolvedMembers);
  }
  if (authored.nodes.length === 0)
    return unionType(typeNameValue, unmatchedUnionMembers(members, sourceNode, context, resolve));
  // An instantiated generic alias records its members as the alias body's type
  // parameters. Resolving that syntax without the call's bindings would leave
  // every parameter node unmatched and append its semantic member at the end.
  const scope: Context =
    authored.substitutions === undefined ? context : { ...context, substitutions: authored.substitutions };

  const result: SemanticType[] = [];
  // A member is "covered" once some authored position accounts for it, and
  // "matched" once it has been consumed by a single-member match. The two sets
  // differ because a composite member (a nested union alias, or the `false |
  // true` pair) accounts for members that an authored duplicate may name again.
  const covered = new Set<BackendTypeHandle>();
  const matched = new Set<BackendTypeHandle>();
  for (const node of authored.nodes) {
    const nodeType = applySubstitutions(
      scope.operations.typeAtNode(node),
      scope.substitutions,
      scope.operations
    );
    if (nodeType === undefined) continue;
    // TypeScript expands an authored `boolean` into `false | true`, so one
    // authored node claims every boolean-literal member at its position.
    if (claimBooleanLiterals(nodeType, members, covered, scope)) {
      result.push(resolve(nodeType, node, undefined, scope));
      continue;
    }
    // A referenced alias whose body is itself a union is flattened into the
    // parent by the checker. Claiming its members keeps the authored composite
    // as one named member instead of leaking its expansion.
    if (claimNestedUnionMembers(nodeType, members, covered, scope)) {
      result.push(resolve(nodeType, node, undefined, scope));
      continue;
    }
    const match = matchUnionMember(node, nodeType, members, matched, scope);
    if (match === undefined) continue;
    matched.add(match);
    covered.add(match);
    result.push(resolve(match, node, undefined, scope));
  }
  // A member without authored syntax still belongs to the union. Optional
  // properties reach this path because the checker adds `undefined` without a
  // corresponding authored node.
  for (const member of members) {
    if (!covered.has(member)) result.push(resolve(member, undefined, undefined, scope));
  }
  return unionType(typeNameValue, result);
}

/**
 * Resolves an intersection by matching the checker's members back to authored
 * member syntax, then merging the compiler's aggregate property view.
 */
export function intersectionNode(
  type: BackendTypeHandle,
  sourceNode: BackendNodeReference | undefined,
  typeNameValue: TypeName | undefined,
  context: Context,
  resolve: ResolveSemanticType
): SemanticType {
  const members = context.operations.typeFacts(type).unionOrIntersectionTypes ?? [];
  const memberNodes = matchIntersectionMemberNodes(members, sourceNode, context);
  const memberContext: Context = { ...context, authoredIntersectionMember: true };
  const resolved = members.map((member, index) =>
    resolve(member, memberNodes[index], undefined, memberContext)
  );
  // A callable intersection is described by its call signatures. Its extra
  // properties are deliberately dropped: the merged type is used as a function,
  // and reporting both forms would give one export two incompatible shapes.
  const signatures = context.operations.signaturesOfType(type);
  if (signatures.length > 0) {
    return {
      kind: "function",
      callSignatures: signatures.map((signature, index) =>
        resolveSignatureNode(signature, context, index, resolve)
      ),
      ...definedFields({ typeName: typeNameValue }),
    };
  }
  // The aggregate property list is the compiler's merged view of every member.
  // Merging there is what preserves conflicting members, optionality, readonly
  // state, and declaration documentation instead of re-deriving them from the
  // member models, and it is independent of whether the intersection was
  // authored inline or reached through an alias reference.
  const merged = resolveObjectNode(type, undefined, sourceNode, memberContext, resolve);
  return intersectionType(typeNameValue, resolved, merged?.kind === "object" ? merged.properties : []);
}

/**
 * Pairs each checker member with the authored member syntax that describes it.
 *
 * TypeScript deduplicates and reorders intersection members, so positional
 * pairing would attach one member's name to another member's shape. Members are
 * matched semantically first, with any leftover node used as a fallback, exactly
 * as upstream does. A matched node is handed back only when it can still change
 * the resolved model, which today means preserved `keyof` syntax.
 */
function matchIntersectionMemberNodes(
  members: readonly BackendTypeHandle[],
  sourceNode: BackendNodeReference | undefined,
  context: Context
): readonly (BackendNodeReference | undefined)[] {
  const nodes = flattenAuthoredIntersection(sourceNode, context);
  if (nodes === undefined) return members.map(() => undefined);
  const usedIndexes = new Set<number>();
  return members.map((member) => {
    const memberText = context.operations.typeToString(member);
    let index = nodes.findIndex((node, candidate) => {
      if (usedIndexes.has(candidate)) return false;
      const nodeType = context.operations.typeAtNode(node);
      return (
        nodeType !== undefined &&
        (nodeType === member || context.operations.typeToString(nodeType) === memberText)
      );
    });
    if (index === -1) index = nodes.findIndex((_, candidate) => !usedIndexes.has(candidate));
    if (index === -1) return undefined;
    usedIndexes.add(index);
    const node = nodes[index];
    return node !== undefined && preservesIntersectionMemberSyntax(node, context) ? node : undefined;
  });
}

/**
 * Flattens authored intersection syntax the way TypeScript flattens
 * intersection types. Returns `undefined` when the authored syntax is not an
 * intersection at all, which is how a type reference's type arguments are kept
 * from being mistaken for member syntax.
 */
function flattenAuthoredIntersection(
  sourceNode: BackendNodeReference | undefined,
  context: Context
): readonly BackendNodeReference[] | undefined {
  if (sourceNode === undefined) return undefined;
  const node = unwrapAuthoredNode(sourceNode, context) ?? sourceNode;
  if (context.operations.nodeKind(node) !== "intersection") return undefined;
  return (context.operations.nodeFacts(node).children ?? []).flatMap((child) => {
    const unwrapped = unwrapAuthoredNode(child, context) ?? child;
    return flattenAuthoredIntersection(unwrapped, context) ?? [unwrapped];
  });
}

/**
 * Whether authored member syntax still carries information the semantic member
 * cannot express. Only `keyof` survives resolution as authored syntax, so every
 * other member is resolved from its checker type alone.
 */
function preservesIntersectionMemberSyntax(node: BackendNodeReference, context: Context): boolean {
  return context.operations.nodeFacts(node).operator === "keyof";
}

/**
 * Resolves members of a union whose authored syntax is not a union. The parent
 * node is propagated only for the optional-property shape `T | undefined`,
 * where it helps resolve `T`.
 *
 * Two deliberate differences from upstream (`unionTypeResolver.ts`):
 * - Upstream propagates only when the parent node is a TypeReference or an
 *   ImportType. The normalized backend reports an import type as the generic
 *   `type` node kind, so narrowing to `typeReference` here would silently drop
 *   upstream's ImportType case; every parent node kind is propagated instead.
 *   The observable delta is a parent that is neither of those two kinds, such as
 *   an indexed access whose type is `T | undefined`, which upstream resolves
 *   without a node.
 * - Upstream hands the parent node to both members. Here the `undefined` member
 *   is resolved without it, because this resolver derives a member's public name
 *   from the node it is given and the parent names the non-`undefined` member.
 */
function unmatchedUnionMembers(
  members: readonly BackendTypeHandle[],
  sourceNode: BackendNodeReference | undefined,
  context: Context,
  resolve: ResolveSemanticType
): readonly SemanticType[] {
  const claimed = new Set<BackendTypeHandle>();
  const authoredType = sourceNode === undefined ? undefined : context.operations.typeAtNode(sourceNode);
  // An authored `boolean` reaches the resolver as the `false | true` pair the
  // checker expanded. One authored node owns both members, so the pair is
  // restored to the single intrinsic at its authored position.
  const booleanMember =
    authoredType !== undefined && claimBooleanLiterals(authoredType, members, claimed, context)
      ? resolve(authoredType, sourceNode, undefined, context)
      : undefined;
  const propagate =
    sourceNode !== undefined &&
    members.length === 2 &&
    members.some((member) => context.operations.typeFacts(member).intrinsic === "undefined");
  const resolved = members.flatMap((member) => {
    if (claimed.has(member)) return [];
    const isUndefined = context.operations.typeFacts(member).intrinsic === "undefined";
    return [resolve(member, propagate && !isUndefined ? sourceNode : undefined, undefined, context)];
  });
  return booleanMember === undefined ? resolved : [booleanMember, ...resolved];
}

function matchUnionMember(
  node: BackendNodeReference,
  nodeType: BackendTypeHandle,
  members: readonly BackendTypeHandle[],
  used: ReadonlySet<BackendTypeHandle>,
  context: Context
): BackendTypeHandle | undefined {
  const authoredBooleanLiteral = authoredBooleanValue(node, context);
  return members.find(
    (candidate) =>
      !used.has(candidate) &&
      (candidate === nodeType ||
        context.operations.typeToString(candidate) === context.operations.typeToString(nodeType) ||
        (authoredBooleanLiteral !== undefined &&
          context.operations.typeFacts(candidate).literal === authoredBooleanLiteral) ||
        isClosedGeneric(candidate, nodeType, context))
  );
}

/**
 * Whether a member is an instantiation of the generic the authored node names.
 *
 * An alias body such as `Value[]`, or a reference to a generic interface, is a
 * container whose type parameter cannot be rebound by substituting the whole
 * node type, so the authored node still resolves to the uninstantiated container
 * while the member is the closed one. Both share the same reference target,
 * which is how upstream pairs them (`unionTypeResolver.ts`, `isClosedGeneric`).
 *
 * Upstream reads that target off any instantiated type, including an alias body
 * that is not a type reference (`type Box<Value> = { value: Value }`).
 * TypeScript 7 publishes a target for references only, so such a body still
 * falls through to the unmatched members appended after the authored ones.
 */
function isClosedGeneric(member: BackendTypeHandle, nodeType: BackendTypeHandle, context: Context): boolean {
  const target = context.operations.typeFacts(member).referenceTarget;
  if (target === undefined) return false;
  return target === nodeType || target === context.operations.typeFacts(nodeType).referenceTarget;
}

/**
 * Marks the members a nested union alias accounts for.
 *
 * Membership is deliberately not reduced by what earlier positions already
 * covered: overlapping alias unions such as `A | "x"` legitimately name the
 * same member twice. Upstream reaches the same result by reading TypeScript's
 * pre-flattening `origin` member list, which the normalized backend cannot
 * expose because the compiler's type response carries no origin field. Deriving
 * the coverage from authored syntax instead reproduces that behavior without an
 * internal-only fact.
 */
function claimNestedUnionMembers(
  nodeType: BackendTypeHandle,
  members: readonly BackendTypeHandle[],
  covered: Set<BackendTypeHandle>,
  context: Context
): boolean {
  const nested = context.operations.typeFacts(nodeType).unionOrIntersectionTypes;
  if (nested === undefined || nested.length === 0 || members.includes(nodeType)) return false;
  const nestedText = new Set(nested.map((member) => context.operations.typeToString(member)));
  const claimed = members.filter(
    (member) => nested.includes(member) || nestedText.has(context.operations.typeToString(member))
  );
  if (claimed.length === 0 || claimed.length !== nested.length) return false;
  for (const member of claimed) covered.add(member);
  return true;
}

function claimBooleanLiterals(
  nodeType: BackendTypeHandle,
  members: readonly BackendTypeHandle[],
  used: Set<BackendTypeHandle>,
  context: Context
): boolean {
  if (context.operations.typeFacts(nodeType).intrinsic !== "boolean") return false;
  const literals = members.filter((member) => {
    const literal = context.operations.typeFacts(member).literal;
    return !used.has(member) && (literal === true || literal === false);
  });
  if (literals.length === 0) return false;
  for (const literal of literals) used.add(literal);
  return true;
}

/**
 * Finds the authored union members for a union type. The authored syntax may be
 * the node itself, or the declaration of a referenced type alias whose body is
 * a union: TypeScript drops simple alias hops, so the alias declaration is the
 * only remaining record of the authored member order.
 */
function authoredUnionMembers(
  type: BackendTypeHandle,
  sourceNode: BackendNodeReference | undefined,
  context: Context
): AuthoredUnion {
  const direct =
    sourceNode === undefined ? undefined : (unwrapAuthoredNode(sourceNode, context) ?? sourceNode);
  if (direct !== undefined && context.operations.nodeKind(direct) === "union")
    return { nodes: flattenAuthoredUnion(direct, context) };
  const alias = aliasUnionBody(type, sourceNode, context);
  if (alias === undefined) return { nodes: [] };
  return {
    nodes: flattenAuthoredUnion(alias.body, context),
    ...definedFields({ substitutions: alias.substitutions }),
  };
}

function aliasUnionBody(
  type: BackendTypeHandle,
  sourceNode: BackendNodeReference | undefined,
  context: Context
): { readonly body: BackendNodeReference; readonly substitutions?: Substitutions } | undefined {
  const semanticAlias = context.operations.typeFacts(type).aliasSymbol;
  const authoredAlias =
    sourceNode === undefined ? undefined : context.operations.nodeFacts(sourceNode).typeName?.authoredSymbol;
  for (const alias of [semanticAlias, authoredAlias]) {
    const declaration = alias === undefined ? undefined : aliasUnionDeclaration(alias, context);
    if (declaration === undefined) continue;
    const substitutions = aliasTypeParameterSubstitutions(declaration.declaration, type, sourceNode, context);
    return {
      body: declaration.body,
      ...definedFields({ substitutions }),
    };
  }
  return undefined;
}

function aliasUnionDeclaration(
  alias: BackendSymbolHandle,
  context: Context
): { readonly declaration: BackendNodeReference; readonly body: BackendNodeReference } | undefined {
  for (const declaration of context.operations.symbolFacts(alias).declarations) {
    const facts = context.operations.nodeFacts(declaration);
    if (facts.kind !== "typeAlias" || facts.type === undefined) continue;
    const body = unwrapAuthoredNode(facts.type, context) ?? facts.type;
    if (context.operations.nodeKind(body) === "union") return { declaration, body };
  }
  return undefined;
}

/**
 * Binds an alias declaration's type parameters to the arguments of one
 * instantiation. The semantic alias arguments are authoritative; a reference
 * that reached the alias through a different symbol supplies its authored
 * arguments instead.
 */
function aliasTypeParameterSubstitutions(
  declaration: BackendNodeReference,
  type: BackendTypeHandle,
  sourceNode: BackendNodeReference | undefined,
  context: Context
): Substitutions | undefined {
  const parameters = context.operations.nodeFacts(declaration).typeParameters ?? [];
  if (parameters.length === 0) return undefined;
  // An instantiation without arguments binds nothing on its own; the union is
  // then matched without a substitution scope.
  const args = aliasInstantiationArguments(type, sourceNode, context);
  if (args.length === 0) return undefined;
  return bindAliasParameters(declaration, context, (index) => args[index]);
}

/** Flattens nested authored unions the way TypeScript flattens union types. */
function flattenAuthoredUnion(node: BackendNodeReference, context: Context): readonly BackendNodeReference[] {
  return (context.operations.nodeFacts(node).children ?? []).flatMap((child) => {
    const unwrapped = unwrapAuthoredNode(child, context) ?? child;
    return context.operations.nodeKind(unwrapped) === "union"
      ? flattenAuthoredUnion(unwrapped, context)
      : [unwrapped];
  });
}

function authoredBooleanValue(node: BackendNodeReference, context: Context): boolean | undefined {
  const text = context.operations.nodeFacts(node).text;
  return text === "true" ? true : text === "false" ? false : undefined;
}
