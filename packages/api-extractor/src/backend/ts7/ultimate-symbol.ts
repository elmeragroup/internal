import type { Checker, Symbol as TsSymbol } from "typescript/unstable/sync";

import { aliasedSymbol } from "./module-resolution.ts";

/** Explicit result for alias resolution; ambiguity never degrades to missing. */
type UltimateSymbolResolution =
  | { readonly status: "resolved"; readonly symbol: TsSymbol }
  | { readonly status: "ambiguous"; readonly symbols: readonly TsSymbol[] }
  | { readonly status: "missing" };

/**
 * Follows checker aliases to one canonical symbol. A repeated alias is a
 * graph ambiguity, not an absent declaration, so callers can preserve that
 * distinction when deciding whether star branches are equivalent.
 */
export function ultimateSymbol(checker: Checker, symbol: TsSymbol): UltimateSymbolResolution {
  const seen: TsSymbol[] = [];
  let current = symbol;
  while (true) {
    if (checker.isUnknownSymbol(current)) return { status: "missing" };
    const repeated = seen.indexOf(current);
    if (repeated !== -1) {
      return { status: "ambiguous", symbols: seen.slice(repeated) };
    }
    seen.push(current);
    const target = aliasedSymbol(checker, current);
    if (target === undefined || target === current) return { status: "resolved", symbol: current };
    current = target;
  }
}

/** Strict identity comparison for two branch symbols. */
export function sameUltimateSymbol(checker: Checker, left: TsSymbol, right: TsSymbol): boolean {
  const leftResult = ultimateSymbol(checker, left);
  const rightResult = ultimateSymbol(checker, right);
  return (
    leftResult.status === "resolved" &&
    rightResult.status === "resolved" &&
    leftResult.symbol.id === rightResult.symbol.id
  );
}
