import type { Context, ESTree, Rule } from "@oxlint/plugins";

import { descendants, isFunction, isPromiseCallback, unwrap, within } from "../shared/ast-walk.ts";
import { captureAway, FAKE_CLOCK_HELPERS_SCHEMA, isSimulated } from "../shared/fake-clock.ts";
import type { ClockCapture, FakeClockHelper } from "../shared/fake-clock.ts";
import { anyViolates } from "../shared/quantify.ts";
import { calleeApis, evaluate } from "../shared/resolve.ts";
import { ruleOptions } from "../shared/rule-options.ts";
import { isolated } from "../shared/traversal.ts";
import { targetOf, UNDEFINED, withDefault } from "../shared/value.ts";
import type { Alt, CalleeTarget } from "../shared/value.ts";

/** The modules that export the callback timers, which a fake clock does not patch once imported. */
const TIMER_MODULES = new Set(["node:timers", "timers"]);

/** The promise timer modules, whose `setTimeout(ms)` and `scheduler.wait(ms)` take the delay first. */
const PROMISE_TIMER_MODULES = new Set(["node:timers/promises", "timers/promises"]);

/** The promise timers, by their name off the module. */
const PROMISE_TIMERS = new Set(["setTimeout", "scheduler.wait"]);

/** The rule's options: the repository's own wait and fake-clock helpers. */
type Options = {
  /**
   * The helpers whose first argument is how long to wait on the global timers, wherever they come
   * from. A fake clock faking `setTimeout` takes them over. Default: `sleep` and `delay`.
   */
  readonly waitHelpers: ReadonlyArray<string>;
  /**
   * The helpers whose first argument is how long to wait for real under any fake timers, such as a
   * `wait(ms)` that spins on animation frames and `performance.now()`. Default: none.
   */
  readonly realWaitHelpers: ReadonlyArray<string>;
  /** The repository's fake-clock helpers and the APIs each fakes. Default: none. */
  readonly fakeClockHelpers: ReadonlyArray<FakeClockHelper>;
};

/** The Playwright page method that waits a fixed time. */
const PAGE_WAIT = "waitForTimeout";

/** The test entries that run an Effect on the live clock, where `Effect.sleep` really waits. */
const LIVE_TESTS = /(?:^|\.)(?:live|scopedLive)$/u;

/** The assignment operators that step a counter. */
const STEPS = new Set(["+=", "-="]);

/**
 * A delayed call: every value its delay may be, `undefined` for one that waits no delay, and
 * whether a fake clock can take it over. A global callback timer and a `sleep`-style helper run on
 * the global timers, which a fake clock faking `setTimeout` takes over; every other wait is real.
 */
type Wait = {
  readonly delay: ReadonlyArray<Alt> | undefined;
  readonly fakeable: boolean;
  /**
   * Where the timer read the global a fake clock replaces, when that is not the call itself
   * (`captureAway`): the wait is judged there, since the alias keeps whatever the slot held.
   */
  readonly capture: ClockCapture | undefined;
};

/**
 * A wait a local function hands a parameter to when it runs: the function that owns the parameter
 * (the function itself, or one it is nested in, whose call built it as a closure), the parameter's
 * index, and whether the wait is fakeable.
 */
type Forward = {
  readonly owner: ESTree.Node;
  readonly index: number;
  readonly fakeable: boolean;
  /** Where the timer read its global outside the forwarding function, if it did. */
  readonly capture: ClockCapture | undefined;
};

/** Whether a function is a `new Promise` executor, which runs as soon as the promise is created. */
function isExecutor(fn: ESTree.Node): boolean {
  const parent = fn.parent;
  if (parent?.type !== "NewExpression" || parent.arguments[0] !== fn) return false;
  const callee = unwrap(parent.callee);
  return callee.type === "Identifier" && callee.name === "Promise";
}

/**
 * Each file's forwarded parameters, by the wait helpers the options name, then by local function:
 * the least fixpoint over every function in the file, so the result does not depend on which
 * helper a rule reaches first.
 */
const FORWARDS = new WeakMap<ESTree.Node, Map<string, ReadonlyMap<ESTree.Node, ReadonlyArray<Forward>>>>();

