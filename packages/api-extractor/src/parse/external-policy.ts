import type {
  BackendNodeReference,
  BackendSymbolHandle,
  BackendTypeFacts,
  BackendTypeHandle,
} from "../backend/contracts.ts";
import { isInternalSymbolName } from "../backend/contracts.ts";
import type { TypeName } from "../model.ts";
import { definedFields } from "../optional-fields.ts";
import type { ResolverContext } from "./contracts.ts";
import { externalTypeSelectionAllowsSymbol } from "./external-type-selection.ts";
import { isExternalSymbol, isTypeScriptToolchainDeclaration } from "./ownership.ts";
import { isReactWrapperType, reactRefCallbackName } from "./react-policy.ts";

const builtInTypeScriptUtilityNames = new Set([
  "Pick",
  "Omit",
  "ReturnType",
  "Parameters",
  "InstanceType",
  "Partial",
  "Required",
  "Readonly",
  "Exclude",
  "Extract",
]);

/** One explicit outcome for the dependency boundary. */
export type ExternalPolicyDecision =
  | { readonly kind: "expand" }
  | { readonly kind: "external-reference"; readonly typeName: TypeName }
  | { readonly kind: "anonymous-root" };

type ExternalPolicyInput = {
  readonly type: BackendTypeHandle;
  readonly sourceNode: BackendNodeReference | undefined;
  readonly typeName: TypeName | undefined;
  readonly symbol: BackendSymbolHandle | undefined;
  readonly context: ResolverContext;
  readonly resolveTypeName: (
    type: BackendTypeHandle,
    sourceNode: BackendNodeReference | undefined,
    context: ResolverContext
  ) => TypeName | undefined;
  /** Cycle cuts preserve external identity even when expansion is enabled. */
  readonly cycle?: boolean;
  /** An unresolved expanded object can still degrade to an opaque reference. */
  readonly fallback?: boolean;
};

/**
 * Decides the dependency boundary once, before structural dispatch. The
 * resolver consumes this discriminated result for normal expansion, root
 * anonymization, object fallback, and recursion cuts.
 */
export function externalPolicy(input: ExternalPolicyInput): ExternalPolicyDecision {
  const { type, context } = input;
  const facts = context.operations.typeFacts(type);
  if (facts.isTypeParameter === true) return { kind: "expand" };
  if (isBuiltInContainer(input, facts)) return { kind: "expand" };

  const semanticSymbol = facts.aliasSymbol ?? facts.symbol;
  if (semanticSymbol === undefined) {
    return { kind: "expand" };
  }
  const selectionAllowsSymbol = externalTypeSelectionAllowsSymbol(
    semanticSymbol,
    context.operations,
    context.externalTypes
  );
  if (
    !isExternalSymbol(semanticSymbol, context) &&
    (context.externalTypes.kind !== "packages" || selectionAllowsSymbol)
  )
    return { kind: "expand" };
  if (isAllowedBuiltInExternal(type, context)) return { kind: "expand" };

  const value = input.typeName ?? input.resolveTypeName(type, undefined, context);
  if (value === undefined || isInternalSymbolName(value.name)) {
    if (
      input.symbol !== undefined &&
      input.context.propertyDepth === 0 &&
      facts.isObject === true &&
      isExternalSymbol(input.symbol, context)
    ) {
      return { kind: "anonymous-root" };
    }
    return { kind: "expand" };
  }
  if (selectionAllowsSymbol && input.fallback !== true && input.cycle !== true) {
    return { kind: "expand" };
  }

  // Exporting a dependency-owned interface/value keeps the descriptor's
  // historical empty-object surface; nested dependencies remain references.
  const aliasExternal = facts.aliasSymbol !== undefined && isExternalSymbol(facts.aliasSymbol, context);
  const resolvedInfo = facts.symbol === undefined ? undefined : context.operations.symbolFacts(facts.symbol);
  const resolvedName = resolvedInfo?.name;
  const resolvedIsExternalInterface =
    resolvedName !== undefined &&
    !isInternalSymbolName(resolvedName) &&
    resolvedInfo?.declarations.some(
      (declaration) => context.operations.nodeKind(declaration) === "interface"
    ) === true;
  const rootDescriptorSurface = facts.symbol === undefined || resolvedIsExternalInterface;
  if (
    input.symbol !== undefined &&
    input.context.propertyDepth === 0 &&
    input.fallback !== true &&
    input.cycle !== true &&
    !aliasExternal &&
    facts.isObject === true &&
    rootDescriptorSurface &&
    context.operations.signaturesOfType(type).length === 0
  ) {
    return { kind: "anonymous-root" };
  }
  if (resolvedIsExternalInterface && facts.aliasSymbol === undefined) {
    return {
      kind: "external-reference",
      typeName: {
        name: resolvedName,
        ...definedFields({
          namespaces: value.namespaces,
          typeArguments: value.typeArguments,
        }),
      },
    };
  }
  const reactRefCallback = reactRefCallbackName(value, facts.symbol, context.operations);
  if (reactRefCallback !== undefined) return { kind: "external-reference", typeName: reactRefCallback };
  return { kind: "external-reference", typeName: value };
}

function isBuiltInContainer(input: ExternalPolicyInput, facts: BackendTypeFacts): boolean {
  const authoredBuiltInArray =
    input.sourceNode === undefined
      ? undefined
      : input.context.operations.typeNameFacts(input.type, input.sourceNode)?.builtInArray;
  const isContainer =
    facts.isTuple === true ||
    input.context.operations.isArrayType(input.type) ||
    authoredBuiltInArray !== undefined;
  const aliasExternal = facts.aliasSymbol !== undefined && isExternalSymbol(facts.aliasSymbol, input.context);
  return isContainer && !aliasExternal;
}

/** TypeScript utilities and React component wrappers are the only exceptions. */
export function isAllowedBuiltInExternal(type: BackendTypeHandle, context: ResolverContext): boolean {
  const facts = context.operations.typeFacts(type);
  const symbol = facts.aliasSymbol ?? facts.symbol;
  if (symbol === undefined) return false;
  const info = context.operations.symbolFacts(symbol);
  if (
    builtInTypeScriptUtilityNames.has(info.name) &&
    info.declarations.some((declaration) => isTypeScriptToolchainDeclaration(declaration, context))
  ) {
    return true;
  }
  return isReactWrapperType(context.operations.symbolOrigin(symbol)) && isExternalSymbol(symbol, context);
}
