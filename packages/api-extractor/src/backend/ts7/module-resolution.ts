import { resolve } from "node:path";
import { isExportDeclaration, isImportDeclaration, isStringLiteral } from "typescript/unstable/ast/is";
import { SymbolFlags } from "typescript/unstable/sync";
import type { Checker, Symbol as TsSymbol } from "typescript/unstable/sync";

import type { BackendResolvedModule } from "../contracts.ts";
import type { TsgoModuleSession } from "./module.ts";

/**
 * The native production module-specifier resolution seam.
 *
 * `resolveModule` is one of the backend contract's own operations, and every
 * module-walk consumer — the draft's type-only-star gate, the ambiguous-star
 * scan, ordering contributions, and chain following — resolves specifiers
 * through this one function. It sits beside `module.ts` as its own file
 * because it is the shared dependency of the walk's siblings, not part of any
 * one of them.
 */

/**
 * Asks the checker about an authored module specifier. This is the native
 * production resolution seam: it applies paths, package exports, suffixes,
 * and the configured module-resolution mode before we inspect declarations.
 * Do not reimplement `resolveModuleName` here; that legacy API is not part
 * of the TS7 boundary.
 */
export function resolveModule(
  session: TsgoModuleSession,
  moduleSpecifier: string,
  containingFile: string
): BackendResolvedModule | undefined {
  session.ensureOpen("resolveModule");
  const absoluteContaining = resolve(session.cwd, containingFile);
  const source = session.sourceFile(absoluteContaining);
  if (source === undefined) return undefined;
  const moduleStatement = source.statements.find((statement) => {
    if (isImportDeclaration(statement)) {
      return isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === moduleSpecifier;
    }
    return (
      isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === moduleSpecifier
    );
  });
  const moduleNode =
    moduleStatement === undefined
      ? undefined
      : isImportDeclaration(moduleStatement)
        ? moduleStatement.moduleSpecifier
        : isExportDeclaration(moduleStatement)
          ? moduleStatement.moduleSpecifier
          : undefined;
  if (moduleNode === undefined) return undefined;
  const moduleSymbol = session.symbolAt(moduleNode);
  if (moduleSymbol === undefined || session.checker.isUnknownSymbol(moduleSymbol)) return undefined;
  const symbols = [
    moduleSymbol,
    ...((moduleSymbol.flags & SymbolFlags.Alias) !== 0
      ? [aliasedSymbol(session.checker, moduleSymbol)].filter(
          (symbol): symbol is TsSymbol => symbol !== undefined
        )
      : []),
  ];
  // NodeHandle paths already identify the declaration source file. Resolving
  // one just to ask for `getSourceFile().isDeclarationFile` fetches an entire
  // dependency subtree before the parser has applied external-type policy.
  // Prefer declaration-file paths (the same preference the old AST sort had),
  // then retain the compiler's declaration order as the fallback.
  const declarationPaths = symbols.flatMap((symbol) =>
    symbol.declarations.map((candidate) => candidate.path)
  );
  const resolvedFilePath = declarationPaths.find((path) => path.endsWith(".d.ts")) ?? declarationPaths[0];
  return resolvedFilePath === undefined ? undefined : { filePath: resolve(session.cwd, resolvedFilePath) };
}

/**
 * Follows an alias to its target exactly once.
 *
 * TypeScript 7 panics when `getAliasedSymbol` reaches a non-alias ("Should
 * only get alias here"), so the alias flag is checked before every call. That
 * flag check IS the guard — the same story every facts reader relies on
 * (`typeOfSymbol` and `builtInArrayReferenceName` in `facts.ts` call the
 * checker under an identical flag test with no catch), so there is no
 * additional panic wrapper here. Callers treat a refused non-alias as an
 * unresolved target rather than a crash.
 */
export function aliasedSymbol(checker: Checker, symbol: TsSymbol): TsSymbol | undefined {
  if ((symbol.flags & SymbolFlags.Alias) === 0) return undefined;
  return checker.getAliasedSymbol(symbol);
}
