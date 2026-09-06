import type {
  BackendEnumFacts,
  BackendIndexSignatureFacts,
  BackendNodeFacts,
  BackendNodeHandle,
  BackendNodeReference,
  BackendSignatureHandle,
  BackendSymbolFacts,
  BackendSymbolHandle,
  BackendTypeHandle,
} from "../backend/contracts.ts";
import { isInternalSymbolName } from "../backend/contracts.ts";
import type {
  CallSignatureNode,
  EnumMember,
  IndexSignatureNode,
  ParameterNode,
  PropertyNode,
  SemanticType,
  TypeName,
} from "../model.ts";
import { defaultExtractorOptions } from "../options.ts";
import type { DeclarationOwner, ProvenanceEntry } from "../provenance.ts";
import type { OmittedIndexSignatureReason } from "../warnings.ts";
import type { ResolveSemanticType, ResolverContext } from "./contracts.ts";
import { warningLocation } from "./contracts.ts";
import { externalTypeSelectionAllowsSymbol } from "./external-type-selection.ts";
import { primaryDeclaration, symbolDeclarations } from "./ownership.ts";
import { ResolverFailure } from "./resolver-failure.ts";
import {
  callSignatureSemanticPath,
  componentPropSemanticPath,
  indexSignatureKeySemanticPath,
  enumMemberSemanticPath,
  objectPropertySemanticPath,
  parameterSemanticPath,
  returnValueSemanticPath,
} from "./semantic-paths.ts";
import type { SemanticPath } from "./semantic-paths.ts";
import { signatureTypeParameter } from "./type-parameter.ts";

type Context = ResolverContext;

export function resolveEnumNode(facts: BackendEnumFacts, context: Context): SemanticType {
  const typeName: TypeName = { name: facts.name };
  if (facts.namespaces.length > 0) Object.assign(typeName, { namespaces: facts.namespaces });
  for (const warning of facts.warnings ?? []) {
    context.warnings.push({
      ...warning,
      parsedSymbolStack: [context.filePath, ...context.symbolStack],
    });
  }
  const exportPath = context.provenancePath;
  for (const member of facts.members) {
    const symbolFacts = context.operations.symbolFacts(member.symbol);
    recordProvenance(context, {
      path: enumMemberSemanticPath(exportPath, member.name),
      ...declarationProvenance(symbolFacts, context),
    });
  }
  const members = facts.members.map((member): EnumMember => {
    const result = { name: member.name, value: member.value };
    if (member.documentation !== undefined) Object.assign(result, { documentation: member.documentation });
    return result;
  });
  const result = {
    kind: "enum" as const,
    typeName,
    members,
  };
  if (facts.documentation !== undefined) Object.assign(result, { documentation: facts.documentation });
  return result;
}

export function resolveSignatureNode(
  signature: BackendSignatureHandle,
  context: Context,
  signatureIndex: number,
  resolveType: ResolveSemanticType
): CallSignatureNode {
  context.operations.setErrorContext(context.symbolStack);
  const facts = context.operations.signatureFacts(signature);
  const signaturePath = callSignatureSemanticPath(context.provenancePath, signatureIndex);
  const parameters = facts.parameters.map((parameter) =>
    resolveParameter(parameter, signaturePath, context, resolveType, facts.declaration)
  );
  const result: CallSignatureNode = {
    parameters,
    returnValueType: resolveType(facts.returnType, returnTypeNode(facts.declaration, context), undefined, {
      ...context,
      provenancePath: returnValueSemanticPath(signaturePath),
    }),
  };
  if (facts.typeParameters.length > 0)
    Object.assign(result, {
      typeParameters: facts.typeParameters.map((parameter, index) =>
        signatureTypeParameter(parameter, context, resolveType, facts.declaration, index)
      ),
    });
  return result;
}

/**
 * Resolves one signature parameter: its type against authored syntax, its
 * documentation, optionality, and default value. Shared by call and construct
 * signatures so free functions, methods, and constructors cannot drift.
 */
