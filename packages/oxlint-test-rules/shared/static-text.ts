import type { ESTree } from "@oxlint/plugins";

/** Any ESTree node, as far as a literal check reads it. */
type LiteralCandidate = { readonly type: string; readonly value?: unknown };

/**
 * The value of a string literal, or `undefined` for any other node, numbers and regular
 * expressions included.
 *
 * @param node - Any AST node, or `null` for an absent one.
 * @returns The literal's string value, or `undefined`.
 */
export function stringLiteral(node: LiteralCandidate | null): string | undefined {
  if (node?.type !== "Literal") return undefined;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ESTree tags every literal kind `Literal`; the value's type is the only tag a string literal has
  return typeof node.value === "string" ? node.value : undefined;
}

/**
 * The text a string literal or one template chunk holds, or `undefined` for any other node. A
 * class string, a style key and an import source are all spelled in one of these two nodes.
 *
 * @param node - Any AST node.
 * @returns The literal's value, the chunk's cooked text, or `undefined`.
 */
export function staticText(node: ESTree.TemplateElement): string;
export function staticText(node: ESTree.Node): string | undefined;
export function staticText(node: ESTree.Node): string | undefined {
  if (node.type === "TemplateElement") return chunkText(node);
  return stringLiteral(node);
}

/** A template chunk's text: cooked, or raw where it has none. */
function chunkText(chunk: {
  readonly value: { readonly cooked: string | null; readonly raw: string };
}): string {
  return chunk.value.cooked ?? chunk.value.raw;
}

/**
 * The value of an expression that is a string literal or a template literal without
 * substitutions, or `undefined` for anything that can vary.
 *
 * @param node - An expression or a property key.
 * @returns The constant string, or `undefined`.
 */
export function constantString(node: ESTree.Node): string | undefined {
  if (node.type !== "TemplateLiteral") return stringLiteral(node);
  const [only] = node.quasis;
  return node.expressions.length === 0 && only !== undefined ? chunkText(only) : undefined;
}
