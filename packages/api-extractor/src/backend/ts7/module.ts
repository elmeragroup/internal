import { resolve } from "node:path";
import type { Node, SourceFile } from "typescript/unstable/ast";
import { SyntaxKind } from "typescript/unstable/ast";
import {
  isClassDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isExportSpecifier,
  isFunctionDeclaration,
  isImportDeclaration,
  isModuleDeclaration,
  isNamedExports,
  isNamespaceExport,
  isStringLiteral,
} from "typescript/unstable/ast/is";
import { SymbolFlags } from "typescript/unstable/sync";
import type { Checker, Project, Symbol as TsSymbol } from "typescript/unstable/sync";

import { FileNotInProgramError } from "../../errors.ts";
import { definedFields } from "../../optional-fields.ts";
import type {
  BackendDocumentation,
  BackendExportDraft,
  BackendModuleDraft,
  BackendSymbolHandle,
  BackendWarningFact,
} from "../contracts.ts";
import { applyTypeOnlyStarFilter } from "../type-only-star-filter.ts";
import { declarationModifiers } from "./class-facts.ts";
import type { CompilerDeclaration } from "./declarations.ts";
import { resolveOwnedDeclaration, valueOrFirstDeclarationHandle } from "./declarations.ts";
import { exportsOf, orderedContainerExports } from "./module-ordering.ts";
import { aliasedSymbol, resolveModule } from "./module-resolution.ts";
import { memoizeWalkFact } from "./module-walk-memo.ts";
import { repositoryRelativePath } from "./path-identity.ts";
import type { FollowedChain } from "./reexport-chain.ts";
import { extendChain, followedChain, unforwardedChain } from "./reexport-chain.ts";
import { authoredLocation, enclosingExportDeclaration, isStarExport } from "./syntax.ts";
import { sameUltimateSymbol, ultimateSymbol } from "./ultimate-symbol.ts";

export type TsgoModuleSession = {
  readonly project: Project;
  readonly checker: Checker;
  readonly rootDirectory: string;
  readonly cwd: string;
  readonly ensureOpen: (operation: string) => void;
  readonly isExternalPath: (path: string) => boolean;
  readonly sourceFile: (filePath: string) => SourceFile | undefined;
  readonly resolveDeclaration: (declaration: CompilerDeclaration) => Node | undefined;
  /** The checker symbol at a node, memoized per session. */
  readonly symbolAt: (node: Node) => TsSymbol | undefined;
  /** A module or namespace symbol's exports, memoized per session. */
  readonly moduleExports: (container: TsSymbol) => readonly TsSymbol[];
  readonly symbolHandle: (symbol: TsSymbol) => BackendSymbolHandle;
  readonly documentationOfSymbol: (symbol: BackendSymbolHandle) => BackendDocumentation | undefined;
  readonly heritageTypes: (
    declaration: Node | undefined
  ) => readonly { readonly name: string; readonly resolvedName?: string }[] | undefined;
  readonly sameSourceFile: (left: string, right: string) => boolean;
};

/**
 * One pending export surface while the module walk normalizes it.
 *
 * `publicName` is this descriptor's own authored name (the last dotted
 * segment), `parentNamespaces` accumulates every namespace path it was reached
 * through, and `symbolStack` is the warning/provenance breadcrumb path.
 * `chain` collects the repository-relative files of each intermediate re-export
 * declaration on the way to the original site — the origin itself is excluded
 * because the draft's declaration paths already carry it.
 */
export type DescriptorScope = {
  readonly session: TsgoModuleSession;
  readonly symbol: TsSymbol;
  readonly publicName: string;
  readonly parentNamespaces: readonly string[];
  readonly symbolStack: readonly string[];
  readonly filePath: string;
  readonly source: SourceFile | undefined;
  readonly chain: readonly string[];
  /** Module-walk warnings discovered while normalizing this branch. */
  readonly warnings: BackendWarningFact[];
};

