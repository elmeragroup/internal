import type { ESTree, SourceCode } from "@oxlint/plugins";

/**
 * Function-like nodes whose parameter list and return contract the anti-slop rules inspect. The
 * bare `ESTree.Function` declarations (`FunctionDeclaration`, `FunctionExpression`,
 * `TSDeclareFunction`, `TSEmptyBodyFunctionExpression`) share their shape but are not members of
 * this union.
 */
export type FunctionLikeNode =
	| ESTree.ArrowFunctionExpression
	| ESTree.Function
	| ESTree.TSCallSignatureDeclaration
	| ESTree.TSConstructSignatureDeclaration
	| ESTree.TSConstructorType
	| ESTree.TSFunctionType
	| ESTree.TSMethodSignature;

/**
 * The visitor table for every node shape with a function-like parameter list: the
 * `FunctionLikeNode` members plus the bare function declarations that share their shape.
 *
 * @param check - The check to run for each visited function-like node.
 * @returns One handler per function-like visitor key.
 */
export function functionLikeVisitors(check: (node: FunctionLikeNode) => void) {
	return {
		ArrowFunctionExpression: check,
		FunctionDeclaration: check,
		FunctionExpression: check,
		TSCallSignatureDeclaration: check,
		TSConstructSignatureDeclaration: check,
		TSConstructorType: check,
		TSDeclareFunction: check,
		TSEmptyBodyFunctionExpression: check,
		TSFunctionType: check,
		TSMethodSignature: check,
	};
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

function bindingPattern(parameter: ESTree.ParamPattern): ESTree.BindingPattern {
	if (parameter.type === "TSParameterProperty") return bindingPattern(parameter.parameter);
	if (parameter.type === "RestElement") return bindingPattern(parameter.argument);
	if (parameter.type === "AssignmentPattern") return bindingPattern(parameter.left);
	return parameter;
}

/**
 * Render a parameter's binding name for diagnostics.
 *
 * @param parameter - The parameter pattern to name.
 * @param sourceCode - The rule's source code service.
 * @returns The bound identifier, or the destructuring pattern text without its annotation.
 */
export function parameterName(parameter: ESTree.ParamPattern, sourceCode: SourceCode): string {
	const binding = bindingPattern(parameter);
	if (binding.type === "Identifier") return binding.name;
	const annotation = binding.typeAnnotation;
	if (annotation === null || annotation === undefined) return sourceCode.getText(binding);
	return sourceCode.text.slice(binding.start, annotation.start).trimEnd();
}
