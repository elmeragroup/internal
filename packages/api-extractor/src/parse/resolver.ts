import type {
  BackendExportDraft,
  BackendNodeHandle,
  BackendNodeReference,
  BackendExtractionSession,
  BackendSymbolHandle,
  BackendTypeHandle,
  BackendWarningFact,
  BackendTypeFacts,
} from "../backend/contracts.ts";
import type { BackendModuleDraft } from "../backend/contracts.ts";
import { isInternalSymbolName } from "../backend/contracts.ts";
import type { ExportNode, ModuleNode, SemanticType, TypeName } from "../model.ts";
import { definedFields, flagFields } from "../optional-fields.ts";
import { defaultExtractorOptions } from "../options.ts";
import type { ExtractorOptions } from "../options.ts";
import type { ProvenanceEntry } from "../provenance.ts";
import type { ExtractWarning } from "../warnings.ts";
import { authoredContainsPreservableKeyof } from "./authored-node.ts";
import { resolveClassNode } from "./class-resolver.ts";
import { recoverAuthoredComponent } from "./component-authorship.ts";
import { componentObjectNode } from "./component-object.ts";
import { componentNode } from "./component.ts";
import { authoredUndefinedUnionSyntax, intersectionNode, unionNode } from "./compound.ts";
import { arrayNode, tupleNode } from "./container.ts";
import type { ResolverContext } from "./contracts.ts";
import { warningLocation } from "./contracts.ts";
import { externalPolicy } from "./external-policy.ts";
import type { ExternalPolicyDecision } from "./external-policy.ts";
import { normalizeExternalTypeSelection } from "./external-type-selection.ts";
import { unsupported, warningMessage } from "./fallback.ts";
import { mappedObjectNode } from "./mapped.ts";
import {
  declarationProvenance,
  recordOmittedCallableMembers,
  recordUnrepresentedConstructSignatures,
  resolveEnumNode,
  resolveObjectNode,
  resolveSignatureNode,
  canonicalizeProvenance,
  recordProvenance,
} from "./object-resolver.ts";
import { isStandardLibraryDeclaration, primaryDeclaration } from "./ownership.ts";
import {
  collectSemanticPaths,
  componentPropSemanticPathFromProvenancePath,
  exportSemanticPath,
} from "./semantic-paths.ts";
import { applySubstitutions } from "./substitutions.ts";
import { namedTypeArguments } from "./type-name.ts";
import {
  authoredExtractOverIndexLike,
  authoredKeyofNode,
  conditionalBranches,
  typeOperatorNode,
} from "./type-operator.ts";
import { isTypeParameterSymbol, isUnauthoredAny, occurrenceTypeParameter } from "./type-parameter.ts";

export type ResolvedModule = {
  readonly module: ModuleNode;
  readonly warnings: readonly ExtractWarning[];
  readonly provenance: readonly ProvenanceEntry[];
};
type Context = ResolverContext;

export function resolveModule(
  session: BackendExtractionSession,
  draft: BackendModuleDraft,
  filePath: string,
  options?: ExtractorOptions
): ResolvedModule {
  const { includeExternalTypes, ...resolvedOptions } = { ...defaultExtractorOptions, ...options };
  const warnings: BackendWarningFact[] = [];
  const context: Context = {
    operations: session.compiler,
    filePath,
    warnings,
    provenance: [],
    provenancePath: [],
    provenancePropertyContainer: "object",
    symbolStack: [],
    options: resolvedOptions,
    externalTypes: normalizeExternalTypeSelection(includeExternalTypes),
    substitutions: new Map(),
    active: new Set(),
    propertyDepth: 0,
    pureTypeExport: false,
    authoredIntersectionMember: false,
  };
  context.operations.setErrorContext([]);
  // Module-walk warnings (unresolved re-exports, barrel cycles, ambiguous
  // stars) are discovered before resolution and lead the result's warnings.
  for (const warning of draft.warnings ?? []) context.warnings.push(warning);
  const exports = draft.exports.map((entry) => resolveExport(entry, context));
  const module: ModuleNode = {
    name: draft.name,
    exports,
    ...definedFields({ imports: draft.imports }),
  };
  const semanticPaths = collectSemanticPaths(module);
  return {
    module,
    warnings: warnings.map(warningMessage),
    provenance: canonicalizeProvenance(context.provenance).filter((entry) =>
      semanticPaths.has(JSON.stringify(entry.path))
    ),
  };
}

