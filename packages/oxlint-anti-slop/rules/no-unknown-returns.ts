import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { createTypeNameScope } from "../shared/type-name-scope.ts";
import type { TypeNameScope } from "../shared/type-name-scope.ts";

type FunctionWithReturnType =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

function referencedAliasName(type: ESTree.TSType): string | null {
  if (type.type === "TSParenthesizedType") return referencedAliasName(type.typeAnnotation);
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return null;
  return type.typeArguments === null ||
    type.typeArguments === undefined ||
    type.typeArguments.params.length === 0
    ? type.typeName.name
    : null;
}

/** Ban function contracts that return unknown instead of a parsed domain type. */
export const noUnknownReturnsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow functions whose explicit return contract is unknown or Promise<unknown>.",
    },
    messages: {
      unknownReturn:
        "This function exposes `unknown` to its caller. Parse the value at its boundary and return a named domain type.",
    },
  },
  createOnce(context) {
    let scope: TypeNameScope | null = null;

    const resolvesToUnknown = (
      type: ESTree.TSType,
      visited = new Set<ESTree.TSTypeAliasDeclaration>(),
    ): boolean => {
      if (scope === null) return false;
      if (type.type === "TSUnknownKeyword") return true;
      if (type.type === "TSParenthesizedType") {
        return resolvesToUnknown(type.typeAnnotation, visited);
      }
      if (type.type === "TSUnionType") {
        return type.types.some((member) => resolvesToUnknown(member, visited));
      }
      if (
        type.type === "TSTypeReference" &&
        type.typeName.type === "Identifier" &&
        (type.typeName.name === "Promise" || type.typeName.name === "PromiseLike") &&
        scope.resolve(type, type.typeName.name) === null
      ) {
        const value = type.typeArguments?.params[0];
        return value !== undefined && resolvesToUnknown(value, visited);
      }
      const name = referencedAliasName(type);
      if (name === null) return false;
      const binding = scope.resolve(type, name);
      if (binding?.kind !== "alias" || visited.has(binding.declaration)) return false;
      const alias = binding.declaration;
      if (alias.typeParameters !== null && alias.typeParameters !== undefined) {
        return false;
      }
      const nextVisited = new Set(visited);
      nextVisited.add(alias);
      return resolvesToUnknown(alias.typeAnnotation, nextVisited);
    };

    const checkReturnType = (node: FunctionWithReturnType) => {
      const annotation = node.returnType;
      if (annotation === null || annotation === undefined) return;
      if (!resolvesToUnknown(annotation.typeAnnotation)) return;
      context.report({ node: annotation.typeAnnotation, messageId: "unknownReturn" });
    };

    return {
      Program(node) {
        scope = createTypeNameScope(node, context.sourceCode.visitorKeys);
      },
      ArrowFunctionExpression: checkReturnType,
      FunctionDeclaration: checkReturnType,
      FunctionExpression: checkReturnType,
      TSCallSignatureDeclaration: checkReturnType,
      TSConstructSignatureDeclaration: checkReturnType,
      TSConstructorType: checkReturnType,
      TSDeclareFunction: checkReturnType,
      TSEmptyBodyFunctionExpression: checkReturnType,
      TSFunctionType: checkReturnType,
      TSMethodSignature: checkReturnType,
    };
  },
});