export function readModule(session: TsgoModuleSession, filePath: string): BackendModuleDraft {
  session.ensureOpen("readModule");
  const absoluteFilePath = resolve(session.cwd, filePath);
  const source = session.sourceFile(absoluteFilePath);
  if (source === undefined)
    throw new FileNotInProgramError({
      filePath: absoluteFilePath,
      message: `File is not part of the TypeScript project: ${absoluteFilePath}`,
    });
  const moduleSymbol = session.symbolAt(source);
  if (moduleSymbol === undefined) {
    throw new FileNotInProgramError({
      filePath: absoluteFilePath,
      message: `File has no module symbol: ${absoluteFilePath}`,
    });
  }
  // Upstream reports a container's locally declared *value* exports first and
  // leaves everything else in authored order. TypeScript 7 lists exports in a
  // different order than TypeScript 6, so the four ranks are recovered here —
  // locally declared values (0), then symbols introduced by an explicit
  // statement of THIS container ordered by that statement's position (1), then
  // names contributed only by star re-exports ordered by their star statement
  // and contribution order (2), and finally names with no introduction in this
  // container at all — globals and augmented symbols, kept last (3) — applied
  // with a stable sort. TS6's symbol table inserts explicit bindings before
  // star contributions, each in statement order, which grounds ranks 1 and 2;
  // rank 0 has no equivalent insertion contract in either compiler and is
  // recovered empirically from the upstream oracles. Together this reproduces
  // the upstream oracle order without trusting either compiler's enumeration.
  // The same rule applies at every container level, so namespaces flatten with
  // their own values first.
  const ordered = orderedContainerExports(session, moduleSymbol, source);
  const exports: BackendExportDraft[] = [];
  const warnings: BackendWarningFact[] = [];
  for (const symbol of ordered) {
    appendDescriptors(
      {
        session,
        symbol,
        publicName: symbol.name,
        parentNamespaces: [],
        symbolStack: [symbol.name],
        filePath: absoluteFilePath,
        source,
        chain: [],
        warnings,
      },
      exports,
      new Set()
    );
  }
  const imports = source.statements
    .filter(isImportDeclaration)
    .flatMap((statement) =>
      isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : []
    );
  const typeOnlyStarExports = starExportSpecifiers(source, true);
  // Names contributed by a type-only star re-export keep only their pure
  // types: TypeScript does not export runtime values through them. Upstream
  // applies this gate BEFORE descriptor expansion so a skipped value cannot
  // contribute merged-namespace members either.
  const typeOnlyFiles = new Set(
    typeOnlyStarExports
      .map((specifier) => resolveModule(session, specifier, absoluteFilePath)?.filePath)
      .filter((path): path is string => path !== undefined)
  );
  recordAmbiguousStarWarnings(session, source, absoluteFilePath, warnings, moduleSymbol);
  return {
    name: moduleName(session.rootDirectory, absoluteFilePath),
    exports: applyTypeOnlyStarFilter(exports, typeOnlyFiles),
    ...definedFields({
      imports: imports.length === 0 ? undefined : imports,
      typeOnlyStarExports: typeOnlyStarExports.length === 0 ? undefined : typeOnlyStarExports,
      warnings: warnings.length === 0 ? undefined : warnings,
    }),
  };
}

/**
 * Reports names two or more runtime `export * from '…'` statements contribute
 * from DIFFERENT modules.
 *
 * TypeScript 6 excludes such ambiguous names from the module entirely, but
 * TypeScript 7 does not: a live probe shows the name reaching this walk with
 * the first star's draft kept. Neither enumeration is trusted to hide or keep
 * the name deterministically, so the walk reads each starred module's own
 * export names and warns for collisions instead of letting either behavior
 * pass silently. Type-only stars cannot collide with runtime ones (their
 * contributions are filtered by policy), so only runtime statements
 * participate.
 */
