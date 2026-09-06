import type {
  BackendDeclarationOwnership,
  BackendNodeHandle,
  BackendNodeReference,
  BackendSymbolFacts,
  BackendSymbolHandle,
} from "../backend/contracts.ts";
import { isExternalOwnership } from "../backend/contracts.ts";
import type { ResolverContext } from "./contracts.ts";

export { isExternalOwnership };

type Context = ResolverContext;

/**
 * Declaration-ownership policy for the compiler-free resolver.
 *
 * Ownership is a normalized backend fact (`declarationOwnership`): the
 * resolver asks who owns a declaration and never inspects file paths itself.
 * The operation is mandatory, so replacement backends must state project
 * ownership explicitly when their graph contains no dependency declarations.
 *
 * Quantifiers live with their questions, exactly like upstream's predicates:
 * symbol-level externality is a SOME-form over the symbol's declarations (one
 * dependency-owned declaration makes the whole symbol external), while the
 * standard-library gates quantify over declarations at their own sites.
 */

/** Normalized ownership of one declaration's source file. */
export function declarationOwnership(
  node: BackendNodeReference,
  context: Context
): BackendDeclarationOwnership {
  return context.operations.declarationOwnership(node);
}

/**
 * The declaration a symbol is read from when one must stand for it: the value
 * declaration when it has one, otherwise the first declaration.
 */
export function primaryDeclaration(
  info: Pick<BackendSymbolFacts, "declarations" | "valueDeclaration">
): BackendNodeHandle | undefined {
  return info.valueDeclaration ?? info.declarations[0];
}

/** Every distinct declaration that can establish a symbol's ownership. */
export function symbolDeclarations(
  info: Pick<BackendSymbolFacts, "declarations" | "valueDeclaration">
): readonly BackendNodeHandle[] {
  return [
    ...info.declarations,
    ...(info.valueDeclaration === undefined ? [] : [info.valueDeclaration]),
  ].filter((declaration, index, declarations) => declarations.indexOf(declaration) === index);
}

/**
 * Whether ANY of a symbol's declarations is owned outside the extracted
 * project — upstream's `isSymbolExternal` ground truth
 * (`externalTypeResolver.ts`), which summarizes a type as external when one
 * of its declarations ships in a packaged dependency or library.
 */
export function isExternalSymbol(symbol: BackendSymbolHandle, context: Context): boolean {
  return context.operations
    .symbolFacts(symbol)
    .declarations.some((declaration) => isExternalOwnership(declarationOwnership(declaration, context)));
}

/** Whether one declaration lives in TypeScript's own standard-library files. */
export function isStandardLibraryDeclaration(node: BackendNodeHandle, context: Context): boolean {
  const ownership = declarationOwnership(node, context);
  return ownership.kind === "typescript" && ownership.library === "standard-library";
}

/**
 * Whether one declaration lives inside some TypeScript installation's lib
 * directory — the wider toolchain form used by the built-in-utility gates,
 * where nested toolchain copies count but other packages do not.
 */
export function isTypeScriptToolchainDeclaration(node: BackendNodeHandle, context: Context): boolean {
  return declarationOwnership(node, context).kind === "typescript";
}
