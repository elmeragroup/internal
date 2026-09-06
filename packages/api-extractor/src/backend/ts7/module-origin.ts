import type { Node } from "typescript/unstable/ast";
import { SyntaxKind } from "typescript/unstable/ast";
import {
  isAsExpression,
  isElementAccessExpression,
  isExportAssignment,
  isExportDeclaration,
  isExportSpecifier,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportSpecifier,
  isNamedImports,
  isNamespaceImport,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isStringLiteral,
  isTypeAssertion,
  isVariableDeclaration,
} from "typescript/unstable/ast/is";
import { SymbolFlags } from "typescript/unstable/sync";
import type { Symbol as TsSymbol } from "typescript/unstable/sync";

import { definedFields } from "../../optional-fields.ts";
import type { BackendDeclarationOwnership, BackendModuleOrigin } from "../contracts.ts";
import type { TsgoFactsSession } from "./facts.ts";
import { declarationOwnershipOfPath } from "./file-ownership.ts";
import { aliasedSymbol } from "./module-resolution.ts";
import { isStarExport } from "./syntax.ts";
import { sameUltimateSymbol } from "./ultimate-symbol.ts";

type ModuleSource = {
  readonly specifier: string;
  readonly importedName?: string;
  readonly node: Node;
};

/**
 * Internal origin facts retain the checker symbol until every competing
 * branch has been compared. Reducing to `BackendModuleOrigin` too early makes
 * unrelated declarations with the same textual module facts indistinguishable.
 */
export type OriginResolution =
  | { readonly status: "resolved"; readonly origin: BackendModuleOrigin; readonly symbol?: TsSymbol }
  | { readonly status: "ambiguous" }
  | { readonly status: "missing" };

const missingOrigin = (): OriginResolution => ({ status: "missing" });
const ambiguousOrigin = (): OriginResolution => ({ status: "ambiguous" });

function resolvedOrigin(origin: BackendModuleOrigin, symbol?: TsSymbol): OriginResolution {
  return symbol === undefined ? { status: "resolved", origin } : { status: "resolved", origin, symbol };
}

/** Compares all known origin candidates without erasing an ambiguity. */
function mergeOrigins(session: TsgoFactsSession, candidates: Iterable<OriginResolution>): OriginResolution {
  const resolved: Array<Extract<OriginResolution, { readonly status: "resolved" }>> = [];
  for (const candidate of candidates) {
    if (candidate.status === "ambiguous") return ambiguousOrigin();
    if (candidate.status === "resolved") resolved.push(candidate);
  }
  const first = resolved[0];
  if (first === undefined) return missingOrigin();
  for (const candidate of resolved.slice(1)) {
    if (
      first.symbol === undefined ||
      candidate.symbol === undefined ||
      !sameUltimateSymbol(session.checker, first.symbol, candidate.symbol)
    ) {
      return ambiguousOrigin();
    }
  }
  return first;
}

/**
 * Returns the authored module that introduced a symbol, following explicit
 * import/export aliases and star re-exports.  This is deliberately a generic
 * module fact: no package name or framework policy is encoded here.
 */
export function moduleOriginOfSymbol(
  session: TsgoFactsSession,
  symbol: TsSymbol,
  memberName?: string
): BackendModuleOrigin | undefined {
  const origin = moduleOriginOfSymbolUnsafe(
    session,
    symbol,
    new Set(),
    memberName === undefined ? [] : [memberName]
  );
  return origin.status === "resolved" ? origin.origin : undefined;
}

/**
 * Finds the module origin of the root expression in a call such as
 * `React.memo` or `memoAlias`.  The checker symbol on `React.memo` is the
 * resolved property and therefore no longer carries the namespace import;
 * walking to the root preserves that authored relation.
 */
export function moduleOriginResolutionOfExpression(
  session: TsgoFactsSession,
  expression: Node
): OriginResolution {
  return moduleOriginOfExpressionUnsafe(session, expression, new Set());
}

function moduleOriginOfExpressionUnsafe(
  session: TsgoFactsSession,
  expression: Node,
  seen: ReadonlySet<TsSymbol>,
  suffixPath: readonly string[] = []
): OriginResolution {
  let root = expression;
  const memberPath: string[] = [];
  while (true) {
    if (isPropertyAccessExpression(root)) {
      memberPath.push(root.name.text);
      root = root.expression;
      continue;
    }
    if (isElementAccessExpression(root)) {
      if (isStringLiteral(root.argumentExpression)) memberPath.push(root.argumentExpression.text);
      root = root.expression;
      continue;
    }
    if (
      isParenthesizedExpression(root) ||
      isAsExpression(root) ||
      isTypeAssertion(root) ||
      isSatisfiesExpression(root) ||
      isNonNullExpression(root)
    ) {
      root = root.expression;
      continue;
    }
    break;
  }
  const symbol = session.rawSymbolAt(root);
  const fullPath = [...memberPath.reverse(), ...suffixPath];
  return symbol === undefined || session.checker.isUnknownSymbol(symbol)
    ? missingOrigin()
    : moduleOriginOfSymbolUnsafe(session, symbol, new Set(seen), fullPath);
}