function recordAmbiguousStarWarnings(
  session: TsgoModuleSession,
  source: SourceFile,
  filePath: string,
  warnings: BackendWarningFact[],
  moduleSymbol: TsSymbol
): void {
  const branchesByName = new Map<string, Map<string, TsSymbol>>();
  const firstStarStatement = source.statements.find((statement) => isStarExport(statement, false));
  // An explicitly declared export shadows any star contribution of the same
  // name, so only names the module itself does not declare can be ambiguous.
  // Path identity is enough; resolving the handle would fetch the declaration
  // file of a star contribution before parser policy has asked for a node.
  const explicitNames = new Set(
    exportsOf(session, moduleSymbol)
      .filter((symbol) =>
        symbol.declarations.some((declaration) => session.sameSourceFile(declaration.path, source.fileName))
      )
      .map((symbol) => symbol.name)
  );
  for (const statement of source.statements) {
    if (!isStarExport(statement, false)) continue;
    const resolvedFile = resolveModule(session, statement.moduleSpecifier.text, filePath)?.filePath;
    if (resolvedFile === undefined) continue;
    // The specifier node is already materialized with this source file. Its
    // checker symbol lists target exports without fetching an excluded
    // declaration file (the same pattern `forwardedSymbol` uses).
    const resolvedModule = session.symbolAt(statement.moduleSpecifier);
    if (resolvedModule === undefined || session.checker.isUnknownSymbol(resolvedModule)) continue;
    for (const member of exportsOf(session, resolvedModule)) {
      if (explicitNames.has(member.name)) continue;
      const branches = branchesByName.get(member.name) ?? new Map<string, TsSymbol>();
      // A repeated star target cannot introduce a second declaration. Keep
      // one checker symbol per resolved branch so equivalence can be decided
      // after aliases are followed rather than by path identity alone.
      branches.set(resolvedFile, member);
      branchesByName.set(member.name, branches);
    }
  }
  // `firstStarStatement` already passed the export-declaration predicate in
  // the `find` above, so only its presence is checked here.
  const location =
    firstStarStatement === undefined
      ? { filePath: source.fileName, line: 1, column: 1 }
      : authoredLocation(firstStarStatement, source);
  for (const [name, branches] of branchesByName) {
    if (branches.size < 2 || equivalentStarBranches(session.checker, branches.values())) continue;
    warnings.push({
      code: "unresolved-re-export",
      reason: "ambiguous",
      name,
      ...location,
      parsedSymbolStack: [filePath],
    });
  }
}

/**
 * Diagnostic-free star exports may repeat the same declaration through
 * independent barrels. TypeScript 7 still exposes one symbol per branch, so
 * comparing resolved file paths would report a false ambiguity. Follow each
 * alias to its ultimate checker symbol; unresolved aliases remain
 * conservative and therefore do not get grouped.
 */
function equivalentStarBranches(checker: TsgoModuleSession["checker"], symbols: Iterable<TsSymbol>): boolean {
  const [first, ...rest] = [...symbols];
  if (first === undefined) return false;
  const firstResult = ultimateSymbol(checker, first);
  if (firstResult.status !== "resolved") return false;
  return rest.every((symbol) => sameUltimateSymbol(checker, first, symbol));
}

/**
 * Normalizes one module export symbol into zero or more export drafts,
 * mirroring upstream's descriptor normalization (`resolveExportDescriptors`).
 *
 * A pure namespace export contributes ONLY its flattened members; an
 * `export * as Name` re-export contributes the target module's members under
 * that public name; any other export contributes its own draft followed by the
 * flattened members of every namespace merged onto its target.
 */
function appendDescriptors(
  scope: DescriptorScope,
  out: BackendExportDraft[],
  visitedNamespaces: ReadonlySet<TsSymbol>
): void {
  const first = resolveOwnedDeclaration(scope.session, scope.symbol.declarations[0]);
  if (first !== undefined && isModuleDeclaration(first)) {
    appendNamespaceMembers(scope, out, visitedNamespaces);
    return;
  }
  if (first !== undefined && isNamespaceExport(first)) {
    // `export * as Name from '…'`: flatten the target module under the public
    // name. The alias statement itself contributes no export of its own.
    const target = aliasedSymbol(scope.session.checker, scope.symbol);
    if (target === undefined) {
      recordUnresolvedReExport(scope, "missing-target");
      return;
    }
    appendNamespaceMembers(
      { ...scope, symbol: target },
      out,
      visitedNamespaces,
      extendChain(scope, scope.symbol)
    );
    return;
  }
  if (first !== undefined && isExportAssignment(first)) {
    appendDefaultExport(scope, first, out);
    return;
  }
  const defaultNamedTarget = defaultExportNameSymbol(scope.session, first);
  const target = defaultNamedTarget ?? exportTarget(scope.session, scope.symbol);
  const followed = followedChain(scope.session, scope, scope.symbol);
  out.push(exportDescriptor(scope, target, followed));
  // A re-exported value can carry a namespace merged onto its ORIGINAL
  // declaration (`function f() {}; namespace f {}` forwarded with
  // `export { f } from …`). Upstream merges those member descriptors onto the
  // specifier descriptor using the PUBLIC export name.
  for (const namespaceSymbol of mergedNamespaceSymbols(scope.session, target)) {
    appendNamespaceMembers({ ...scope, symbol: namespaceSymbol }, out, visitedNamespaces);
  }
}

