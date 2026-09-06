import type {
  BackendNodeReference,
  BackendSymbolHandle,
  BackendTypeHandle,
  BackendTypeNameFacts,
} from "../backend/contracts.ts";
import type { TypeArgument } from "../model.ts";
import type { ResolveSemanticType, ResolverContext } from "./contracts.ts";

type NamedTypeArguments = {
  readonly namespaces: readonly string[];
  readonly typeArguments: readonly TypeArgument[];
};

type NamedTypeArgumentOptions = {
  readonly args: readonly BackendTypeHandle[];
  readonly nameFacts: BackendTypeNameFacts;
  readonly namespaces: readonly string[];
  readonly sourceNode: BackendNodeReference | undefined;
  readonly symbol: BackendSymbolHandle | undefined;
  readonly context: ResolverContext;
  readonly resolveType: ResolveSemanticType;
};

type TypeArgumentPolicy = {
  readonly outerDeclarationIsExternal: boolean;
  readonly effectiveNamespaces: readonly string[];
  readonly checkerSubstitutions: readonly boolean[];
  readonly generatedFallback: readonly string[] | undefined;
};

/**
 * Builds named type arguments while deferring `moduleOrigin` until a generated
 * fallback or checker substitution actually needs the ownership distinction.
 */
export function namedTypeArguments(options: NamedTypeArgumentOptions): NamedTypeArguments {
  const policy = typeArgumentPolicy(options);
  const typeArguments = options.args.map((argument, index) =>
    namedTypeArgument(argument, index, policy, options)
  );
  return { namespaces: policy.effectiveNamespaces, typeArguments };
}

function typeArgumentPolicy(options: NamedTypeArgumentOptions): TypeArgumentPolicy {
  const { args, nameFacts, namespaces, sourceNode, symbol, context } = options;
  const inheritedGenerated = context.generatedTypeArgumentNamespaces;
  const checkerSubstitutions = args.map((argument, index) => {
    const authoredArgument = nameFacts.authoredArguments?.[index];
    const authoredArgumentType =
      namespaces.length === 0 || authoredArgument === undefined
        ? undefined
        : context.operations.typeAtNode(authoredArgument);
    return (
      namespaces.length > 0 &&
      authoredArgumentType !== undefined &&
      authoredArgumentType !== argument &&
      typeGraphContainsTypeParameter(authoredArgumentType, context) &&
      !typeGraphContainsTypeParameter(argument, context)
    );
  });
  // A generated namespace is evidence attached to the checker substitution
  // context below, never a general enclosing-namespace fallback. It is only
  // consumed for a source-less concrete argument whose own symbol is known to
  // come from an external declaration. Project-owned substitutions (for
  // example `Outer<T>` instantiated with top-level `Local`) must keep their
  // own, empty namespace path. Reading moduleOrigin is a remote fact, so defer
  // it until a generated fallback or an actual checker substitution needs the
  // ownership distinction; ordinary authored names do not.
  const needsExternalOrigin =
    (sourceNode === undefined && inheritedGenerated !== undefined) || checkerSubstitutions.some(Boolean);
  const outerDeclarationIsExternal =
    needsExternalOrigin &&
    symbol !== undefined &&
    context.operations.symbolOrigin(symbol).moduleOrigin?.external === true;
  const canConsumeGeneratedFallback =
    sourceNode === undefined && inheritedGenerated !== undefined && outerDeclarationIsExternal;
  let effectiveNamespaces: readonly string[] = [];
  if (namespaces.length > 0) effectiveNamespaces = namespaces;
  else if (canConsumeGeneratedFallback) effectiveNamespaces = inheritedGenerated;
  let generatedFallback: readonly string[] | undefined;
  if (outerDeclarationIsExternal) {
    generatedFallback = namespaces.length > 0 ? namespaces : inheritedGenerated;
  }
  return { outerDeclarationIsExternal, effectiveNamespaces, checkerSubstitutions, generatedFallback };
}

function namedTypeArgument(
  argument: BackendTypeHandle,
  index: number,
  policy: TypeArgumentPolicy,
  options: NamedTypeArgumentOptions
): TypeArgument {
  const authoredArgument = options.nameFacts.authoredArguments?.[index];
  const isCheckerSubstitution = policy.checkerSubstitutions[index] === true;
  const argumentSourceNode = isCheckerSubstitution ? undefined : authoredArgument;
  const resolveArgument = (context: ResolverContext) =>
    options.resolveType(argument, argumentSourceNode, undefined, context);
  return {
    type: resolveNamedArgumentType(
      isCheckerSubstitution,
      authoredArgument,
      policy,
      options.context,
      resolveArgument
    ),
    equalToDefault: argumentMatchesDefault(argument, index, options.symbol, options.context),
  };
}

function resolveNamedArgumentType(
  isCheckerSubstitution: boolean,
  authoredArgument: BackendNodeReference | undefined,
  policy: TypeArgumentPolicy,
  context: ResolverContext,
  resolveArgument: (context: ResolverContext) => ReturnType<ResolveSemanticType>
): ReturnType<ResolveSemanticType> {
  // Only an external outer declaration justifies carrying its namespace to
  // a checker-generated replacement argument. A project-owned generic such
  // as `Outer<T>` can resolve its concrete `Local` argument through the same
  // substitution path, but `Local` must remain top-level. The inherited
  // namespaces travel on the context so an authored argument nested under a
  // generated one drops them again.
  if (isCheckerSubstitution) {
    if (!policy.outerDeclarationIsExternal || policy.generatedFallback === undefined) {
      return resolveArgument(context);
    }
    return resolveArgument({ ...context, generatedTypeArgumentNamespaces: policy.generatedFallback });
  }
  if (authoredArgument !== undefined && context.generatedTypeArgumentNamespaces !== undefined) {
    return resolveArgument({ ...context, generatedTypeArgumentNamespaces: undefined });
  }
  return resolveArgument(context);
}

/** Whether a checker type graph contains a type parameter at any nested position. */
function typeGraphContainsTypeParameter(
  type: BackendTypeHandle,
  context: ResolverContext,
  seen: Set<BackendTypeHandle> = new Set()
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  const facts = context.operations.typeFacts(type);
  if (facts.isTypeParameter === true) return true;
  const nested = [
    ...(facts.unionOrIntersectionTypes ?? []),
    ...(facts.typeArguments ?? []),
    ...(facts.aliasTypeArguments ?? []),
  ];
  return nested.some((child) => typeGraphContainsTypeParameter(child, context, seen));
}

function argumentMatchesDefault(
  argument: BackendTypeHandle,
  index: number,
  symbol: BackendSymbolHandle | undefined,
  context: ResolverContext
): boolean {
  if (context.operations.typeFacts(argument).isTypeParameter === true || symbol === undefined) return false;
  const declaration = context.operations.symbolFacts(symbol).declarations[0];
  if (declaration === undefined) return false;
  const info = context.operations.nodeFacts(declaration);
  const parameter = info.typeParameters?.[index];
  if (parameter === undefined) return false;
  const parameterInfo = context.operations.nodeFacts(parameter);
  if (parameterInfo.defaultType === undefined) return false;
  const defaultType = context.operations.typeAtNode(parameterInfo.defaultType);
  return (
    defaultType !== undefined &&
    context.operations.typeToString(defaultType) === context.operations.typeToString(argument)
  );
}