function moduleOriginOfSymbolUnsafe(
  session: TsgoFactsSession,
  symbol: TsSymbol,
  seen: ReadonlySet<TsSymbol>,
  memberPath: readonly string[]
): OriginResolution {
  if (seen.has(symbol) || session.checker.isUnknownSymbol(symbol)) return missingOrigin();
  const nextSeen = new Set(seen);
  nextSeen.add(symbol);

  const candidates: OriginResolution[] = [];
  for (const declarationHandle of symbol.declarations) {
    const unmaterializedOrigin = declarationOriginWithoutMaterialization(session, declarationHandle);
    if (unmaterializedOrigin !== undefined) {
      candidates.push(resolvedOrigin(unmaterializedOrigin, symbol));
      continue;
    }
    const declaration = session.resolveNode(declarationHandle);
    if (declaration === undefined) continue;
    const source = moduleSource(declaration);
    const candidate =
      source === undefined
        ? (() => {
            const local = localExportOrigin(session, declaration, symbol, nextSeen, memberPath);
            if (local.status !== "missing") return local;
            const declarationOriginFact = declarationOrigin(session, declaration);
            return declarationOriginFact === undefined
              ? missingOrigin()
              : resolvedOrigin(declarationOriginFact, symbol);
          })()
        : moduleOriginFromSource(session, source, nextSeen, memberPath);
    candidates.push(candidate);
  }

  const declarationResult = mergeOrigins(session, candidates);
  if (declarationResult.status !== "missing") return declarationResult;
  if ((symbol.flags & SymbolFlags.Alias) === 0) return missingOrigin();
  const target = aliasedSymbol(session.checker, symbol);
  return target === undefined
    ? missingOrigin()
    : moduleOriginOfSymbolUnsafe(session, target, nextSeen, memberPath);
}

function moduleSource(node: Node): ModuleSource | undefined {
  let current: Node | undefined = node;
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- remote AST parents can end before the shared type says they do.
  while (current !== undefined && current.kind !== SyntaxKind.SourceFile) {
    if (isImportEqualsDeclaration(current)) {
      const moduleReference = current.moduleReference;
      if (!isExternalModuleReference(moduleReference) || !isStringLiteral(moduleReference.expression))
        return undefined;
      return {
        specifier: moduleReference.expression.text,
        node: moduleReference.expression,
      };
    }
    if (isImportDeclaration(current)) {
      if (!isStringLiteral(current.moduleSpecifier)) return undefined;
      const importedName = isImportSpecifier(node)
        ? (node.propertyName?.getText() ?? node.name.getText())
        : undefined;
      return {
        specifier: current.moduleSpecifier.text,
        node: current.moduleSpecifier,
        ...definedFields({ importedName }),
      };
    }
    if (isExportDeclaration(current)) {
      const moduleSpecifier = current.moduleSpecifier;
      if (moduleSpecifier === undefined || !isStringLiteral(moduleSpecifier)) return undefined;
      const importedName =
        isExportSpecifier(node) && node.propertyName !== undefined
          ? node.propertyName.getText()
          : isExportSpecifier(node)
            ? node.name.getText()
            : undefined;
      return {
        specifier: moduleSpecifier.text,
        node: moduleSpecifier,
        ...definedFields({ importedName }),
      };
    }
    current = current.parent;
  }
  return undefined;
}

/** `moduleOriginFromSource` for an authored string-literal specifier node. */
function originFromSpecifier(
  session: TsgoFactsSession,
  node: Node & { readonly text: string },
  seen: ReadonlySet<TsSymbol>,
  memberPath: readonly string[],
  importedName?: string
): OriginResolution {
  return moduleOriginFromSource(
    session,
    { specifier: node.text, node, ...definedFields({ importedName }) },
    seen,
    memberPath
  );
}

