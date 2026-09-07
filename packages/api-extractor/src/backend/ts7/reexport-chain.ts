import type { Node, SourceFile } from "typescript/unstable/ast";
import { isExportSpecifier, isStringLiteral } from "typescript/unstable/ast/is";
import { SymbolFlags } from "typescript/unstable/sync";
import type { Symbol as TsSymbol } from "typescript/unstable/sync";

import { resolveOwnedDeclaration } from "./declarations.ts";
import { exportsOf } from "./module-ordering.ts";
import { memoizeWalkFact } from "./module-walk-memo.ts";
import type { DescriptorScope, TsgoModuleSession } from "./module.ts";
import { repositoryRelativePath } from "./path-identity.ts";
import { enclosingExportDeclaration, isStarExport } from "./syntax.ts";
import { sameUltimateSymbol, ultimateSymbol } from "./ultimate-symbol.ts";

/**
 * Re-export chain walking for the module surface.
 *
 * A chain records the repository-relative files of each intermediate re-export
 * declaration between the extraction entry and the original declaration site,
 * outermost first. This module owns the per-hop primitives
 * (`forwardingReExport`, `forwardedSymbol`) and the bounds around them;
 * descriptor-level policy — when a chain starts, and what it attaches to —
 * stays in `module.ts`.
 */

/**
 * One forwarding link recovered from a re-export statement.
 *
 * `file` owns the statement, `exportedName` names the target export, and
 * `moduleNode` resolves the target module without loading dependency sources.
 */
type ForwardingReExport = {
  readonly file: SourceFile;
  readonly exportedName: string;
  /** The authored string-literal node resolves its module symbol directly. */
  readonly moduleNode: Node;
};

/**
 * Extends an inherited chain with THIS symbol's own forwarding hop.
 *
 * The hop is the file whose re-export declaration forwards the symbol — the
 * extraction-entry module for top-level exports, or a flattened member's own
 * container when that member re-exports onward from inside an expanded
 * namespace. Consecutive duplicates collapse, so a hop already inherited
 * from an enclosing statement is not repeated.
 */
export function extendChain(scope: DescriptorScope, symbol: TsSymbol): readonly string[] {
  const hop = repositoryRelativePath(
    scope.session.rootDirectory,
    forwardingReExport(scope.session, symbol)?.file.fileName ?? scope.filePath
  );
  return scope.chain[scope.chain.length - 1] === hop ? scope.chain : [...scope.chain, hop];
}

/** Upper bound on re-export links followed while recording one chain. */
const maxReexportHops = 64;

/**
 * Recover the authored route through named and star re-exports. Each hop
 * retains its module and symbol, since the checker collapses star aliases.
 * Equivalent branches are tried in authored order; revisits and the depth
 * bound stop cyclic routes without hiding a later valid branch.
 *
 * The chain excludes the declaration site. `forwardingModulePath` names the
 * innermost project module reached, including a local alias or implementation.
 * Source inspection uses it when the value ends at a dependency declaration.
 */
export function followedChain(
  session: TsgoModuleSession,
  scope: DescriptorScope,
  start: TsSymbol
): FollowedChain {
  if (scope.source === undefined) return unforwardedChain(scope);
  const followed = followModule(session, scope.source, start, new Map(), 0);
  if (followed === undefined) return unforwardedChain(scope);
  return {
    ...followed,
    chain: [...scope.chain, ...followed.chain].filter(
      (path, index, paths) => index === 0 || paths[index - 1] !== path
    ),
  };
}

/** A state includes its module because stars reuse the target's symbol. */
function followModule(
  session: TsgoModuleSession,
  source: SourceFile,
  symbol: TsSymbol,
  visited: Map<SourceFile, Set<TsSymbol>>,
  depth: number
): FollowedChain | undefined {
  const symbols = visited.get(source) ?? new Set<TsSymbol>();
  if (depth >= maxReexportHops || symbols.has(symbol)) return undefined;
  symbols.add(symbol);
  visited.set(source, symbols);
  const edges = moduleForwardings(session, source, symbol);
  if (edges.length === 0) return { chain: [], forwardingModulePath: source.fileName };
  for (const edge of edges) {
    const step = forwardedSymbol(session, edge);
    if (step === undefined) continue;
    const followed =
      step.source === undefined
        ? { chain: [], forwardingModulePath: source.fileName }
        : followModule(session, step.source, step.symbol, visited, depth + 1);
    if (followed !== undefined) {
      return {
        ...followed,
        chain: [repositoryRelativePath(session.rootDirectory, source.fileName), ...followed.chain],
      };
    }
  }
  return undefined;
}

