import type { ESTree } from "@oxlint/plugins";

/**
 * Unwrap expression wrappers that do not change the runtime value.
 *
 * @param expression - The expression to unwrap.
 * @returns The innermost expression under parentheses, assertions, and non-null wrappers.
 */
export function unwrapExpression(expression: ESTree.Expression): ESTree.Expression {
	let current = expression;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSAsExpression" ||
		current.type === "TSSatisfiesExpression" ||
		current.type === "TSTypeAssertion" ||
		current.type === "TSNonNullExpression"
	) {
		current = current.expression;
	}
	return current;
}

/**
 * Whether an expression is an empty object literal once transparent wrappers are unwrapped.
 *
 * @param expression - The expression to inspect.
 * @returns True when the expression is `{}` after unwrapping.
 */
export function isEmptyObjectExpression(expression: ESTree.Expression): boolean {
	const unwrapped = unwrapExpression(expression);
	return unwrapped.type === "ObjectExpression" && unwrapped.properties.length === 0;
}
