import type { Node, TypeNode } from "typescript/unstable/ast";
import { SyntaxKind } from "typescript/unstable/ast";
import {
  isArrayTypeNode,
  isAsExpression,
  isBindingElement,
  isCallExpression,
  isClassDeclaration,
  isFunctionLikeDeclaration,
  isIdentifier,
  isImportClause,
  isImportSpecifier,
  isImportTypeNode,
  isIndexSignatureDeclaration,
  isInterfaceDeclaration,
  isIntersectionTypeNode,
  isMappedTypeNode,
  isNamedTupleMember,
  isNonNullExpression,
  isNumericLiteral,
  isObjectBindingPattern,
  isOptionalTypeNode,
  isParameterDeclaration,
  isParenthesizedExpression,
  isParenthesizedTypeNode,
  isPropertyAssignment,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isRestTypeNode,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isTupleTypeNode,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isTypeNode,
  isTypeOperatorNode,
  isTypeParameterDeclaration,
  isTypeQueryNode,
  isTypeReferenceNode,
  isUnionTypeNode,
  isVariableDeclaration,
} from "typescript/unstable/ast/is";

import { definedFields } from "../../optional-fields.ts";
import type {
  BackendNodeFacts,
  BackendNodeReference,
  BackendSymbolHandle,
  BackendSymbolOrigin,
} from "../contracts.ts";
import { callExpressionFacts } from "./call-facts.ts";
import { declarationModifiers } from "./class-facts.ts";
import type { TsgoFactsSession } from "./facts.ts";
import { aliasedSymbol } from "./module-resolution.ts";
import { authoredLocation } from "./syntax.ts";

/**
 * Reads one handle's parser-facing kind. Answers from the compiler kind alone
 * except for import types, whose `typeof` form is only visible on the resolved
 * node; those handles resolve the AST so the answer matches `nodeFacts().kind`.
 */
export function nodeKindOfHandle(
  session: TsgoFactsSession,
  handle: BackendNodeReference
): BackendNodeFacts["kind"] {
  const kind = session.compilerKind(handle);
  if (kind === SyntaxKind.ImportType) return nodeKind(session.node(handle, "nodeKind"));
  return nodeKindFromCompilerKind(kind);
}

/**
 * The single kind table. Maps a compiler syntax kind to the parser-facing
 * kind; type nodes without a dedicated kind report `"type"` and everything
 * else `"unknown"`. `nodeKind(node)` applies it to a resolved node and only
 * refines what the syntax kind cannot express (`typeof import(...)`).
 */
function nodeKindFromCompilerKind(kind: Node["kind"]): BackendNodeFacts["kind"] {
  switch (kind) {
    case SyntaxKind.TypeAliasDeclaration:
      return "typeAlias";
    case SyntaxKind.InterfaceDeclaration:
      return "interface";
    case SyntaxKind.ClassDeclaration:
      return "class";
    case SyntaxKind.ClassExpression:
      return "classExpression";
    case SyntaxKind.EnumDeclaration:
      return "enum";
    case SyntaxKind.EnumMember:
      return "enumMember";
    case SyntaxKind.FunctionDeclaration:
      return "function";
    case SyntaxKind.MethodDeclaration:
      return "method";
    case SyntaxKind.MethodSignature:
      return "methodSignature";
    case SyntaxKind.GetAccessor:
      return "getAccessor";
    case SyntaxKind.SetAccessor:
      return "setAccessor";
    case SyntaxKind.TypeReference:
      return "typeReference";
    case SyntaxKind.TypeQuery:
      return "typeQuery";
    case SyntaxKind.UnionType:
      return "union";
    case SyntaxKind.IntersectionType:
      return "intersection";
    case SyntaxKind.TypeOperator:
      return "typeOperator";
    case SyntaxKind.ArrayType:
      return "array";
    case SyntaxKind.TupleType:
      return "tuple";
    case SyntaxKind.MappedType:
      return "mapped";
    case SyntaxKind.ParenthesizedType:
      return "parenthesized";
    case SyntaxKind.TypeParameter:
      return "typeParameter";
    case SyntaxKind.Parameter:
      return "parameter";
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
      return "property";
    case SyntaxKind.VariableDeclaration:
      return "variable";
    case SyntaxKind.CallExpression:
      return "callExpression";
    case SyntaxKind.IndexSignature:
      return "indexSignature";
    case SyntaxKind.Constructor:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
      return "functionLike";
    default:
      return isTypeNodeKind(kind) ? "type" : "unknown";
  }
}

