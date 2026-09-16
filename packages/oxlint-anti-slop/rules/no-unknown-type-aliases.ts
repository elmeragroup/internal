import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { referencedAliasName } from "../shared/scope-lookup.ts";
import { createTypeNameScope } from "../shared/type-name-scope.ts";
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
			visited = new Set<ESTree.TSTypeAliasDeclaration>(),
		): boolean => {
			if (scope === null) return false;
			if (type.type === "TSUnknownKeyword") return true;
			if (type.type === "TSParenthesizedType") {
				return resolvesToUnknown(type.typeAnnotation, visited);
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
