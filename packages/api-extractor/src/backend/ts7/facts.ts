/**
 * SIZE CEILING: 665. Nothing more lands here before the node-facts or
 * type-name machinery splits into its own sibling (`class-facts.ts` style).
 */

import type { InterfaceDeclaration, Node, TypeNode } from "typescript/unstable/ast";
import { SyntaxKind } from "typescript/unstable/ast";
import {
  isEnumMember,
  isIdentifier,
  isIndexSignatureDeclaration,
  isInterfaceDeclaration,
  isQualifiedName,
  isTypeReferenceNode,
  isTypeNode,
} from "typescript/unstable/ast/is";
import { SignatureKind, SymbolFlags, TypeFlags } from "typescript/unstable/sync";
import type {
  Checker,
  NodeHandle,
  Program,
  Signature,
  Symbol as TsSymbol,
  Type,
} from "typescript/unstable/sync";

import { definedFields, flagFields } from "../../optional-fields.ts";
import { typeFlagNames } from "../../warnings.ts";
import type { TypeFlagName } from "../../warnings.ts";
import type {
  BackendCompilerOperations,
  BackendDeclarationOwnership,
  BackendDocumentation,
  BackendEnumFacts,
  BackendEnumMemberFacts,
  BackendIndexSignatureFacts,
  BackendNodeHandle,
  BackendNodeReference,
  BackendSignatureFacts,
  BackendSignatureHandle,
  BackendSymbolHandle,
  BackendTypeFacts,
  BackendTypeHandle,
  BackendTypeNodeHandle,
  BackendTypeNameFacts,
  BackendWarningFact,
} from "../contracts.ts";
import { constructSignaturesOfType } from "./class-facts.ts";
import { valueOrFirstDeclarationHandle } from "./declarations.ts";
import { documentationOfNode, documentationOfParameter, documentationOfSymbol } from "./documentation.ts";
import {
  declarationOwnership,
  isExternalDeclaration,
  isTypeScriptLibraryDeclaration,
} from "./file-ownership.ts";
import { extendsTypes } from "./heritage.ts";
import type { TsgoHeritageSession } from "./heritage.ts";
import { nodeFacts, nodeKindOfHandle } from "./node-facts.ts";
import { SessionFactCache } from "./session-fact-cache.ts";
import { declaringParentIsClass, symbolFacts, symbolNamespaces, symbolOrigin } from "./symbol-facts.ts";
import { authoredLocation } from "./syntax.ts";

export type TsgoFactsSession = {
  readonly componentSources: boolean;
  readonly checker: Checker;
  readonly program: Program;
  readonly sourceFileMetadata: (path: string) => ReturnType<Program["getSourceFileMetadata"]>;
  readonly rootDirectory: string;
  readonly ensureOpen: (operation: string) => void;
  readonly symbol: (handle: BackendSymbolHandle, operation: string) => TsSymbol;
  readonly type: (handle: BackendTypeHandle, operation: string) => Type;
  readonly signature: (handle: BackendSignatureHandle, operation: string) => Signature;
  readonly node: (handle: BackendNodeReference, operation: string) => Node;
  readonly symbolHandle: (symbol: TsSymbol) => BackendSymbolHandle;
  readonly typeHandle: (type: Type) => BackendTypeHandle;
  readonly typeHandlesFor: (types: readonly Type[]) => readonly BackendTypeHandle[];
  readonly nodeHandle: (node: Node) => BackendNodeHandle;
  readonly declarationHandle: (declaration: NodeHandle) => BackendNodeHandle;
  readonly declarationPath: (declaration: NodeHandle) => string;
  readonly signatureHandle: (signature: Signature) => BackendSignatureHandle;
  readonly typeNodeHandle: (node: TypeNode) => BackendTypeNodeHandle;
  readonly nodeReference: (node: Node) => BackendNodeReference;
  readonly symbolAt: (node: Node) => BackendSymbolHandle | undefined;
  /** The checker symbol at a node, memoized per session; `symbolAt` is its handle form. */
  readonly rawSymbolAt: (node: Node) => TsSymbol | undefined;
  /** Session-memoized ownership classification of one source-file path. */
  readonly ownershipOfPath: (path: string) => BackendDeclarationOwnership;
  /**
   * Session-memoized classification from the path name alone, without the
   * compiler's per-file metadata. The pre-check before a metadata read and
   * the standard-library path test ask this; every other owner question goes
   * through `ownershipOfPath`.
   */
  readonly ownershipFromPathName: (path: string) => BackendDeclarationOwnership;
  readonly resolveNode: (node: {
    readonly index: number;
    readonly path: string;
    readonly resolve: () => Node | undefined;
  }) => Node | undefined;
  readonly nodePath: (node: BackendNodeReference) => string;
  readonly compilerKind: (node: BackendNodeReference) => Node["kind"];
};

