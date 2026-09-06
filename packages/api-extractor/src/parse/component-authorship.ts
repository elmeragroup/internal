import type {
  BackendNodeFacts,
  BackendNodeHandle,
  BackendSymbolHandle,
  BackendTypeNodeHandle,
} from "../backend/contracts.ts";
import type { ResolverContext } from "./contracts.ts";
import { primaryDeclaration } from "./ownership.ts";
import { isReactWrapperCall } from "./react-policy.ts";

/** One authored props parameter and the type syntax attached to it. */
export type AuthoredComponentParameter = {
  readonly parameter: BackendNodeHandle;
  readonly propsType: BackendTypeNodeHandle | undefined;
};

/**
 * All authored evidence recovered in one graph walk. Keeping parameters,
 * props nodes, and binding defaults together prevents the component transform
 * from traversing the same declarations once for props and again for defaults.
 */
export type AuthoredComponentRecovery = {
  readonly parameters: readonly AuthoredComponentParameter[];
  readonly propNodes: readonly BackendTypeNodeHandle[];
  readonly bindingDefaults?: ReadonlyMap<string, string>;
};

/** Recovers direct-export and supported-wrapper authored component syntax. */
export function recoverAuthoredComponent(
  symbol: BackendSymbolHandle,
  context: ResolverContext
): AuthoredComponentRecovery {
  const parameters = authoredDirectExportParameters(symbol, context);
  const propNodes = parameters.flatMap((entry) => (entry.propsType === undefined ? [] : [entry.propsType]));
  const entries: [string, string][] = [];
  for (const { parameter } of parameters) {
    for (const entry of context.operations.nodeFacts(parameter).bindingDefaults ?? []) {
      if (!entries.some(([name]) => name === entry.name)) entries.push([entry.name, entry.initializerText]);
    }
  }
  if (entries.length === 0) return { parameters, propNodes };
  return { parameters, propNodes, bindingDefaults: new Map(entries) };
}

/**
 * Direct exports and identifiers recovered from React wrappers have different
 * authored-signature contracts. Direct exports preserve the declaration walk
 * (including an overload implementation); wrapper identifiers use the
 * checker's public signatures, which intentionally omit that implementation.
 */
function authoredDirectExportParameters(
  symbol: BackendSymbolHandle,
  context: ResolverContext,
  seenSymbols: ReadonlySet<BackendSymbolHandle> = new Set()
): AuthoredComponentParameter[] {
  const inspected = inspectAuthoredSymbol(symbol, context, seenSymbols);
  if (inspected === undefined) return [];
  const { facts, declarationFacts, nextSeenSymbols } = inspected;
  if (declarationFacts.kind === "function" || declarationFacts.kind === "functionLike") {
    // Every authored overload declaration contributes its first parameter,
    // including an implementation declaration on a direct export.
    return facts.declarations.flatMap((candidate): AuthoredComponentParameter[] => {
      const candidateFacts = context.operations.nodeFacts(candidate);
      if (candidateFacts.kind !== "function" && candidateFacts.kind !== "functionLike") return [];
      const parameter = candidateFacts.parameters?.[0];
      if (parameter === undefined) return [];
      return [{ parameter, propsType: context.operations.nodeFacts(parameter).type }];
    });
  }
  return authoredVariableParameters(
    declarationFacts,
    context,
    nextSeenSymbols,
    authoredWrapperIdentifierParameters
  );
}

/** Resolves an identifier passed as the first argument of a React wrapper. */
function authoredWrapperIdentifierParameters(
  symbol: BackendSymbolHandle,
  context: ResolverContext,
  seenSymbols: ReadonlySet<BackendSymbolHandle> = new Set()
): AuthoredComponentParameter[] {
  const inspected = inspectAuthoredSymbol(symbol, context, seenSymbols);
  if (inspected === undefined) return [];
  const { declarationFacts, nextSeenSymbols } = inspected;
  if (declarationFacts.kind === "function" || declarationFacts.kind === "functionLike") {
    return authoredFunctionParameters(symbol, context);
  }
  return authoredVariableParameters(
    declarationFacts,
    context,
    nextSeenSymbols,
    authoredWrapperIdentifierParameters
  );
}

function inspectAuthoredSymbol(
  symbol: BackendSymbolHandle,
  context: ResolverContext,
  seenSymbols: ReadonlySet<BackendSymbolHandle>
):
  | {
      readonly facts: ReturnType<ResolverContext["operations"]["symbolFacts"]>;
      readonly declarationFacts: BackendNodeFacts;
      readonly nextSeenSymbols: ReadonlySet<BackendSymbolHandle>;
    }
  | undefined {
  if (seenSymbols.has(symbol)) return undefined;
  const nextSeenSymbols = new Set(seenSymbols);
  nextSeenSymbols.add(symbol);
  const exportName = context.symbolStack.at(-1);
  if (exportName !== "default" && (exportName === undefined || !/^[A-Z]/u.test(exportName))) return undefined;
  context.operations.setErrorContext(context.symbolStack);
  const facts = context.operations.symbolFacts(symbol);
  const declaration = primaryDeclaration(facts);
  if (declaration === undefined) return undefined;
  return { facts, declarationFacts: context.operations.nodeFacts(declaration), nextSeenSymbols };
}