/**
 * Whether one delay alternative is evidence of a wait that is not zero: a positive number, a
 * string that converts to one or names a duration with a non-zero digit (`"1 second"`), `true`
 * (1 ms), or a value the evaluator holds by name only, such as an imported constant or a
 * `Duration.millis(200)` call. A parameter is answered for at its call sites; `0`, a negative or
 * `NaN` delay, `null`, `undefined` and `false` wait no time; a value the evaluator cannot know
 * (`unknown`) is no evidence.
 */
function isNonZeroDelay(alternative: Alt): boolean {
  switch (alternative.kind) {
    case "number":
      return alternative.value > 0;
    case "string": {
      const text = alternative.value.trim();
      const value = Number(text);
      return text !== "" && !Number.isNaN(value) ? value > 0 : /[1-9]/u.test(text);
    }
    case "boolean":
      return alternative.value;
    case "null":
    case "undefined":
    case "parameter":
    case "unknown":
      return false;
    default:
      return true;
  }
}

/** The names a loop steps as counters: `i++`, `--i`, `i += 1`, `i -= 1`, anywhere in the loop. */
function countersOf(context: Context, loop: ESTree.Node): ReadonlySet<string> {
  const counters = new Set<string>();
  for (const node of descendants(context, loop, "this-function")) {
    const target =
      node.type === "UpdateExpression"
        ? node.argument
        : node.type === "AssignmentExpression" && STEPS.has(node.operator)
          ? node.left
          : undefined;
    if (target?.type === "Identifier") counters.add(target.name);
  }
  return counters;
}

/** Whether an expression mentions a stepped counter. */
function mentionsCounter(context: Context, node: ESTree.Node, counters: ReadonlySet<string>): boolean {
  return descendants(context, node, "this-function").some(
    (inner) => inner.type === "UpdateExpression" || (inner.type === "Identifier" && counters.has(inner.name))
  );
}

/**
 * Whether a loop or `if` test checks a condition other than a counter. A counter test steps or
 * compares a stepped counter (`i++ < 3`, `i--`, `attempt < MAX`); a condition reads state
 * (`!done`, `status !== "ready"`, `alive(pid)`); `true` checks nothing.
 */
function checksCondition(context: Context, test: ESTree.Node | null, counters: ReadonlySet<string>): boolean {
  if (test === null) return false;
  const expression = unwrap(test);
  switch (expression.type) {
    case "Literal":
      return false;
    case "LogicalExpression":
      return (
        checksCondition(context, expression.left, counters) ||
        checksCondition(context, expression.right, counters)
      );
    case "UpdateExpression":
      return false;
    case "Identifier":
      return !counters.has(expression.name);
    case "BinaryExpression":
      return !mentionsCounter(context, expression, counters);
    default:
      return true;
  }
}

/** Whether a loop body leaves early on a checked condition: a `break` or `return` under such an `if`. */
function exitsOnCondition(
  context: Context,
  loop: ESTree.Node,
  body: ESTree.Node,
  counters: ReadonlySet<string>
): boolean {
  return descendants(context, body, "this-function").some((node) => {
    if (node.type !== "ReturnStatement" && !(node.type === "BreakStatement" && node.label === null))
      return false;
    for (
      let parent: ESTree.Node | null = node.parent;
      parent !== null && parent !== loop;
      parent = parent.parent
    ) {
      if (parent.type === "IfStatement" && checksCondition(context, parent.test, counters)) return true;
    }
    return false;
  });
}

/**
 * Whether a node runs inside a polling loop: one whose test checks a condition other than a counter,
 * or one that leaves early on such a check. A counted loop or a loop over items is not a poll. A
 * `new Promise` executor between the node and the loop runs in the same turn, so it does not end
 * the search.
 */
function isInPollingLoop(context: Context, node: ESTree.Node): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    switch (parent.type) {
      case "WhileStatement":
      case "DoWhileStatement":
      case "ForStatement": {
        const counters = countersOf(context, parent);
        return (
          checksCondition(context, parent.test, counters) ||
          exitsOnCondition(context, parent, parent.body, counters)
        );
      }
      case "ForOfStatement":
      case "ForInStatement":
        return exitsOnCondition(context, parent, parent.body, countersOf(context, parent));
      default:
        if (isFunction(parent) && !isPromiseCallback(parent)) return false;
    }
  }
  return false;
}

