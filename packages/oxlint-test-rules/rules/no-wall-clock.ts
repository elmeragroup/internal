import type { ESTree, Rule } from "@oxlint/plugins";

import { captureAway, FAKE_CLOCK_HELPERS_SCHEMA, isSimulated } from "../shared/fake-clock.ts";
import type { ClockApi, FakeClockHelper } from "../shared/fake-clock.ts";
import { allAgree, allQualify, anyViolates } from "../shared/quantify.ts";
import { calleeApis, evaluate } from "../shared/resolve.ts";
import { ruleOptions } from "../shared/rule-options.ts";
import { assertionOf } from "../shared/test-context.ts";
import { Analysis } from "../shared/traversal.ts";
import { derive, targetOf } from "../shared/value.ts";
import type { Alt } from "../shared/value.ts";

/** The calls that read the wall clock, by their resolved name, with the clock API each reads. */
const CLOCK_READS = new Map<string, ClockApi>([
  ["performance.now", "performance"],
  ["Date.now", "Date"],
  ["process.hrtime", "hrtime"],
  ["process.hrtime.bigint", "hrtime"],
]);

/** The arithmetic that scales a value (`days * DAY`, `now / 1000`). */
const SCALING = new Set(["*", "/", "%"]);

/** The calls that round or convert a value and keep what it measures. */
const ROUNDING = new Set(["Math.round", "Math.floor", "Math.ceil", "Math.trunc", "Number"]);

/**
 * The values each scaling or rounding expression is built from, through nested scaling and
 * rounding, as one analysis on the bounded traversal: an expression reached again while it is
 * read, or past the budget, is built from nothing known. Each value carries its provenance
 * (`named`, `via`) as reached from the expression; the caller applies the provenance of the
 * alternative that reached the expression, since that differs per alternative. The empty result
 * on a cycle or budget cut is deliberate: an operand that cannot be read neither blocks an offset
 * nor reports.
 */
const SCALED_FROM = new Analysis<ReadonlyArray<Alt>>([]);

/**
 * A clock capture: where the time is taken (which decides its coverage), the API it reads, and
 * the local calls that carried it out, so a helper's capture is judged at the call that made it.
 * `call` is the call or construction that reads the clock and `reading` the local calls that
 * carried that read out: together they name one reading, since `at` may be an alias that many
 * reads share.
 */
type Capture = {
  readonly at: ESTree.Node;
  readonly api: ClockApi;
  readonly via: ReadonlyArray<ESTree.CallExpression>;
  readonly call: ESTree.Node;
  readonly reading: ReadonlyArray<ESTree.CallExpression>;
};

/** The arithmetic that shifts a timestamp (`Date.now() - DAY`, `performance.timeOrigin + performance.now()`). */
const SHIFTING = new Set(["+", "-"]);

/**
 * The values each timestamp a `Date` is built from (`new Date(stamp)`) is made of, through nested
 * shifting, on the same terms as `SCALED_FROM`: provenance applied by the caller, nothing known on
 * a cycle or budget cut.
 */
const SHIFTED_FROM = new Analysis<ReadonlyArray<Alt>>([]);

/**
 * The captures each `new Date(stamp)` holds, as reached from the construction, on the same terms:
 * the caller applies the calls that reached it, and a cycle or budget cut holds no capture, so a
 * date built from a date built from a reading recurses through the bounded traversal.
 */
const STAMP_CAPTURES = new Analysis<ReadonlyArray<Capture>>([]);

