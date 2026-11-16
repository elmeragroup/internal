import type { Context, ESTree } from "@oxlint/plugins";

import { isFunction } from "./ast-walk.ts";
import { callSitesOf } from "./test-context.ts";
import { pairKey } from "./traversal.ts";
import type { EvidenceKey, StepKey } from "./traversal.ts";
import type { Alt } from "./value.ts";

/**
 * The calls that bind a helper's parameters while `no-source-reading-tests` judges a value the
 * helper produced, such as a list returned through `collectFiles(root, "src", ".ts")`.
 *
 * - A chain holds local calls, the innermost first; each link's `outer` holds the calls outside it.
 * - `key` interns the chain through `pairKey`, so equal chains share one key, and an analysis step
 *   keyed on it never reuses a result judged under another chain.
 * - A chain holds each call once and at most `MAX_CALLS` calls. Entering a call it already holds
 *   (a recursion re-entering itself) or one past the cap gives `NO_CALLS`, so a recursion meets a
 *   chain it has seen and is cut as a cycle, and every chain stays finite.
 * - `contextOf` is the one rule for the chain a value is judged under; `bindingOf` finds the call
 *   that binds a function's parameters in it.
 */

/** A chain of binding calls: none, or a call with the calls outside it. */
export type Calls =
  | { readonly _tag: "none"; readonly key: StepKey }
  | {
      readonly _tag: "call";
      readonly call: ESTree.CallExpression;
      readonly outer: Calls;
      readonly key: StepKey;
      readonly depth: number;
    };

/** The interned key of the empty chain. */
const NO_CALLS_KEY: EvidenceKey = { _tag: "evidence" };

/** No binding call: a parameter is judged at every call site. */
export const NO_CALLS: Calls = { _tag: "none", key: NO_CALLS_KEY };

/** How many calls one chain holds; entering one more gives `NO_CALLS`. */
const MAX_CALLS = 8;

/** Whether a chain already holds a call. */
function holds(calls: Calls, call: ESTree.CallExpression): boolean {
  for (let link = calls; link._tag === "call"; link = link.outer) if (link.call === call) return true;
  return false;
}

/** The chain with a call inside it, or `NO_CALLS` for a call it holds or one past `MAX_CALLS`. */
function enter(calls: Calls, call: ESTree.CallExpression): Calls {
  if (holds(calls, call)) return NO_CALLS;
  const depth = calls._tag === "call" ? calls.depth + 1 : 1;
  if (depth > MAX_CALLS) return NO_CALLS;
  return { _tag: "call", call, outer: calls, key: pairKey(calls.key, call), depth };
}

/** Whether a node sits inside a function that a call invokes. */
function isInsideCallee(context: Context, node: ESTree.Node, call: ESTree.CallExpression): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent)
    if (isFunction(parent) && callSitesOf(context, parent).includes(call)) return true;
  return false;
}

/**
 * The chain a value is judged under, from the chain around the judgement (`calls`) and the calls
 * the value was returned through (its `via`, outermost first):
 *
 * - no `via`: the value was read where it is judged, so it keeps `calls`;
 * - its outermost call sits inside the function the innermost call of `calls` invokes: that call
 *   ran in the same invocation (a wrapped or recursive call), so its calls extend `calls`;
 * - otherwise the value was produced elsewhere (`const saved = make(".json").name` at the top
 *   level), so its own calls alone bind it.
 *
 * @param context - The rule context.
 * @param value - The value.
 * @param calls - The chain around the judgement.
 * @returns The chain to judge the value under.
 */
export function contextOf(context: Context, value: Pick<Alt, "via">, calls: Calls): Calls {
  const [producer] = value.via;
  if (producer === undefined) return calls;
  const base = calls._tag === "call" && isInsideCallee(context, producer, calls.call) ? calls : NO_CALLS;
  return value.via.reduce(enter, base);
}

/**
 * The nearest call in a chain that invokes a function, with the calls outside it.
 *
 * @param context - The rule context.
 * @param fn - The function whose parameters are bound.
 * @param calls - The chain.
 * @returns The binding call and its outer chain, or `undefined` when no call in the chain invokes it.
 */
export function bindingOf(
  context: Context,
  fn: ESTree.Node,
  calls: Calls
): { readonly call: ESTree.CallExpression; readonly outer: Calls } | undefined {
  const sites = callSitesOf(context, fn);
  for (let link = calls; link._tag === "call"; link = link.outer)
    if (sites.includes(link.call)) return { call: link.call, outer: link.outer };
  return undefined;
}
