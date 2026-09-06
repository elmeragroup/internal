import { SyntaxKind } from "typescript/unstable/ast";
import type { Node } from "typescript/unstable/ast";
import { isIdentifier, isModuleDeclaration } from "typescript/unstable/ast/is";
import { SymbolFlags } from "typescript/unstable/sync";
import type { Symbol as TsSymbol } from "typescript/unstable/sync";

import { definedFields } from "../../optional-fields.ts";
import type { BackendSymbolFacts, BackendSymbolHandle, BackendSymbolOrigin } from "../contracts.ts";
import { isExternalOwnership } from "../contracts.ts";
import { authoredSymbolName } from "./class-facts.ts";
import type { TsgoFactsSession } from "./facts.ts";
import { isExternalDeclaration } from "./file-ownership.ts";
import { moduleOriginOfSymbol } from "./module-origin.ts";
import { repositoryRelativePath } from "./path-identity.ts";

/** Reads one symbol's normalized, alias-resolved facts. */
export function symbolFacts(session: TsgoFactsSession, handle: BackendSymbolHandle): BackendSymbolFacts {
  const symbol = session.symbol(handle, "symbolFacts");
  const repoPath = (path: string): string => repositoryRelativePath(session.rootDirectory, path);
  const valueDeclaration =
    symbol.valueDeclaration === undefined ? undefined : session.declarationHandle(symbol.valueDeclaration);
  const sourcePaths = symbol.declarations.map((declaration) => session.declarationPath(declaration));
  return {
    name: authoredSymbolName(symbol.name),
    flags: [
      ...((symbol.flags & SymbolFlags.Alias) !== 0 ? (["alias"] as const) : []),
      ...((symbol.flags & SymbolFlags.Class) !== 0 ? (["class"] as const) : []),
      ...((symbol.flags & SymbolFlags.TypeParameter) !== 0 ? (["typeParameter"] as const) : []),
      ...((symbol.flags & SymbolFlags.Optional) !== 0 ? (["optional"] as const) : []),
    ],
    declarationPaths: sourcePaths,
    declarations: symbol.declarations.map((declaration) => session.declarationHandle(declaration)),
    repositoryRelativeDeclarationPaths: sourcePaths.map(repoPath),
    ...definedFields({ valueDeclaration }),
  };
}

/**
 * Alias-resolved identity and authored import origin. Ordinary `symbolFacts`
 * reads do not pay for this.
 */
export function symbolOrigin(session: TsgoFactsSession, handle: BackendSymbolHandle): BackendSymbolOrigin {
  const symbol = session.symbol(handle, "symbolOrigin");
  const target = (symbol.flags & SymbolFlags.Alias) !== 0 ? session.checker.getAliasedSymbol(symbol) : symbol;
  const identity = {
    name: authoredSymbolName(target.name),
    namespaces: symbolNamespaces(session, target),
  };
  const moduleOrigin = moduleOriginOfSymbol(session, symbol);
  return moduleOrigin === undefined ? { identity } : { identity, moduleOrigin };
}

/**
 * Determines whether a member was declared by a class without resolving any
 * declaration node. The TS7 symbol response carries the declaring parent id;
 * `getParent()` fetches only that symbol record, whose class bit is enough for
 * the parser's visibility gate.
 */
export function declaringParentIsClass(session: TsgoFactsSession, handle: BackendSymbolHandle): boolean {
  return parentSymbolIsClass(session, session.symbol(handle, "symbolFacts.declaringParentIsClass"));
}

function parentSymbolIsClass(session: TsgoFactsSession, symbol: TsSymbol): boolean {
  session.ensureOpen("symbolFacts.declaringParentIsClass");
  const parent = symbol.getParent();
  return parent !== undefined && (parent.flags & SymbolFlags.Class) !== 0;
}

/** Returns enclosing authored namespace/module names for a compiler symbol. */
export function symbolNamespaces(session: TsgoFactsSession, symbol: TsSymbol): string[] {
  if ((symbol.flags & SymbolFlags.Alias) === 0) {
    const localDeclaration = symbol.declarations.find(
      (declaration) =>
        !isExternalOwnership(session.ownershipFromPathName(declaration.path)) &&
        !isExternalDeclaration(session, declaration)
    );
    const localNamespaces = declarationNamespaces(
      localDeclaration === undefined ? undefined : session.resolveNode(localDeclaration)
    );
    if (localNamespaces !== undefined) return localNamespaces;
  }

  const result: string[] = [];
  const seen = new Set<number>();
  let parent = symbol.getParent();
  while (parent !== undefined && !seen.has(parent.id)) {
    seen.add(parent.id);
    const name = parent.name;
    if (
      (parent.flags & SymbolFlags.Namespace) !== 0 &&
      parent.declarations.length > 0 &&
      !name.startsWith("__") &&
      !((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'")))
    ) {
      result.unshift(name);
    }
    parent = parent.getParent();
  }
  return result;
}

/**
 * Recovers a non-alias symbol's authored namespace chain from a project-owned
 * declaration's AST.
 *
 * A compiler symbol for a top-level declaration in an external module has a
 * quoted external-module symbol as its parent. Asking that parent for its own
 * parent is semantically useless for namespace output, but it is still a
 * remote checker request. Project-owned declarations are resolved locally, so
 * their AST ancestry provides the same namespace facts without traversing the
 * symbol graph. String-literal module names are intentionally ignored: they
 * represent external-module containers, not authored namespace segments.
 */
function declarationNamespaces(declaration: Node | undefined): string[] | undefined {
  if (declaration === undefined) return undefined;
  const result: string[] = [];
  let current: Node = declaration.parent;
  while (current.kind !== SyntaxKind.SourceFile) {
    if (isModuleDeclaration(current) && isIdentifier(current.name)) result.unshift(current.name.text);
    current = current.parent;
  }
  return result;
}
