import type {
  BackendCompilerOperations,
  BackendModuleOrigin,
  BackendSymbolHandle,
  BackendSymbolIdentity,
} from "../backend/contracts.ts";
import type { TypeName } from "../model.ts";

/** The small set of React declarations whose public identity affects parsing. */
const reactWrapperNames = new Set([
  "MemoExoticComponent",
  "NamedExoticComponent",
  "FC",
  "FunctionComponent",
  "ForwardRefExoticComponent",
]);

const reactWrapperCallNames = new Set(["memo", "forwardRef"]);

/**
 * React's package identity as declaration ownership reports it: the runtime
 * package or its DefinitelyTyped declarations, which `symbolOrigin` folds into
 * the one public name `react`.
 */
const reactPackageNames = new Set(["react", "@types/react"]);

/** The backend supplies neutral identity and origin; React policy lives here. */
export type ParserSymbolOrigin = {
  readonly identity?: BackendSymbolIdentity;
  readonly moduleOrigin?: BackendModuleOrigin;
};

/** An origin is React only when the authored specifier and the package both say so. */
function isReactModuleOrigin(origin: BackendModuleOrigin | undefined): boolean {
  return origin?.moduleSpecifier === "react" && origin.packageName === "react" && origin.external;
}

/**
 * Recognizes a React API only when both its canonical symbol identity and its
 * package origin agree. A dependency that merely exports `FC` or `memo` is
 * intentionally not React: names alone are not a framework contract.
 *
 * Without `name`, any of the React wrapper type names is accepted.
 */
export function isReactApiSymbol(facts: ParserSymbolOrigin | undefined, name?: string): boolean {
  if (facts === undefined) return false;
  const identity = facts.identity;
  return (
    identity?.namespaces.length === 1 &&
    identity.namespaces[0] === "React" &&
    (name === undefined ? reactWrapperNames.has(identity.name) : identity.name === name) &&
    isReactModuleOrigin(facts.moduleOrigin)
  );
}

/** React's `memo` and `forwardRef` are the only supported wrapper calls. */
export function isReactWrapperCall(facts: ParserSymbolOrigin | undefined): boolean {
  if (facts?.identity === undefined) return false;
  return reactWrapperCallNames.has(facts.identity.name) && isReactApiSymbol(facts, facts.identity.name);
}

/** Applies the same identity/origin policy to a normalized backend origin. */
export function isReactWrapperType(origin: ParserSymbolOrigin): boolean {
  return isReactApiSymbol(origin);
}

/**
 * React declares `RefCallback<T>` as an indexed access into a
 * `{ bivarianceHack(instance: T | null): ... }` literal, so once the checker
 * drops the alias (inside `Ref<T> | undefined`, for one) the callback is named
 * after that method. A `bivarianceHack` React itself declares is published as
 * `React.RefCallback`; a dependency that borrows the same declaration trick
 * keeps its own name.
 *
 * The gate reads declaration ownership, which the session already resolved for
 * the external-policy decision, so it costs no compiler request.
 */
export function reactRefCallbackName(
  value: TypeName,
  symbol: BackendSymbolHandle | undefined,
  operations: Pick<BackendCompilerOperations, "symbolFacts" | "declarationOwnership">
): TypeName | undefined {
  if (value.name !== "bivarianceHack" || symbol === undefined) return undefined;
  const reactOwned = operations.symbolFacts(symbol).declarations.some((declaration) => {
    const ownership = operations.declarationOwnership(declaration);
    return ownership.kind === "dependency" && reactPackageNames.has(ownership.packageName);
  });
  if (!reactOwned) return undefined;
  const typeArguments = value.typeArguments;
  return typeArguments === undefined
    ? { name: "RefCallback", namespaces: ["React"] }
    : { name: "RefCallback", namespaces: ["React"], typeArguments };
}