/**
 * Keyword and expression kinds the compiler's `isTypeNode` admits outside the
 * type-node range. Hand-copied from `isTypeNodeKind` in
 * `typescript/dist/ast/is.js`, which the library does not export;
 * `test/node-kind-table.test.ts` fails when the two drift.
 */
const typeNodeKindsOutsideRange: ReadonlySet<Node["kind"]> = new Set([
  SyntaxKind.AnyKeyword,
  SyntaxKind.UnknownKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.BigIntKeyword,
  SyntaxKind.ObjectKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
  SyntaxKind.VoidKeyword,
  SyntaxKind.UndefinedKeyword,
  SyntaxKind.NeverKeyword,
  SyntaxKind.IntrinsicKeyword,
  SyntaxKind.ExpressionWithTypeArguments,
  SyntaxKind.JSDocAllType,
  SyntaxKind.JSDocNullableType,
  SyntaxKind.JSDocNonNullableType,
  SyntaxKind.JSDocOptionalType,
  SyntaxKind.JSDocVariadicType,
  SyntaxKind.JSDocTypeExpression,
  SyntaxKind.JSDocTypeLiteral,
  SyntaxKind.JSDocSignature,
]);

/** Mirrors the compiler's `isTypeNode`, which is a pure syntax-kind test. */
function isTypeNodeKind(kind: Node["kind"]): boolean {
  return (
    (kind >= SyntaxKind.FirstTypeNode && kind <= SyntaxKind.LastTypeNode) ||
    typeNodeKindsOutsideRange.has(kind)
  );
}

/**
 * Syntax kinds where `isTypeNodeKind` disagrees with the compiler's own
 * `isTypeNode`. Empty for the pinned TypeScript; a non-empty result after an
 * upgrade means `typeNodeKindsOutsideRange` must be re-copied. Lives beside
 * the table because the compiler import may not leave this adapter.
 */
export function typeNodeKindTableDrift(): readonly string[] {
  const drift: string[] = [];
  for (let kind = 0; kind < SyntaxKind.Count; kind += 1) {
    // SAFETY: the compiler's isTypeNode reads only `node.kind`, so a kind-only stub is a faithful probe.
    if (isTypeNodeKind(kind) !== isTypeNode({ kind } as Node)) drift.push(SyntaxKind[kind] ?? String(kind));
  }
  return drift;
}

