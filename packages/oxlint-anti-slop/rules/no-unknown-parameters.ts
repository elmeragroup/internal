import { defineRule } from "@oxlint/plugins";

import {
  functionLikeVisitors,
  parameterAnnotation,
  parameterName,
  returnedTypePredicate,
} from "../shared/function-parameters.ts";
import type { FunctionLikeNode } from "../shared/function-parameters.ts";

/** The parameter a type predicate or assertion narrows, `this` included, or null without one. */
function narrowedParameterName(node: FunctionLikeNode): string | null {
  const predicate = returnedTypePredicate(node);
  if (predicate === null) return null;
  return predicate.parameterName.type === "TSThisType" ? "this" : predicate.parameterName.name;
}

/** Disallow unknown inputs except explicitly named error-cause enrichment. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters except `cause`; decode unknown input at its I/O boundary instead.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowInTypeGuards: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allowInTypeGuards: false }],
  },
  createOnce(context) {
    const checkParameters = (node: FunctionLikeNode) => {
      const option = context.options?.[0];
      const allowInTypeGuards =
        typeof option === "object" &&
        option !== null &&
        !Array.isArray(option) &&
        option.allowInTypeGuards === true;
      const narrowed = allowInTypeGuards ? narrowedParameterName(node) : null;
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation?.typeAnnotation.type !== "TSUnknownKeyword") continue;
        const name = parameterName(parameter, context.sourceCode);
        if (name === "cause" || name === narrowed) continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: name },
        });
      }
    };

    return functionLikeVisitors(checkParameters);
  },
});