/**
 * No timing assertions: a value that may be a wall-clock capture is neither subtracted nor
 * asserted, unless a simulated clock that fakes that API covers the capture, as `fake-clock.ts`
 * models one: `vi.useFakeTimers()` with its effective `toFake`, `vi.setSystemTime()` without fake
 * timers (`Date` only), a configured fake-clock helper (the `fakeClockHelpers` option, default
 * none) or `vi.useRealTimers()` for the test's own clock, and Playwright's `page.clock` for
 * captures inside a page `evaluate` callback. Time is captured by `Date.now()`,
 * `performance.now()`, `process.hrtime()`, `new Date()` and a `new Date(stamp)` whose timestamp
 * holds a capture through `+` and `-` (`new Date(Date.now())`), and `date.getTime()` reads the time its
 * date captured at construction. A capture is judged where its callee read the global a fake clock
 * replaces, so `const now = Date.now` at module scope stays real in a faked test. A budget
 * measured on the machine running the test flakes under load and proves nothing a user sees.
 * Reading the clock for a unique name or to seed a fake clock stays allowed, and so does
 * offsetting a capture by a duration in every alternative, which builds a timestamp rather than
 * measuring one: a number, an imported constant (`Date.now() - HOUR`), arithmetic that scales or
 * rounds one (`days * DAY`, `Math.round(days * DAY)`), or the time of a date that is no clock
 * capture (`born.getTime()`). A capture stays one through scaling and rounding
 * (`performance.now() / 1000`), so an offset holds none, and a scaled capture is asserted or
 * subtracted like the capture itself. A subtraction whose sides both hold one and the same reading
 * (`now - (now % DAY)`) builds a timestamp from it and stays allowed; two calls of the clock, or
 * of one helper, are two readings.
 *
 * Scope: follows what `resolve.ts` follows, for the capture and every callee, and judges coverage
 * as `fake-clock.ts` does, a capture a helper returns at the call that returned it. Scaling and
 * rounding are followed only through `*`, `/`, `%` and `Math.round`, `Math.floor`, `Math.ceil`,
 * `Math.trunc` and `Number`. Beyond that: a
 * clock change inside a nested function, or at module or `describe` level outside a hook, does not
 * count, and `page.clock` never covers the test's own clock. A test registered through a local
 * wrapper that forwards its body to `it`, and a clock read in a class method (`new C().m()`), are
 * judged without their test, so that test's fake clock does not cover them.
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
     * Where a clock call or construction takes its time, judged where its callee read the slot a
     * fake clock replaces (`captureAway`): at the call itself when the slot is read there, or at
     * an earlier alias (`const now = Date.now`), which keeps whatever the slot held when it ran.
     */
    const captureAt = (
      callee: Alt,
      api: ClockApi,
      call: ESTree.Node,
      via: ReadonlyArray<ESTree.CallExpression>
    ): Capture => ({ api, call, reading: via, ...(captureAway(callee, api, call) ?? { at: call, via }) });

    /**
     * Where an alternative that constructs a `Date` captures the time: `new Date()` where its
     * callee read the clock, and `new Date(stamp)` wherever its one timestamp does, through
     * shifting (`new Date(performance.timeOrigin + performance.now())`).
     */
    const constructedNow = (alternative: Alt, via: ReadonlyArray<ESTree.CallExpression>): Capture[] => {
      if (alternative.kind !== "opaque" || alternative.node.type !== "NewExpression") return [];
      const construction = alternative.node;
      const dates = evaluate(context, construction.callee).filter(
        (callee) => targetOf(callee)?.path.join(".") === "Date"
      );
      if (construction.arguments.length === 0)
        return dates.map((callee) => captureAt(callee, "Date", construction, via));
      const [stamp, ...rest] = construction.arguments;
      if (dates.length === 0 || stamp === undefined || stamp.type === "SpreadElement" || rest.length > 0)
        return [];
      return STAMP_CAPTURES.run(
        context,
        construction,
        () => evaluate(context, stamp).flatMap((value) => partsOf(value).flatMap(capturesOf)),
        () => []
      ).map((capture) => ({
        ...capture,
        via: [...via, ...capture.via],
        reading: [...via, ...capture.reading],
      }));
    };

    /** The values a timestamp is made of past shifting (`+`, `-`), as reached from it. */
    const partsOf = (alternative: Alt): ReadonlyArray<Alt> => {
      if (alternative.kind !== "opaque") return [alternative];
      const { node } = alternative;
      if (node.type !== "BinaryExpression" || !SHIFTING.has(node.operator)) return [alternative];
      return SHIFTED_FROM.run(
        context,
        node,
        () => [node.left, node.right].flatMap((operand) => evaluate(context, operand).flatMap(partsOf)),
        () => []
      ).map((part) => derive(part, { _tag: "projection", container: alternative }));
    };

    /**
     * Where one alternative is itself a capture: a clock call (`Date.now()`, `performance.now()`,
     * `process.hrtime()`) or `new Date()`, each where its callee read the clock (`captureAt`), and
     * `date.getTime()` or `date.valueOf()` where its date was constructed.
     */
    const directCapturesOf = (alternative: Alt): Capture[] => {
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

    /** The expression of an alternative that scales a value (`days * DAY`) or rounds one (`Math.round(x)`). */
    const scalingOf = (alternative: Alt): ESTree.Node | undefined => {
      if (alternative.kind !== "opaque") return undefined;
      const { node } = alternative;
      if (node.type === "BinaryExpression") return SCALING.has(node.operator) ? node : undefined;
      return node.type === "CallExpression" && ROUNDING.has(allAgree(calleeApis(context, node.callee)) ?? "")
        ? node
        : undefined;
    };

    /** The values an alternative is built from past scaling and rounding, as reached from it. */
    const basesOf = (alternative: Alt): ReadonlyArray<Alt> => {
      const scaling = scalingOf(alternative);
      if (scaling === undefined) return [alternative];
      return scaledFrom(scaling).map((base) => derive(base, { _tag: "projection", container: alternative }));
    };

    /**
     * The values a scaling or rounding expression is built from, past nested scaling and rounding,
     * each as reached from the expression: one step of `SCALED_FROM` per expression.
     */
    const scaledFrom = (node: ESTree.Node): ReadonlyArray<Alt> =>
      SCALED_FROM.run(
        context,
        node,
        () => {
          const operands =
            node.type === "BinaryExpression"
              ? [node.left, node.right]
              : node.type === "CallExpression"
                ? node.arguments
                : [];
          return operands.flatMap((operand) => evaluate(context, operand).flatMap(basesOf));
        },
        () => []
      );

    /**
     * Where one alternative captures the time, through scaling and rounding: a capture divided down
     * to seconds or rounded is still a capture.
     */
    const capturesOf = (alternative: Alt): Capture[] => basesOf(alternative).flatMap(directCapturesOf);

    /** Whether one alternative captures the time where no simulated clock covers it. */
    const onWallClock = (alternative: Alt): boolean =>
      capturesOf(alternative).some(
        ({ at, api, via }) => !isSimulated(context, at, api, fakeClockHelpers, via)
      );

    /**
     * Whether a value is a duration in every alternative: a number, a constant held by name (an
     * import), arithmetic that scales or rounds one (`days * DAY`, `Math.round(days * DAY)`), or
     * the time of a date that is no clock capture (`born.getTime()`), and in each case holds no
     * capture, even through scaling. An offset builds a timestamp; it is not a second capture.
     */
    const isOffset = (values: ReadonlyArray<Alt>): boolean =>
      allQualify(
        values,
        (alternative) =>
          (alternative.kind === "number" ||
            alternative.kind === "import" ||
            scalingOf(alternative) !== undefined ||
            isStamp(alternative)) &&
          capturesOf(alternative).length === 0
      );

    /** Whether two captures are one reading: the same clock read, carried out by the same calls. */
    const sameReading = (first: Capture, second: Capture): boolean =>
      first.call === second.call &&
      first.reading.length === second.reading.length &&
      first.reading.every((call, index) => call === second.reading[index]);

    /**
     * Whether both sides of a subtraction hold one and the same reading in every alternative
     * (`now - (now % DAY)`): a timestamp built from that reading, which measures nothing.
     */
    const isOneReading = (left: ReadonlyArray<Alt>, right: ReadonlyArray<Alt>): boolean => {
      const sides = [left, right].map((values) => values.map(capturesOf));
      const [first] = sides.flat(2);
      return (
        first !== undefined &&
        sides.every((side) =>
          side.every(
            (captures) => captures.length > 0 && captures.every((capture) => sameReading(capture, first))
          )
        )
      );
    };

    /** Whether an alternative is `date.getTime()` or `date.valueOf()`: a date's stamp. */
    const isStamp = (alternative: Alt): boolean =>
      alternative.kind === "opaque" &&
      alternative.node.type === "CallExpression" &&
      evaluate(context, alternative.node.callee).some(
        (callee) => callee.kind === "member" && (callee.key === "getTime" || callee.key === "valueOf")
      );

    return {
      BinaryExpression(node) {
        if (node.operator !== "-") return;
        const left = evaluate(context, node.left);
        const right = evaluate(context, node.right);
        // A capture offset by a number (`Date.now() - HOUR`) seeds a timestamp; it measures nothing.
        if (isOffset(left) || isOffset(right) || isOneReading(left, right)) return;
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
