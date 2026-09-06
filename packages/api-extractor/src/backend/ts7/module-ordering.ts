import { SyntaxKind } from "typescript/unstable/ast";
import type { SourceFile } from "typescript/unstable/ast";
import type { Symbol as TsSymbol } from "typescript/unstable/sync";

import { memoizeSubjectFact } from "./module-walk-memo.ts";
import type { TsgoModuleSession } from "./module.ts";
import { isStarExport } from "./syntax.ts";

/**
 * Export ordering for one container: the rank/position rule `readModule`
 * documents.
 *
 * TypeScript 7 enumerates a container's exports in a different order than
 * TypeScript 6, so the upstream symbol-table order is recovered by ranking
 * each export's introduction instead of trusting either enumeration. This
 * module owns that data model (`StarContribution`, `IntroductionKey`) and its
 * policy; it imports the shared specifier-resolution seam to see which names
 * each star statement contributes.
 */

/**
 * Orders one container's exports by the rank/position rule described in
 * `readModule`, so top-level modules and flattened namespaces enumerate alike.
 */
export function orderedContainerExports(
  session: TsgoModuleSession,
  containerSymbol: TsSymbol,
  containerFile: SourceFile
): readonly TsSymbol[] {
  const rawSymbols = exportsOf(session, containerSymbol);
  const contributions = starContributionOrder(session, containerFile);
  const positions = authoredExportPositions(containerFile);
  const ordered = rawSymbols.map((symbol, index) => ({
    symbol,
    index,
    ...introductionKey(symbol, localDeclaration(session, symbol, containerFile), contributions, positions),
  }));
  ordered.sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    if (left.position !== right.position) return left.position - right.position;
    return left.index - right.index;
  });
  return ordered.map((entry) => entry.symbol);
}

/** Where a star re-export statement's contributions land in the authored order. */
type StarContribution = { readonly position: number; readonly names: ReadonlySet<string> };

/**
 * Materializes a container's export symbols as a concrete array.
 *
 * The checker's own enumeration is only loosely typed on the native seam, so
 * every caller goes through this one normalization point.
 */
export function exportsOf(session: TsgoModuleSession, containerSymbol: TsSymbol): readonly TsSymbol[] {
  return session.moduleExports(containerSymbol);
}

/**
 * Resolves every star export statement of the module and records which names
 * each contributes, in statement order. Names are matched by symbol name, the
 * only identity a contributed export carries.
 */
function starContributionOrder(session: TsgoModuleSession, source: SourceFile): readonly StarContribution[] {
  const contributions: StarContribution[] = [];
  for (const statement of source.statements) {
    if (!isStarExport(statement, undefined)) continue;
    // The authored module-specifier node already carries the checker symbol.
    // Looking the resolved path up again would fetch the entire dependency
    // source file solely to enumerate names for ordering.
    const moduleSymbol = session.symbolAt(statement.moduleSpecifier);
    const names = new Set<string>();
    if (moduleSymbol !== undefined) {
      for (const member of session.moduleExports(moduleSymbol)) names.add(member.name);
    }
    contributions.push({ position: statement.getStart(source), names });
  }
  return contributions;
}

/**
 * The symbol's own declaration inside this module, when it has one.
 *
 * Both halves of the ranking rule ask this question, so the walk resolves it
 * once per export: `symbol.declarations` is a native seam read, not a local
 * array.
 */
function localDeclaration(
  session: TsgoModuleSession,
  symbol: TsSymbol,
  source: SourceFile
): { readonly kind: number } | undefined {
  return symbol.declarations.find((candidate) => session.sameSourceFile(candidate.path, source.fileName));
}

/**
 * Whether the declaration is a VALUE declared directly in this module — a
 * variable, function, class, or a default export. These are exactly the
 * exports upstream reports before every re-export and declared type; an
 * `export * as Name` alias is NOT one even though TypeScript flags it as an
 * alias to a module full of values.
 */
function declaresLocalValue(declaration: { readonly kind: number } | undefined): boolean {
  if (declaration === undefined) return false;
  return (
    declaration.kind === SyntaxKind.VariableDeclaration ||
    declaration.kind === SyntaxKind.FunctionDeclaration ||
    declaration.kind === SyntaxKind.ClassDeclaration ||
    declaration.kind === SyntaxKind.ExportAssignment
  );
}

/**
 * Where an export's introduction places it in the container's authored order.
 */
type IntroductionKey = { readonly rank: number; readonly position: number };