/** `typeFlagNames` order minus the `Other` sentinel, paired with the compiler's flag bits. */
const typeFlagDisplayOrder: readonly (readonly [TypeFlags, TypeFlagName])[] = typeFlagNames
  .filter((name): name is Exclude<TypeFlagName, "Other"> => name !== "Other")
  .map((name) => [TypeFlags[name], name] as const);

export type TsgoSessionFacts = {
  /** Every operation except the error-context breadcrumb, which the session itself owns. */
  readonly operations: Omit<BackendCompilerOperations, "setErrorContext">;
  readonly heritageTypes: (
    declaration: BackendNodeHandle
  ) => readonly { readonly name: string; readonly resolvedName?: string }[] | undefined;
  readonly clear: () => void;
};

export function createSessionFacts(
  session: TsgoFactsSession,
  heritage: TsgoHeritageSession
): TsgoSessionFacts {
  const cache = new SessionFactCache(session);
  const symbolOriginRead = cache.byHandle("symbolOrigin", (symbol: BackendSymbolHandle) =>
    symbolOrigin(session, symbol)
  );
  const documentationOfSymbolRead = cache.byHandle("documentationOfSymbol", (symbol: BackendSymbolHandle) =>
    documentationOfSymbol(session, symbol)
  );
  const operations: Omit<BackendCompilerOperations, "setErrorContext"> = {
    typeOfSymbol: cache.byHandlePair("typeOfSymbol", (symbol, declared) =>
      typeOfSymbol(session, symbol, declared)
    ),
    typeAtNode: cache.byHandle("typeAtNode", (node) => typeAtNode(session, node)),
    typeFacts: cache.byHandle("typeFacts", (type) => typeFacts(session, type)),
    declarationOwnership: cache.byHandle("declarationOwnership", (node) =>
      declarationOwnership(session, node)
    ),
    symbolFacts: cache.byHandle("symbolFacts", (symbol) => symbolFacts(session, symbol)),
    symbolOrigin: symbolOriginRead,
    declaringParentIsClass: cache.byHandle("symbolFacts.declaringParentIsClass", (symbol) =>
      declaringParentIsClass(session, symbol)
    ),
    documentationOfSymbol: documentationOfSymbolRead,
    enumFacts: cache.byHandle("enumFacts", (type) => enumFacts(session, type, documentationOfSymbolRead)),
    nodeFacts: cache.byHandle("nodeFacts", (node) =>
      nodeFacts(session, node, (source) => typeNameFromNode(session, source), symbolOriginRead)
    ),
    nodeKind: cache.byHandle("nodeKind", (node) => nodeKindOfHandle(session, node)),
    typeNameFacts: cache.byHandlePair("typeNameFacts", (type, sourceNode) =>
      typeNameFacts(session, type, sourceNode)
    ),
    signaturesOfType: cache.byHandle("signaturesOfType", (type) => signaturesOfType(session, type)),
    constructSignaturesOfType: cache.byHandle("constructSignaturesOfType", (type) =>
      constructSignaturesOfType(session, type)
    ),
    signatureFacts: cache.byHandle("signatureFacts", (signature) => signatureFacts(session, signature)),
    documentationOfNode: cache.byHandle("documentationOfNode", (node) => documentationOfNode(session, node)),
    documentationOfParameter: cache.byHandlePair("documentationOfParameter", (parameter, ownerDeclaration) =>
      documentationOfParameter(session, parameter, ownerDeclaration)
    ),
    propertiesOfType: cache.byHandle("propertiesOfType", (type) => propertiesOfType(session, type)),
    propertyType: cache.byHandle("propertyType", (property) => propertyType(session, property)),
    indexSignaturesOfType: cache.byHandle("indexSignaturesOfType", (type) =>
      indexSignaturesOfType(session, type)
    ),
    baseConstraintOfType: cache.byHandle("baseConstraintOfType", (type) =>
      baseConstraintOfType(session, type)
    ),
    isArrayType: cache.byHandle("isArrayType", (type) => isArrayType(session, type)),
    isReadonlyType: cache.byHandle("isReadonlyType", (type) => isReadonlyType(session, type)),
    typeToString: cache.byHandle("typeToString", (type) => typeToString(session, type)),
  };
  return {
    operations,
    heritageTypes: cache.byHandle("heritageTypes", (declaration) =>
      extendsTypes(heritage, session.node(declaration, "heritageTypes"))
    ),
    clear: cache.clear,
  };
}

