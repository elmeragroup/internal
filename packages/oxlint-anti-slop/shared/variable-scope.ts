import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

/**
 * Resolve the binding an identifier refers to, walking outward through lexical scopes.
 *
 * @param sourceCode - The rule's source code service.
 * @param identifier - The identifier reference to resolve.
 * @returns The bound variable, or null when no scope on the walk declares the name.
 */
export function resolveVariable(
	sourceCode: SourceCode,
	identifier: ESTree.IdentifierReference,
): Variable | null {
	let scope: Scope | null = sourceCode.getScope(identifier);
	while (scope !== null) {
		const variable = scope.set.get(identifier.name);
		if (variable !== undefined) return variable;
		scope = scope.upper;
	}
	return null;
}
