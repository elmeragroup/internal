import type { BackendNodeFacts, BackendNodeReference, BackendTypeHandle } from "../backend/contracts.ts";
import type { SemanticType, TypeName } from "../model.ts";
import { definedFields, flagFields } from "../optional-fields.ts";
import { unwrapAuthoredNode } from "./authored-node.ts";
import type { ResolveSemanticType, ResolverContext } from "./contracts.ts";
import type { Substitutions } from "./substitutions.ts";
import { applySubstitutions, bindAliasParameters } from "./substitutions.ts";

type Context = ResolverContext;

/** An authored element and the generic environment belonging to its spread occurrence. */
type TupleElement = {
  readonly node: BackendNodeReference | undefined;
  readonly substitutions: Substitutions;
};
type TupleElementExpansion = { readonly elements: readonly TupleElement[] };

/** The tuple an authored rest element spreads, with the bindings its element nodes are read under. */
type TupleSource = {
  readonly body: BackendNodeReference;
  readonly substitutions?: Substitutions;
};

/**
 * Resolves an array container.
 *
 * The public name of an array is only ever its *alias* name: `Array<string>`
 * and `string[]` are the same anonymous container, and naming one of them
 * `Array` would make the authored spelling observable in the model. Upstream
 * takes the name from `type.aliasSymbol` alone (`arrayTypeResolver.ts`), and the
 * surrounding `TypeName` — namespaces and type arguments — is reused so an
 * aliased generic array keeps its arguments.
 */
export function arrayNode(
  type: BackendTypeHandle,
  sourceNode: BackendNodeReference | undefined,
  typeNameValue: TypeName | undefined,
  context: Context,
  resolve: ResolveSemanticType
): SemanticType {
  const facts = context.operations.typeFacts(type);
  const elementType = (facts.typeArguments ?? [])[0];
  const alias = facts.aliasSymbol;
  const aliasName = alias === undefined ? undefined : context.operations.symbolFacts(alias).name;
  return {
    kind: "array",
    elementType: resolve(elementType, containerElementNode(sourceNode, context), undefined, context),
    ...flagFields({ isReadonly: context.operations.isReadonlyType(type) }),
    ...definedFields({
      typeName:
        aliasName === undefined || aliasName === "" ? undefined : { ...typeNameValue, name: aliasName },
    }),
  };
}

/**
 * Resolves a tuple container.
 *
 * Elements come from the reference's type arguments, which is the only ordered
 * view of a tuple: reading properties instead would expose `0`, `1`, `length`
 * and the `Array` members in symbol order. Optional, rest, and variadic
 * elements are already expanded into that ordered element list by the checker,
 * so element structure survives without replaying authored element syntax.
 */
export function tupleNode(
  type: BackendTypeHandle,
  sourceNode: BackendNodeReference | undefined,
  typeNameValue: TypeName | undefined,
  context: Context,
  resolve: ResolveSemanticType
): SemanticType {
  const elements = context.operations.typeFacts(type).typeArguments ?? [];
  const expansion = authoredTupleElementNodes(sourceNode, elements.length, context);
  return {
    kind: "tuple",
    types: elements.map((element, index) => {
      const authored = expansion.elements[index];
      const node = authored?.node;
      const scoped = authored === undefined ? context : { ...context, substitutions: authored.substitutions };
      if (node === undefined) return resolve(element, undefined, undefined, scoped);
      // A donated element node written in terms of a spread alias's own
      // parameters resolves to its bound argument; every other node keeps the
      // semantic element the checker already instantiated.
      const nodeType = context.operations.typeAtNode(node);
      const bound = applySubstitutions(nodeType, scoped.substitutions, context.operations);
      return resolve(bound === nodeType ? element : nodeType, node, undefined, scoped);
    }),
    ...flagFields({ isReadonly: context.operations.isReadonlyType(type) }),
    ...definedFields({ typeName: typeNameValue }),
  };
}

/**
 * Recovers authored container element syntax, so a nested alias or `keyof`
 * operand inside `T[]` / `Array<T>` / `ReadonlyArray<T>` still reaches the
 * element resolver — for an array's single element as well as for every
 * element an open rest spreads. Returns `undefined` when no authored container
 * is available and the semantic element type is sufficient on its own.
 *
 * Any *other* reference is refused: an alias such as `type StrArr<T> = string[]`
 * is an array whose authored syntax names `T`, and donating that argument to the
 * element would publish an element named after a type it has nothing to do with.
 * Upstream gates the same branch on `getBuiltInArrayReferenceName`
 * (`arrayTypeResolver.ts`). Only the array literal syntax and TypeScript's own
 * array references describe their element type in a position this can read.
 */
