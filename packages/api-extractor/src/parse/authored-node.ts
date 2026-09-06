import type { BackendNodeFacts, BackendNodeReference } from "../backend/contracts.ts";
import type { ResolverContext } from "./contracts.ts";
import { declarationOwnership, isExternalOwnership } from "./ownership.ts";

type Context = ResolverContext;

/**
 * How many alias hops a `keyof` search may follow before giving up.
 *
 * Upstream's seen set is unbounded only because its recursion guard is the
 * seen-alias set itself; the hop count here additionally bounds chains that
 * keep naming fresh declarations. Shared by every syntax walk that follows
 * project alias bodies (`authoredContainsPreservableKeyof`, and the resolver's
 * built-in `Extract` detection).
 */
export const maxKeyofAliasHops = 8;

/**
 * Steps through transparent authored wrappers and returns the node the syntax
 * finally describes, or `undefined` when the walk runs out of nodes — an
 * absent start, or a wrapper without a child.
 *
 * `isWrapper` decides which node kinds are transparent; parentheses are
 * always wrappers, and callers extend the predicate when more kinds carry no
 * type of their own. A caller that treats the walked-to node as mandatory
 * recovers it with `?? node`, which also covers the wrapper-without-child
 * case.
 */
export function unwrapAuthoredNode(
  node: BackendNodeReference | undefined,
  context: Context,
  isWrapper: (facts: BackendNodeFacts) => boolean = isParenthesizedWrapper
): BackendNodeReference | undefined {
  let current = node;
  while (current !== undefined) {
    const facts = context.operations.nodeFacts(current);
    if (!isWrapper(facts)) return current;
    current = facts.children?.[0];
  }
  return undefined;
}

function isParenthesizedWrapper(facts: BackendNodeFacts): boolean {
  return facts.kind === "parenthesized";
}

/**
 * Whether authored syntax contains a `keyof` operator whose operand resolution
 * still needs the syntax — the "preservable keyof" test upstream's
 * `containsKeyofTypeOperatorOrAlias` performs before replaying a node.
 *
 * Transparent parentheses are stepped over, and a reference to a project type
 * alias is followed into its body (bounded, with a seen set) because the alias
 * may be the only place the operator is spelled out. Library references are
 * not followed: their bodies are external policy, not authored syntax.
 *
 * Reviewed delta vs upstream's value-position gate — the
 * `getPreservableTypeNode` family (`typeOperatorTypeNodes.ts:251-293`,
 * called from `objectTypeResolver.ts:147-159`) — which runs four probes
 * where this walk runs three: a direct `keyof`, one behind project-alias
 * bodies (bounded at eight hops, a bound upstream's unbounded seen set
 * lacks), and one inside reference type arguments. The unreplicated fourth
 * probe (`containsKeyofTypeNodeSubstitution`) substitutes a bare parameter
 * reference with its authored argument node and checks that node. It matters
 * only for NESTED parameter positions: a bare-root `Wrap<keyof Base>`-style
 * instantiation is preserved without it because the resolver's
 * operator-first reconstruction (`authoredKeyofNode`) replays the whole
 * authored operator before broad shape resolvers run — the same job
 * upstream's root substitution inside probes 2 and 3 does there. Nested
 * parameter positions keep the checker-side reading instead, which resolves
 * their values from the substituted checker type; no ported or known
 * upstream fixture exercises a shape where that loses syntax. Upstream's
 * alias-body probe also traverses conditional-type branches (these node
 * facts expose no conditional children) and expands indexed accesses;
 * replicating either is deferred until a fixture demands it.
 */
export function authoredContainsPreservableKeyof(
  node: BackendNodeReference | undefined,
  context: Context,
  seen: ReadonlySet<BackendNodeReference> = new Set(),
  hops = 0
): boolean {
  if (node === undefined || seen.has(node)) return false;
  const unwrapped = unwrapAuthoredNode(node, context) ?? node;
  if (seen.has(unwrapped)) return false;
  const visited = new Set([...seen, unwrapped]);
  const facts = context.operations.nodeFacts(unwrapped);
  if (facts.kind === "typeOperator" && facts.operator === "keyof") return true;
  for (const child of facts.children ?? []) {
    if (authoredContainsPreservableKeyof(child, context, visited, hops)) return true;
  }
  if (hops >= maxKeyofAliasHops) return false;
  const referenced = referencedProjectAliasBody(unwrapped, facts, context);
  if (referenced === undefined) return false;
  return authoredContainsPreservableKeyof(referenced, context, visited, hops + 1);
}

/** The body node of a project-declared type alias a reference names, if any. */
function referencedProjectAliasBody(
  node: BackendNodeReference,
  facts: BackendNodeFacts,
  context: Context
): BackendNodeReference | undefined {
  if (facts.kind !== "typeReference") return undefined;
  const symbol = facts.typeName?.authoredSymbol;
  const declaration =
    symbol === undefined ? undefined : context.operations.symbolFacts(symbol).declarations[0];
  if (declaration === undefined) return undefined;
  const declarationFacts = context.operations.nodeFacts(declaration);
  if (declarationFacts.kind !== "typeAlias") return undefined;
  // The alias body is followed only when its declaration is project-authored;
  // a dependency alias's body belongs to the external graph this walk must not
  // traverse. Ownership is the normalized backend fact (`declarationOwnership`),
  // shared with every other external-policy site.
  if (isExternalOwnership(declarationOwnership(declaration, context))) return undefined;
  return declarationFacts.type;
}