/**
 * No fixed delays: no global `setTimeout`, timer imported from `node:timers`, promise timer from
 * `node:timers/promises`, `sleep`, `delay`, `wait`, `page.waitForTimeout` or live `Effect.sleep`
 * waits a delay that is not zero. A fixed delay guesses how long the machine takes, so it flakes
 * under load and slows every run. A wait wrapped in a local helper is the wait its callers ask
 * for: a delay that is the helper's parameter, passed on unchanged through any chain of helpers, is
 * judged and reported at each call that sets it (its argument, or else the parameter's default),
 * never at the timer, so a disable names the one wait it allows. A delay a helper writes itself is
 * reported at the timer that writes it. A delay reports only on evidence of a non-zero wait: a
 * positive number, a duration string, or a value held by name only (an imported constant,
 * `Duration.millis(200)`). Allowed: a delay of 0, `undefined` (a timer with no delay), `null`, a
 * negative or `NaN` number (one turn), a parameter no call sets, or a value the evaluator cannot
 * know (a reassigned binding); a wait inside a polling loop, whose test or early exit checks state
 * rather than a stepped counter; `Effect.sleep` on the test clock; and a global `setTimeout` or
 * `sleep`-style helper that a simulated clock faking `setTimeout` covers, as `fake-clock.ts` models
 * one, at the call that sets the delay: in the test, in a setup hook after the hook's own install,
 * or in a helper or component that only covered tests call or render, however the call reaches it
 * (an alias, an object property, a destructured binding). A timer read through an alias is judged
 * where the alias read the global (`const later = setTimeout` at module scope stays real). A
 * callee that may be a timer waits when any alternative does.
 *
 * Options: `waitHelpers` names the helpers that wait on the global timers (default `sleep` and
 * `delay`), `realWaitHelpers` the helpers that wait for real under any fake timers (default none;
 * a helper in both lists waits for real), and `fakeClockHelpers` the repository's own fake-clock
 * installers (default none). A helper's forwarded delays are a least fixpoint over the file's
 * functions, so mutually recursive helpers forward the same delays whichever is reached first. A
 * helper forwards only through the code it runs when called (its body and any `new Promise`
 * executor in it); a closure it returns waits where the closure is called, with the delay the call
 * that built it passed, so building one (`const later = makeLater(100)`) waits nothing.
 *
 * Scope: follows what `resolve.ts` follows, for the timer and for the delay. Beyond that: an
 * imported wait helper the options do not name is not recognised; a local helper is a wait only
 * through a recognised wait it hands its parameter to, so one that waits another way (spinning on
 * `performance.now()`) is not; imported and promise timers, `wait` and `page.waitForTimeout` count
 * as real waits under any fake clock, since Vitest's fake timers patch only the globals; and a test
 * registered through a local wrapper that forwards its body to `it`, and a timer in a class method
 * (`new C().m()`), are judged without their test, so that test's fake clock does not cover them.
 */
