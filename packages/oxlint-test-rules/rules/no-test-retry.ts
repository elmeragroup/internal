import type { Context, ESTree, Rule } from "@oxlint/plugins";

import { propertyKeyName } from "../shared/ast-names.ts";
import { isFunction, unwrap } from "../shared/ast-walk.ts";
import { anyViolates, firstViolation } from "../shared/quantify.ts";
import { calleeApis, evaluate } from "../shared/resolve.ts";
import { isTestFile } from "../shared/source-file.ts";
import { callSitesOf, runnerRoots } from "../shared/test-context.ts";
import { Analysis } from "../shared/traversal.ts";
import { entryFor, mayTakeDefault } from "../shared/value.ts";
import type { Alt } from "../shared/value.ts";

/** The option keys that rerun a test: Vitest's `retry` and `repeats`, Playwright's `retries`. */
const RERUN_KEYS = ["retry", "repeats", "retries"] as const;

/** The test API roots whose options a rerun key configures. */
const RUNNERS = new Set(["it", "test", "describe", "suite", "bench"]);

/** Whether a call takes test or suite options: a test API call or `vi.setConfig`. */
function takesRunnerOptions(context: Context, call: ESTree.CallExpression): boolean {
  return (
    calleeApis(context, call.callee).includes("vi.setConfig") ||
    runnerRoots(context, call.callee).some((root) => root !== undefined && RUNNERS.has(root))
  );
}

/**
 * Whether each rerun value expression may rerun, as one analysis on the bounded traversal: a
 * parameter followed back into its call sites, or a walk past the budget, is no evidence.
 */
const RERUNS = new Analysis<boolean>(false);

/** Whether any alternative of a rerun value expression reruns. */
function rerunsIn(context: Context, node: ESTree.Node): boolean {
  const expression = unwrap(node);
  return RERUNS.run(
    context,
    expression,
    () => anyViolates(evaluate(context, expression), (alternative) => reruns(context, alternative)),
    () => false
  );
}

/**
 * Whether one rerun value alternative reruns: anything but `0`, `false`, `undefined` or `null`
 * (Vitest's default of no reruns). A parameter reruns when any call site passes a value that does
 * (or its default, where a call passes none); one no call site sets, or one a spread may set, is
 * no evidence. A loop binding or a value the evaluator cannot know (`unknown`) is no evidence.
 */
function reruns(context: Context, alternative: Alt): boolean {
  switch (alternative.kind) {
    case "unknown":
    case "loop":
    case "undefined":
    case "null":
      return false;
    case "number":
      return alternative.value !== 0;
    case "boolean":
      return alternative.value;
    case "parameter": {
      const { fn, index } = alternative;
      const param = isFunction(fn) ? fn.params[index] : undefined;
      const fallback = param?.type === "AssignmentPattern" ? param.right : undefined;
      return callSitesOf(context, fn).some((site) => {
        if (site.arguments.slice(0, index + 1).some((argument) => argument.type === "SpreadElement"))
          return false;
        const argument = site.arguments[index];
        if (argument === undefined) return fallback !== undefined && rerunsIn(context, fallback);
        return (
          rerunsIn(context, argument) ||
          (fallback !== undefined && withDefaultReruns(context, argument, fallback))
        );
      });
    }
    default:
      return true;
  }
}

/** Whether an argument that may be `undefined` takes a default that reruns. */
function withDefaultReruns(context: Context, argument: ESTree.Node, fallback: ESTree.Node): boolean {
  return evaluate(context, argument).some(mayTakeDefault) && rerunsIn(context, fallback);
}

/**
 * No test reruns: no `retry`, `repeats` or `retries` option reaches a test, a suite or
 * `vi.setConfig`, and none appears anywhere in a Vitest or Playwright config. A rerun turns a red
 * test green without a fix, so a test that flakes is made deterministic or deleted in the same
 * change. A value that is `0`, `false`, `undefined` or `null` in every alternative reruns nothing
 * and stays allowed, and so does a value the evaluator cannot know (`unknown`, such as a
 * reassigned binding), which is no evidence of a rerun. A helper's parameter is judged at every
 * call site of the helper: it reruns when any call passes a rerun (or leaves a rerunning default).
 *
 * Scope: follows what `resolve.ts` follows, for the test API (named, aliased or namespace import,
 * through `.each` and modifiers) and for the options object (bindings, spreads with last-wins
 * precedence, and a local function's returned object). Beyond that: a `--retry` flag in a
 * `package.json` script or CI workflow is outside what an AST rule sees.
 */
export const noTestRetry: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Forbid retry and repeat options on tests, suites and test configs." },
    messages: {
      rerun:
        "`{{key}}` reruns a test until it passes, which hides a flake instead of fixing it. Make the test deterministic or delete it.",
    },
    schema: [],
  },
  create(context) {
    const reported = new Set<ESTree.Node>();

    /** The rerun key a property sets to rerun: a rerun key any alternative of whose value reruns. */
    const rerunKeyOf = (property: ESTree.ObjectProperty): string | undefined => {
      const key = propertyKeyName(property);
      if (key === undefined || !RERUN_KEYS.some((rerun) => rerun === key)) return undefined;
      return rerunsIn(context, property.value) ? key : undefined;
    };

    const check = (property: ESTree.ObjectProperty): void => {
      const key = rerunKeyOf(property);
      if (key === undefined || reported.has(property)) return;
      reported.add(property);
      context.report({ node: property.key, messageId: "rerun", data: { key } });
    };
    if (!isTestFile(context.filename)) return { Property: check };
    return {
      CallExpression(node) {
        if (!takesRunnerOptions(context, node)) return;
        for (const argument of node.arguments) {
          const options = evaluate(context, argument);
          // Any alternative that sets a rerun key reruns; the report sits on the first one's setting.
          for (const key of RERUN_KEYS) {
            const setting = firstViolation(options, (alternative) => {
              const entry = entryFor(alternative, key);
              if (entry === undefined || entry === "unknown") return undefined;
              return rerunsIn(context, entry.value) ? entry.property : undefined;
            });
            if (setting !== undefined) check(setting);
          }
        }
      },
    };
  },
};