function resolveExport(entry: BackendExportDraft, base: Context): ExportNode {
  const symbolStack = entry.symbolStack ?? [entry.name];
  const semanticPath = exportSemanticPath(entry.name);
  base.operations.setErrorContext(symbolStack);
  const symbolFacts = base.operations.symbolFacts(entry.symbol);
  const rootProvenance: ProvenanceEntry = {
    path: semanticPath,
    ...declarationProvenance(symbolFacts, base),
    ...definedFields({ reexportChain: entry.reexportChain }),
  };
  const declaration = primaryDeclaration(symbolFacts);
  const declarationFacts = declaration === undefined ? undefined : base.operations.nodeFacts(declaration);
  const sourceNode =
    declarationFacts?.kind === "function" || declarationFacts?.kind === "functionLike"
      ? undefined
      : declarationFacts?.type;
  const declared =
    declarationFacts?.kind === "typeAlias" ||
    declarationFacts?.kind === "interface" ||
    declarationFacts?.kind === "class" ||
    declarationFacts?.kind === "enum";
  const type = base.operations.typeOfSymbol(entry.symbol, declared);
  const declaredType =
    type ?? (declaration === undefined ? undefined : base.operations.typeAtNode(declaration));
  const resolvedProvenance: ProvenanceEntry[] = [];
  const resolvedType = typeNode(declaredType, sourceNode, entry.symbol, {
    ...base,
    provenance: resolvedProvenance,
    provenancePath: semanticPath,
    symbolStack,
    pureTypeExport: entry.pureType === true,
  });
  const componentContext = {
    ...base,
    symbolStack: entry.symbolStack ?? [entry.name],
  };
  const authored = recoverAuthoredComponent(entry.symbol, componentContext);
  const authoredProvenance: ProvenanceEntry[] = [];
  const authoredWarnings: BackendWarningFact[] = [];
  const authoredPropsTypes = authored.propNodes.map((authoredProps) =>
    typeNode(base.operations.typeAtNode(authoredProps), authoredProps, undefined, {
      ...base,
      provenance: authoredProvenance,
      provenancePath: semanticPath,
      provenancePropertyContainer: "componentProps",
      propertyDepth: 0,
      symbolStack,
      warnings: authoredWarnings,
      ...definedFields({ bindingDefaults: authored.bindingDefaults }),
    })
  );
  // The authored export context is applied BEFORE the component transform,
  // matching upstream's ordering: repair the resolved root's public name, then
  // let the transform reshape functions into components.
  const namedOutputType = publicExportName(resolvedType, entry);
  const transformedComponent = componentNode(namedOutputType, entry.name, authoredPropsTypes);
  const resolvedOutputType = transformedComponent.type;
  // Rejected and uncertain candidates never publish their speculative props, so
  // diagnostics collected while resolving those props are dropped with them.
  if (transformedComponent.recognition.outcome === "transformed")
    for (const warning of authoredWarnings) base.warnings.push(warning);
  if (transformedComponent.recognition.outcome === "uncertain")
    recordUncertainComponentRecognition(base, entry, symbolFacts, transformedComponent.recognition);
  // A dependency-owned bare interface/value at the export root is deliberately
  // represented as an anonymous empty object in this workspace. It has no
  // durable semantic anchor, so do not publish a declaration provenance entry
  // for a shape that exposes neither a name nor any members. Named external
  // aliases and all non-empty roots retain their usual root provenance.
  const rootDecision =
    declaredType === undefined
      ? ({ kind: "expand" } satisfies ExternalPolicyDecision)
      : externalPolicy({
          type: declaredType,
          sourceNode,
          typeName: undefined,
          symbol: entry.symbol,
          context: base,
          resolveTypeName: typeNameFor,
        });
  if (rootDecision.kind !== "anonymous-root") recordProvenance(base, rootProvenance);
  const selectedProvenance =
    resolvedOutputType.kind === "component"
      ? authoredProvenance.length > 0
        ? authoredProvenance
        : componentProvenance(resolvedProvenance, semanticPath, resolvedOutputType)
      : resolvedProvenance;
  for (const provenance of selectedProvenance) recordProvenance(base, provenance);
  const output: ExportNode = {
    name: entry.name,
    type: resolvedOutputType,
    ...definedFields({
      documentation: entry.documentation,
      reexportedFrom: entry.reexportedFrom,
      extendsTypes: entry.extendsTypes,
    }),
  };
  return output;
}