function containerElementNode(
  sourceNode: BackendNodeReference | undefined,
  context: Context
): BackendNodeReference | undefined {
  const node = unwrapAuthoredNode(sourceNode, context, isContainerWrapper);
  if (node === undefined) return undefined;
  const facts = context.operations.nodeFacts(node);
  if (facts.kind === "array") return facts.children?.[0];
  return builtInArrayElementNode(facts);
}

/**
 * Reads the element syntax of a reference to one of TypeScript's own array
 * interfaces, or `undefined` for every other reference.
 *
 * The backend verifies the reference through the checker rather than by its name
 * text, so a project that declares its own `Array<T>` cannot donate element
 * syntax that describes a different type than the element the checker reports.
 */
function builtInArrayElementNode(facts: BackendNodeFacts): BackendNodeReference | undefined {
  if (facts.kind !== "typeReference" || facts.typeName?.builtInArray === undefined) return undefined;
  return facts.typeName.authoredArguments?.[0];
}

/**
 * Pairs each semantic tuple element with the authored syntax that produced it.
 *
 * A rest or variadic position expands into a different number of semantic
 * elements than the one authored node it was written as, so the two lists are
 * aligned by *width* rather than by index: every fixed position is one element,
 * a spread of a known finite tuple contributes that tuple's own elements, and an
 * open rest absorbs whatever is left. Pairing by index instead would attach one
 * element's authored syntax to another element's type. This mirrors upstream's
 * tuple element selection plan (`tupleTypeResolver.ts`).
 */
function authoredTupleElementNodes(
  sourceNode: BackendNodeReference | undefined,
  elementCount: number,
  context: Context
): TupleElementExpansion {
  const node = unwrapAuthoredNode(sourceNode, context, isContainerWrapper);
  if (node === undefined) return { elements: [] };
  const plan = tupleElementPlan(node, elementCount, context, new Set());
  return plan ?? { elements: [] };
}

/** Authored tuple sources already entered, so a spread cannot re-enter itself. */
type VisitedTupleSources = ReadonlySet<BackendNodeReference>;

/**
 * Expands one authored element node per semantic tuple element, or `undefined`
 * when the authored widths cannot account for the semantic element list.
 * Each donated element carries its own bindings, including through nested spreads.
 */
function tupleElementPlan(
  node: BackendNodeReference,
  elementCount: number,
  context: Context,
  visited: VisitedTupleSources
): TupleElementExpansion | undefined {
  const facts = context.operations.nodeFacts(node);
  if (facts.kind !== "tuple" || facts.children === undefined) return undefined;
  const children = facts.children;
  const restPositions = facts.restElements ?? [];
  const widths = distributedWidths(
    children.map((child, index) =>
      restPositions[index] === true ? finiteRestWidth(child, context, visited) : 1
    ),
    elementCount
  );
  if (widths === undefined) return undefined;
  const elements = children.flatMap((child, index) =>
    expandedTupleElement(child, restPositions[index] === true, widths[index] ?? 0, context, visited)
  );
  return { elements };
}

/**
 * Resolves the authored widths against the semantic element count. Known widths
 * must add up exactly; otherwise the first open rest absorbs the remaining
 * elements, and every other open rest keeps the single element it must have.
 */
function distributedWidths(
  widths: readonly (number | undefined)[],
  elementCount: number
): readonly number[] | undefined {
  const minimum = widths.reduce<number>((total, width) => total + (width ?? 1), 0);
  const firstOpen = widths.indexOf(undefined);
  if (firstOpen === -1) return minimum === elementCount ? widths.map((width) => width ?? 1) : undefined;
  if (minimum > elementCount) return undefined;
  return widths.map((width, index) => width ?? (index === firstOpen ? elementCount - minimum + 1 : 1));
}