/**
 * Resolves the symbol a named default declaration declares.
 *
 * TypeScript 7 materializes `export default function f() {}` (and the class
 * form) as the DECLARATION itself carrying the default modifier — not as an
 * export assignment wrapping an expression, which is the TS6 shape upstream's
 * `resolveDefaultExportDescriptor` resolves. The public name stays `default`,
 * while the underlying symbol reports the authored name and documentation.
 */
function defaultExportNameSymbol(
  session: TsgoModuleSession,
  declaration: Node | undefined
): TsSymbol | undefined {
  if (
    declaration === undefined ||
    (!isFunctionDeclaration(declaration) && !isClassDeclaration(declaration))
  ) {
    return undefined;
  }
  // SAFETY: the shared declaration typing omits the modifier and name slots
  // that every function/class declaration materializes with at runtime.
  const modifiers = declarationModifiers(declaration);
  if (!modifiers.some((modifier) => modifier.kind === SyntaxKind.DefaultKeyword)) return undefined;
  // SAFETY: the shared declaration typing omits the `name` slot. A default export may be
  // anonymous (`export default class {}`), so the read stays optional and the next line returns
  // on absence rather than assuming a name.
  const name = (declaration as Node & { readonly name?: Node }).name;
  if (name === undefined) return undefined;
  const symbol = session.symbolAt(name);
  return symbol === undefined || session.checker.isUnknownSymbol(symbol) ? undefined : symbol;
}

/**
 * Flattens one namespace symbol's exported members into descriptors under the
 * current namespace path.
 *
 * The `visitedNamespaces` set holds the namespaces on the CURRENT flattening
 * path only, so a barrel cycle stops with a structured warning instead of
 * recursing forever while a diamond (the same namespace legitimately reached
 * twice) still expands both times.
 */
function appendNamespaceMembers(
  scope: DescriptorScope,
  out: BackendExportDraft[],
  visitedNamespaces: ReadonlySet<TsSymbol>,
  chain: readonly string[] = scope.chain
): void {
  const ns = namespaceSymbolOf(scope.session, scope.symbol) ?? scope.symbol;
  if (visitedNamespaces.has(ns)) {
    recordUnresolvedReExport({ ...scope, chain }, "cycle");
    return;
  }
  const nextVisited = new Set(visitedNamespaces);
  nextVisited.add(ns);
  const memberScope: DescriptorScope = {
    ...scope,
    chain,
    parentNamespaces: [...scope.parentNamespaces, scope.publicName],
  };
  // A namespace flattens with its own container's authored order. For a
  // re-exported module (`export * as NS`) the target's first declaration is
  // the source file itself, which is exactly the container file.
  const firstResolved = resolveOwnedDeclaration(scope.session, ns.declarations[0]);
  const containerFile = firstResolved === undefined ? undefined : firstResolved.getSourceFile();
  const members =
    containerFile !== undefined
      ? orderedContainerExports(scope.session, ns, containerFile)
      : scope.source !== undefined
        ? orderedContainerExports(scope.session, ns, scope.source)
        : scope.session.moduleExports(ns);
  for (const member of members) {
    appendDescriptors(
      {
        ...memberScope,
        filePath: containerFile?.fileName ?? scope.filePath,
        source: containerFile ?? scope.source,
        symbol: member,
        publicName: member.name,
        symbolStack: [...scope.symbolStack, member.name],
      },
      out,
      nextVisited
    );
  }
}

function appendDefaultExport(scope: DescriptorScope, assignment: Node, out: BackendExportDraft[]): void {
  // `export default <expression>`: upstream resolves the symbol AT the
  // expression so the export reports the underlying declaration (its name and
  // docs), while keeping the synthetic `default` public name.
  // SAFETY: the export-assignment typing does not publish its expression
  // slot, but every materialized assignment carries one.
  const expression = (assignment as { expression?: Node }).expression;
  if (expression === undefined) return;
  const exported = scope.session.symbolAt(expression);
  if (exported === undefined || scope.session.checker.isUnknownSymbol(exported)) {
    scope.warnings.push({
      code: "missing-default-export-symbol",
      ...authoredLocation(expression),
      parsedSymbolStack: [scope.filePath, ...scope.symbolStack],
      sourceText: expression.getText(),
    });
    return;
  }
  out.push(exportDescriptor({ ...scope, symbol: exported }, exported, unforwardedChain(scope)));
}

