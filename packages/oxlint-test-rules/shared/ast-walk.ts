import type { Context, ESTree } from "@oxlint/plugins";

/**
 * The expression under the wrappers that do not change its value: parentheses, `await`, optional
 * chains and TypeScript's assertions.
 *
 * @param node - Any AST node.
 * @returns The innermost wrapped node.
 */
export function unwrap(node: ESTree.Node): ESTree.Node {
  switch (node.type) {
    case "AwaitExpression":
      return unwrap(node.argument);
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TSTypeAssertion":
    case "ChainExpression":
      return unwrap(node.expression);
    default:
      return node;
  }
}

/**
 * Whether a node is a function boundary.
 *
 * @param node - Any AST node.
 * @returns Whether it is an arrow, a function expression or a function declaration.
 */
export function isFunction(node: ESTree.Node): node is ESTree.Function | ESTree.ArrowFunctionExpression {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}

/**
 * Whether `node` lies inside `root`.
 *
 * @param node - Any AST node.
 * @param root - The possible ancestor.
 * @returns Whether `root` is `node` or one of its ancestors.
 */
export function within(node: ESTree.Node, root: ESTree.Node): boolean {
  for (let current: ESTree.Node | null = node; current !== null; current = current.parent) {
    if (current === root) return true;
  }
  return false;
}

/**
 * The binding that names a function: a declaration's own name, or the variable it is assigned to.
 *
 * @param fn - A function node.
 * @returns The naming identifier, or `undefined` for an anonymous callback.
 */
export function functionNameOf(fn: ESTree.Node): ESTree.Node | undefined {
  if (fn.type === "FunctionDeclaration") return fn.id ?? undefined;
  const holder = fn.parent;
  return holder?.type === "VariableDeclarator" ? holder.id : undefined;
}

/** Whether a value is an AST node, judged by the parser's own visitor keys. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this guard is the parse step: a node's child slots come back from their property descriptors untyped
function isNode(value: unknown, keys: Readonly<Record<string, readonly string[]>>): value is ESTree.Node {
  return value instanceof Object && "type" in value && Object.hasOwn(keys, String(value.type));
}

/** A node's child nodes, in visitor-key order. */
function childrenOf(context: Context, node: ESTree.Node): ESTree.Node[] {
  const keys = context.sourceCode.visitorKeys;
  const children: ESTree.Node[] = [];
  for (const key of keys[node.type] ?? []) {
    const value: unknown = Object.getOwnPropertyDescriptor(node, key)?.value;
    const values: unknown[] = Array.isArray(value) ? value : [value];
    for (const item of values) if (isNode(item, keys)) children.push(item);
  }
  return children;
}

/**
 * Every node under a root, the root included, in source order.
 *
 * @param context - The rule context.
 * @param root - The subtree's root.
 * @param reach - Whether to descend into nested functions or stay in the root's own function.
 * @returns The nodes, depth first.
 */
export function descendants(
  context: Context,
  root: ESTree.Node,
  reach: "into-functions" | "this-function"
): ESTree.Node[] {
  const found: ESTree.Node[] = [];
  const stack = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    found.push(node);
    if (node !== root && reach === "this-function" && isFunction(node)) continue;
    stack.push(...childrenOf(context, node).reverse());
  }
  return found;
}

/**
 * Whether a function is a `new Promise` executor or a callback created inside one, which run in
 * the turn the promise is created rather than later.
 *
 * @param fn - A function node.
 * @returns Whether it runs as part of a `new Promise(…)` expression.
 */
export function isPromiseCallback(fn: ESTree.Node): boolean {
  for (let parent = fn.parent; parent !== null; parent = parent.parent) {
    if (parent.type === "NewExpression") {
      const callee = unwrap(parent.callee);
      if (callee.type === "Identifier" && callee.name === "Promise") return true;
    }
    if (isFunction(parent)) return isPromiseCallback(parent);
  }
  return false;
}