/** Expands one authored tuple position into the semantic elements it covers. */
function expandedTupleElement(
  child: BackendNodeReference,
  isRest: boolean,
  width: number,
  context: Context,
  visited: VisitedTupleSources
): readonly TupleElement[] {
  if (!isRest) return [{ node: child, substitutions: context.substitutions }];
  const source = finiteTupleSource(child, context, visited);
  if (source === undefined) return openRestArrayElements(child, width, context);
  const nested = tupleElementPlan(
    source.body,
    width,
    source.substitutions === undefined ? context : { ...context, substitutions: source.substitutions },
    new Set([...visited, source.body])
  );
  if (nested !== undefined) return nested.elements;
  return openRestArrayElements(child, width, context);
}

/**
 * An open rest spreads an array, so every element it covers is described by
 * the array's element syntax — not by the array itself, which would name a
 * different type than the element the checker reports.
 */
function openRestArrayElements(
  child: BackendNodeReference,
  width: number,
  context: Context
): readonly TupleElement[] {
  const node = containerElementNode(child, context);
  return Array.from({ length: width }, () => ({ node, substitutions: context.substitutions }));
}

/**
 * Counts the semantic elements a spread contributes, or `undefined` when the
 * spread is open-ended.
 */
function finiteRestWidth(
  child: BackendNodeReference,
  context: Context,
  visited: VisitedTupleSources
): number | undefined {
  const source = finiteTupleSource(child, context, visited);
  if (source === undefined) return undefined;
  const facts = context.operations.nodeFacts(source.body);
  const children = facts.children ?? [];
  const restPositions = facts.restElements ?? [];
  const nested = new Set([...visited, source.body]);
  let total = 0;
  for (const [index, element] of children.entries()) {
    const width = restPositions[index] === true ? finiteRestWidth(element, context, nested) : 1;
    if (width === undefined) return undefined;
    total += width;
  }
  return total;
}

/**
 * Follows a rest element's authored syntax to the tuple it spreads, when that
 * tuple describes the same elements at every instantiation.
 *
 * An inline tuple and a reference to a parameterless tuple alias both do. A
 * *generic* tuple alias does too since the binding machinery landed: its
 * declaration's parameters are rebound to the written arguments, so the
 * declaration's element nodes describe this instantiation — upstream carries
 * the same bindings through the traversal
 * (`deriveTypeParameterBindings`). The returned `substitutions` travel with
 * the expansion so donated element nodes resolve against this instantiation.
 */
function finiteTupleSource(
  child: BackendNodeReference,
  context: Context,
  visited: VisitedTupleSources
): TupleSource | undefined {
  const node = unwrapAuthoredNode(child, context, isContainerWrapper);
  if (node === undefined || visited.has(node)) return undefined;
  const facts = context.operations.nodeFacts(node);
  if (facts.kind === "tuple") return { body: node };
  if (facts.kind !== "typeReference") return undefined;
  const symbol = facts.typeName?.authoredSymbol;
  const authoredArguments = facts.typeName?.authoredArguments;
  if (symbol === undefined) return undefined;
  const declaration = context.operations.symbolFacts(symbol).declarations[0];
  const declarationFacts = declaration === undefined ? undefined : context.operations.nodeFacts(declaration);
  if (
    declaration === undefined ||
    declarationFacts?.kind !== "typeAlias" ||
    declarationFacts.type === undefined
  )
    return undefined;
  const body =
    unwrapAuthoredNode(declarationFacts.type, context, isContainerWrapper) ?? declarationFacts.type;
  if (context.operations.nodeKind(body) !== "tuple") return undefined;
  if (authoredArguments === undefined) {
    return finiteTupleSource(body, context, new Set([...visited, node]));
  }
  // A generic instantiation: bind the declaration's parameters to the written
  // arguments so its element nodes describe this spread.
  const bindings = bindAliasParameters(declaration, context, (index) => {
    const argument = authoredArguments[index];
    return argument === undefined
      ? undefined
      : applySubstitutions(
          context.operations.typeAtNode(argument),
          context.substitutions,
          context.operations
        );
  });
  if (bindings === undefined) {
    return finiteTupleSource(body, context, new Set([...visited, node]));
  }
  return { body, substitutions: bindings };
}

/**
 * Removes authored parentheses and the `readonly` type operator so container
 * syntax reaches its element list. `readonly` is a modifier on the container,
 * not a distinct authored container, and the readonly state is already read
 * from the checker type.
 */
function isContainerWrapper(facts: BackendNodeFacts): boolean {
  return facts.kind === "parenthesized" || (facts.kind === "typeOperator" && facts.operator === "readonly");
}
