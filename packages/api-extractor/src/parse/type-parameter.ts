import type {
  BackendNodeFacts,
  BackendNodeHandle,
  BackendNodeReference,
  BackendSymbolHandle,
  BackendTypeHandle,
} from "../backend/contracts.ts";
import type { SemanticType, TypeParameterNode } from "../model.ts";
import { definedFields } from "../optional-fields.ts";
import { authoredContainsPreservableKeyof } from "./authored-node.ts";
import type { ResolveSemanticType, ResolverContext } from "./contracts.ts";

type Context = ResolverContext;

/** One declared parameter's symbol name and declaration node. */
type BackendDeclaredParameterInfo = {
  /** The checker symbol's declared name; absent when the type carries no symbol. */
  readonly name?: string;
  readonly node?: BackendNodeFacts;
};

/**
 * Builds the type-parameter node for a SIGNATURE slot (`<T extends Data = Data>`
 * on a method or callable).
 *
 * Upstream's `buildSignatureTypeParameterNodes` replays the authored constraint
 * node here — the slot describes the DECLARED parameters, so `<T extends Data>`
 * reports `Data` with its own constraint and default. The checker's base
 * constraint steps in only when that replay degraded to a bare `any` the source
 * never wrote (a checker-internal indexed-access shape).
 *
 * `ownerDeclaration` and `index` mirror upstream's declaration pick: the
 * parameter node authored at the owning signature declaration's own position
 * wins over any symbol declaration.
 */
export function signatureTypeParameter(
  type: BackendTypeHandle,
  context: Context,
  resolveType: ResolveSemanticType,
  ownerDeclaration?: BackendNodeHandle,
  index = 0
): TypeParameterNode {
  const info = declaredInfo(type, context, ownerDeclaration, index);
  const node = info?.node;
  // Upstream names a SIGNATURE parameter through a three-step chain
  // (`signatureTypeParameterNodes.ts`, its name block: symbol name, then the
  // chosen declaration's own identifier text, then `T${index}`). The middle
  // step reads the bare identifier the backend normalizes onto a
  // `typeParameter` node — no string surgery on whole-declaration text. The
  // occurrence resolver below cannot take an index — it resolves one type,
  // not a position — and upstream's own occurrence path has no fallback name
  // at all, so that slot documents its delta instead of borrowing this one.
  const authoredName = node?.kind === "typeParameter" ? node.name : undefined;
  const name = info?.name ?? authoredName ?? `T${index}`;
  const result: TypeParameterNode = { name, kind: "typeParameter" };
  if (node?.constraint !== undefined) {
    let constraint = resolveAuthored(node.constraint, context, resolveType);
    if (isUnauthoredAny(constraint) && !isAnySource(node.constraint, context)) {
      const base = context.operations.baseConstraintOfType(type);
      if (base !== undefined && base !== type) constraint = resolveType(base, undefined, undefined, context);
    }
    if (constraint !== undefined) Object.assign(result, { constraint });
  }
  if (node?.defaultType !== undefined) {
    const resolvedDefault = resolveAuthored(node.defaultType, context, resolveType);
    if (resolvedDefault !== undefined) Object.assign(result, { defaultValue: resolvedDefault });
  }
  return result;
}

/**
 * Builds the type-parameter node for an OCCURRENCE of a parameter elsewhere in
 * the tree.
 *
 * Upstream's `resolveTypeParameterType` prefers the checker's base constraint
 * here — TypeScript resolves it through chained parameter constraints — and
 * replays authored syntax only when it carries a preservable `keyof`. The
 * authored constraint still anchors resolution when it names another type
 * parameter, because that chain is exactly what TypeScript 6's base constraint
 * preserves and TypeScript 7 pre-resolves away.
 */
export function occurrenceTypeParameter(
  type: BackendTypeHandle,
  context: Context,
  resolveType: ResolveSemanticType
): TypeParameterNode {
  const info = declaredInfo(type, context);
  const node = info?.node;
  // Upstream's occurrence resolver (`resolveTypeParameterType`) has no
  // fallback name: it reads the symbol's declared name and bails out when
  // the type carries no symbol. This seam cannot bail mid-resolution, so `"T"`
  // stands in — unreachable in practice, because a checker type parameter
  // always reports its declared name through its symbol.
  const name = info?.name ?? "T";
  const result: TypeParameterNode = { name, kind: "typeParameter" };
  if (node?.constraint !== undefined) {
    const constraint = resolvedConstraint(type, node.constraint, context, resolveType);
    if (constraint !== undefined) Object.assign(result, { constraint });
  }
  if (node?.defaultType !== undefined) {
    const defaultType = context.operations.typeAtNode(node.defaultType);
    if (defaultType !== undefined) {
      const preservesSyntax = authoredContainsPreservableKeyof(node.defaultType, context);
      Object.assign(result, {
        defaultValue: resolveType(
          defaultType,
          preservesSyntax ? node.defaultType : undefined,
          undefined,
          context
        ),
      });
    }
  }
  return result;
}

