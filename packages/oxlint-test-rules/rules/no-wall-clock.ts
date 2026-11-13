import type { ESTree, Rule } from "@oxlint/plugins";

import { within } from "../shared/ast-walk.ts";
import { captureSite, FAKE_CLOCK_HELPERS_SCHEMA, isSimulated } from "../shared/fake-clock.ts";
import type { ClockApi, FakeClockHelper } from "../shared/fake-clock.ts";
import { allQualify, anyViolates } from "../shared/quantify.ts";
import { evaluate } from "../shared/resolve.ts";
import { ruleOptions } from "../shared/rule-options.ts";
import { assertionOf } from "../shared/test-context.ts";
import { targetOf } from "../shared/value.ts";
import type { Alt } from "../shared/value.ts";

/** The calls that read the wall clock, by their resolved name, with the clock API each reads. */
const CLOCK_READS = new Map<string, ClockApi>([
  ["performance.now", "performance"],
  ["Date.now", "Date"],
  ["process.hrtime", "hrtime"],
  ["process.hrtime.bigint", "hrtime"],
]);

/**
 * No timing assertions: a value that may be a wall-clock capture is neither subtracted nor
 * asserted, unless a simulated clock that fakes that API covers the capture, as `fake-clock.ts`
 * models one: `vi.useFakeTimers()` with its effective `toFake`, a configured fake-clock helper
 * (the `fakeClockHelpers` option, default none) or `vi.useRealTimers()` for the test's own clock,
 * and Playwright's `page.clock`
 * for captures inside a page `evaluate` callback. Time is captured by `Date.now()`,
 * `performance.now()`, `process.hrtime()` and `new Date()`, and `date.getTime()` reads the time its
 * date captured at construction. A capture is judged where its callee read the global a fake clock
 * replaces, so `const now = Date.now` at module scope stays real in a faked test. A budget measured on the machine running the test flakes under
 * load and proves nothing a user sees. Reading the clock for a unique name or to seed a fake clock
 * stays allowed, and so does offsetting a capture by a number in every alternative
 * (`Date.now() - HOUR`), which builds a timestamp rather than measuring one.
 *
 * Scope: follows what `resolve.ts` follows, for the capture and every callee, and judges coverage
 * as `fake-clock.ts` does, a capture a helper returns at the call that returned it. Beyond that: a clock change inside a nested function, or at module or
 * `describe` level outside a hook, does not count, and `page.clock` never covers the test's own
 * clock.
 */
export const noWallClock: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Forbid elapsed-time measurements and wall-clock assertions in tests." },
    messages: {
      budget:
        "This measures elapsed wall-clock time, which flakes under load. Assert the outcome instead; for time-dependent logic, drive a fake clock (vi.useFakeTimers, TestClock, page.clock).",
    },
    schema: [
      {
        type: "object",
        properties: { fakeClockHelpers: FAKE_CLOCK_HELPERS_SCHEMA },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ fakeClockHelpers: [] }],
  },
  create(context) {
    const { fakeClockHelpers } = ruleOptions<{ readonly fakeClockHelpers: ReadonlyArray<FakeClockHelper> }>(
      context
    );

    /**
     * A clock capture: where the time is taken (which decides its coverage), the API it reads, and
     * the local calls that carried it out, so a helper's capture is judged at the call that made it.
     */
    type Capture = {
      readonly at: ESTree.Node;
      readonly api: ClockApi;
      readonly via: ReadonlyArray<ESTree.CallExpression>;
    };

    /**
     * Where a clock call or construction takes its time, judged where its callee read the slot a
     * fake clock replaces (`captureSite`): at the call itself when the slot is read there, or at
     * an earlier alias (`const now = Date.now`), which keeps whatever the slot held when it ran.
     */
    const captureAt = (
      callee: Alt,
      api: ClockApi,
      call: ESTree.Node,
      via: ReadonlyArray<ESTree.CallExpression>
    ): Capture => {
      const site = captureSite(callee, api);
      return site === undefined || within(site, call)
        ? { at: call, api, via }
        : { at: site, api, via: callee.via };
    };

    /** Where an alternative that is `new Date()` with no argument captures the time. */
    const constructedNow = (alternative: Alt, via: ReadonlyArray<ESTree.CallExpression>): Capture[] => {
      if (alternative.kind !== "opaque" || alternative.node.type !== "NewExpression") return [];
      const construction = alternative.node;
      if (construction.arguments.length > 0) return [];
      return evaluate(context, construction.callee).flatMap((callee): Capture[] =>
        targetOf(callee)?.path.join(".") === "Date" ? [captureAt(callee, "Date", construction, via)] : []
      );
    };

    /**
     * Where one alternative captures the time: a clock call (`Date.now()`, `performance.now()`,
     * `process.hrtime()`) or `new Date()`, each where its callee read the clock (`captureAt`), and
     * `date.getTime()` or `date.valueOf()` where its date was constructed.
     */
    const capturesOf = (alternative: Alt): Capture[] => {
      const constructed = constructedNow(alternative, alternative.via);
      if (constructed.length > 0) return constructed;
      if (alternative.kind !== "opaque" || alternative.node.type !== "CallExpression") return [];
      const call = alternative.node;
      return evaluate(context, call.callee).flatMap((callee): Capture[] => {
        const api = CLOCK_READS.get(targetOf(callee)?.path.join(".") ?? "");
        if (api !== undefined) return [captureAt(callee, api, call, alternative.via)];
        if (callee.kind !== "member" || (callee.key !== "getTime" && callee.key !== "valueOf")) return [];
        return constructedNow(callee.object, [...alternative.via, ...callee.object.via]);
      });
    };

    /** Whether one alternative captures the time where no simulated clock covers it. */
    const onWallClock = (alternative: Alt): boolean =>
      capturesOf(alternative).some(
        ({ at, api, via }) => !isSimulated(context, at, api, fakeClockHelpers, via)
      );

    /** Whether a value is a number in every alternative: an offset, not a second capture. */
    const isOffset = (values: ReadonlyArray<Alt>): boolean =>
      allQualify(values, (alternative) => alternative.kind === "number");

    return {
      BinaryExpression(node) {
        if (node.operator !== "-") return;
        const left = evaluate(context, node.left);
        const right = evaluate(context, node.right);
        // A capture offset by a number (`Date.now() - HOUR`) seeds a timestamp; it measures nothing.
        if (isOffset(left) || isOffset(right)) return;
        if (anyViolates([...left, ...right], onWallClock)) context.report({ node, messageId: "budget" });
      },
      CallExpression(node) {
        const actuals = (assertionOf(context, node)?.actuals ?? []).flatMap((actual) =>
          evaluate(context, actual)
        );
        if (anyViolates(actuals, onWallClock)) context.report({ node, messageId: "budget" });
      },
    };
  },
};
