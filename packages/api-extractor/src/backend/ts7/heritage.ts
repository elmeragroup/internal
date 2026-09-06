import type { Node } from "typescript/unstable/ast";
import { SyntaxKind } from "typescript/unstable/ast";
import {
  isClassDeclaration,
  isInterfaceDeclaration,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
} from "typescript/unstable/ast/is";
import type { Checker, Symbol as TsSymbol, Type } from "typescript/unstable/sync";

import { isInternalSymbolName } from "../contracts.ts";
import type { CompilerDeclaration } from "./declarations.ts";
import { resolveOwnedDeclaration } from "./declarations.ts";

export type TsgoHeritageSession = {
  readonly checker: Checker;
  readonly isExternalPath: (path: string) => boolean;
  readonly symbolAt: (node: Node) => TsSymbol | undefined;
  readonly resolveDeclaration: (declaration: CompilerDeclaration) => Node | undefined;
};

/**
 * Heritage metadata for exported interfaces and classes.
 *
 * Upstream reports `extendsTypes` by unwrapping the heritage utility types
 * whose FIRST type argument names the real base type and resolving each base
 * through alias chains. This module deliberately sits beside `module.ts`
 * instead of growing it, the way `class-facts.ts` and `documentation.ts`
 * own their own slices of the walk.
 */

/** Heritage utility types whose FIRST type argument names the real base type. */
const heritageUtilityTypes = new Set(["Omit", "Pick", "Partial", "Required", "Readonly"]);

/**
 * Extracts heritage metadata the way upstream does, unwrapping the heritage
 * utility types whose first type argument names the real base type and
 * resolving each base to its underlying symbol through alias chains.
 */
export function extendsTypes(
  session: TsgoHeritageSession,
  declaration: Node | undefined
): readonly { readonly name: string; readonly resolvedName?: string }[] | undefined {
  if (declaration === undefined || (!isInterfaceDeclaration(declaration) && !isClassDeclaration(declaration)))
    return undefined;
  const clauses =
    declaration.heritageClauses?.filter((clause) => clause.token === SyntaxKind.ExtendsKeyword) ?? [];
  const extendsTypes: { name: string; resolvedName?: string }[] = [];
  for (const clause of clauses) {
    for (const typeExpr of clause.types) {
      const baseTypeName = typeExpr.expression.getText();
      const firstArgument =
        heritageUtilityTypes.has(baseTypeName) && (typeExpr.typeArguments?.length ?? 0) > 0
          ? typeExpr.typeArguments?.[0]
          : undefined;
      const info: { name: string; resolvedName?: string } =
        firstArgument === undefined
          ? { name: baseTypeName }
          : {
              name: isTypeReferenceNode(firstArgument)
                ? firstArgument.typeName.getText()
                : firstArgument.getText(),
            };
      const type = session.checker.getTypeAtLocation(firstArgument ?? typeExpr);
      const resolvedName = underlyingSymbolName(type, session);
      if (resolvedName !== undefined && resolvedName !== info.name && !isInternalSymbolName(resolvedName)) {
        info.resolvedName = resolvedName;
      }
      extendsTypes.push(info);
    }
  }
  return extendsTypes.length === 0 ? undefined : extendsTypes;
}

/**
 * Upper bound on alias hops followed while resolving one heritage base.
 *
 * Parity with the resolver-side `maxKeyofAliasHops`: upstream's walks are
 * bounded only by their seen sets, so an explicit hop count additionally
 * bounds chains that keep naming fresh declarations.
 */
const maxHeritageAliasHops = 8;

/**
 * Resolves the underlying symbol name for a heritage type, following generic
 * alias chains (`type Props<T> = DialogProps<T>` names DialogProps).
 */
function underlyingSymbolName(
  type: Type | undefined,
  session: TsgoHeritageSession,
  hops = 0
): string | undefined {
  if (type === undefined) return undefined;
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  if (symbol === undefined) return undefined;
  if (hops >= maxHeritageAliasHops) return symbol.name;
  const aliasHandle = symbol.declarations[0];
  // Alias names are already available from the checker symbol. Only inspect
  // the authored type syntax for project-owned aliases, where the source file
  // is in the extraction surface; resolving a dependency alias here would
  // defeat the external-selection gate that follows in the parser.
  const aliasDeclaration = resolveOwnedDeclaration(session, aliasHandle);
  if (
    aliasDeclaration !== undefined &&
    isTypeAliasDeclaration(aliasDeclaration) &&
    isTypeReferenceNode(aliasDeclaration.type)
  ) {
    const targetSymbol = session.symbolAt(aliasDeclaration.type.typeName);
    if (targetSymbol !== undefined && !isInternalSymbolName(targetSymbol.name) && targetSymbol !== symbol) {
      const targetDeclaration = resolveOwnedDeclaration(session, targetSymbol.declarations[0]);
      if (targetDeclaration !== undefined && isTypeAliasDeclaration(targetDeclaration)) {
        const deeper = underlyingSymbolName(
          session.checker.getDeclaredTypeOfSymbol(targetSymbol),
          session,
          hops + 1
        );
        if (deeper !== undefined && deeper !== targetSymbol.name) return deeper;
      }
      return targetSymbol.name;
    }
  }
  return symbol.name;
}