/**
 * One declared parameter's symbol name and declaration node.
 *
 * Upstream (`signatureTypeParameterNodes.ts`) picks the parameter declaration
 * authored at the owning signature declaration's own index first, then among
 * the symbol's declarations the one whose parent matches that owning
 * declaration, else the first candidate. The parent match needs a node's
 * parent handle at the seam, which the backend does not expose; the owned-node
 * preference below covers the merge cases where it matters (each part declares
 * its own parameters), and the final fallback stays the symbol's first
 * declaration as upstream's `candidates[0]` does.
 */
function declaredInfo(
  type: BackendTypeHandle,
  context: Context,
  ownerDeclaration?: BackendNodeHandle,
  index = 0
): BackendDeclaredParameterInfo | undefined {
  const facts = context.operations.typeFacts(type);
  const symbol = facts.symbol;
  const info = symbol === undefined ? undefined : context.operations.symbolFacts(symbol);
  const owned =
    ownerDeclaration === undefined
      ? undefined
      : context.operations.nodeFacts(ownerDeclaration).typeParameters?.[index];
  const declaration =
    owned !== undefined && context.operations.nodeKind(owned) === "typeParameter"
      ? owned
      : info?.declarations[0];
  return definedFields({
    name: info?.name,
    node: declaration === undefined ? undefined : context.operations.nodeFacts(declaration),
  });
}

/** Resolves the authored constraint/default node with its own syntax attached. */
function resolveAuthored(
  node: BackendNodeReference,
  context: Context,
  resolveType: ResolveSemanticType
): SemanticType | undefined {
  const type = context.operations.typeAtNode(node);
  return type === undefined ? undefined : resolveType(type, node, undefined, context);
}

/**
 * Whether a resolved model is the bare `any` fallback (no authored alias).
 *
 * Shared by this module's constraint probe and the resolver's substitution
 * fallback (`resolver.ts`), which must agree on what "unauthored any" means.
 */
export function isUnauthoredAny(model: SemanticType | undefined): boolean {
  return model?.kind === "intrinsic" && model.intrinsic === "any" && model.typeName === undefined;
}

/** Whether the authored constraint node genuinely spells the `any` type. */
function isAnySource(node: BackendNodeReference, context: Context): boolean {
  const type = context.operations.typeAtNode(node);
  return type !== undefined && context.operations.typeFacts(type).flags.includes("Any");
}

/**
 * Resolves one constraint under the base-constraint policy above, or
 * `undefined` when neither the authored node nor the checker yields a type.
 *
 * TypeScript resolves a base constraint THROUGH chained parameter constraints
 * (`<T extends Data>` where `Data extends object` bottoms out at `object`), and
 * this slot reports that representable bound rather than re-naming the chain.
 * The authored node still rides along as the syntax anchor: an anonymous
 * `{ a: string }` bound is only describable because its authored braces anchor
 * object resolution, and a `keyof` operand is preserved by the earlier branch.
 */
function resolvedConstraint(
  type: BackendTypeHandle,
  constraintNode: BackendNodeReference,
  context: Context,
  resolveType: ResolveSemanticType
): SemanticType | undefined {
  const authored = context.operations.typeAtNode(constraintNode);
  if (authoredContainsPreservableKeyof(constraintNode, context)) {
    return authored === undefined ? undefined : resolveType(authored, constraintNode, undefined, context);
  }
  const base = context.operations.baseConstraintOfType(type);
  if (base !== undefined && base !== type) return resolveType(base, constraintNode, undefined, context);
  return authored === undefined ? undefined : resolveType(authored, constraintNode, undefined, context);
}

/** Whether a symbol declares a type parameter (used to ignore authored candidates). */
export function isTypeParameterSymbol(symbol: BackendSymbolHandle, context: Context): boolean {
  return context.operations.symbolFacts(symbol).flags.includes("typeParameter");
}