/**
 * Applies the authored export context to a resolved root type, mirroring
 * upstream's `applyExportTypeNameContext`.
 *
 * A re-exported alias can otherwise lose its authored export name and surface
 * as an internal `__type` name, and a namespace member defines a new public
 * reference path, so its type is renamed to the exported name under the
 * namespace path even when the underlying declaration came from another
 * module or carries an anonymous name.
 */
function publicExportName(type: SemanticType, entry: BackendExportDraft): SemanticType {
  if (!("typeName" in type)) return type;
  const parentNamespaces = (entry.symbolStack ?? [entry.name]).slice(0, -1);
  const ownName = entry.name.slice(entry.name.lastIndexOf(".") + 1);
  // SAFETY: the `"typeName" in type` guard above established the property; this assertion only
  // names its type, and every read below handles the undefined case.
  const typeName = (type as { typeName?: TypeName | undefined }).typeName;
  if (parentNamespaces.length === 0) {
    // Top-level exports keep the resolved name unless it is internal.
    if (typeName === undefined || !isInternalSymbolName(typeName.name)) return type;
    return { ...type, typeName: { ...typeName, name: ownName } };
  }
  return {
    ...type,
    typeName: {
      name: ownName,
      namespaces: [...parentNamespaces],
      ...definedFields({ typeArguments: typeName?.typeArguments }),
    },
  };
}

/**
 * Records structured uncertainty about component recognition. The export's
 * semantic kind is deliberately left as resolved — a union with non-component
 * arms stays a union — and this warning makes the heuristic's hesitation
 * inspectable rather than silently changing the kind.
 */
function recordUncertainComponentRecognition(
  base: Context,
  entry: BackendExportDraft,
  symbolFacts: {
    readonly valueDeclaration?: BackendNodeHandle | undefined;
    readonly declarations: readonly BackendNodeHandle[];
  },
  recognition: { readonly reason: "mixed-component-union" }
): void {
  base.warnings.push({
    code: "uncertain-component-recognition",
    ...warningLocation(
      { ...base, symbolStack: entry.symbolStack ?? [entry.name] },
      primaryDeclaration(symbolFacts)
    ),
    reason: recognition.reason,
    name: entry.name,
  });
}

function componentProvenance(
  entries: readonly ProvenanceEntry[],
  semanticPath: readonly string[],
  output: Extract<SemanticType, { kind: "component" }>
): readonly ProvenanceEntry[] {
  const propertyNames = new Set(output.props.map((property) => property.name));
  const normalized: ProvenanceEntry[] = [];
  for (const entry of entries) {
    const componentPath = componentPropSemanticPathFromProvenancePath(
      entry.path,
      semanticPath,
      propertyNames
    );
    if (componentPath !== undefined) normalized.push({ ...entry, path: componentPath });
  }
  return normalized;
}

function typeNode(
  type: BackendTypeHandle | undefined,
  sourceNode: BackendNodeReference | undefined,
  symbol: BackendSymbolHandle | undefined,
  context: Context
): SemanticType {
  context.operations.setErrorContext(context.symbolStack);
  if (type === undefined) return unsupported(context, undefined, symbol, sourceNode);
  const substituted = applySubstitutions(type, context.substitutions, context.operations) ?? type;
  const facts = context.operations.typeFacts(substituted);
  if (facts.isError === true) return unsupported(context, substituted, symbol, sourceNode);
  if (context.active.has(substituted)) return shallowType(substituted, sourceNode, context);
  const active = new Set(context.active);
  active.add(substituted);
  // A bound parameter's syntax names the donor, not the supplied object.
  // Keep the argument's declaration anchor so anonymous object arguments are
  // described as structure rather than mistaken for unanchored module values.
  const substitutedSource =
    substituted === type || facts.symbol === undefined
      ? sourceNode
      : (primaryDeclaration(context.operations.symbolFacts(facts.symbol)) ?? sourceNode);
  return typeNodeUnsafe(substituted, substitutedSource, symbol, { ...context, active });
}

