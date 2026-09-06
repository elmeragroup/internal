import type { BackendNodeHandle, BackendNodeReference, BackendTypeHandle } from "../backend/contracts.ts";
import type { SemanticType, TypeName } from "../model.ts";
import { definedFields } from "../optional-fields.ts";
import { authoredContainsPreservableKeyof } from "./authored-node.ts";
import { addUndefined } from "./component.ts";
import type { ResolveSemanticType, ResolverContext } from "./contracts.ts";
import { recordIndexSignatureKeyProvenance } from "./object-resolver.ts";
import { declarationOwnership, isExternalOwnership } from "./ownership.ts";
import { aliasInstantiationArguments, applySubstitutions, bindAliasParameters } from "./substitutions.ts";
import type { Substitutions } from "./substitutions.ts";

type Context = ResolverContext;

/** The key domain, value template, and optionality one mapped type declares. */
type MappedKeySignature = {
  readonly keyName?: string;
  readonly keyNameFromLibrary: boolean;
  readonly keyType: "string" | "number";
  readonly valueType: BackendTypeHandle;
  readonly valueNode?: BackendNodeReference;
  readonly optional: boolean;
  readonly substitutions: Substitutions;
};

/**
 * Resolves a mapped type into an object carrying one synthesized index
 * signature, or `undefined` when the mapped key domain is not representable as
 * one.
 *
 * A mapped type over an *open* key domain (`[P in K]` where `K extends string`)
 * has no concrete properties, so the only faithful shape is an index signature
 * synthesized from the authored key parameter and value template. A mapped type
 * over a *finite* key domain — a literal union, or an `as` clause that renames
 * keys — is deliberately left to ordinary object resolution, which reports the
 * real properties. That split follows upstream's
 * `buildMappedIndexSignatureNode`: it produces a signature only when the key
 * constraint's base is `string` or `number`.
 */
export function mappedObjectNode(
  type: BackendTypeHandle,
  sourceNode: BackendNodeReference | undefined,
  typeNameValue: TypeName | undefined,
  context: Context,
  resolve: ResolveSemanticType
): SemanticType | undefined {
  const declaration = mappedDeclaration(type, sourceNode, context);
  const mapped = declaration === undefined ? undefined : mappedKeySignature(declaration, context);
  if (mapped === undefined) return undefined;
  // A mapped key is never declared: the type invents one per constraint
  // member, so its entry is attributed to the mapped type's own declarations
  // and marked synthesized.
  recordIndexSignatureKeyProvenance(type, true, context);
  const value = resolve(mapped.valueType, mapped.valueNode, undefined, {
    ...context,
    substitutions: mapped.substitutions,
    propertyDepth: context.propertyDepth + 1,
  });
  return {
    kind: "object",
    properties: [],
    indexSignature: {
      keyType: mapped.keyType,
      valueType: mapped.optional ? addUndefined(value) : value,
      // A key name invented inside a library declaration is not public.
      //
      // Upstream emits the mapped key parameter's name unconditionally, but it
      // only reaches the mapped branch when the checker reports no index info
      // for the type (`buildIndexSignatureNodeCore`). A library mapped alias
      // like `Record<string, V>` does have one, so upstream takes the ordinary
      // index-signature route, whose key name comes from an authored index
      // signature — which a synthesized key has none of, and upstream reports no
      // key name at all. TypeScript 7 reaches the same types through their
      // mapped declaration, so `Record`'s internal `P` would become public here.
      // The upstream oracle for `type-object-shape-resolution` is the recorded
      // evidence for that difference.
      ...definedFields({
        keyName: mapped.keyName === undefined || mapped.keyNameFromLibrary ? undefined : mapped.keyName,
      }),
    },
    ...definedFields({ typeName: typeNameValue }),
  };
}

/** One mapped declaration together with the bindings its parameters need. */
type MappedDeclaration = {
  readonly node: BackendNodeReference;
  readonly substitutions: Substitutions;
};

/**
 * Finds the mapped declaration behind a type, together with the type-parameter
 * bindings that make its key and value resolvable.
 *
 * Two routes reach a mapped declaration. An instantiated alias reaches its
 * mapped body by walking alias hops and rebinding each hop's type parameters,
 * which is what keeps `type A<K> = B<K>; type B<K> = { [P in K]: … }` resolvable
 * *and* what makes each hop report its own parameter defaults. That route is
 * tried first, because the mapped declaration a type's symbol points at is
 * always the innermost one and would otherwise report the innermost alias's
 * parameters — unbound — for every hop. A type with no alias at all, such as an
 * inline `{ [P in K]: V }` written directly in a type position, is then read
 * from its own symbol.
 */
function mappedDeclaration(
  type: BackendTypeHandle,
  sourceNode: BackendNodeReference | undefined,
  context: Context
): MappedDeclaration | undefined {
  const facts = context.operations.typeFacts(type);
  const authoredAlias =
    sourceNode === undefined ? undefined : context.operations.nodeFacts(sourceNode).typeName?.authoredSymbol;
  for (const alias of [facts.aliasSymbol, authoredAlias]) {
    const aliasDeclaration =
      alias === undefined ? undefined : context.operations.symbolFacts(alias).declarations[0];
    if (aliasDeclaration === undefined || context.operations.nodeKind(aliasDeclaration) !== "typeAlias")
      continue;
    const viaAlias = followAliasToMappedDeclaration(
      aliasDeclaration,
      aliasSubstitutions(aliasDeclaration, type, sourceNode, context),
      context,
      new Set<BackendNodeHandle>()
    );
    if (viaAlias !== undefined) return viaAlias;
  }
  const symbol = facts.symbol;
  const direct =
    symbol === undefined
      ? undefined
      : context.operations
          .symbolFacts(symbol)
          .declarations.find((declaration) => context.operations.nodeKind(declaration) === "mapped");
  return direct === undefined ? undefined : { node: direct, substitutions: context.substitutions };
}