export type FollowedChain = {
  readonly chain: readonly string[];
  readonly forwardingModulePath: string;
};

/** A chain that never leaves the described module. */
export function unforwardedChain(scope: DescriptorScope): FollowedChain {
  return { chain: scope.chain, forwardingModulePath: scope.filePath };
}

/**
 * The re-export statement that forwards a symbol from another module, when
 * its declarations contain one (`export { x } from '…'`, including renamed
 * and type-only forms).
 *
 * The answer, including an absent one, is memoized across module routes.
 */
const forwardingReExport = memoizeWalkFact(
  (session: TsgoModuleSession, symbol: TsSymbol): ForwardingReExport | undefined =>
    readForwardingReExport(session, symbol)
);

function readForwardingReExport(
  session: TsgoModuleSession,
  symbol: TsSymbol
): ForwardingReExport | undefined {
  for (const declaration of symbol.declarations) {
    // A dependency barrel's export-specifier declaration is not needed to
    // reject its package at the parser boundary. Resolving it would fetch the
    // complete external declaration file before that policy runs.
    const resolved = resolveOwnedDeclaration(session, declaration);
    if (resolved === undefined || !isExportSpecifier(resolved)) continue;
    const owner = enclosingExportDeclaration(resolved);
    if (
      // oxlint-disable-next-line typescript/prefer-optional-chain -- remote AST parents can end earlier at runtime than the shared node typing admits.
      owner === undefined ||
      owner.moduleSpecifier === undefined ||
      !isStringLiteral(owner.moduleSpecifier)
    ) {
      continue;
    }
    // SAFETY: the shared specifier typing omits the name slots every
    // materialized export specifier carries at runtime.
    const specifier = resolved as Node & {
      readonly name: { readonly text: string };
      readonly propertyName?: { readonly text: string };
    };
    return {
      file: resolved.getSourceFile(),
      exportedName: specifier.propertyName?.text ?? specifier.name.text,
      moduleNode: owner.moduleSpecifier,
    };
  }
  return undefined;
}

/**
 * One re-export link: the export the statement names and, when the target
 * module is project-owned, its source file. A dependency
 * module is never a forwarding hop, so it stays unresolved and absent.
 */
type ForwardedStep = {
  readonly symbol: TsSymbol;
  readonly source: SourceFile | undefined;
};

/**
 * Find this module's authored edge before following the symbol. Star exports
 * reuse their target symbol, so its declaration alone cannot identify the
 * intermediate modules. Local exports shadow every star contribution.
 */
function moduleForwardings(
  session: TsgoModuleSession,
  source: SourceFile,
  symbol: TsSymbol
): readonly ForwardingReExport[] {
  if (symbol.declarations.some((declaration) => session.sameSourceFile(declaration.path, source.fileName))) {
    const named = forwardingReExport(session, symbol);
    return named === undefined ? [] : [named];
  }
  if (symbol.name === "default") return [];
  const target = ultimateSymbol(session.checker, symbol);
  const runtimeValue = target.status === "resolved" && (target.symbol.flags & SymbolFlags.Value) !== 0;
  const contributions: ForwardingReExport[] = [];
  for (const statement of source.statements) {
    if (!isStarExport(statement, runtimeValue ? false : undefined)) continue;
    const forwarding = {
      file: source,
      exportedName: symbol.name,
      moduleNode: statement.moduleSpecifier,
    };
    const member = forwardedSymbol(session, forwarding)?.symbol;
    if (member === undefined) continue;
    // Distinct declarations make this name ambiguous. The module walk owns
    // its warning; provenance must not choose a route through the collision.
    if (!sameUltimateSymbol(session.checker, symbol, member)) return [];
    contributions.push(forwarding);
  }
  return contributions;
}

/** Resolve one authored edge without collapsing subsequent aliases or stars. */
function forwardedSymbol(
  session: TsgoModuleSession,
  forwarding: ForwardingReExport
): ForwardedStep | undefined {
  const moduleSymbol = session.symbolAt(forwarding.moduleNode);
  if (moduleSymbol === undefined || session.checker.isUnknownSymbol(moduleSymbol)) return undefined;
  const member = exportsOf(session, moduleSymbol).find(
    (candidate) => candidate.name === forwarding.exportedName
  );
  if (member === undefined) return undefined;
  return {
    symbol: member,
    source: resolveOwnedDeclaration(session, moduleSymbol.declarations[0])?.getSourceFile(),
  };
}