function typeNodeUnsafe(
  type: BackendTypeHandle,
  sourceNode: BackendNodeReference | undefined,
  symbol: BackendSymbolHandle | undefined,
  context: Context
): SemanticType {
  const facts = context.operations.typeFacts(type);
  // A checker-internal substitution has no model form of its own. Upstream's
  // `resolveSubstitutionFallback` probes its base type and then its constraint
  // and rejects a candidate that degrades to an unauthored `any`, so one
  // warning with the best source location survives instead of several.
  if (facts.flags.includes("Substitution")) {
    const substituted = substitutionFallback(facts, sourceNode, context);
    if (substituted !== undefined) return substituted;
  }
  const typeNameValue = typeNameFor(type, sourceNode, context);
  if (facts.isTypeParameter === true) return occurrenceTypeParameter(type, context, typeNode);
  // Authored `keyof` syntax is reconstructed before broad shape resolvers can
  // report only the checker's reduced result — upstream runs its operator
  // resolver first for exactly this reason.
  if (sourceNode !== undefined) {
    const reconstructed = authoredKeyofNode(type, sourceNode, typeNameValue, context, typeNode);
    if (reconstructed !== undefined) return reconstructed;
  }
  // An authored union whose alias member absorbs into `any` or `unknown`
  // collapses on the checker side to that single intrinsic (`AliasedAny |
  // undefined` is just `any`). Walking the written members keeps the aliased
  // member's public name alongside `undefined`, exactly as upstream does when
  // it resolves the authored union instead of the collapsed intrinsic.
  if (
    facts.intrinsic !== undefined &&
    sourceNode !== undefined &&
    authoredUndefinedUnionSyntax(sourceNode, context)
  ) {
    return unionNode(type, sourceNode, typeNameValue, context, typeNode);
  }
  // Dependency policy runs before structural dispatch. The parser receives a
  // single explicit decision, so roots, nested members, and cycles cannot
  // drift into subtly different ad-hoc ownership checks.
  const externalDecision = externalPolicy({
    type,
    sourceNode,
    typeName: typeNameValue,
    symbol,
    context,
    resolveTypeName: typeNameFor,
  });
  if (externalDecision.kind === "external-reference") {
    return { kind: "external", typeName: externalDecision.typeName };
  }
  if (externalDecision.kind === "anonymous-root") return { kind: "object", properties: [] };
  if (facts.isEnum === true) {
    const enumValue = context.operations.enumFacts(type);
    if (enumValue !== undefined) return resolveEnumNode(enumValue, context);
    recordMissingEnumWarning(type, typeNameValue, context);
    return {
      kind: "enum",
      typeName: typeNameValue ?? {
        name: facts.symbol === undefined ? "enum" : context.operations.symbolFacts(facts.symbol).name,
      },
      members: [],
    };
  }
  if (facts.intrinsic !== undefined) {
    return {
      kind: "intrinsic",
      intrinsic: facts.intrinsic,
      ...definedFields({ typeName: typeNameValue }),
    };
  }
  // TypeScript's `object` intrinsic has no slot in the intrinsic-name union;
  // upstream renders it as the empty object it describes
  // (`resolveTypeParameterType` reaches it through a base constraint). A
  // NonPrimitive flag with no symbol and no members is exactly that type.
  if (
    facts.flags.includes("NonPrimitive") &&
    facts.symbol === undefined &&
    facts.aliasSymbol === undefined &&
    (facts.unionOrIntersectionTypes ?? []).length === 0
  ) {
    return {
      kind: "object",
      properties: [],
      ...definedFields({ typeName: typeNameValue }),
    };
  }
  if (facts.literal !== undefined) {
    return {
      kind: "literal",
      value: literalValue(facts.literal),
      ...definedFields({ typeName: typeNameValue }),
    };
  }
  // Template-literal types are not checker literals (`isLiteralType` is false).
  // Store the checker's printed form so a union of them stays a union of
  // template-literal strings in source order instead of falling back to `any`.
  if (facts.flags.includes("TemplateLiteral")) {
    return {
      kind: "literal",
      value: context.operations.typeToString(type),
      ...definedFields({ typeName: typeNameValue }),
    };
  }
  // Deferred conditionals follow upstream's dispatch order: a built-in
  // `Extract` over an index-like check type resolves through the checker's
  // base constraint (`Extract<keyof T, string>` is `string`); any other
  // deferred conditional reports its resolved branches as a union; and the
  // base-constraint read remains as the final representable answer.
  if (facts.flags.includes("Conditional")) {
    if (authoredExtractOverIndexLike(facts, context)) {
      const extracted = context.operations.baseConstraintOfType(type);
      if (extracted !== undefined && extracted !== type) {
        return typeNode(extracted, undefined, undefined, context);
      }
    }
    const branchUnion = conditionalBranches(facts, context, typeNode);
    if (branchUnion !== undefined) return branchUnion;
    const base = context.operations.baseConstraintOfType(type);
    if (base !== undefined && base !== type) {
      return typeNode(base, undefined, undefined, context);
    }
  }
  if (facts.isUnion === true) return unionNode(type, sourceNode, typeNameValue, context, typeNode);
  if (facts.isIntersection === true)
    return intersectionNode(type, sourceNode, typeNameValue, context, typeNode);
  if (facts.indexTarget !== undefined && sourceNode !== undefined) {
    return typeOperatorNode(type, sourceNode, typeNameValue, context, typeNode);
  }
  // An Index type reached WITHOUT its authored `keyof` syntax — an inferred
  // return, or an alias position the checker reduced — still describes a key
  // set. A checker-internal indexed access (`T[K]` under unresolved
  // parameters) has no shape of its own. Both degrade identically through
  // upstream's `resolveIndexLikeType` — base constraint when one exists,
  // otherwise `any` carrying the authored alias name, silently: an expected
  // limit rather than a parser bug.
  if (facts.indexTarget !== undefined || facts.flags.includes("IndexedAccess")) {
    return baseConstraintOrAny(type, typeNameValue, context);
  }
  if (context.operations.isArrayType(type))
    return arrayNode(type, sourceNode, typeNameValue, context, typeNode);
  if (facts.isTuple === true) return tupleNode(type, sourceNode, typeNameValue, context, typeNode);
  const signatures = context.operations.signaturesOfType(type);
  if (signatures.length > 0) {
    recordOmittedCallableMembers(type, signatures, context);
    // A callable-first shape may also declare construct signatures, which
    // the function node returned below cannot carry. Only a class would have been
    // resolved through them, so any other shape's construct side is reported
    // here rather than vanishing silently.
    const constructs = context.operations.constructSignaturesOfType(type);
    if (constructs.length > 0 && !isClassType(type, context)) {
      recordUnrepresentedConstructSignatures(type, context);
    }
    return {
      kind: "function",
      callSignatures: signatures.map((signature, index) =>
        resolveSignatureNode(signature, context, index, typeNode)
      ),
      ...definedFields({ typeName: typeNameValue }),
    };
  }
  // A class is recognized after plain callables and before objects, matching
  // upstream's resolver order: only the static side of a class carries
  // construct signatures, so a shape that merely declares `new (…)` still falls
  // through to object resolution here.
  const constructs = context.operations.constructSignaturesOfType(type);
  if (constructs.length > 0 && isClassType(type, context))
    return resolveClassNode(type, constructs, typeNameValue, context, typeNode);
  if (facts.isObject === true) {
    const mapped = mappedObjectNode(type, sourceNode, typeNameValue, context, typeNode);
    if (mapped !== undefined) return mapped;
    // A module value made only of components (`export const Menu = { Root,
    // Item }`) is described by its members instead of taking the anonymous
    // module-value fallback below.
    if (typeNameValue === undefined && sourceNode === undefined) {
      const componentObject = componentObjectNode(type, context, typeNode);
      if (componentObject !== undefined) return componentObject;
    }
    const object = resolveObjectNode(type, typeNameValue, sourceNode, context, typeNode);
    if (object !== undefined) return object;
    // A compiler-internal aggregate arm — an anonymous, symbol-less shape with
    // no members and no authored syntax of its own, such as the construct-only
    // arm of a library union like `JSXElementConstructor` — has no API surface
    // to lose. Upstream reports such shapes as bare objects, so the model does
    // the same instead of manufacturing an unsupported-type warning.
    if (
      symbol === undefined &&
      sourceNode === undefined &&
      facts.aliasSymbol === undefined &&
      context.operations.propertiesOfType(type).length === 0 &&
      context.operations.indexSignaturesOfType(type).length === 0
    ) {
      return { kind: "object", properties: [] };
    }
    const fallbackDecision = externalPolicy({
      type,
      sourceNode,
      typeName: typeNameValue,
      symbol,
      context,
      resolveTypeName: typeNameFor,
      fallback: true,
    });
    if (fallbackDecision.kind === "external-reference") {
      return { kind: "external", typeName: fallbackDecision.typeName };
    }
    if (fallbackDecision.kind === "anonymous-root") return { kind: "object", properties: [] };
  }
  return unsupported(context, type, symbol, sourceNode);
}
/**
 * Upstream's `resolveIndexLikeType` for an index-like shape reached without
 * authored operator syntax: expand through the checker's base constraint when
 * one exists (and is not this type itself, or already being resolved higher up
 * the stack), otherwise report bare `any` — silently.
 *
 * Shared by the merged Index/IndexedAccess arm above. The deferred-conditional
 * arm deliberately does NOT use this helper: it must fall through to the
 * compound resolvers when no base constraint exists instead of reporting `any`.
 */