/**
 * The type an exported symbol describes.
 *
 * Class symbols report their STATIC side through `getTypeOfSymbol`, which is
 * where construct signatures live — the same choice upstream makes so
 * `export class Dialog {}` resolves as a class. Interfaces, aliases, and enums
 * keep `getDeclaredTypeOfSymbol`, which for a class would silently describe
 * only its instance side.
 */
function typeOfSymbol(
  session: TsgoFactsSession,
  handle: BackendSymbolHandle,
  declared: boolean
): BackendTypeHandle | undefined {
  const raw = session.symbol(handle, "typeOfSymbol");
  const target = (raw.flags & SymbolFlags.Alias) !== 0 ? session.checker.getAliasedSymbol(raw) : raw;
  const declarationHandle = valueOrFirstDeclarationHandle(target);
  const declaration =
    declarationHandle?.kind === SyntaxKind.VariableDeclaration &&
    !isTypeScriptLibraryDeclaration(session, declarationHandle)
      ? session.resolveNode(declarationHandle)
      : undefined;
  const type =
    declaration !== undefined
      ? session.checker.getTypeAtLocation(declaration)
      : declared &&
          declarationHandle !== undefined &&
          (declarationHandle.kind === SyntaxKind.TypeAliasDeclaration ||
            declarationHandle.kind === SyntaxKind.InterfaceDeclaration ||
            declarationHandle.kind === SyntaxKind.EnumDeclaration)
        ? session.checker.getDeclaredTypeOfSymbol(target)
        : session.checker.getTypeOfSymbol(target);
  return type === undefined ? undefined : session.typeHandle(type);
}

function typeAtNode(session: TsgoFactsSession, handle: BackendNodeReference): BackendTypeHandle | undefined {
  const raw = session.node(handle, "typeAtNode");
  const type = isTypeNode(raw)
    ? session.checker.getTypeFromTypeNode(raw)
    : session.checker.getTypeAtLocation(raw);
  return type === undefined ? undefined : session.typeHandle(type);
}

function typeFacts(session: TsgoFactsSession, handle: BackendTypeHandle): BackendTypeFacts {
  const type = session.type(handle, "typeFacts");
  const symbol = type.getSymbol();
  const aliasSymbol = type.getAliasSymbol();
  const isTypeReference = type.isTypeReference();
  const isConditional = type.isConditionalType();
  const isSubstitution = type.isSubstitutionType();
  return {
    flags: typeFlagNamesOf(type.flags),
    ...definedFields({
      intrinsic: isIntrinsic(type.flags),
      indexTarget: type.isIndexType() ? session.typeHandle(type.getTarget()) : undefined,
      symbol: symbol === undefined ? undefined : session.symbolHandle(symbol),
      aliasSymbol: aliasSymbol === undefined ? undefined : session.symbolHandle(aliasSymbol),
      literal: type.isLiteralType() && isLiteral(type.value) ? type.value : undefined,
      unionOrIntersectionTypes:
        type.isUnionType() || type.isIntersectionType() ? session.typeHandlesFor(type.getTypes()) : undefined,
      referenceTarget: isTypeReference ? session.typeHandle(type.getTarget()) : undefined,
      typeArguments: isTypeReference
        ? session.typeHandlesFor(session.checker.getTypeArguments(type))
        : undefined,
      aliasTypeArguments:
        type.getAliasTypeArguments().length > 0
          ? session.typeHandlesFor(type.getAliasTypeArguments())
          : undefined,
      conditionalCheckType: isConditional ? session.typeHandle(type.getCheckType()) : undefined,
      conditionalTrueType: isConditional ? session.typeHandle(type.getTrueType()) : undefined,
      conditionalFalseType: isConditional ? session.typeHandle(type.getFalseType()) : undefined,
      substitutionBaseType: isSubstitution ? session.typeHandle(type.getBaseType()) : undefined,
      substitutionConstraint: isSubstitution ? session.typeHandle(type.getConstraint()) : undefined,
    }),
    ...flagFields({
      isError: type.isErrorType(),
      isTypeParameter: type.isTypeParameter(),
      isUnion: type.isUnionType(),
      isIntersection: type.isIntersectionType(),
      isTuple: tupleTarget(type) !== undefined,
      // `typeToString` is a checker round trip, so it is asked only for the one
      // flag combination whose answer depends on it: the `object` keyword.
      isObject:
        type.isIntersectionType() ||
        (type.flags & TypeFlags.Object) !== 0 ||
        ((type.flags & TypeFlags.NonPrimitive) !== 0 && session.checker.typeToString(type) === "object"),
      isEnum: (type.flags & TypeFlags.EnumLike) !== 0,
    }),
  };
}