export function resolveParameter(
  parameter: BackendSymbolHandle,
  signaturePath: SemanticPath,
  context: Context,
  resolveType: ResolveSemanticType,
  ownerDeclaration?: BackendNodeHandle
): ParameterNode {
  const info = context.operations.symbolFacts(parameter);
  const declaration = primaryDeclaration(info);
  const node = declaration === undefined ? undefined : context.operations.nodeFacts(declaration);
  const parameterType =
    context.operations.propertyType(parameter) ?? context.operations.typeOfSymbol(parameter, false);
  // A generic signature's authored parameter node names the DECLARATION's type
  // parameter (`props: P`), not the instantiated argument. Replaying that node
  // would name and shape the resolved type after a parameter of the declaring
  // interface, so it is dropped like any other unreplayable syntax.
  // A parameter's authored type node is read from its owning declaration
  // exactly as a property's is — the shared reader IS the parameter case.
  const authoredSourceNode = omitTypeParameterSourceNode(propertyTypeNode(parameter, context), context);
  const authoredDefaultValue = node?.initializerText;
  const defaultValue = parameterDefaultValue(node, context);
  const parameterPath = parameterSemanticPath(signaturePath, info.name);
  const bindingDefaults = normalizedBindingDefaults(node);
  const output: ParameterNode = {
    name: info.name,
    type: resolveType(parameterType, authoredSourceNode, parameter, {
      ...context,
      provenancePath: parameterPath,
      bindingDefaults,
      symbolStack: [...context.symbolStack, `parameter: ${info.name}`],
    }),
    optional: info.flags.includes("optional") || node?.optional === true || defaultValue !== undefined,
  };
  const provenance: ProvenanceEntry = { path: parameterPath, ...declarationProvenance(info, context) };
  if (authoredDefaultValue !== undefined)
    Object.assign(provenance, { defaultInitializer: authoredDefaultValue });
  recordProvenance(context, provenance);
  // Parameter documentation comes only from scoped authored sources: the
  // owning declaration's `@param` entry, or a JSDoc block written directly on
  // the parameter. The checker's aggregate would leak another overload's
  // summary across signatures that share a parameter name.
  const docs = context.operations.documentationOfParameter(parameter, ownerDeclaration);
  if (docs !== undefined) Object.assign(output, { documentation: docs });
  if (defaultValue !== undefined) Object.assign(output, { defaultValue });
  return output;
}