function baseConstraintOrAny(
  type: BackendTypeHandle,
  typeNameValue: TypeName | undefined,
  context: Context
): SemanticType {
  const baseConstraint = context.operations.baseConstraintOfType(type);
  if (baseConstraint !== undefined && baseConstraint !== type && !context.active.has(baseConstraint)) {
    return typeNode(baseConstraint, undefined, undefined, context);
  }
  return {
    kind: "intrinsic",
    intrinsic: "any",
    ...definedFields({ typeName: typeNameValue }),
  };
}

/**
 * Whether a type with construct signatures was authored as a class.
 *
 * Upstream accepts the class symbol flag or, for class expressions that can
 * miss it, any declaration written as a class. An interface with a construct
 * signature fails both checks and stays an object.
 */
function isClassType(type: BackendTypeHandle, context: Context): boolean {
  const facts = context.operations.typeFacts(type);
  const symbol = facts.symbol;
  if (symbol === undefined) return false;
  const info = context.operations.symbolFacts(symbol);
  if (info.flags.includes("class")) return true;
  return info.declarations.some((declaration) => {
    const kind = context.operations.nodeKind(declaration);
    return kind === "class" || kind === "classExpression";
  });
}

function recordMissingEnumWarning(
  type: BackendTypeHandle,
  typeNameValue: TypeName | undefined,
  context: Context,
  memberName?: string
): void {
  const facts = context.operations.typeFacts(type);
  const symbol = facts.aliasSymbol ?? facts.symbol;
  const symbolFacts = symbol === undefined ? undefined : context.operations.symbolFacts(symbol);
  context.warnings.push({
    code: "missing-enum-declaration",
    ...warningLocation(context, symbolFacts?.declarations[0]),
    enumName: typeNameValue?.name ?? symbolFacts?.name ?? "enum",
    ...definedFields({ memberName }),
  });
}