function exportDescriptor(
  scope: DescriptorScope,
  target: TsSymbol,
  followed: FollowedChain
): BackendExportDraft {
  const session = scope.session;
  const declarationHandle = valueOrFirstDeclarationHandle(target);
  // Declaration paths and syntax kinds are available on the native handle.
  // Resolve the node only for project-owned declarations, where the module
  // walk itself may need authored heritage details. External declarations are
  // later subject to parser package selection and must not fetch their source
  // subtree during draft discovery.
  const declaration = resolveOwnedDeclaration(session, declarationHandle);
  const inheritedTypes = session.heritageTypes(declaration);
  const docs = session.documentationOfSymbol(
    session.symbolHandle(documentationSourceSymbol(session, scope.symbol, target))
  );
  const reexportedFrom =
    isModuleReExportSpecifier(session, scope.symbol) && target.name !== scope.publicName
      ? target.name
      : undefined;
  return {
    name: joinPublicName(scope.parentNamespaces, scope.publicName),
    symbol: session.symbolHandle(target),
    symbolStack: scope.symbolStack,
    ...definedFields({
      documentation: docs,
      declarationSourcePath: declarationHandle === undefined ? undefined : declarationHandle.path,
    }),
    pureType: isPureType(target),
    explicitValueReExport:
      scope.source === undefined
        ? false
        : explicitValueReExport(session, scope.symbol, scope.source, scope.publicName),
    ...definedFields({
      reexportedFrom,
      reexportChain: followed.chain.length === 0 ? undefined : followed.chain,
      forwardingModulePath: followed.forwardingModulePath,
      extendsTypes: inheritedTypes,
    }),
  };
}

function joinPublicName(parentNamespaces: readonly string[], name: string): string {
  return parentNamespaces.length === 0 ? name : [...parentNamespaces, name].join(".");
}

/**
 * The symbol whose documentation an export reports, mirroring upstream's
 * descriptor symbol selection.
 *
 * A MODULE re-export (`export { x } from '…'`) documents from its ultimate
 * target; a LOCAL specifier (`export { x }`) documents from the local binding
 * the name refers to — usually a bare import alias whose declarations carry no
 * JSDoc, so the re-export itself stays undocumented; direct exports document
 * from their own (target) symbol.
 */
function documentationSourceSymbol(session: TsgoModuleSession, symbol: TsSymbol, target: TsSymbol): TsSymbol {
  for (const declaration of symbol.declarations) {
    const resolved = resolveOwnedDeclaration(session, declaration);
    if (resolved === undefined || !isExportSpecifier(resolved)) continue;
    if (enclosingExportDeclaration(resolved)?.moduleSpecifier !== undefined) return target;
    // SAFETY: `resolved` is an export specifier (checked above), so `propertyName` is the optional
    // `x as y` half of it; the fallback reads the specifier's own name.
    const nameNode = (resolved as Node & { readonly propertyName?: Node }).propertyName ?? resolved.name;
    const local = session.symbolAt(nameNode);
    if (local !== undefined && !session.checker.isUnknownSymbol(local)) return local;
  }
  return target;
}

/** The distinct namespace symbols declared by `namespace X {}` blocks merged onto a symbol, in declaration order. */
function mergedNamespaceSymbols(session: TsgoModuleSession, symbol: TsSymbol): readonly TsSymbol[] {
  const namespaces: TsSymbol[] = [];
  for (const declaration of symbol.declarations) {
    const resolved = resolveOwnedDeclaration(session, declaration);
    if (resolved === undefined || !isModuleDeclaration(resolved)) continue;
    const named = session.symbolAt(resolved.name);
    if (named !== undefined && !namespaces.includes(named)) namespaces.push(named);
  }
  return namespaces;
}

/** Resolves the namespace symbol a module declaration declares, when it has one. */
function namespaceSymbolOf(session: TsgoModuleSession, symbol: TsSymbol): TsSymbol | undefined {
  return mergedNamespaceSymbols(session, symbol)[0];
}

function starExportSpecifiers(source: SourceFile, typeOnly: boolean): readonly string[] {
  return source.statements.flatMap((statement) =>
    isStarExport(statement, typeOnly) ? [statement.moduleSpecifier.text] : []
  );
}

