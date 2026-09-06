import type {
  BackendCompilerOperations,
  BackendNodeReference,
  BackendTypeHandle,
} from "../backend/contracts.ts";
import type { ResolverContext } from "./contracts.ts";

type Context = ResolverContext;

/** Alias type-parameter bindings that make an alias body's syntax resolvable. */
export type Substitutions = ResolverContext["substitutions"];

/**
 * Applies the active alias bindings to one checker type. This is the one owner
 * of that lookup: a type whose symbol is a bound type parameter becomes the
 * argument it was bound to; every other type — including `undefined` — is
 * returned as is.
 *
 * Only a BARE type-parameter reference is rebound. A generic container that
 * merely mentions a parameter (`Value[]`) keeps naming the uninstantiated type,
 * and the caller pairs it with its instantiation by target.
 */
export function applySubstitutions(
  type: BackendTypeHandle | undefined,
  substitutions: Substitutions,
  operations: Pick<BackendCompilerOperations, "typeFacts">
): BackendTypeHandle | undefined {
  if (type === undefined || substitutions.size === 0) return type;
  const symbol = operations.typeFacts(type).symbol;
  return symbol === undefined ? type : (substitutions.get(symbol) ?? type);
}

/**
 * Reads one instantiation's alias arguments: the checker's semantic alias
 * arguments when it recorded any, otherwise the arguments authored on the
 * reference that reached the alias. Unresolved positions stay `undefined`, so
 * a caller decides whether a hole keeps later arguments aligned to their
 * parameter or drops them out of the list.
 */
export function aliasInstantiationArguments(
  type: BackendTypeHandle,
  sourceNode: BackendNodeReference | undefined,
  context: Context
): readonly (BackendTypeHandle | undefined)[] {
  const semanticArguments = context.operations.typeFacts(type).aliasTypeArguments ?? [];
  if (semanticArguments.length > 0) return semanticArguments;
  // TypeScript does not always publish an alias symbol for an instantiated
  // alias. The authored reference is then the only record of which arguments
  // this instantiation was given.
  const authoredArguments =
    sourceNode === undefined
      ? []
      : (context.operations.nodeFacts(sourceNode).typeName?.authoredArguments ?? []);
  return authoredArguments.map((argument) => context.operations.typeAtNode(argument));
}

/**
 * Binds an alias declaration's type parameters to the arguments of one
 * instantiation. This is the one owner of that invariant; every alias walk
 * reaches its bindings through here.
 *
 * The argument at each position comes from `argumentAt`; a missing argument
 * falls back to the parameter's authored default, mirroring upstream's
 * `deriveTypeParameterBindings`. Bindings accumulate onto a copy of
 * `inherited` — the active substitutions by default — so a multi-hop alias
 * walk re-binds each hop's parameters over the previous hop's bindings.
 *
 * Returns `undefined` when the declaration contributes no binding at all: it
 * declares no parameters, or no parameter whose symbol and argument both
 * resolve.
 */
export function bindAliasParameters(
  declaration: BackendNodeReference,
  context: Context,
  argumentAt: (index: number) => BackendTypeHandle | undefined,
  inherited: Substitutions = context.substitutions
): Substitutions | undefined {
  const result = new Map(inherited);
  const parameters = context.operations.nodeFacts(declaration).typeParameters ?? [];
  let bindings = 0;
  for (const [index, parameter] of parameters.entries()) {
    const info = context.operations.nodeFacts(parameter);
    const symbol = info.typeName?.authoredSymbol;
    const argument =
      argumentAt(index) ??
      (info.defaultType === undefined ? undefined : context.operations.typeAtNode(info.defaultType));
    if (symbol === undefined || argument === undefined) continue;
    result.set(symbol, argument);
    bindings += 1;
  }
  return bindings === 0 ? undefined : result;
}