/**
 * Resolves a type that is already being resolved further up the stack.
 *
 * The cut keeps the type's discriminant and public name but drops its members,
 * so a recursive container still reports what kind of container it is. Choosing
 * a different kind — collapsing every cycle to an object — would make the model
 * depend on where the cycle happened to be broken.
 */
function shallowType(
  type: BackendTypeHandle,
  sourceNode: BackendNodeReference | undefined,
  context: Context
): SemanticType {
  const facts = context.operations.typeFacts(type);
  // A type parameter re-entered while its own constraint is still being
  // resolved keeps its identity; the constraint/default subtree is what the
  // cut drops, since replaying it would recurse forever.
  if (facts.isTypeParameter === true) {
    const symbol = facts.symbol;
    const info = symbol === undefined ? undefined : context.operations.symbolFacts(symbol);
    return { kind: "typeParameter", name: info?.name ?? "T" };
  }
  const name = typeNameFor(type, sourceNode, context);
  if (facts.intrinsic !== undefined)
    return {
      kind: "intrinsic",
      intrinsic: facts.intrinsic,
      ...definedFields({ typeName: name }),
    };
  if (facts.literal !== undefined) {
    return {
      kind: "literal",
      value: literalValue(facts.literal),
      ...definedFields({ typeName: name }),
    };
  }
  const externalDecision = externalPolicy({
    type,
    sourceNode,
    typeName: name,
    symbol: facts.aliasSymbol ?? facts.symbol,
    context,
    resolveTypeName: typeNameFor,
    cycle: true,
  });
  if (externalDecision.kind === "external-reference") {
    return { kind: "external", typeName: externalDecision.typeName };
  }
  if (externalDecision.kind === "anonymous-root") return { kind: "object", properties: [] };
  if (facts.isUnion === true) return { kind: "union", types: [], ...definedFields({ typeName: name }) };
  if (facts.isIntersection === true)
    return {
      kind: "intersection",
      types: [],
      properties: [],
      ...definedFields({ typeName: name }),
    };
  // An array keeps an element type in the model, so the cut supplies the
  // wildcard `any` rather than omitting the field.
  if (context.operations.isArrayType(type))
    return {
      kind: "array",
      elementType: { kind: "intrinsic", intrinsic: "any" },
      ...flagFields({ isReadonly: context.operations.isReadonlyType(type) }),
      ...definedFields({ typeName: name }),
    };
  if (facts.isTuple === true)
    return {
      kind: "tuple",
      types: [],
      ...flagFields({ isReadonly: context.operations.isReadonlyType(type) }),
      ...definedFields({ typeName: name }),
    };
  return { kind: "object", properties: [], ...definedFields({ typeName: name }) };
}