export const noFixedDelay: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Forbid fixed-duration waits in tests." },
    messages: {
      delay:
        "A fixed delay guesses how long the machine takes, so it flakes under load. Wait on the condition (expect.poll, vi.waitFor, a Deferred) or drive a fake clock.",
    },
    schema: [
      {
        type: "object",
        properties: {
          waitHelpers: { type: "array", items: { type: "string" } },
          realWaitHelpers: { type: "array", items: { type: "string" } },
          fakeClockHelpers: FAKE_CLOCK_HELPERS_SCHEMA,
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ waitHelpers: ["sleep", "delay"], realWaitHelpers: [], fakeClockHelpers: [] }],
  },
  create(context) {
    const { waitHelpers, realWaitHelpers, fakeClockHelpers } = ruleOptions<Options>(context);

    /** Whether a lone first argument is a delay: a number in any alternative. */
    const isDelay = (argument: ESTree.Node): boolean =>
      evaluate(context, argument).some((alternative) => alternative.kind === "number");

    /** Whether a call runs inside an `it.live`-style test, whose Effects read the real clock. */
    const onLiveClock = (node: ESTree.Node): boolean => {
      for (let parent = node.parent; parent !== null; parent = parent.parent) {
        if (parent.type !== "CallExpression") continue;
        if (calleeApis(context, parent.callee).some((name) => name !== undefined && LIVE_TESTS.test(name)))
          return true;
      }
      return false;
    };

    /** Every value an argument may be, or `undefined` for a missing one. */
    const valuesOf = (argument: ESTree.Node | undefined): ReadonlyArray<Alt> | undefined =>
      argument === undefined ? undefined : evaluate(context, argument);

    /** A callback timer's wait: its second argument, or a lone numeric first argument. */
    const callbackWait = (
      call: ESTree.CallExpression,
      fakeable: boolean,
      capture: ClockCapture | undefined
    ): Wait => {
      const [first, second] = call.arguments;
      if (second !== undefined) return { delay: valuesOf(second), fakeable, capture };
      return {
        delay: first !== undefined && isDelay(first) ? valuesOf(first) : undefined,
        fakeable,
        capture,
      };
    };

    /** The wait one target makes, or `undefined` for a target that waits on no clock. */
    const waitOf = (call: ESTree.CallExpression, target: CalleeTarget, callee: Alt): Wait | undefined => {
      const name = target.path.join(".");
      const first = valuesOf(call.arguments[0]);
      if (target.module !== undefined && PROMISE_TIMER_MODULES.has(target.module)) {
        return PROMISE_TIMERS.has(name) ? { delay: first, fakeable: false, capture: undefined } : undefined;
      }
      if (target.module !== undefined && TIMER_MODULES.has(target.module)) {
        return name === "setTimeout" ? callbackWait(call, false, undefined) : undefined;
      }
      if (target.module === undefined && name === "setTimeout")
        return callbackWait(call, true, captureAway(callee, "setTimeout", call));
      if (target.path.length === 2 && target.path[1] === PAGE_WAIT)
        return { delay: first, fakeable: false, capture: undefined };
      // A helper named as a real wait waits for real, whether or not it is also a wait helper.
      if (target.path.length === 1 && realWaitHelpers.includes(name))
        return { delay: first, fakeable: false, capture: undefined };
      if (target.path.length === 1 && waitHelpers.includes(name))
        return { delay: first, fakeable: true, capture: undefined };
      if (name === "Effect.sleep" && onLiveClock(call))
        return { delay: first, fakeable: false, capture: undefined };
      return undefined;
    };

    /**
     * Every value a call sets a parameter to: its argument, missing or not, with the parameter's
     * default applied where it is `undefined`, as `withDefault` applies a destructuring default.
     */
    const argumentFor = (call: ESTree.CallExpression, fn: ESTree.Node, index: number): ReadonlyArray<Alt> => {
      const argument = valuesOf(call.arguments[index]) ?? [UNDEFINED];
      const param = isFunction(fn) ? fn.params[index] : undefined;
      if (param?.type !== "AssignmentPattern") return argument;
      return withDefault(argument, () => evaluate(context, param.right));
    };

    /**
     * The waits one call makes, given each local function's forwards: each callee alternative's
     * own wait, or, for a local function, the waits its body hands its parameters to, with the
     * delays this call sets them to.
     */
    const waitsWith = (
      call: ESTree.CallExpression,
      forwards: ReadonlyMap<ESTree.Node, ReadonlyArray<Forward>>
    ): Wait[] =>
      evaluate(context, call.callee).flatMap((callee): Wait[] => {
        if (callee.kind === "function") {
          return (forwards.get(callee.fn) ?? []).flatMap(({ owner, index, fakeable, capture }): Wait[] => {
            if (owner === callee.fn) return [{ delay: argumentFor(call, owner, index), fakeable, capture }];
            // A closure's captured parameter is the argument of the call that built it, when the
            // closure came out of that call (`const later = makeLater(100); later()`).
            const builder = callee.via.at(-1);
            if (
              builder === undefined ||
              !evaluate(context, builder.callee).some(
                (built) => built.kind === "function" && built.fn === owner
              )
            )
              return [];
            return [{ delay: argumentFor(builder, owner, index), fakeable, capture }];
          });
        }
        const target = targetOf(callee);
        const wait = target === undefined ? undefined : waitOf(call, target, callee);
        return wait === undefined ? [] : [wait];
      });

    /**
     * The parameters each local function hands unchanged to a wait outside a polling loop, through
     * any chain of local helpers, recursive ones included: the least fixpoint, grown from no
     * forwards until no function's list changes, computed once per file and option set.
     */
    const forwardsTable = (): ReadonlyMap<ESTree.Node, ReadonlyArray<Forward>> => {
      const program = context.sourceCode.ast;
      const byOptions =
        FORWARDS.get(program) ?? new Map<string, ReadonlyMap<ESTree.Node, ReadonlyArray<Forward>>>();
      FORWARDS.set(program, byOptions);
      const key = JSON.stringify([waitHelpers, realWaitHelpers]);
      const cached = byOptions.get(key);
      if (cached !== undefined) return cached;
      const table = isolated(() => fixpoint(program));
      byOptions.set(key, table);
      return table;
    };

    /** The least fixpoint of every function's forwards in a file. */
    const fixpoint = (program: ESTree.Node): ReadonlyMap<ESTree.Node, ReadonlyArray<Forward>> => {
      const functions = descendants(context, program, "into-functions").filter(isFunction);
      const calls = new Map(functions.map((fn) => [fn, executedCalls(fn)]));
      const table = new Map<ESTree.Node, ReadonlyArray<Forward>>();
      for (let changed = true; changed;) {
        changed = false;
        for (const fn of functions) {
          const found = new Map<string, Forward>();
          for (const call of calls.get(fn) ?? []) {
            for (const wait of waitsWith(call, table)) {
              if (wait.delay === undefined) continue;
              // A global read inside the function is read when it runs, so the call site judges it.
              const capture =
                wait.capture === undefined || within(wait.capture.at, fn) ? undefined : wait.capture;
              for (const alternative of wait.delay) {
                if (alternative.kind !== "parameter" || !within(fn, alternative.fn)) continue;
                const { fn: owner, index } = alternative;
                const key = `${owner.start}:${index}:${wait.fakeable}:${capture?.at.start ?? "call"}`;
                found.set(key, { owner, index, fakeable: wait.fakeable, capture });
              }
            }
          }
          if (found.size === (table.get(fn) ?? []).length) continue;
          table.set(fn, [...found.values()]);
          changed = true;
        }
      }
      return table;
    };

    /**
     * The calls a function makes when it is called, outside a polling loop: its own body's, and
     * those of each `new Promise` executor it creates, which run at once. A callback it hands on or
     * a closure it returns runs later, so its calls forward through its own call sites instead.
     */
    const executedCalls = (fn: ESTree.Node): ESTree.CallExpression[] => {
      const calls: ESTree.CallExpression[] = [];
      const bodies = [fn];
      for (const body of bodies) {
        for (const node of descendants(context, body, "this-function")) {
          if (node !== body && isFunction(node) && isExecutor(node)) bodies.push(node);
          else if (node.type === "CallExpression" && !isInPollingLoop(context, node)) calls.push(node);
        }
      }
      return calls;
    };

    /** The waits one call makes, with every local function's forwards known. */
    const waitsOf = (call: ESTree.CallExpression): Wait[] => waitsWith(call, forwardsTable());

    /**
     * Whether a wait's delay waits real time at the call that sets it: an alternative that is
     * evidence of a non-zero wait (`isNonZeroDelay`) and, for a fakeable wait, not covered by a
     * simulated clock at the call.
     */
    const waitsForReal = (call: ESTree.CallExpression, { delay, fakeable, capture }: Wait): boolean =>
      delay !== undefined &&
      anyViolates(delay, isNonZeroDelay) &&
      (!fakeable ||
        !isSimulated(context, capture?.at ?? call, "setTimeout", fakeClockHelpers, capture?.via ?? []));

    return {
      CallExpression(node) {
        if (anyViolates(waitsOf(node), (wait) => waitsForReal(node, wait)) && !isInPollingLoop(context, node))
          context.report({ node, messageId: "delay" });
      },
    };
  },
};