/**
 * The sort rank and position an export's introduction gives it.
 *
 * Locally declared values rank first regardless of position; everything
 * introduced by an explicit statement of this file ranks next in statement
 * order; star-contributed names rank last, ordered by their star statement.
 */
function introductionKey(
  symbol: TsSymbol,
  declaration: { readonly kind: number } | undefined,
  contributions: readonly StarContribution[],
  positions: ReadonlyMap<string, number>
): IntroductionKey {
  const key = (rank: number, position: number): IntroductionKey => ({ rank, position });
  if (declaresLocalValue(declaration)) return key(0, -1);
  if (declaration !== undefined) {
    // A declaration's authored position is only needed for ordering. Avoid a
    // second source-file lookup (NodeHandle paths may differ in casing from
    // the already opened SourceFile) by reading the container's authored
    // statement positions, built once for the whole container.
    return key(1, positions.get(symbol.name) ?? Number.MAX_SAFE_INTEGER);
  }
  for (const contribution of contributions) {
    if (contribution.names.has(symbol.name)) return key(2, contribution.position);
  }
  // No introduction found (a global or augmented symbol): keep it last.
  return key(3, Number.MAX_SAFE_INTEGER);
}

/** What one authored statement contributes to its container's introduction order. */
export type AuthoredIntroduction = {
  /** The statement's start offset in its container. */
  readonly position: number;
  /** `export * as Name from '…'` carries the introduced name on the clause. */
  readonly clauseName?: string;
  /** `export { a, b } from '…'` introduces one name per element. */
  readonly clauseElementNames?: readonly string[];
  /** A declaration statement introduces its own name. */
  readonly declaredName?: string;
};

/**
 * Every authored name of a container mapped to the position of the statement
 * that introduces it.
 *
 * Scanning the statement list per export made ordering O(exports ×
 * statements); one pass builds the whole answer. Explicit export clauses are
 * the symbol's authored introduction and win over declaration names: an alias
 * symbol's declaration points at its target, a namespace export carries its
 * name on the clause itself, and a direct declaration can precede its later
 * explicit export clause. The first statement wins within each of the two
 * groups, which is what the two ordered scans returned.
 */
export function authoredPositionsOf(
  introductions: Iterable<AuthoredIntroduction>
): ReadonlyMap<string, number> {
  const clausePositions = new Map<string, number>();
  const declarationPositions = new Map<string, number>();
  const introduce = (names: Map<string, number>, name: string | undefined, position: number): void => {
    if (name === undefined || names.has(name)) return;
    names.set(name, position);
  };
  for (const introduction of introductions) {
    introduce(clausePositions, introduction.clauseName, introduction.position);
    for (const element of introduction.clauseElementNames ?? []) {
      introduce(clausePositions, element, introduction.position);
    }
    introduce(declarationPositions, introduction.declaredName, introduction.position);
  }
  for (const [name, position] of declarationPositions) {
    introduce(clausePositions, name, position);
  }
  return clausePositions;
}

/** The authored introductions of one container, built once per source file. */
const authoredExportPositions = memoizeSubjectFact((source: SourceFile) =>
  authoredPositionsOf(authoredIntroductions(source))
);

/** The introduction record while one statement is being read. */
type MutableAuthoredIntroduction = {
  position: number;
  clauseName?: string;
  clauseElementNames?: readonly string[];
  declaredName?: string;
};

function* authoredIntroductions(source: SourceFile): Generator<AuthoredIntroduction> {
  for (const statement of source.statements) {
    // SAFETY: these optional fields mirror runtime AST members that may be present on authored statements; this widening only reads them without changing the node.
    const candidate = statement as typeof statement & {
      readonly name?: { readonly text?: string };
      readonly exportClause?: {
        readonly name?: { readonly text?: string };
        readonly elements?: readonly { readonly name?: { readonly text?: string } }[];
      };
    };
    const introduction: MutableAuthoredIntroduction = { position: statement.getStart(source) };
    const clauseName = candidate.exportClause?.name?.text;
    if (clauseName !== undefined) introduction.clauseName = clauseName;
    const elements = candidate.exportClause?.elements;
    if (elements !== undefined) {
      introduction.clauseElementNames = elements.flatMap((element) =>
        element.name?.text === undefined ? [] : [element.name.text]
      );
    }
    const declaredName = candidate.name?.text;
    if (declaredName !== undefined) introduction.declaredName = declaredName;
    yield introduction;
  }
}