export function resolveObjectNode(
  type: BackendTypeHandle,
  typeNameValue: TypeName | undefined,
  sourceNode: BackendNodeReference | undefined,
  context: Context,
  resolveType: ResolveSemanticType
): Extract<SemanticType, { kind: "object" }> | undefined {
  const facts = context.operations.typeFacts(type);
  if (facts.isObject !== true) return undefined;
  const candidateProperties = context.operations.propertiesOfType(type);
  const properties = propertiesOfType(candidateProperties, type, context);
  const resolveData = {
    name: typeNameValue?.name ?? "",
    propertyCount: properties.length,
    depth: context.active.size,
    propertyDepth: context.propertyDepth,
  };
  let callbackDecision: boolean | undefined;
  try {
    callbackDecision = context.options.shouldResolveObject?.(resolveData);
  } catch (cause) {
    throw new ResolverFailure({
      message: `shouldResolveObject failed while resolving ${typeNameValue?.name ?? "an object"}`,
      symbolStack: context.symbolStack,
      cause,
    });
  }
  const shouldResolve = callbackDecision ?? defaultObjectResolution(resolveData);

  // A named or authored object always has an exact shell to return when its
  // expansion is declined. Keep every other fact read below this gate so the
  // callback/default decision remains the first expensive parser-side work.
  // A named type already supplies the anchor. Avoid even reading its authored
  // node on the declined path; an anonymous shape is the only case where the
  // syntax fact participates in classification.
  const hasAuthoredObjectSyntax = typeNameValue === undefined && authoredObjectSyntax(sourceNode, context);
  const isNamedOrAnchored = typeNameValue !== undefined || hasAuthoredObjectSyntax;
  if (shouldResolve === false && isNamedOrAnchored) {
    recordUnrepresentedConstructSignatures(type, context);
    return objectResult([], typeNameValue, selectIndexSignature(type, context), type, context, resolveType);
  }

  // Class-origin modifier facts were paid for pre-gate because they are
  // required for the exact public propertyCount; non-class members remain
  // lazy.
  //
  // An anonymous shape is worth describing when at least one member can be
  // expanded under the caller's dependency selection: a project-owned member
  // always, a dependency-owned one only when its package was selected. A
  // headless library's `ComponentProps<E> = ElementProps<E> & { render?: … }`
  // reaches a consumer's props as exactly such a member; declining it would
  // silently drop `render` from every component built on that library. An
  // unselected `render` still counts: its type is a named union rendered as
  // external references, not an object that needs expansion.
  const hasExpandableCandidate = properties.some((property) => {
    const info = context.operations.symbolFacts(property);
    return (
      info.name === "render" ||
      info.declarations.length === 0 ||
      externalTypeSelectionAllowsSymbol(property, context.operations, context.externalTypes)
    );
  });
  const objectSymbol = facts.symbol === undefined ? undefined : context.operations.symbolFacts(facts.symbol);
  const isReadonlyObject =
    properties.length > 0 &&
    properties.every((property) => {
      const declarations = symbolDeclarations(context.operations.symbolFacts(property));
      return (
        declarations.length > 0 &&
        declarations.every((declaration) => isReadonlyDeclaration(declaration, context))
      );
    });
  // The index-signature view is needed to decide whether an anonymous shape
  // has an exact semantic anchor, and is part of every object result that
  // survives that classification. It is therefore the one post-gate shape
  // fact read for both expanded and declined anonymous objects.
  const indexSignature = selectIndexSignature(type, context);
  // Each predicate records a different reason an anonymous object has no
  // anchor in the model. The compiler-internal predicate adds to the module
  // value one only while resolving a member of an authored intersection:
  // `authoredIntersectionMember` suppresses that one, and otherwise the first
  // predicate's every condition is implied by it.
  const isAnonymousCompilerObject =
    typeNameValue === undefined &&
    context.propertyDepth === 0 &&
    objectSymbol !== undefined &&
    isInternalSymbolName(objectSymbol.name) &&
    !isReadonlyObject &&
    !hasExpandableCandidate &&
    !hasAuthoredObjectSyntax;
  const isAnonymousModuleValue =
    typeNameValue === undefined &&
    // Only the export's OWN value declines here (`export const value = { … }`).
    // An unnamed object in a nested position — an inferred function return, for
    // example — is ordinary structure to describe, not a module value, and
    // upstream resolves such shapes (`namespace-export-resolution`'s useHook).
    context.provenancePath.length === 1 &&
    context.propertyDepth === 0 &&
    !hasAuthoredObjectSyntax &&
    !context.authoredIntersectionMember;
  const isEmptyUnanchored =
    properties.length === 0 &&
    indexSignature === undefined &&
    typeNameValue === undefined &&
    !hasExpandableCandidate &&
    !hasAuthoredObjectSyntax;
  if (isAnonymousCompilerObject || isAnonymousModuleValue || isEmptyUnanchored) {
    // The callback order is observable, but an anonymous compiler object still
    // has no stable semantic shape to return. Preserve callback failures while
    // avoiding a shallow object node for the default depth/count fallback.
    if (shouldResolve !== false) {
      for (const property of properties) includeProperty(property, context);
    }
    return undefined;
  }
  recordUnrepresentedConstructSignatures(type, context);
  if (shouldResolve === false)
    return objectResult([], typeNameValue, indexSignature, type, context, resolveType);
  // Preserve inclusion callback failures for anonymous authored values while
  // keeping the required resolution-before-inclusion order.
  const includedProperties = properties.filter((property) => includeProperty(property, context));
  // Anonymous module-level values have no authored API shape to anchor. Keep
  // the upstream fallback contract for those values; an anonymous object is
  // resolvable when it is explicitly authored in a type node or is nested
  // under another object that is already being described.
  const resolvedProperties = includedProperties.map((property) => {
    const info = context.operations.symbolFacts(property);
    const propertyType =
      context.operations.propertyType(property) ?? context.operations.typeOfSymbol(property, false);
    const docs = context.operations.documentationOfSymbol(property);
    const declarationHandles = symbolDeclarations(info);
    const readonly = declarationHandles.some((declaration) => isReadonlyDeclaration(declaration, context));
    const declarationInitializer = declarationHandles
      .map((declaration) => context.operations.nodeFacts(declaration).initializerText)
      .find((value): value is string => value !== undefined);
    const initializer =
      declarationInitializer ??
      (context.propertyDepth === 0 ? context.bindingDefaults?.get(info.name) : undefined);
    const propertyPath =
      context.provenancePropertyContainer === "componentProps"
        ? componentPropSemanticPath(context.provenancePath, info.name)
        : objectPropertySemanticPath(context.provenancePath, info.name);
    const provenance: ProvenanceEntry = { path: propertyPath, ...declarationProvenance(info, context) };
    if (readonly) Object.assign(provenance, { readonly: true });
    if (initializer !== undefined) Object.assign(provenance, { defaultInitializer: initializer });
    recordProvenance(context, provenance);
    const result = {
      name: info.name,
      type: resolveType(propertyType, propertyTypeNode(property, context), property, {
        ...context,
        provenancePath: propertyPath,
        provenancePropertyContainer: "object",
        symbolStack: [...context.symbolStack, `property: ${info.name}`],
        propertyDepth: context.propertyDepth + 1,
      }),
      optional:
        info.flags.includes("optional") ||
        declarationHandles.some((declaration) => context.operations.nodeFacts(declaration).optional === true),
    };
    if (docs !== undefined) Object.assign(result, { documentation: docs });
    return result satisfies PropertyNode;
  });
  return objectResult(resolvedProperties, typeNameValue, indexSignature, type, context, resolveType);
}

