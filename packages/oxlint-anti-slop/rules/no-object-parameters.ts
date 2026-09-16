import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { functionLikeVisitors, parameterAnnotation, parameterName } from "../shared/function-parameters.ts";
import type { FunctionLikeNode } from "../shared/function-parameters.ts";
import { createTypeNameScope, resolvesThroughAliases } from "../shared/type-name-scope.ts";
import type { TypeNameScope } from "../shared/type-name-scope.ts";

/** Ban the broad object type on function inputs, including local aliases to object. */
export const noObjectParametersRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow object function parameters; inputs must use an owner-provided type and be parsed at their boundary.",
		},
		messages: {
			objectParameter:
				"Parameter `{{parameter}}` uses the broad `object` type. Accept a named owner type; parse external input at its boundary before calling this function.",
		},
	},
	createOnce(context) {
		let scope: TypeNameScope | null = null;

		const resolvesToObject = (type: ESTree.TSType): boolean =>
			scope !== null &&
			resolvesThroughAliases(scope, type, (candidate) => candidate.type === "TSObjectKeyword", {
				throughUnions: true,
			});

		const checkParameters = (node: FunctionLikeNode) => {
			for (const parameter of node.params) {
				const annotation = parameterAnnotation(parameter);
				if (annotation === null || annotation === undefined) continue;
				if (!resolvesToObject(annotation.typeAnnotation)) continue;
				context.report({
					node: annotation.typeAnnotation,
					messageId: "objectParameter",
					data: { parameter: parameterName(parameter, context.sourceCode) },
				});
			}
		};

		return {
			Program(node) {
				scope = createTypeNameScope(node, context.sourceCode.visitorKeys);
			},
			...functionLikeVisitors(checkParameters),
		};
	},
});