/**
 * Encodes a literal type's value the way upstream does.
 *
 * A boolean literal is *not* one of TypeScript's `isLiteral()` types, so
 * upstream renders it through `typeToString` and stores the rendered text
 * (`"true"` / `"false"`). That text form is also what union canonicalization
 * recognizes when it collapses a `true`/`false` pair back into `boolean`, so a
 * raw boolean here would leave the pair expanded wherever the union was reached
 * without authored syntax.
 */
function literalValue(value: string | number | boolean): string | number | boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- semantic model literals are narrowed at the resolver seam.
  if (typeof value === "string") return JSON.stringify(value);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- semantic model literals are narrowed at the resolver seam.
  if (typeof value === "boolean") return String(value);
  return value;
}

/**
 * Whether an authored reference names a TypeScript library *type alias* that the
 * checker did not keep.
 *
 * `Pick<T, K>` and `Parameters<F>` are both written as references to a lib
 * declaration, but only the first survives resolution as an alias: TypeScript
 * retains an alias symbol for a mapped-type alias and discards it for a
 * conditional one. Reporting the authored spelling in the second case would
 * name a type the model no longer describes — upstream shows the resolved tuple
 * or return type with no public name at all.
 *
 * Only a library *alias* declaration is treated this way. A library interface —
 * `Promise`, `Map`, every DOM type — has no alias symbol either, and dissolving
 * those would strip the authored name from every library reference the
 * `includeExternalTypes` option asks to describe. A project alias likewise keeps
 * its authored name whether or not the checker retained it.
 */
function dissolvedLibraryAlias(
  authoredSymbol: BackendSymbolHandle,
  aliasSymbol: BackendSymbolHandle | undefined,
  context: Context
): boolean {
  if (aliasSymbol !== undefined) return false;
  const info = context.operations.symbolFacts(authoredSymbol);
  return (
    info.declarations.length > 0 &&
    info.declarations.every((declaration) => {
      const facts = context.operations.nodeFacts(declaration);
      return facts.kind === "typeAlias" && isStandardLibraryDeclaration(declaration, context);
    })
  );
}