function exportTarget(session: TsgoModuleSession, symbol: TsSymbol): TsSymbol {
  const declaration = resolveOwnedDeclaration(session, symbol.declarations[0]);
  if (
    (symbol.flags & SymbolFlags.Alias) === 0 &&
    (declaration === undefined || !isExportSpecifier(declaration))
  )
    return symbol;
  return aliasedSymbol(session.checker, symbol) ?? symbol;
}

/**
 * Whether any declaration of the symbol is an export specifier re-exported
 * from another module (`export { x } from './other'`).
 *
 * The walk asks this twice for every re-export — once to decide whether a
 * chain is recorded, once while building the descriptor — so the answer is
 * memoized for the walk instead of reading `symbol.declarations` again.
 */
const isModuleReExportSpecifier = memoizeWalkFact((session: TsgoModuleSession, symbol: TsSymbol): boolean =>
  readIsModuleReExportSpecifier(session, symbol)
);

function readIsModuleReExportSpecifier(session: TsgoModuleSession, symbol: TsSymbol): boolean {
  return symbol.declarations.some((declaration) => {
    const resolved = resolveOwnedDeclaration(session, declaration);
    if (resolved === undefined || !isExportSpecifier(resolved)) return false;
    return enclosingExportDeclaration(resolved)?.moduleSpecifier !== undefined;
  });
}

/**
 * Records one recoverable module-walk failure at the module's first statement,
 * the same anchor upstream uses for its own export-level warnings.
 */
function recordUnresolvedReExport(scope: DescriptorScope, reason: "cycle" | "missing-target"): void {
  const source = scope.source;
  const firstStatement = source?.statements.at(0);
  const location =
    source === undefined || firstStatement === undefined
      ? { filePath: source?.fileName ?? scope.filePath, line: 1, column: 1 }
      : authoredLocation(firstStatement, source);
  scope.warnings.push({
    code: "unresolved-re-export",
    reason,
    name: joinPublicName(scope.parentNamespaces, scope.publicName),
    ...location,
    parsedSymbolStack: [scope.filePath, ...scope.symbolStack],
  });
}

function explicitValueReExport(
  session: TsgoModuleSession,
  symbol: TsSymbol,
  source: SourceFile,
  publicName: string
): boolean {
  if (
    symbol.declarations.some((declaration) => {
      const resolved = resolveOwnedDeclaration(session, declaration);
      if (resolved === undefined || !isExportSpecifier(resolved)) return false;
      const current = enclosingExportDeclaration(resolved);
      // POLARITY: an ownerless specifier fails OPEN here on purpose, even
      // though the sibling walks (`documentationSourceSymbol`,
      // `forwardingReExport`) treat a missing owner as the end of the walk.
      // Those walks answer "where does this declaration point?", where absence
      // can only stop the search; this predicate answers a keep/drop question
      // — whether a non-type-only statement introduced the name — and an
      // owner the remote graph did not materialize cannot prove a TYPE-ONLY
      // introduction. Treating the unknown as explicit keeps the draft alive
      // instead of erasing a public export on incomplete remote-graph
      // evidence; aligning to the negative treatment would change which drafts
      // survive type-only-star filtering, so the polarity is documented rather
      // than flipped.
      return current?.isTypeOnly !== true;
    })
  ) {
    return true;
  }
  const exportName = publicName.slice(publicName.lastIndexOf(".") + 1);
  return source.statements.some(
    (statement) =>
      isExportDeclaration(statement) &&
      statement.isTypeOnly !== true &&
      statement.exportClause !== undefined &&
      // TypeScript 7 materializes export clauses lazily: a namespace export
      // clause answers `true` to `"elements" in clause` while carrying no
      // elements at all, so the named-exports guard must be a kind check —
      // the structural test crashes readModule on `export * as NS from …`.
      isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some(
        (specifier) =>
          isExportSpecifier(specifier) &&
          (specifier.name.text === exportName || specifier.propertyName?.text === symbol.name)
      )
  );
}

function isPureType(symbol: TsSymbol): boolean {
  const declarations = symbol.declarations;
  return (
    declarations.length > 0 &&
    declarations.every(
      (declaration) =>
        declaration.kind === SyntaxKind.InterfaceDeclaration ||
        declaration.kind === SyntaxKind.TypeAliasDeclaration ||
        declaration.kind === SyntaxKind.EnumDeclaration
    )
  );
}

function moduleName(rootDirectory: string, filePath: string): string {
  return repositoryRelativePath(rootDirectory, filePath).replace(/\.d\.ts$|\.[cm]?tsx?$/, "");
}