/**
 * Recovers the tuple *target* behind a checker type, or `undefined` when the
 * type is not a tuple.
 *
 * `ObjectFlags.Tuple` only ever sits on the uninstantiated tuple target. An
 * authored `[string, number]` reaches the API as a type *reference* to that
 * target, and `Type.isTupleType()` is a plain `objectFlags & Tuple` test, so
 * asking the reference alone reports `false` for every ordinary tuple. Reading
 * through `getTarget()` is what makes the tuple visible, and it is also where
 * `elementFlags`, `fixedLength`, and `readonly` live.
 */
function tupleTarget(type: Type): Type | undefined {
  if (type.isTupleType()) return type;
  if (!type.isTypeReference()) return undefined;
  const target = type.getTarget();
  return target.isTupleType() ? target : undefined;
}

function enumFacts(
  session: TsgoFactsSession,
  handle: BackendTypeHandle,
  documentationOf: (symbol: BackendSymbolHandle) => BackendDocumentation | undefined
): BackendEnumFacts | undefined {
  const type = session.type(handle, "enumFacts");
  if ((type.flags & TypeFlags.EnumLike) === 0) return undefined;
  const initial = type.getAliasSymbol() ?? type.getSymbol();
  if (initial === undefined) return undefined;
  const parent = initial.getParent();
  const symbol = parent !== undefined && (parent.flags & SymbolFlags.Enum) !== 0 ? parent : initial;
  if ((symbol.flags & SymbolFlags.Enum) === 0) return undefined;
  const members: BackendEnumMemberFacts[] = [];
  const warnings: BackendWarningFact[] = [];
  for (const member of symbol.getExports().values()) {
    const declaration = member.declarations
      .map((candidate) => session.resolveNode(candidate))
      .find((candidate): candidate is Node => candidate !== undefined && isEnumMember(candidate));
    const memberType = session.checker.getTypeOfSymbol(member);
    const value = declaration === undefined ? undefined : session.checker.getConstantValue(declaration);
    const inferredValue =
      value ??
      (memberType?.isLiteralType() === true && isLiteral(memberType.value) ? memberType.value : undefined);
    if (
      declaration === undefined ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- literal values are narrowed at the compiler boundary.
      (typeof inferredValue !== "string" && typeof inferredValue !== "number")
    ) {
      warnings.push(enumWarning(session, symbol, member.name));
    }
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- literal values are narrowed at the compiler boundary.
    if (typeof inferredValue !== "string" && typeof inferredValue !== "number") continue;
    const memberDocumentation = documentationOf(session.symbolHandle(member));
    members.push({
      name: member.name,
      value: inferredValue,
      symbol: session.symbolHandle(member),
      ...definedFields({
        declaration: declaration === undefined ? undefined : session.nodeHandle(declaration),
        documentation: memberDocumentation,
      }),
    });
  }
  const documentation = documentationOf(session.symbolHandle(symbol));
  return {
    name: symbol.name,
    namespaces: symbolNamespaces(session, symbol),
    members,
    ...definedFields({
      warnings: warnings.length === 0 ? undefined : warnings,
      documentation,
    }),
  };
}

function enumWarning(session: TsgoFactsSession, symbol: TsSymbol, memberName: string): BackendWarningFact {
  const declaration = symbol.declarations
    .map((candidate) => session.resolveNode(candidate))
    .find((candidate): candidate is Node => candidate !== undefined);
  const location = declaration === undefined ? undefined : authoredLocation(declaration);
  return {
    code: "missing-enum-declaration",
    filePath: location?.filePath ?? "<unknown>",
    line: location?.line ?? 1,
    column: location?.column ?? 1,
    parsedSymbolStack: [],
    enumName: symbol.name,
    memberName,
  };
}