function authoredVariableParameters(
  declarationFacts: BackendNodeFacts,
  context: ResolverContext,
  nextSeenSymbols: ReadonlySet<BackendSymbolHandle>,
  resolveWrapperIdentifier: (
    symbol: BackendSymbolHandle,
    context: ResolverContext,
    seenSymbols: ReadonlySet<BackendSymbolHandle>
  ) => AuthoredComponentParameter[]
): AuthoredComponentParameter[] {
  if (declarationFacts.kind !== "variable" || declarationFacts.initializer === undefined) return [];
  const initializerFacts = context.operations.nodeFacts(declarationFacts.initializer);
  const singleParameter = (factsForNode: {
    readonly parameters?: readonly BackendNodeHandle[];
  }): AuthoredComponentParameter[] => {
    const parameter = factsForNode.parameters?.[0];
    return parameter === undefined
      ? []
      : [{ parameter, propsType: context.operations.nodeFacts(parameter).type }];
  };
  if (initializerFacts.kind === "function" || initializerFacts.kind === "functionLike")
    return singleParameter(initializerFacts);
  if (initializerFacts.kind !== "callExpression") return [];

  // Only the first argument of a supported React wrapper owns component
  // syntax. A comparator callback passed to memo is deliberately ignored.
  const firstArgument = (initializerFacts.arguments ?? [])[0];
  const supportedWrapper = isSupportedReactWrapperCall(initializerFacts);
  const renderFunctions = supportedWrapper ? authoredComponentRenderFunctions(firstArgument, context) : [];
  if (renderFunctions.length > 0)
    return renderFunctions.flatMap((renderFunction) =>
      singleParameter(context.operations.nodeFacts(renderFunction))
    );

  // A wrapper can receive an authored overloaded function through an
  // identifier (`memo(OverloadedRender)`), so follow its checker symbols.
  if (!supportedWrapper) return [];
  const argumentType = firstArgument === undefined ? undefined : context.operations.typeAtNode(firstArgument);
  if (argumentType === undefined) return [];
  const argumentFacts = context.operations.typeFacts(argumentType);
  const argumentSymbols = [argumentFacts.symbol, argumentFacts.aliasSymbol].filter(
    (candidate, index, all): candidate is BackendSymbolHandle =>
      candidate !== undefined && all.indexOf(candidate) === index
  );
  for (const argumentSymbol of argumentSymbols) {
    const authored = resolveWrapperIdentifier(argumentSymbol, context, nextSeenSymbols);
    if (authored.length > 0) return authored;
  }
  return [];
}

function authoredComponentRenderFunctions(
  node: BackendNodeHandle | undefined,
  context: ResolverContext,
  seen: ReadonlySet<BackendNodeHandle> = new Set()
): readonly BackendNodeHandle[] {
  if (node === undefined || seen.has(node)) return [];
  const nextSeen = new Set(seen);
  nextSeen.add(node);
  const facts = context.operations.nodeFacts(node);
  if (facts.kind === "function" || facts.kind === "functionLike") return [node];
  if (facts.kind !== "callExpression") return [];
  if (!isSupportedReactWrapperCall(facts)) return [];
  return authoredComponentRenderFunctions(facts.arguments?.[0], context, nextSeen);
}

function isSupportedReactWrapperCall(facts: BackendNodeFacts): boolean {
  return isReactWrapperCall(facts.calleeFacts);
}

/** Reads authored props from checker-visible public call signatures. */
function authoredFunctionParameters(
  symbol: BackendSymbolHandle,
  context: ResolverContext
): AuthoredComponentParameter[] {
  const type = context.operations.typeOfSymbol(symbol, false);
  if (type === undefined) return [];
  const parameters: AuthoredComponentParameter[] = [];
  const seenDeclarations = new Set<BackendNodeHandle>();
  for (const signature of context.operations.signaturesOfType(type)) {
    const signatureFacts = context.operations.signatureFacts(signature);
    const declaration = signatureFacts.declaration;
    const declarationFacts =
      declaration === undefined ? undefined : context.operations.nodeFacts(declaration);
    const parameter =
      declarationFacts?.parameters?.[0] ??
      (signatureFacts.parameters[0] === undefined
        ? undefined
        : primaryDeclaration(context.operations.symbolFacts(signatureFacts.parameters[0])));
    if (parameter === undefined || seenDeclarations.has(parameter)) continue;
    seenDeclarations.add(parameter);
    parameters.push({ parameter, propsType: context.operations.nodeFacts(parameter).type });
  }
  return parameters;
}