/**
 * Drops an authored type node that only names a type parameter of the
 * declaring signature — but only where the anonymous-shape policy would
 * otherwise read that nameless anchor as an unresolvable module value (the
 * export root). The node describes the declaration's own parameter, not the
 * instantiated argument the checker resolved, so replaying it there would
 * leave a callable's parameter shape undescribed. Nested positions keep the
 * node: their resolution is anchored by the enclosing member either way.
 */
export function omitTypeParameterSourceNode(
  sourceNode: BackendNodeReference | undefined,
  context: Context
): BackendNodeReference | undefined {
  if (sourceNode === undefined) return undefined;
  if (context.propertyDepth !== 0) return sourceNode;
  const authoredSymbol = context.operations.nodeFacts(sourceNode).typeName?.authoredSymbol;
  if (authoredSymbol === undefined) return sourceNode;
  if (!context.operations.symbolFacts(authoredSymbol).flags.includes("typeParameter")) return sourceNode;
  return context.substitutions.has(authoredSymbol) ? sourceNode : undefined;
}

export function declarationPathsFor(info: {
  readonly declarationPaths: readonly string[];
  readonly repositoryRelativeDeclarationPaths?: readonly string[];
}): readonly string[] {
  return info.repositoryRelativeDeclarationPaths ?? info.declarationPaths;
}

/**
 * The declaration facts every provenance entry carries for one symbol: its
 * repository-relative declaration paths, each path's owner, and whether the
 * symbol has no declaration at all.
 */