function typeNameFor(
  type: BackendTypeHandle,
  sourceNode: BackendNodeReference | undefined,
  context: Context
): TypeName | undefined {
  const facts = context.operations.typeFacts(type);
  const nameFacts = context.operations.typeNameFacts(type, sourceNode);
  if (nameFacts === undefined || isInternalSymbolName(nameFacts.name)) return undefined;
  // An authored node that names a TYPE PARAMETER describes the declaring
  // generic's own parameter, not the instantiation the checker resolved. The
  // candidate is therefore dropped and naming falls through to the checker's
  // alias/symbol — upstream refuses such candidates for the same reason
  // (`getFullName`, common.ts) while still reporting e.g. the substituted
  // union's own alias name.
  const rawAuthoredSymbol = nameFacts.authoredSymbol;
  const semanticCandidate = facts.aliasSymbol ?? facts.symbol;
  // The refusal covers both spellings of the same mistake: an authored node
  // that names a parameter, and a checker symbol that still is one (a
  // substitution view carries its parameter's symbol). Either way the public
  // name would describe the DECLARING generic, not this instantiation.
  const semanticSymbol =
    semanticCandidate !== undefined && isTypeParameterSymbol(semanticCandidate, context)
      ? undefined
      : semanticCandidate;
  const authoredSymbol =
    rawAuthoredSymbol !== undefined && isTypeParameterSymbol(rawAuthoredSymbol, context)
      ? undefined
      : rawAuthoredSymbol;
  if (authoredSymbol !== undefined && dissolvedLibraryAlias(authoredSymbol, semanticSymbol, context))
    return undefined;
  const symbol = authoredSymbol ?? semanticSymbol;
  const symbolInfo = symbol === undefined ? undefined : context.operations.symbolFacts(symbol);
  const authoredName = authoredSymbol === undefined ? undefined : nameFacts.name;
  const name = authoredName !== undefined && authoredName !== "" ? authoredName : symbolInfo?.name;
  if (name === undefined || isInternalSymbolName(name)) return undefined;
  // A refused authored candidate leaves the checker's own symbol speaking.
  // Its namespaces come from where the SYMBOL declares, not from the refused
  // node's spelling (a bare `State` inside a library signature carries none,
  // while the instantiated project interface it resolves to lives in a
  // namespace). Re-asking without the node reads the semantic branch.
  const namespaces =
    rawAuthoredSymbol !== undefined && authoredSymbol === undefined
      ? (context.operations.typeNameFacts(type, undefined)?.namespaces ?? [])
      : nameFacts.namespaces;
  const authoredArguments = authoredSymbol === undefined ? undefined : nameFacts.authoredArguments;
  const authoredUsesDifferentSymbol =
    authoredSymbol !== undefined && facts.aliasSymbol !== undefined && authoredSymbol !== facts.aliasSymbol;
  // A parameterless alias of a container has no type arguments at all. Its
  // checker type is still a type *reference* — to the tuple or array target —
  // whose type arguments are its ELEMENTS, so reading them here would publish
  // `Pair<string, number>` for `type Pair = [string, number]`. Upstream's
  // `getTypeArguments` (common.ts) guards the same way.
  const aliasWithoutArguments = facts.aliasSymbol !== undefined && facts.aliasTypeArguments === undefined;
  const args = authoredUsesDifferentSymbol
    ? (authoredArguments ?? [])
        .map((argument) => context.operations.typeAtNode(argument))
        .filter((value): value is BackendTypeHandle => value !== undefined)
    : aliasWithoutArguments
      ? []
      : facts.referenceTarget !== undefined
        ? (facts.typeArguments ?? [])
        : (facts.aliasTypeArguments ?? []);
  const named = namedTypeArguments({
    args,
    nameFacts,
    namespaces,
    sourceNode,
    symbol,
    context,
    resolveType: typeNode,
  });
  return {
    name,
    ...definedFields({
      namespaces: named.namespaces.length === 0 ? undefined : named.namespaces,
      typeArguments: named.typeArguments.length === 0 ? undefined : named.typeArguments,
    }),
  };
}

/**
 * Probes a substitution's base type and then its constraint, the way upstream's
 * `resolveSubstitutionFallback` does.
 *
 * Each candidate collects warnings and provenance locally. A candidate that
 * degrades to an unauthored `any`, emits a warning, or drops preservable
 * `keyof` syntax is rejected without merging that evidence, so the ORIGINAL
 * location reports a single fallback warning instead of several misleading
 * ones. Accepted provenance is committed through `recordProvenance`.
 */
function substitutionFallback(
  facts: BackendTypeFacts,
  sourceNode: BackendNodeReference | undefined,
  context: Context
): SemanticType | undefined {
  for (const candidate of [facts.substitutionBaseType, facts.substitutionConstraint]) {
    if (candidate === undefined) continue;
    const warnings: BackendWarningFact[] = [];
    const provenance: ProvenanceEntry[] = [];
    const resolved = typeNode(candidate, undefined, undefined, { ...context, warnings, provenance });
    if (warnings.length > 0) continue;
    if (isUnauthoredAny(resolved)) continue;
    if (sourceNode !== undefined && authoredContainsPreservableKeyof(sourceNode, context)) {
      // The authored syntax still describes something the probe dropped; keep
      // the operator reconstruction in charge rather than the semantic view.
      continue;
    }
    for (const entry of provenance) recordProvenance(context, entry);
    return resolved;
  }
  return undefined;
}
