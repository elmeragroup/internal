import type { Context, ESTree } from "@oxlint/plugins";

import { memberName } from "./ast-names.ts";
import { descendants, unwrap } from "./ast-walk.ts";
import { isolated } from "./traversal.ts";
import type { Alt } from "./value.ts";

/**
 * The mutation index: every place a file changes an object or array literal in place, by that
 * literal. `resolve.ts` reads it for step 2 of its contract; a rule reads a literal's pushes
 * through `mutationsOf` there.
 */

/** The methods that change an array or object in place. */
const MUTATORS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "set",
  "delete",
  "clear",
  "add",
]);

/**
 * A place the code changes an object or array in place, at `site` (the assignment, update,
 * `delete` or call that makes the change): a `push`, which appends its arguments, or an `other`
 * change to what the value holds, which is not followed.
 */
export type Mutation =
  | { readonly kind: "other"; readonly site: ESTree.Node }
  | {
      readonly kind: "push";
      readonly site: ESTree.Node;
      /** The values it appends as written arguments, in order. */
      readonly values: ReadonlyArray<ESTree.Node>;
      /** The lists it spreads into its arguments (`push(...xs)`), each appending what it holds. */
      readonly spreads: ReadonlyArray<ESTree.Node>;
    };

/** Each file's mutations, by the literal they change. */
const INDEXES = new WeakMap<ESTree.Node, ReadonlyMap<ESTree.Node, ReadonlyArray<Mutation>>>();

/** A mutation's site and the expression whose value it changes, for one node of the file. */
function mutationAt(
  node: ESTree.Node
): { readonly target: ESTree.Node; readonly mutation: Mutation } | undefined {
  const memberTarget = (member: ESTree.Node): ESTree.Node | undefined => {
    const expression = unwrap(member);
    return expression.type === "MemberExpression" ? expression.object : undefined;
  };
  const other = (target: ESTree.Node | undefined) =>
    target === undefined ? undefined : { target, mutation: { kind: "other" as const, site: node } };
  switch (node.type) {
    case "AssignmentExpression":
      return other(memberTarget(node.left));
    case "UpdateExpression":
      return other(memberTarget(node.argument));
    case "UnaryExpression":
      return node.operator === "delete" ? other(memberTarget(node.argument)) : undefined;
    case "CallExpression": {
      const callee = unwrap(node.callee);
      const method = memberName(callee);
      if (callee.type !== "MemberExpression" || method === undefined || !MUTATORS.has(method))
        return undefined;
      if (method !== "push") return other(callee.object);
      const values: ESTree.Node[] = [];
      const spreads: ESTree.Node[] = [];
      for (const argument of node.arguments)
        if (argument.type === "SpreadElement") spreads.push(argument.argument);
        else values.push(argument);
      return { target: callee.object, mutation: { kind: "push", site: node, values, spreads } };
    }
    default:
      return undefined;
  }
}

/**
 * Every place the file changes an object or array literal in place, by that literal: an assigned,
 * updated or deleted member, a mutating method such as `push`, through the literal's own binding
 * or any value `readAsWritten` resolves to it. A change through a value it does not resolve to a
 * literal, such as a parameter, is not followed. Built once per file, isolated from any walk.
 *
 * @param context - The rule context.
 * @param literal - An object or array literal.
 * @param readAsWritten - The evaluator reading literals as written, without this index.
 * @returns Its mutations, in source order.
 */
export function mutationsIn(
  context: Context,
  literal: ESTree.Node,
  readAsWritten: (node: ESTree.Node) => ReadonlyArray<Alt>
): ReadonlyArray<Mutation> {
  const program = context.sourceCode.ast;
  const known = INDEXES.get(program);
  if (known !== undefined) return known.get(literal) ?? [];
  const index = isolated(() => {
    const built = new Map<ESTree.Node, Mutation[]>();
    for (const node of descendants(context, program, "into-functions")) {
      const found = mutationAt(node);
      if (found === undefined) continue;
      for (const value of readAsWritten(found.target)) {
        if (value.kind !== "object" && value.kind !== "array") continue;
        built.set(value.node, [...(built.get(value.node) ?? []), found.mutation]);
      }
    }
    return built;
  });
  INDEXES.set(program, index);
  return index.get(literal) ?? [];
}