export function declarationProvenance(
  info: Pick<BackendSymbolFacts, "declarationPaths" | "repositoryRelativeDeclarationPaths" | "declarations">,
  context: Context
): Pick<ProvenanceEntry, "declarations" | "synthesized"> {
  const declarationPaths = declarationPathsFor(info);
  // Owners are read from the handles, so they are known only when the backend
  // reported one handle per path.
  const ownersKnown = info.declarations.length === declarationPaths.length;
  return {
    declarations: declarationPaths.map((path, index) => {
      const handle = info.declarations[index];
      return ownersKnown && handle !== undefined
        ? { path, owner: context.operations.declarationOwnership(handle) }
        : { path };
    }),
    synthesized: info.declarations.length === 0,
  };
}

/**
 * Keep one deterministic sidecar entry for each structural semantic path.
 *
 * Known collision, deliberately kept: the path grammar addresses a member by
 * name alone, so same-named static and instance members of one class produce
 * the same path and their entries merge here. The merged entry unions their
 * declaration paths instead of keeping the two origins distinguishable — do not
 * add a static/instance discriminator to the grammar without a reviewed change.
 */
const provenanceIndexes = new WeakMap<ProvenanceEntry[], Map<string, number>>();

function provenanceIndex(entries: ProvenanceEntry[]): Map<string, number> {
  const existing = provenanceIndexes.get(entries);
  if (existing !== undefined) return existing;
  const index = new Map(entries.map((entry, position) => [JSON.stringify(entry.path), position] as const));
  provenanceIndexes.set(entries, index);
  return index;
}

export function recordProvenance(context: Context, entry: ProvenanceEntry): void {
  const index = provenanceIndex(context.provenance);
  const key = JSON.stringify(entry.path);
  const position = index.get(key);
  const existing = position === undefined ? undefined : context.provenance[position];
  if (existing === undefined || position === undefined) {
    index.set(key, context.provenance.length);
    context.provenance.push(entry);
    return;
  }
  const ownerByPath = new Map<string, DeclarationOwner | undefined>();
  for (const candidate of [existing, entry]) {
    for (const declaration of candidate.declarations) {
      ownerByPath.set(declaration.path, ownerByPath.get(declaration.path) ?? declaration.owner);
    }
  }
  const declarations = [...ownerByPath.keys()].sort().map((path) => {
    const owner = ownerByPath.get(path);
    return owner === undefined ? { path } : { path, owner };
  });
  const merged: ProvenanceEntry = {
    ...existing,
    declarations,
    synthesized: existing.synthesized && entry.synthesized,
  };
  if (existing.readonly === true || entry.readonly === true) Object.assign(merged, { readonly: true });
  const defaultInitializer = existing.defaultInitializer ?? entry.defaultInitializer;
  if (defaultInitializer !== undefined) Object.assign(merged, { defaultInitializer });
  const reexportChain = existing.reexportChain ?? entry.reexportChain;
  if (reexportChain !== undefined) Object.assign(merged, { reexportChain });
  context.provenance[position] = merged;
}

export function canonicalizeProvenance(entries: readonly ProvenanceEntry[]): readonly ProvenanceEntry[] {
  return [...entries].sort((left, right) => comparePaths(left.path, right.path));
}