function typeNameFromNode(session: TsgoFactsSession, node: TypeNode): BackendTypeNameFacts {
  // SAFETY: the caller reaches this only for a type-reference node, whose `typeName` is always
  // present; `typeArguments` stays optional and every read below tolerates its absence.
  const typeReference = node as TypeNode & {
    readonly typeName: Node;
    readonly typeArguments?: readonly TypeNode[];
  };
  const typeName = typeReference.typeName;
  const authoredSymbol = session.symbolAt(isQualifiedName(typeName) ? typeName.right : typeName);
  const qualified = qualifiedNamespaces(typeName);
  const authoredRawSymbol =
    authoredSymbol === undefined ? undefined : session.symbol(authoredSymbol, "typeNameFromNode");
  // The enclosing namespace chain of the TARGET declaration speaks first
  // (`Nested.Foo` inside `namespace Root` reports ["Root", "Nested"]); the
  // written qualifier only fills in when the chain has nothing to say, which
  // mirrors upstream's `getFullName` namespace selection.
  const chain = authoredRawSymbol === undefined ? [] : symbolNamespaces(session, authoredRawSymbol);
  const namespaces = chain.length > 0 ? chain : qualified;
  const builtInArray = builtInArrayReferenceName(session, authoredRawSymbol);
  return {
    name: rightmostName(typeName) ?? "",
    namespaces,
    ...definedFields({
      authoredArguments: typeReference.typeArguments?.map((argument) => session.typeNodeHandle(argument)),
      authoredSymbol,
      builtInArray,
    }),
  };
}

/**
 * Reports which built-in array interface an authored reference names.
 *
 * The reference is only TypeScript's own array when the symbol it resolves to —
 * through an import alias — is an *interface* named `Array` or `ReadonlyArray`
 * declared in a TypeScript library file. User code can declare all three of
 * those things separately, so all three are checked. This mirrors upstream's
 * `getBuiltInArrayReferenceName` (`typeContainerUtils.ts`).
 */
function builtInArrayReferenceName(
  session: TsgoFactsSession,
  symbol: TsSymbol | undefined
): "Array" | "ReadonlyArray" | undefined {
  if (symbol === undefined) return undefined;
  const target = (symbol.flags & SymbolFlags.Alias) !== 0 ? session.checker.getAliasedSymbol(symbol) : symbol;
  const name = target.name;
  if (name !== "Array" && name !== "ReadonlyArray") return undefined;
  if ((target.flags & SymbolFlags.Interface) === 0) return undefined;
  return target.declarations.some((declaration) => isTypeScriptLibraryDeclaration(session, declaration))
    ? name
    : undefined;
}

function typeNameFacts(
  session: TsgoFactsSession,
  handle: BackendTypeHandle,
  sourceNode: BackendNodeReference | undefined
): BackendTypeNameFacts | undefined {
  const rawNode = sourceNode === undefined ? undefined : session.node(sourceNode, "typeNameFacts");
  // Optional properties hand the resolver the authored value node while the
  // checker type is a union with `undefined`. The authored reference is only
  // the name of one union member, not the union itself, so do not let that
  // node manufacture a union-level type name. The resolver still obtains a
  // semantic alias name from the checker type below when one exists (for
  // example ReactNode/AwaitedReactNode).
  if (rawNode !== undefined && isTypeReferenceNode(rawNode)) {
    const type = session.type(handle, "typeNameFacts");
    const authored = typeNameFromNode(session, rawNode);
    if (!type.isUnionType() && !type.isIntersectionType()) return authored;
    const authoredSymbol = authored.authoredSymbol;
    if (
      authoredSymbol === undefined ||
      !session
        .symbol(authoredSymbol, "typeNameFacts")
        .declarations.some((declaration) => isExternalDeclaration(session, declaration))
    )
      return authored;
  }
  const type = session.type(handle, "typeNameFacts");
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  if (symbol === undefined || internalSymbolNames.has(symbol.name)) return undefined;
  return { name: symbol.name, namespaces: symbolNamespaces(session, symbol) };
}

function signaturesOfType(
  session: TsgoFactsSession,
  handle: BackendTypeHandle
): readonly BackendSignatureHandle[] {
  const type = session.type(handle, "signaturesOfType");
  return session.checker
    .getSignaturesOfType(type, SignatureKind.Call)
    .map((signature) => session.signatureHandle(signature));
}

