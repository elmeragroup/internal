import type {
  BackendCompilerOperations,
  BackendExportDraft,
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

/**
 * Mutable bookkeeping for one request's walk.
 *
 * `authoredFilePath` is the last project-owned file the walk passed through.
 * When the walk ends on a dependency declaration, that file (or, for a pure
 * re-export chain the walk never steps through, the export's own forwarding
 * statement) is the authored module the value is published from.
 */
type Walk = {
  readonly visitedSymbols: Set<BackendSymbolHandle>;
  readonly visitedNodes: Set<BackendNodeHandle>;
  readonly forwardingFilePath: string | undefined;
  authoredFilePath: string | undefined;
};

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
  return followSymbol(operations, root, startWalk(exported));
}

function startWalk(exported: BackendExportDraft): Walk {
  return {
    visitedSymbols: new Set(),
    visitedNodes: new Set(),
    forwardingFilePath: exported.forwardingFilePath,
    authoredFilePath: undefined,
  };
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
  walk: Walk
): ComponentSourceResult {
  if (walk.visitedSymbols.has(symbol)) return unresolved("cycle");
  walk.visitedSymbols.add(symbol);
  const facts = operations.symbolFacts(symbol);
  const implementations = functionImplementations(operations, facts);
  if (implementations.length > 1) return unresolved("ambiguous-implementation");
  const implementation = implementations[0];
  if (implementation !== undefined) {
    return followNode(operations, implementation, walk);
  }
  const declaration = facts.valueDeclaration ?? facts.declarations[0];
  if (declaration === undefined) return unresolved("no-implementation");
  return followNode(operations, declaration, walk);
}

function followNode(
  operations: SourceOperations,
  node: BackendNodeHandle,
  walk: Walk
): ComponentSourceResult {
  if (walk.visitedNodes.has(node)) return unresolved("cycle");
  walk.visitedNodes.add(node);
  const facts = operations.nodeFacts(node);
  if (facts.ownership?.kind === "project") walk.authoredFilePath = facts.filePath;
  if (facts.innerExpression !== undefined) {
    return followNode(operations, facts.innerExpression, walk);
  }
  if (isFunctionKind(facts)) {
    if (facts.hasImplementationBody !== true) return declarationOnly(facts, walk);
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
    return followNode(operations, firstArgument, walk);
  }
  if (facts.kind === "variable" || facts.kind === "property") {
    if (facts.initializer !== undefined) {
      return followNode(operations, facts.initializer, walk);
    }
    if (facts.referencedValueSymbol !== undefined) {
      return followSymbol(operations, facts.referencedValueSymbol, walk);
    }
    return declarationOnly(facts, walk);
  }
  if (facts.referencedValueSymbol !== undefined) {
    return followSymbol(operations, facts.referencedValueSymbol, walk);
  }
  return unresolved("no-implementation");
}

/**
 * A declaration without a body is a forwarded dependency value when it is
 * owned by a dependency and an authored module forwards it. A project
 * declaration file, or a dependency reached without any authored hop, still
 * has no recoverable implementation.
 */
function declarationOnly(facts: BackendNodeFacts, walk: Walk): ComponentSourceResult {
  const filePath = walk.authoredFilePath ?? walk.forwardingFilePath;
  if (facts.ownership?.kind !== "dependency" || filePath === undefined) {
    return unresolved("no-implementation");
  }
  return { status: "forwarded", filePath, packageName: facts.ownership.packageName };
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
