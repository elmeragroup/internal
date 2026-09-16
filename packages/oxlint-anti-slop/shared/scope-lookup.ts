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

/**
 * Find a parameter's type annotation through parameter properties, rest elements, and defaults.
 *
 * @param parameter - The parameter pattern to inspect.
 * @returns The attached annotation, or null/undefined when the parameter has none.
 */
export function parameterAnnotation(
	parameter: ESTree.ParamPattern,
): ESTree.TSTypeAnnotation | null | undefined {
	if (parameter.type === "TSParameterProperty") {
		return parameterAnnotation(parameter.parameter);
	}
	if (parameter.type === "RestElement") {
		return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
	}
	if (parameter.type === "AssignmentPattern") {
		return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
	}
	return parameter.typeAnnotation;
}

/**
 * Name referenced by a bare type reference, unwrapping parentheses.
 *
 * @param type - The type node to inspect.
 * @returns The referenced name, or null when the type is not an unapplied identifier reference.
 */
export function referencedAliasName(type: ESTree.TSType): string | null {
	if (type.type === "TSParenthesizedType") return referencedAliasName(type.typeAnnotation);
	if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return null;
	return type.typeArguments === null ||
		type.typeArguments === undefined ||
		type.typeArguments.params.length === 0
		? type.typeName.name
		: null;
}