function signatureFacts(session: TsgoFactsSession, handle: BackendSignatureHandle): BackendSignatureFacts {
  const signature = session.signature(handle, "signatureFacts");
  const returnType = session.checker.getReturnTypeOfSignature(signature);
  return {
    parameters: signature.getParameters().map((parameter) => session.symbolHandle(parameter)),
    typeParameters: signature.getTypeParameters().map((parameter) => session.typeHandle(parameter)),
    ...definedFields({
      returnType: returnType === undefined ? undefined : session.typeHandle(returnType),
      declaration: signature.declaration && session.declarationHandle(signature.declaration),
    }),
  };
}

function propertiesOfType(
  session: TsgoFactsSession,
  handle: BackendTypeHandle
): readonly BackendSymbolHandle[] {
  const type = session.type(handle, "propertiesOfType");
  const ordered: TsSymbol[] = [];
  const seen = new Set<string>();
  const add = (property: TsSymbol): void => {
    if (seen.has(property.name)) return;
    seen.add(property.name);
    ordered.push(property);
  };
  // Upstream prepends direct interface heritage properties in the authored
  // `extends` clause order, then appends the owner's checker properties. Keep
  // that narrow interface-only read: calling `getBaseTypes()` for every type
  // perturbs class member order on TypeScript 7, while resolving an external
  // declaration here would defeat the lazy ownership gate. Declaration kind
  // and path are available without materializing the declaration body, so only
  // project-owned interfaces are resolved for their authored heritage syntax.
  const declaration = type
    .getSymbol()
    ?.declarations.filter((candidate) => candidate.kind === SyntaxKind.InterfaceDeclaration)
    .filter((candidate) => !isExternalDeclaration(session, candidate))
    .map((candidate) => session.resolveNode(candidate))
    .find(
      (candidate): candidate is InterfaceDeclaration =>
        candidate !== undefined && isInterfaceDeclaration(candidate)
    );
  if (declaration !== undefined) {
    for (const clause of declaration.heritageClauses ?? []) {
      if (clause.token !== SyntaxKind.ExtendsKeyword) continue;
      for (const heritage of clause.types) {
        const heritageType = session.checker.getTypeAtLocation(heritage);
        if (heritageType === undefined) continue;
        for (const property of session.checker.getPropertiesOfType(heritageType)) add(property);
      }
    }
  }
  for (const property of session.checker.getPropertiesOfType(type)) add(property);
  return ordered.map((property) => session.symbolHandle(property));
}

function propertyType(session: TsgoFactsSession, handle: BackendSymbolHandle): BackendTypeHandle | undefined {
  const property = session.symbol(handle, "propertyType");
  const type = session.checker.getTypeOfSymbol(property);
  return type === undefined ? undefined : session.typeHandle(type);
}

/**
 * Normalizes every index signature a type carries, in the compiler's own order.
 *
 * All of them are reported, including the `symbol` and pattern key domains the
 * semantic model has no encoding for, so the decision to drop one — and the
 * warning that records it — stays in the compiler-free resolver.
 *
 * A key name is read from every authored index signature, wherever it is
 * declared, exactly as upstream's `getKeyName` does: an index signature written
 * in a dependency is only ever reached when the caller asked for external types,
 * and its parameter name is as authored as any other.
 */
function indexSignaturesOfType(
  session: TsgoFactsSession,
  handle: BackendTypeHandle
): readonly BackendIndexSignatureFacts[] {
  const type = session.type(handle, "indexSignaturesOfType");
  return session.checker.getIndexInfosOfType(type).map((info) => {
    const declaration = info.declaration === undefined ? undefined : session.resolveNode(info.declaration);
    return {
      keyType: indexKeyType(info.keyType.flags),
      valueType: session.typeHandle(info.valueType),
      ...flagFields({ isReadonly: info.isReadonly }),
      ...definedFields({
        declaration: declaration === undefined ? undefined : session.nodeHandle(declaration),
        keyName:
          declaration !== undefined &&
          isIndexSignatureDeclaration(declaration) &&
          declaration.parameters[0] !== undefined &&
          isIdentifier(declaration.parameters[0].name)
            ? declaration.parameters[0].name.text
            : undefined,
      }),
    };
  });
}

function indexKeyType(flags: TypeFlags): BackendIndexSignatureFacts["keyType"] {
  if ((flags & TypeFlags.Number) !== 0) return "number";
  if ((flags & TypeFlags.ESSymbolLike) !== 0) return "symbol";
  if ((flags & TypeFlags.String) !== 0) return "string";
  return "other";
}