function moduleOriginFromSource(
  session: TsgoFactsSession,
  source: ModuleSource,
  seen: ReadonlySet<TsSymbol>,
  memberPath: readonly string[]
): OriginResolution {
  const sourcePackageName = packageName(source.specifier);
  const moduleSymbol = session.rawSymbolAt(source.node);
  const direct = {
    moduleSpecifier: source.specifier,
    ...definedFields({ packageName: sourcePackageName }),
    external: moduleSymbol === undefined ? false : moduleIsExternal(session, moduleSymbol),
  } satisfies BackendModuleOrigin;
  const directOrigin = resolvedOrigin(direct, moduleSymbol);

  const referencedPath =
    source.importedName === undefined ? memberPath : [source.importedName, ...memberPath];
  if (moduleSymbol === undefined || referencedPath.length === 0) return directOrigin;
  if (seen.has(moduleSymbol)) return missingOrigin();
  const moduleSeen = new Set(seen);
  moduleSeen.add(moduleSymbol);

  const [referencedName, ...remainingPath] = referencedPath;
  if (referencedName === undefined) return directOrigin;
  const member = session.checker.getMemberInModuleExports(moduleSymbol, referencedName);
  const memberOrigin =
    member === undefined || member === moduleSymbol
      ? missingOrigin()
      : moduleOriginOfSymbolUnsafe(session, member, moduleSeen, remainingPath);
  const exportAssignmentOrigin =
    memberOrigin.status === "missing"
      ? exportAssignmentOriginOfModule(session, moduleSymbol, moduleSeen, referencedPath)
      : missingOrigin();

  // A symbol contributed through `export *` has the origin declaration's
  // symbol, so inspect the forwarding statements when that symbol itself no
  // longer carries an export-specifier declaration.
  const starOrigin = starReExportOrigin(session, moduleSymbol, referencedPath, moduleSeen);
  const branchOrigin = mergeOrigins(session, [memberOrigin, exportAssignmentOrigin, starOrigin]);
  return branchOrigin.status === "missing" ? directOrigin : branchOrigin;
}

function exportAssignmentOriginOfModule(
  session: TsgoFactsSession,
  moduleSymbol: TsSymbol,
  seen: ReadonlySet<TsSymbol>,
  memberPath: readonly string[]
): OriginResolution {
  const candidates: OriginResolution[] = [];
  for (const declarationHandle of moduleSymbol.declarations) {
    const sourceFile = session.resolveNode(declarationHandle)?.getSourceFile();
    if (sourceFile === undefined) continue;
    for (const statement of sourceFile.statements) {
      if (!isExportAssignment(statement) || !statement.isExportEquals) continue;
      const target = session.rawSymbolAt(statement.expression);
      if (target === undefined || session.checker.isUnknownSymbol(target)) continue;
      const origin = moduleOriginOfSymbolUnsafe(session, target, seen, memberPath);
      candidates.push(origin);
    }
  }
  return mergeOrigins(session, candidates);
}

function starReExportOrigin(
  session: TsgoFactsSession,
  moduleSymbol: TsSymbol,
  memberPath: readonly string[],
  seen: ReadonlySet<TsSymbol>
): OriginResolution {
  const memberName = memberPath[0];
  if (memberName === undefined) return missingOrigin();
  const candidates: OriginResolution[] = [];
  for (const declarationHandle of moduleSymbol.declarations) {
    const declaration = session.resolveNode(declarationHandle);
    const sourceFile = declaration?.getSourceFile();
    if (sourceFile === undefined) continue;
    // A named export in this container wins over every star contribution. If
    // the checker selected a star symbol despite a local conflict, the syntax
    // walk below still sees both stars and can conservatively reject it.
    const selected = session.checker.getMemberInModuleExports(moduleSymbol, memberName);
    if (
      selected?.declarations.some(
        (candidate) => session.resolveNode(candidate)?.getSourceFile() === sourceFile
      )
    )
      continue;
    for (const statement of sourceFile.statements) {
      if (!isStarExport(statement, undefined)) continue;
      const forwardedModule = session.rawSymbolAt(statement.moduleSpecifier);
      if (forwardedModule === undefined) continue;
      const forwardedMember = session.checker.getMemberInModuleExports(forwardedModule, memberName);
      if (forwardedMember === undefined) continue;
      candidates.push(originFromSpecifier(session, statement.moduleSpecifier, seen, memberPath));
    }
  }
  return mergeOrigins(session, candidates);
}