/** Reads one mapped type node's key domain, value template, and optionality. */
function mappedKeySignature(
  { node, substitutions }: MappedDeclaration,
  context: Context
): MappedKeySignature | undefined {
  const facts = context.operations.nodeFacts(node);
  // An `as` clause rewrites every key, so the authored key parameter no longer
  // describes the resulting key domain.
  if (facts.mappedNameType !== undefined) return undefined;
  const keyType = mappedKeyType(facts.constraint, substitutions, context);
  if (keyType === undefined) return undefined;
  const valueType = applySubstitutions(
    facts.mappedValueType === undefined ? undefined : context.operations.typeAtNode(facts.mappedValueType),
    substitutions,
    context.operations
  );
  if (valueType === undefined) return undefined;
  // The value template's syntax rides along only when it carries a `keyof`
  // whose key set would otherwise degrade — upstream resolves the template
  // through `getPreservableKeyofTypeNode`, which returns a node for exactly
  // those templates. Every other template is resolved from its checker type
  // alone, so an alias naming an intrinsic (`type U = unknown`) loses the alias
  // name it would otherwise publish on the synthesized signature's value.
  const valueNode =
    facts.mappedValueType !== undefined && authoredContainsPreservableKeyof(facts.mappedValueType, context)
      ? facts.mappedValueType
      : undefined;
  return {
    keyName: facts.keyName ?? "P",
    keyNameFromLibrary: isExternalOwnership(declarationOwnership(node, context)),
    keyType,
    valueType,
    valueNode,
    optional: facts.mappedOptional === true,
    substitutions,
  };
}

/**
 * Classifies a mapped type's key domain. Only `string` and `number` key domains
 * are open enough to be an index signature; a literal union, a template literal,
 * or a missing constraint all describe a finite or unrepresentable key set.
 */
function mappedKeyType(
  constraint: BackendNodeReference | undefined,
  substitutions: Substitutions,
  context: Context
): "string" | "number" | undefined {
  if (constraint === undefined) return undefined;
  const constraintType = applySubstitutions(
    context.operations.typeAtNode(constraint),
    substitutions,
    context.operations
  );
  if (constraintType === undefined) return undefined;
  // The base constraint is only asked for when the constraint is still a type
  // parameter. TypeScript 7 widens a *concrete* literal union to its primitive
  // base ("a" | "b" becomes string), which would turn a finite key domain into
  // an open one and hide the real properties behind an index signature.
  const base =
    context.operations.typeFacts(constraintType).isTypeParameter === true
      ? (context.operations.baseConstraintOfType(constraintType) ?? constraintType)
      : constraintType;
  const intrinsic = context.operations.typeFacts(base).intrinsic;
  return intrinsic === "string" ? "string" : intrinsic === "number" ? "number" : undefined;
}

/** Binds an alias declaration's type parameters to one instantiation's arguments. */
function aliasSubstitutions(
  declaration: BackendNodeHandle,
  type: BackendTypeHandle,
  sourceNode: BackendNodeReference | undefined,
  context: Context
): Substitutions {
  // A hole in the authored arguments drops out of the list instead of keeping
  // its parameter position, so later arguments shift left.
  const args = aliasInstantiationArguments(type, sourceNode, context).filter(
    (argument): argument is BackendTypeHandle => argument !== undefined
  );
  return bindAliasParameters(declaration, context, (index) => args[index]) ?? new Map(context.substitutions);
}

/**
 * Walks alias hops until a mapped body is reached, rebinding type parameters at
 * each hop so the final mapped node's key and value resolve under the original
 * instantiation's arguments.
 */
function followAliasToMappedDeclaration(
  declaration: BackendNodeHandle,
  substitutions: Substitutions,
  context: Context,
  seen: Set<BackendNodeHandle>
): MappedDeclaration | undefined {
  if (seen.has(declaration)) return undefined;
  seen.add(declaration);
  const info = context.operations.nodeFacts(declaration);
  const body = info.type;
  if (body === undefined) return undefined;
  const bodyInfo = context.operations.nodeFacts(body);
  if (bodyInfo.kind === "mapped") return { node: body, substitutions };
  if (bodyInfo.kind !== "typeReference" || bodyInfo.typeName?.authoredSymbol === undefined) return undefined;
  const target = context.operations.symbolFacts(bodyInfo.typeName.authoredSymbol).declarations[0];
  if (target === undefined) return undefined;
  const authoredArguments = bodyInfo.typeName.authoredArguments;
  // Each hop's authored arguments are re-bound through the substitutions
  // accumulated so far before they become the next hop's bindings.
  const next =
    bindAliasParameters(
      target,
      context,
      (index) => {
        const argumentNode = authoredArguments?.[index];
        const authoredArgument =
          argumentNode === undefined ? undefined : context.operations.typeAtNode(argumentNode);
        return applySubstitutions(authoredArgument, substitutions, context.operations);
      },
      substitutions
    ) ?? substitutions;
  return followAliasToMappedDeclaration(target, next, context, seen);
}
