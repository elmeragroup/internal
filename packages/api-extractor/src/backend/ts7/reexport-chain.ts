import type { Node, SourceFile } from "typescript/unstable/ast";
import { isExportSpecifier, isStringLiteral } from "typescript/unstable/ast/is";
import type { Symbol as TsSymbol } from "typescript/unstable/sync";

import { resolveOwnedDeclaration } from "./declarations.ts";
import { exportsOf } from "./module-ordering.ts";
import { memoizeWalkFact } from "./module-walk-memo.ts";
import type { DescriptorScope, TsgoModuleSession } from "./module.ts";
import { repositoryRelativePath } from "./path-identity.ts";
import { enclosingExportDeclaration } from "./syntax.ts";

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
 * `file` is the module whose statement forwards the symbol, `exportedName`
 * is the name the target module exports it under, and `moduleSpecifier` is
 * the authored specifier to resolve against that file.
 */
type ForwardingReExport = {
  readonly file: SourceFile;
  readonly exportedName: string;
  readonly moduleSpecifier: string;
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
 * The full intermediate chain of a module re-export: this symbol's own
 * forwarding hop followed by every further file its specifier statement
 * forwards through, outermost first, up to the original declaration site.
 *
 * Each link resolves one statement at a time — the specifier's authored
 * module specifier resolves against its owning file and names one export of
 * the target module — so the walk never depends on how far the checker's
 * alias resolution collapses the chain in one step. A link that stops
 * resolving (the origin's own declaration, an unresolvable specifier, or a
 * revisit) ends the chain; the origin itself stays out because the draft's
 * declaration paths already carry it. The bound guards pathological barrels.
 *
 * `forwardingFilePath` is the compiler path of the innermost hop: the file
 * whose statement forwards the original declaration itself. Source inspection
 * reads a dependency-forwarding facade's directive prologue from it.
 */
export function followedChain(
  session: TsgoModuleSession,
  scope: DescriptorScope,
  start: TsSymbol
): FollowedChain {
  let chain = extendChain(scope, start);
  let forwardingFilePath = forwardingReExport(session, start)?.file.fileName ?? scope.filePath;
  const visited = new Set<TsSymbol>([start]);
  let current = start;
  for (let hop = 0; hop < maxReexportHops; hop += 1) {
    const next = forwardedSymbol(session, current);
    if (next === undefined || visited.has(next)) break;
    visited.add(next);
    const forwarding = forwardingReExport(session, next);
    if (forwarding === undefined) break;
    forwardingFilePath = forwarding.file.fileName;
    const candidate = repositoryRelativePath(session.rootDirectory, forwarding.file.fileName);
    if (chain[chain.length - 1] !== candidate) chain = [...chain, candidate];
    current = next;
  }
  return { chain, forwardingFilePath };
}

export type FollowedChain = {
  readonly chain: readonly string[];
  readonly forwardingFilePath: string;
};

/**
 * The re-export statement that forwards a symbol from another module, when
 * its declarations contain one (`export { x } from '…'`, including renamed
 * and type-only forms).
 *
 * A chain resolves each symbol's forwarding statement twice — once as the hop
 * it steps to and once as the hop it steps from — so the answer, including an
 * absent one, is memoized for the walk.
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
      moduleSpecifier: owner.moduleSpecifier.text,
      moduleNode: owner.moduleSpecifier,
    };
  }
  return undefined;
}

/**
 * Steps ONE re-export link outward: the export of the specifier's target
 * module that the statement names, without collapsing further aliases.
 */
function forwardedSymbol(session: TsgoModuleSession, symbol: TsSymbol): TsSymbol | undefined {
  const forwarding = forwardingReExport(session, symbol);
  if (forwarding === undefined) return undefined;
  // The module-specifier node belongs to the already materialized forwarding
  // source file. Its checker symbol exposes the target module exports without
  // resolving the target source file (which may be an excluded dependency).
  const moduleSymbol = session.symbolAt(forwarding.moduleNode);
  if (moduleSymbol === undefined || session.checker.isUnknownSymbol(moduleSymbol)) return undefined;
  for (const member of exportsOf(session, moduleSymbol)) {
    if (member.name === forwarding.exportedName) return member;
  }
  return undefined;
}