function localExportOrigin(
  session: TsgoFactsSession,
  declaration: Node,
  symbol: TsSymbol,
  seen: ReadonlySet<TsSymbol>,
  memberPath: readonly string[]
): OriginResolution {
  const initializerOrigin = localInitializerOrigin(session, declaration, seen, memberPath);
  if (initializerOrigin.status !== "missing") return initializerOrigin;
  if (!isExportSpecifier(declaration)) return missingOrigin();
  const localName = declaration.propertyName ?? declaration.name;
  const local = session.rawSymbolAt(localName);
  if (local !== undefined && local !== symbol)
    return moduleOriginOfSymbolUnsafe(session, local, seen, memberPath);

  // TypeScript may collapse a local `export { React }` specifier onto the
  // exported alias itself. In that case the import binding is still visible
  // in the source file, so recover its generic module relation from syntax.
  const sourceFile = declaration.getSourceFile();
  const localText = localName.getText();
  const fromSpecifier = (node: Node & { readonly text: string }, importedName?: string) =>
    originFromSpecifier(session, node, seen, memberPath, importedName);
  for (const statement of sourceFile.statements) {
    if (isImportEqualsDeclaration(statement)) {
      const moduleReference = statement.moduleReference;
      if (
        statement.name.text !== localText ||
        !isExternalModuleReference(moduleReference) ||
        !isStringLiteral(moduleReference.expression)
      )
        continue;
      return fromSpecifier(moduleReference.expression);
    }
    if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (clause?.name !== undefined && clause.name.text === localText)
      return fromSpecifier(statement.moduleSpecifier);
    const bindings = clause?.namedBindings;
    if (bindings === undefined) continue;
    if (isNamespaceImport(bindings) && bindings.name.text === localText)
      return fromSpecifier(statement.moduleSpecifier);
    if (!isNamedImports(bindings)) continue;
    const imported = bindings.elements.find(
      (entry) => isIdentifier(entry.name) && entry.name.text === localText
    );
    if (imported === undefined) continue;
    return fromSpecifier(
      statement.moduleSpecifier,
      imported.propertyName?.getText() ?? imported.name.getText()
    );
  }
  return missingOrigin();
}

/** Follows a project-local `const Alias = ImportedNamespace` value alias. */
function localInitializerOrigin(
  session: TsgoFactsSession,
  declaration: Node,
  seen: ReadonlySet<TsSymbol>,
  memberPath: readonly string[]
): OriginResolution {
  if (!isVariableDeclaration(declaration) || declaration.initializer === undefined) return missingOrigin();
  return moduleOriginOfExpressionUnsafe(session, declaration.initializer, seen, memberPath);
}

function moduleIsExternal(session: TsgoFactsSession, symbol: TsSymbol): boolean {
  return symbol.declarations.some((declaration) => {
    const metadata = session.sourceFileMetadata(declaration.path);
    return metadata?.isFromExternalLibrary === true || metadata?.isDefaultLibrary === true;
  });
}

/**
 * A declaration symbol does not have an authored import node of its own. When
 * an alias has already reached that declaration, recover the package identity
 * from the backend's ownership fact so React and other parser policies still
 * see one origin. Project declarations intentionally have no origin.
 */
function declarationOrigin(session: TsgoFactsSession, declaration: Node): BackendModuleOrigin | undefined {
  const sourceFile = declaration.getSourceFile();
  const ownership = declarationOwnershipOfPath(session, sourceFile.fileName);
  return moduleOriginFromOwnership(ownership);
}

function moduleOriginFromOwnership(ownership: BackendDeclarationOwnership): BackendModuleOrigin | undefined {
  if (ownership.kind === "project") return undefined;
  if (ownership.kind === "typescript") {
    return {
      moduleSpecifier: "typescript",
      packageName: "typescript",
      external: true,
    };
  }
  if (ownership.kind === "external") {
    return { moduleSpecifier: "<external>", external: true };
  }
  const packageName = ownership.packageName;
  const publicName = packageName.startsWith("@types/") ? packageName.slice("@types/".length) : packageName;
  return {
    moduleSpecifier: publicName,
    packageName: publicName,
    external: true,
  };
}

/**
 * Default-library files have no authored imports to inspect. Interfaces and
 * type aliases also cannot carry an initializer or be import/export
 * specifiers, so their external owner is enough to determine the same origin
 * without fetching the declaration's source-file subtree.
 */
function declarationOriginWithoutMaterialization(
  session: TsgoFactsSession,
  declaration: { readonly kind: Node["kind"]; readonly path: string }
): BackendModuleOrigin | undefined {
  const pathOwnership = session.ownershipFromPathName(declaration.path);
  const pathIsStandardLibrary =
    pathOwnership.kind === "typescript" && pathOwnership.library === "standard-library";
  const declarationHasNoAuthoredSource =
    declaration.kind === SyntaxKind.InterfaceDeclaration ||
    declaration.kind === SyntaxKind.TypeAliasDeclaration;
  if (!pathIsStandardLibrary && !declarationHasNoAuthoredSource) {
    return undefined;
  }
  const ownership = declarationOwnershipOfPath(session, declaration.path);
  if (pathIsStandardLibrary) {
    return ownership.kind === "typescript" && ownership.library === "standard-library"
      ? moduleOriginFromOwnership(ownership)
      : undefined;
  }
  return ownership.kind === "project" ? undefined : moduleOriginFromOwnership(ownership);
}

function packageName(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) {
    return undefined;
  }
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}