function baseConstraintOfType(
  session: TsgoFactsSession,
  handle: BackendTypeHandle
): BackendTypeHandle | undefined {
  const type = session.type(handle, "baseConstraintOfType");
  const base = session.checker.getBaseConstraintOfType(type);
  return base === undefined ? undefined : session.typeHandle(base);
}

function isArrayType(session: TsgoFactsSession, handle: BackendTypeHandle): boolean {
  return session.checker.isArrayType(session.type(handle, "isArrayType"));
}

/**
 * Reports TypeScript's semantic readonly marker for array and tuple containers.
 *
 * `readonly T[]` is a reference to the built-in `ReadonlyArray` interface and
 * `readonly [A, B]` is a tuple reference whose *target* carries the readonly
 * flag. Neither marker lives on the reference itself, so both are read from the
 * reference target. The declaring file is checked as well because user code may
 * declare its own `ReadonlyArray`. A generic tuple type that is its own target
 * is accepted directly for the same reason.
 */
function isReadonlyType(session: TsgoFactsSession, handle: BackendTypeHandle): boolean {
  const type = session.type(handle, "isReadonlyType");
  const tuple = tupleTarget(type);
  if (tuple !== undefined) return tuple.isTupleType() && tuple.readonly;
  if (!type.isTypeReference()) return false;
  const target = type.getTarget();
  const symbol = target.getSymbol();
  return (
    symbol?.name === "ReadonlyArray" &&
    symbol.declarations.some((declaration) => isTypeScriptLibraryDeclaration(session, declaration))
  );
}

function typeToString(session: TsgoFactsSession, handle: BackendTypeHandle): string {
  return session.checker.typeToString(session.type(handle, "typeToString"));
}

function typeFlagNamesOf(flags: TypeFlags): readonly TypeFlagName[] {
  const names = typeFlagDisplayOrder.filter(([flag]) => (flags & flag) === flag).map(([, name]) => name);
  return names.length === 0 ? ["Other"] : names;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- primitive narrowing is the adapter's normalized-fact seam.
function isLiteral(value: unknown): value is string | number | boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- literal values are narrowed at the compiler boundary.
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isIntrinsic(flags: TypeFlags): BackendTypeFacts["intrinsic"] {
  if ((flags & TypeFlags.Any) !== 0) return "any";
  if ((flags & TypeFlags.Unknown) !== 0) return "unknown";
  if ((flags & TypeFlags.Undefined) !== 0) return "undefined";
  if ((flags & TypeFlags.Null) !== 0) return "null";
  if ((flags & TypeFlags.Void) !== 0) return "void";
  if ((flags & TypeFlags.String) !== 0) return "string";
  if ((flags & TypeFlags.Number) !== 0) return "number";
  if ((flags & TypeFlags.BigInt) !== 0) return "bigint";
  if ((flags & TypeFlags.Boolean) !== 0) return "boolean";
  if ((flags & TypeFlags.ESSymbolLike) !== 0) return "symbol";
  if ((flags & TypeFlags.Never) !== 0) return "never";
  return undefined;
}

function rightmostName(node: Node): string | undefined {
  return isIdentifier(node) ? node.text : isQualifiedName(node) ? node.right.text : undefined;
}

function qualifiedNamespaces(node: Node): string[] {
  if (!isQualifiedName(node)) return [];
  const result: string[] = [];
  let current: Node = node;
  while (isQualifiedName(current)) {
    if (isIdentifier(current.left)) result.unshift(current.left.text);
    current = current.left;
  }
  return result;
}

/**
 * Compiler-internal symbol names that never describe a public API name.
 * Hoisted so the hot `typeNameFacts` path does not rebuild the set per call.
 *
 * DELIBERATELY NOT the shared prefix rule (`isInternalSymbolName` in
 * `backend/contracts.ts`): this closed set lists exactly the names the checker
 * reports here and also admits "VoidOrUndefinedOnly", which carries no `__`
 * prefix; merging either policy into the other would change what is refused.
 */
const internalSymbolNames: ReadonlySet<string> = new Set([
  "__call",
  "__constructor",
  "__new",
  "__index",
  "__export",
  "__global",
  "__missing",
  "__type",
  "__object",
  "__jsxAttributes",
  "__class",
  "__function",
  "VoidOrUndefinedOnly",
]);
