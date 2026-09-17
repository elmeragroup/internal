import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { createTypeNameScope, resolvesThroughAliases } from "../shared/type-name-scope.ts";
import type { TypeNameScope } from "../shared/type-name-scope.ts";

/** Ban named aliases that merely conceal TypeScript's unknown top type. */
export const noUnknownTypeAliasesRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow type aliases whose resolved type is unknown; unknown must remain visible at an allowed boundary.",
		},
		messages: {
			unknownAlias:
				"Type alias `{{alias}}` hides `unknown`. Keep `unknown` explicit at the parsing boundary or on an allowed `cause` field; otherwise use the parsed owner type.",
		},
	},
	createOnce(context) {
		let scope: TypeNameScope | null = null;

		const resolvesToUnknown = (
			type: ESTree.TSType,
			visitedAliases: ReadonlySet<ESTree.TSTypeAliasDeclaration>,
		): boolean =>
			scope !== null &&
			resolvesThroughAliases(scope, type, (candidate) => candidate.type === "TSUnknownKeyword", {
				throughUnions: true,
				visitedAliases,
			});

		return {
			Program(node) {
				scope = createTypeNameScope(node, context.sourceCode.visitorKeys);
			},
			TSTypeAliasDeclaration(node) {
				if (!resolvesToUnknown(node.typeAnnotation, new Set([node]))) return;
				context.report({
					node: node.id,
					messageId: "unknownAlias",
					data: { alias: node.id.name },
				});
			},
		};
	},
});
