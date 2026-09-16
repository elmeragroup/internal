import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { functionLikeVisitors } from "../shared/function-parameters.ts";
import type { FunctionLikeNode } from "../shared/function-parameters.ts";
import { createTypeNameScope, resolvesThroughAliases } from "../shared/type-name-scope.ts";
import type { TypeNameScope } from "../shared/type-name-scope.ts";

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

    const resolvesToUnknown = (type: ESTree.TSType): boolean => {
      if (scope === null) return false;
      return resolvesThroughAliases(scope, type, (candidate) => candidate.type === "TSUnknownKeyword", {
        throughUnions: true,
        throughPromises: true,
      });
    };

    const checkReturnType = (node: FunctionLikeNode) => {
      const annotation = node.returnType;
      if (annotation === null || annotation === undefined) return;
      if (!resolvesToUnknown(annotation.typeAnnotation)) return;
      context.report({ node: annotation.typeAnnotation, messageId: "unknownReturn" });
    };

    return {
      Program(node) {
        scope = createTypeNameScope(node, context.sourceCode.visitorKeys);
      },
      ...functionLikeVisitors(checkReturnType),
    };
  },
});