function comparePaths(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftSegment = left[index] ?? "";
    const rightSegment = right[index] ?? "";
    const comparison = leftSegment < rightSegment ? -1 : leftSegment > rightSegment ? 1 : 0;
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function defaultObjectResolution(data: {
  readonly name: string;
  readonly propertyCount: number;
  readonly depth: number;
  readonly propertyDepth: number;
}): boolean {
  return defaultExtractorOptions.shouldResolveObject(data) ?? true;
}

function isReadonlyDeclaration(declaration: BackendNodeHandle, context: Context): boolean {
  return context.operations.nodeFacts(declaration).declarationFlags?.includes("readonly") === true;
}

function propertiesOfType(
  all: readonly BackendSymbolHandle[],
  ownerType: BackendTypeHandle,
  context: Context
): readonly BackendSymbolHandle[] {
  const seen = new Set<string>();
  return all.filter((property) => {
    const info = context.operations.symbolFacts(property);
    if (seen.has(info.name) || !propertyEligible(property, ownerType, context)) {
      return false;
    }
    seen.add(info.name);
    return true;
  });
}

function authoredObjectSyntax(sourceNode: BackendNodeReference | undefined, context: Context): boolean {
  if (sourceNode === undefined) return false;
  const facts = context.operations.nodeFacts(sourceNode);
  return facts.kind === "intersection" || facts.text === "object" || facts.text.startsWith("{");
}

function includeProperty(property: BackendSymbolHandle, context: Context): boolean {
  // `propertiesOfType` has already applied the structural and ownership
  // eligibility policy. Read the interned symbol name and depth directly here
  // so the caller's inclusion predicate runs before any per-property type,
  // documentation, or declaration reads. Keeping this as a separate phase
  // preserves the historical callback count and order: ineligible properties
  // never reach this function, and `seen` remains owned by `propertiesOfType`.
  const info = context.operations.symbolFacts(property);
  try {
    return context.options.shouldInclude?.({ name: info.name, depth: context.active.size + 1 }) ?? true;
  } catch (cause) {
    throw new ResolverFailure({
      message: `shouldInclude failed while resolving property ${info.name}`,
      symbolStack: context.symbolStack,
      cause,
    });
  }
}

function propertyEligible(
  property: BackendSymbolHandle,
  ownerType: BackendTypeHandle,
  context: Context
): boolean {
  const info = context.operations.symbolFacts(property);
  if (info.name.startsWith("#")) return false;
  const declarations = symbolDeclarations(info);
  if (declarations.length === 0) {
    // A mapped type synthesizes one member per constraint key and other
    // compiler views can contribute members with no declaration either; they
    // belong to their owner's local shape rather than being filtered here.
    const ownerFacts = context.operations.typeFacts(ownerType);
    const ownerSymbol = ownerFacts.aliasSymbol ?? ownerFacts.symbol;
    return (
      ownerSymbol === undefined ||
      externalTypeSelectionAllowsSymbol(ownerSymbol, context.operations, context.externalTypes)
    );
  }
  // Ownership/package selection is a cheap declaration-path fact. Consult it
  // before any declaration node is materialized; a declined dependency
  // property must not pay for its modifier/kind subtree merely to be dropped.
  // `render` is the exception: dropping it from an unselected mixin object
  // falls the whole `{ render?: ComponentRenderFn | ReactElement }` shape
  // back to `any`.
  if (!externalTypeSelectionAllowsSymbol(property, context.operations, context.externalTypes)) {
    return info.name === "render";
  }
  // A class instance reached as an object must not contribute its methods:
  // they belong to the class model, not to an object's property list. Upstream
  // whitelists the declaration kinds an object property may be written as
  // (`objectTypeResolver.ts`), which excludes plain method declarations and
  // leaves method *signatures* (interfaces) in place.
  const primary = primaryDeclaration(info);
  if (primary !== undefined && !objectMemberDeclarationKinds.has(context.operations.nodeKind(primary)))
    return false;
  if (context.operations.declaringParentIsClass(property)) {
    if (
      declarations.some((declaration) =>
        context.operations.nodeFacts(declaration).declarationFlags?.includes("static")
      )
    )
      return false;
    if (
      declarations.some((declaration) =>
        context.operations
          .nodeFacts(declaration)
          .declarationFlags?.some((flag) => flag === "private" || flag === "protected")
      )
    )
      return false;
  }
  return true;
}

/** Declaration kinds an object-typed shape may report its members from. */
const objectMemberDeclarationKinds = new Set<BackendNodeFacts["kind"]>([
  "property",
  "methodSignature",
  "parameter",
  "getAccessor",
  "setAccessor",
]);

/**
 * Chooses the one index signature the semantic model can carry and records
 * every signature it cannot.
 *
 * The model has a single `indexSignature` slot with a `string` or `number` key,
 * matching upstream. A type may legitimately declare more — a `symbol` key, a
 * template-literal pattern key, or both a string and a number key — and those
 * are recoverable omissions, so each one is reported as a structured warning
 * rather than disappearing from the output.
 */
function selectIndexSignature(
  type: BackendTypeHandle,
  context: Context
): BackendIndexSignatureFacts | undefined {
  const all = context.operations.indexSignaturesOfType(type);
  const selected =
    all.find((candidate) => candidate.keyType === "string") ??
    all.find((candidate) => candidate.keyType === "number");
  const omitted = all.filter((candidate) => candidate !== selected);
  // The two omissions have different causes and different remedies, so they are
  // reported apart: a `symbol` or pattern key has no encoding in the model at
  // all, while a `number` key alongside a `string` key is perfectly
  // representable and lost only because the model carries one signature.
  recordOmittedIndexSignatures(
    omitted.filter((candidate) => candidate.keyType === "string" || candidate.keyType === "number"),
    "additional-signature",
    context
  );
  recordOmittedIndexSignatures(
    omitted.filter((candidate) => candidate.keyType !== "string" && candidate.keyType !== "number"),
    "unrepresentable-key",
    context
  );
  return selected;
}

function recordOmittedIndexSignatures(
  omitted: readonly BackendIndexSignatureFacts[],
  reason: OmittedIndexSignatureReason,
  context: Context
): void {
  if (omitted.length === 0) return;
  const declaration = omitted.find((candidate) => candidate.declaration !== undefined)?.declaration;
  context.warnings.push({
    code: "omitted-index-signature",
    ...warningLocation(context, declaration),
    reason,
    keyTypes: omitted.map((candidate) => candidate.keyType),
  });
}

/**
 * Reports construct signatures a shape carries but the model cannot.
 *
 * Only a class becomes a class node; an interface or object literal type that
 * merely declares `new (…)` is reported as a bare object, exactly as upstream
 * does. The same loss hits callable-first shapes: a function node carries only
 * call signatures, so construct signatures declared beside them vanish. The
 * signatures themselves are recoverable information, so each omission is a
 * structured warning addressed at the `constructSignatures` slot of the
 * current structural path instead of a silent loss.
 */
export function recordUnrepresentedConstructSignatures(type: BackendTypeHandle, context: Context): void {
  const constructs = context.operations.constructSignaturesOfType(type);
  const first = constructs.at(0);
  if (first === undefined) return;
  context.warnings.push({
    code: "unrepresented-construct-signatures",
    ...warningLocation(context, context.operations.signatureFacts(first).declaration),
    structuralPath: [...context.provenancePath, "constructSignatures"],
    signatureCount: constructs.length,
  });
}

/**
 * Names the object members of a type that survive eligibility policy.
 *
 * Shared by the callable warning sites: a function node cannot carry members,
 * so the resolver reports which named members a callable shape declared before
 * they are dropped. Inclusion callbacks are deliberately not consulted here —
 * this is about what the model could represent, not what a caller filtered.
 */
function eligiblePropertyNames(type: BackendTypeHandle, context: Context): readonly string[] {
  return propertiesOfType(context.operations.propertiesOfType(type), type, context).map(
    (property) => context.operations.symbolFacts(property).name
  );
}

/**
 * Reports named members a callable shape declares besides its call signatures.
 *
 * A function node describes only the callable half, and the model gives it no
 * member list — an interface that merges `(…) => T` with properties keeps just
 * its signatures, so the dropped names become a structured warning addressed
 * at the callable's structural path instead of a silent loss. Intersections are
 * exempt: their aggregate property view is a separate resolution decision that
 * the compound resolver owns, and only shapes that anchor a described value
 * (depth zero) report at all.
 */
export function recordOmittedCallableMembers(
  type: BackendTypeHandle,
  signatures: readonly BackendSignatureHandle[],
  context: Context
): void {
  if (context.propertyDepth !== 0 || signatures.length === 0) return;
  if (context.operations.typeFacts(type).isIntersection === true) return;
  const memberNames = eligiblePropertyNames(type, context);
  if (memberNames.length === 0) return;
  const firstSignature = signatures.at(0);
  if (firstSignature === undefined) return;
  context.warnings.push({
    code: "omitted-callable-members",
    ...warningLocation(context, context.operations.signatureFacts(firstSignature).declaration),
    structuralPath: [...context.provenancePath],
    memberNames,
  });
}

function indexSignatureNode(
  index: BackendIndexSignatureFacts,
  owner: BackendTypeHandle | undefined,
  context: Context,
  resolveType: ResolveSemanticType
): IndexSignatureNode {
  recordIndexSignatureKeyProvenance(owner, false, context);
  const result = {
    keyType: index.keyType === "number" ? ("number" as const) : ("string" as const),
    valueType: resolveType(
      index.valueType,
      index.declaration === undefined ? undefined : context.operations.nodeFacts(index.declaration).type,
      undefined,
      { ...context, propertyDepth: context.propertyDepth + 1 }
    ),
  };
  if (index.keyName !== undefined) Object.assign(result, { keyName: index.keyName });
  return result;
}

/**
 * Records where an index signature's key came from. A key declared by an
 * authored index signature is attributed to the declarations of the type that
 * carries it. A key a mapped type synthesized (`synthesized`) is never
 * declared — the mapped type invents one per constraint member — so its entry
 * is attributed to the mapped type's own declarations and marked synthesized.
 * A key with no declaring symbol at all is marked synthesized for the same
 * reason: no declaration of that key exists.
 */
export function recordIndexSignatureKeyProvenance(
  owner: BackendTypeHandle | undefined,
  synthesized: boolean,
  context: Context
): void {
  const facts = owner === undefined ? undefined : context.operations.typeFacts(owner);
  const symbol = facts?.aliasSymbol ?? facts?.symbol;
  const info = symbol === undefined ? undefined : context.operations.symbolFacts(symbol);
  const declared =
    info === undefined ? { declarations: [], synthesized: true } : declarationProvenance(info, context);
  recordProvenance(context, {
    path: indexSignatureKeySemanticPath(context.provenancePath),
    ...declared,
    synthesized: synthesized || declared.synthesized,
  });
}

function parameterDefaultValue(node: BackendNodeFacts | undefined, context: Context): string | undefined {
  if (node?.initializer === undefined) return undefined;
  const initializerType = context.operations.typeAtNode(node.initializer);
  if (initializerType !== undefined) {
    const literal = context.operations.typeFacts(initializerType).literal;
    if (literal !== undefined) return JSON.stringify(literal);
  }
  return node.initializerText;
}

function normalizedBindingDefaults(
  node: BackendNodeFacts | undefined
): ReadonlyMap<string, string> | undefined {
  if (node?.bindingDefaults === undefined || node.bindingDefaults.length === 0) return undefined;
  return new Map(node.bindingDefaults.map((entry) => [entry.name, entry.initializerText]));
}

function objectResult(
  properties: readonly PropertyNode[],
  typeName: TypeName | undefined,
  indexSignature: BackendIndexSignatureFacts | undefined,
  owner: BackendTypeHandle,
  context: Context,
  resolveType: ResolveSemanticType
): Extract<SemanticType, { kind: "object" }> {
  const result: Extract<SemanticType, { kind: "object" }> = { kind: "object", properties };
  if (typeName !== undefined) Object.assign(result, { typeName });
  if (indexSignature !== undefined) {
    Object.assign(result, {
      indexSignature: indexSignatureNode(indexSignature, owner, context, resolveType),
    });
  }
  return result;
}

export function propertyTypeNode(
  property: BackendSymbolHandle,
  context: Context
): BackendNodeReference | undefined {
  const declaration = primaryDeclaration(context.operations.symbolFacts(property));
  return declaration === undefined ? undefined : context.operations.nodeFacts(declaration).type;
}

function returnTypeNode(
  declaration: BackendNodeHandle | undefined,
  context: Context
): BackendNodeReference | undefined {
  return declaration === undefined ? undefined : context.operations.nodeFacts(declaration).returnType;
}