/** Reads one node's normalized syntax facts, resolving the AST. */
export function nodeFacts(
  session: TsgoFactsSession,
  handle: BackendNodeReference,
  readTypeName: (node: TypeNode) => NonNullable<BackendNodeFacts["typeName"]>,
  originOf: (symbol: BackendSymbolHandle) => BackendSymbolOrigin
): BackendNodeFacts {
  const node = session.node(handle, "nodeFacts");
  const sourceFile = node.getSourceFile();
  const base: BackendNodeFacts = {
    kind: nodeKind(node),
    text: node.getText().replaceAll(/\s+/gu, " ").trim(),
    ...authoredLocation(node, sourceFile),
  };
  const type = sourceNodeType(node);
  const result: BackendNodeFacts =
    type === undefined ? base : { ...base, type: session.typeNodeHandle(type) };
  if (isTypeReferenceNode(node)) {
    return {
      ...result,
      typeName: readTypeName(node),
      children: node.typeArguments?.map((child) => session.typeNodeHandle(child)),
    };
  }
  if (isTypeQueryNode(node)) return { ...result, expressionName: node.exprName.getText() };
  if (isImportTypeNode(node) && node.isTypeOf) {
    return { ...result, expressionName: typeQueryExpressionName(node, sourceFile) };
  }
  if (isUnionTypeNode(node) || isIntersectionTypeNode(node)) {
    return { ...result, children: node.types.map((child) => session.typeNodeHandle(child)) };
  }
  if (isTypeOperatorNode(node)) {
    return {
      ...result,
      operator:
        node.operator === SyntaxKind.KeyOfKeyword
          ? "keyof"
          : node.operator === SyntaxKind.ReadonlyKeyword
            ? "readonly"
            : undefined,
      children: [session.typeNodeHandle(node.type)],
    };
  }
  if (isParenthesizedTypeNode(node)) {
    return { ...result, children: [session.typeNodeHandle(node.type)] };
  }
  if (isArrayTypeNode(node)) return { ...result, children: [session.typeNodeHandle(node.elementType)] };
  if (isTupleTypeNode(node)) {
    return {
      ...result,
      children: node.elements.map((element) => session.typeNodeHandle(unwrapTupleElement(element))),
      restElements: node.elements.map((element) => isRestTupleElement(element)),
    };
  }
  if (isMappedTypeNode(node)) {
    return {
      ...result,
      keyName: node.typeParameter.name.text,
      constraint:
        node.typeParameter.constraint === undefined
          ? undefined
          : session.typeNodeHandle(node.typeParameter.constraint),
      mappedValueType: node.type === undefined ? undefined : session.typeNodeHandle(node.type),
      mappedNameType: node.nameType === undefined ? undefined : session.typeNodeHandle(node.nameType),
      mappedOptional: node.questionToken !== undefined && node.questionToken.kind !== SyntaxKind.MinusToken,
    };
  }
  if (
    isTypeAliasDeclaration(node) ||
    isInterfaceDeclaration(node) ||
    isClassDeclaration(node) ||
    isFunctionLikeDeclaration(node)
  ) {
    return {
      ...result,
      typeParameters: node.typeParameters?.map((parameter) => session.nodeHandle(parameter)),
      parameters: isFunctionLikeDeclaration(node)
        ? node.parameters.map((parameter) => session.nodeHandle(parameter))
        : undefined,
      returnType:
        isFunctionLikeDeclaration(node) && node.type !== undefined
          ? session.typeNodeHandle(node.type)
          : undefined,
      heritageTypes:
        isInterfaceDeclaration(node) || isClassDeclaration(node)
          ? node.heritageClauses?.flatMap((clause) =>
              clause.types.map((typeNode) => session.nodeReference(typeNode))
            )
          : undefined,
      declarationFlags: modifierFlags(node),
      ...definedFields({
        hasImplementationBody:
          session.componentSources && isFunctionLikeDeclaration(node) ? node.body !== undefined : undefined,
      }),
    };
  }
  if (isTypeParameterDeclaration(node)) {
    return {
      ...result,
      name: node.name.text,
      constraint: node.constraint === undefined ? undefined : session.typeNodeHandle(node.constraint),
      defaultType: node.defaultType === undefined ? undefined : session.typeNodeHandle(node.defaultType),
      typeName: { name: node.name.text, namespaces: [], authoredSymbol: session.symbolAt(node.name) },
    };
  }
  if (
    isParameterDeclaration(node) ||
    isPropertyDeclaration(node) ||
    isPropertySignatureDeclaration(node) ||
    isPropertyAssignment(node) ||
    isVariableDeclaration(node)
  ) {
    const bindingDefaults = isParameterDeclaration(node) ? bindingDefaultsFor(node.name) : undefined;
    const propertyFacts: BackendNodeFacts = {
      ...result,
      name: isIdentifier(node.name) ? node.name.text : undefined,
      initializerText: node.initializer?.getText().trim(),
      initializer: node.initializer === undefined ? undefined : session.nodeHandle(node.initializer),
      optional: "questionToken" in node && node.questionToken !== undefined,
      declarationFlags: modifierFlags(node),
      ...definedFields({
        bindingDefaults: bindingDefaults?.authored,
        sourceBindingDefaults: bindingDefaults?.source,
      }),
    };
    return propertyFacts;
  }
  if (isShorthandPropertyAssignment(node)) {
    return {
      ...result,
      name: isIdentifier(node.name) ? node.name.text : undefined,
      ...definedFields({ referencedValueSymbol: referencedValueSymbol(session, node) }),
    };
  }
  if (isCallExpression(node)) return { ...result, ...callExpressionFacts(session, node, originOf) };
  if (isTransparentExpression(node)) {
    return { ...result, innerExpression: session.nodeHandle(node.expression) };
  }
  if (isIdentifier(node) || isPropertyAccessExpression(node) || isImportAlias(node)) {
    return {
      ...result,
      ...definedFields({ referencedValueSymbol: referencedValueSymbol(session, node) }),
    };
  }
  if (isIndexSignatureDeclaration(node)) {
    return {
      ...result,
      keyName:
        node.parameters[0] && isIdentifier(node.parameters[0].name)
          ? node.parameters[0].name.text
          : undefined,
    };
  }
  return result;
}

/** The property key a binding element destructures, when it is an identifier or a literal the checker names the same way. */
function bindingPropertyKey(propertyName: Node): string | undefined {
  if (isIdentifier(propertyName) || isStringLiteral(propertyName) || isNumericLiteral(propertyName)) {
    return propertyName.text;
  }
  return undefined;
}

function bindingElementKey(element: { propertyName?: Node; name?: Node }): string | undefined {
  if (element.propertyName !== undefined) return bindingPropertyKey(element.propertyName);
  if (element.name !== undefined && isIdentifier(element.name)) return element.name.text;
  return undefined;
}

type BindingDefaultFact = {
  readonly name: string;
  readonly initializerText: string;
};

