import type {
  BackendCompilerOperations,
  BackendModuleDraft,
  BackendNodeFacts,
  BackendNodeHandle,
  BackendSymbolFacts,
  BackendSymbolHandle,
} from "../backend/contracts.ts";
import type {
  ComponentSourceRequest,
  ComponentSourceResult,
  ComponentSourceUnresolvedReason,
} from "../component-sources.ts";
import { isReactWrapperCall } from "./react-policy.ts";

type SourceOperations = Pick<
  BackendCompilerOperations,
  "nodeFacts" | "propertiesOfType" | "symbolFacts" | "typeOfSymbol"
>;

/** Resolves requested component implementation files without semantic extraction. */
export function inspectRequestedComponentSources(
  draft: BackendModuleDraft,
  operations: SourceOperations,
  requests: readonly ComponentSourceRequest[]
): readonly ComponentSourceResult[] {
  return requests.map((request) => inspectRequestedComponentSource(draft, operations, request));
}

function inspectRequestedComponentSource(
  draft: BackendModuleDraft,
  operations: SourceOperations,
  request: ComponentSourceRequest
): ComponentSourceResult {
  const blocked = blockingWarning(draft, request.exportName);
  if (blocked !== undefined) return blocked;
  const exported = draft.exports.find((entry) => entry.name === request.exportName);
  if (exported === undefined) return unresolved("export-not-found");
  const root =
    request.memberName === undefined
      ? exported.symbol
      : findMember(operations, exported.symbol, request.memberName);
  if (root === undefined) return unresolved("member-not-found");
  return followSymbol(operations, root, new Set(), new Set());
}

function blockingWarning(draft: BackendModuleDraft, exportName: string): ComponentSourceResult | undefined {
  for (const warning of draft.warnings ?? []) {
    if (warning.code === "unresolved-re-export" && warning.name === exportName) {
      return unresolved(warning.reason === "ambiguous" ? "ambiguous-export" : "unresolved-export");
    }
    if (warning.code === "missing-default-export-symbol" && exportName === "default") {
      return unresolved("unsupported-default-expression");
    }
  }
  return undefined;
}

function findMember(
  operations: SourceOperations,
  root: BackendSymbolHandle,
  memberName: string
): BackendSymbolHandle | undefined {
  const type = operations.typeOfSymbol(root, false);
  if (type === undefined) return undefined;
  const matches = operations
    .propertiesOfType(type)
    .filter((member) => operations.symbolFacts(member).name === memberName);
  const member = matches[0];
  if (matches.length !== 1 || member === undefined) return undefined;
  return member;
}

function followSymbol(
  operations: SourceOperations,
  symbol: BackendSymbolHandle,
  visitedSymbols: Set<BackendSymbolHandle>,
  visitedNodes: Set<BackendNodeHandle>
): ComponentSourceResult {
  if (visitedSymbols.has(symbol)) return unresolved("cycle");
  visitedSymbols.add(symbol);
  const facts = operations.symbolFacts(symbol);
  const implementations = functionImplementations(operations, facts);
  if (implementations.length > 1) return unresolved("ambiguous-implementation");
  const implementation = implementations[0];
  if (implementation !== undefined) {
    return followNode(operations, implementation, visitedSymbols, visitedNodes);
  }
  const declaration = facts.valueDeclaration ?? facts.declarations[0];
  if (declaration === undefined) return unresolved("no-implementation");
  return followNode(operations, declaration, visitedSymbols, visitedNodes);
}

function followNode(
  operations: SourceOperations,
  node: BackendNodeHandle,
  visitedSymbols: Set<BackendSymbolHandle>,
  visitedNodes: Set<BackendNodeHandle>
): ComponentSourceResult {
  if (visitedNodes.has(node)) return unresolved("cycle");
  visitedNodes.add(node);
  const facts = operations.nodeFacts(node);
  if (facts.innerExpression !== undefined) {
    return followNode(operations, facts.innerExpression, visitedSymbols, visitedNodes);
  }
  if (isFunctionKind(facts)) {
    if (facts.hasImplementationBody !== true) return unresolved("no-implementation");
    const parameter = facts.parameters?.[0];
    return {
      status: "resolved",
      filePath: facts.filePath,
      defaults: parameter === undefined ? [] : (operations.nodeFacts(parameter).sourceBindingDefaults ?? []),
    };
  }
  if (facts.kind === "callExpression") {
    if (!isReactWrapperCall(facts.calleeFacts)) return unresolved("unsupported-wrapper");
    const firstArgument = facts.arguments?.[0];
    if (firstArgument === undefined) return unresolved("no-implementation");
    return followNode(operations, firstArgument, visitedSymbols, visitedNodes);
  }
  if (facts.kind === "variable" || facts.kind === "property") {
    if (facts.initializer !== undefined) {
      return followNode(operations, facts.initializer, visitedSymbols, visitedNodes);
    }
    if (facts.referencedValueSymbol !== undefined) {
      return followSymbol(operations, facts.referencedValueSymbol, visitedSymbols, visitedNodes);
    }
    return unresolved("no-implementation");
  }
  if (facts.referencedValueSymbol !== undefined) {
    return followSymbol(operations, facts.referencedValueSymbol, visitedSymbols, visitedNodes);
  }
  return unresolved("no-implementation");
}

function functionImplementations(
  operations: SourceOperations,
  facts: BackendSymbolFacts
): readonly BackendNodeHandle[] {
  const declarations = [
    ...facts.declarations,
    ...(facts.valueDeclaration === undefined ? [] : [facts.valueDeclaration]),
  ].filter((declaration, index, all) => all.indexOf(declaration) === index);
  return declarations.filter((declaration) => {
    const nodeFacts = operations.nodeFacts(declaration);
    return isFunctionKind(nodeFacts) && nodeFacts.hasImplementationBody === true;
  });
}

function isFunctionKind(facts: BackendNodeFacts): boolean {
  return facts.kind === "function" || facts.kind === "functionLike" || facts.kind === "method";
}

function unresolved(reason: ComponentSourceUnresolvedReason): ComponentSourceResult {
  return { status: "unresolved", reason };
}