type BindingDefaults = {
  readonly authored: readonly BindingDefaultFact[];
  readonly source: readonly BindingDefaultFact[];
};

/**
 * Reads both binding-default sets in one pass over a parameter's object-binding
 * pattern. Both require an initializer and a resolvable key; `authored` (the
 * semantic model's view) additionally requires an identifier-named element,
 * while `source` (source inspection) accepts any keyed binding element.
 */
function bindingDefaultsFor(name: Node | undefined): BindingDefaults {
  if (name === undefined || !isObjectBindingPattern(name)) return { authored: [], source: [] };
  const authored: BindingDefaultFact[] = [];
  const source: BindingDefaultFact[] = [];
  for (const element of name.elements) {
    if (!isBindingElement(element) || element.initializer === undefined) continue;
    const key = bindingElementKey(element);
    if (key === undefined) continue;
    const fact = { name: key, initializerText: element.initializer.getText().trim() };
    if (element.name !== undefined && isIdentifier(element.name)) authored.push(fact);
    source.push(fact);
  }
  return { authored, source };
}

/**
 * An import binding (`import { F }`, `import F`) declares an alias whose value
 * is the imported declaration, so it references that value the way an
 * identifier does. `export default F` over an import lands the source walk on
 * this declaration.
 */
function isImportAlias(node: Node): node is Node & { readonly name: Node } {
  return isImportSpecifier(node) || (isImportClause(node) && node.name !== undefined);
}

function referencedValueSymbol(session: TsgoFactsSession, node: Node): BackendSymbolHandle | undefined {
  const raw = isShorthandPropertyAssignment(node)
    ? session.checker.getShorthandAssignmentValueSymbol(node)
    : isIdentifier(node) || isPropertyAccessExpression(node)
      ? session.rawSymbolAt(node)
      : isImportAlias(node)
        ? session.rawSymbolAt(node.name)
        : undefined;
  if (raw === undefined) return undefined;
  return session.symbolHandle(aliasedSymbol(session.checker, raw) ?? raw);
}

function isTransparentExpression(node: Node): node is Node & { readonly expression: Node } {
  return (
    isParenthesizedExpression(node) ||
    isAsExpression(node) ||
    isSatisfiesExpression(node) ||
    isNonNullExpression(node) ||
    isTypeAssertion(node)
  );
}

function typeQueryExpressionName(node: Node, sourceFile: ReturnType<Node["getSourceFile"]>): string {
  const text = node.getText(sourceFile);
  const importTokenIndex = text.search(/\bimport\b/u);
  return importTokenIndex === -1 ? text.trimStart() : text.slice(importTokenIndex).trimStart();
}

function isRestTupleElement(element: TypeNode): boolean {
  if (isNamedTupleMember(element)) return element.dotDotDotToken !== undefined;
  return isRestTypeNode(element) || (isOptionalTypeNode(element) && isRestTypeNode(element.type));
}

function unwrapTupleElement(element: TypeNode): TypeNode {
  let current: TypeNode = isNamedTupleMember(element) ? element.type : element;
  while (isOptionalTypeNode(current) || isRestTypeNode(current)) current = current.type;
  return current;
}

function sourceNodeType(node: Node | undefined): TypeNode | undefined {
  if (node === undefined) return undefined;
  if (isTypeNode(node)) return node;
  if (isTypeAliasDeclaration(node)) return node.type;
  if (
    isParameterDeclaration(node) ||
    isPropertyDeclaration(node) ||
    isPropertySignatureDeclaration(node) ||
    isVariableDeclaration(node) ||
    isFunctionLikeDeclaration(node)
  ) {
    return node.type;
  }
  return undefined;
}

function nodeKind(node: Node): BackendNodeFacts["kind"] {
  if (isImportTypeNode(node) && node.isTypeOf) return "typeQuery";
  return nodeKindFromCompilerKind(node.kind);
}

type DeclarationFlag = NonNullable<BackendNodeFacts["declarationFlags"]>[number];

const declarationFlagByModifier: ReadonlyMap<SyntaxKind, DeclarationFlag> = new Map([
  [SyntaxKind.ReadonlyKeyword, "readonly"],
  [SyntaxKind.PrivateKeyword, "private"],
  [SyntaxKind.ProtectedKeyword, "protected"],
  [SyntaxKind.StaticKeyword, "static"],
]);

function modifierFlags(node: Node): readonly DeclarationFlag[] {
  return declarationModifiers(node).flatMap((modifier) => {
    const flag = declarationFlagByModifier.get(modifier.kind);
    return flag === undefined ? [] : [flag];
  });
}
