import type { ESTree, Rule } from "@oxlint/plugins";

import { allQualify, anyViolates } from "../shared/quantify.ts";
import { evaluate, isApi } from "../shared/resolve.ts";
import { assertionOf } from "../shared/test-context.ts";
import { Analysis } from "../shared/traversal.ts";
import { entryFor, targetOf } from "../shared/value.ts";
import type { Alt } from "../shared/value.ts";

/** The methods that measure an element's layout box. */
const BOX_METHODS = new Set(["getBoundingClientRect", "getClientRects", "boundingBox"]);

/** A measured box's lengths. */
const BOX_LENGTHS = new Set(["x", "y", "top", "left", "right", "bottom", "width", "height"]);

/**
 * The element properties that hold a layout length. A scroll offset (`scrollTop`, `scrollLeft`) is
 * a position the test drives, not a length the layout computes, so it is none.
 */
const LAYOUT_LENGTHS = new Set([
  "offsetWidth",
  "offsetHeight",
  "offsetTop",
  "offsetLeft",
  "clientWidth",
  "clientHeight",
  "clientTop",
  "clientLeft",
  "scrollWidth",
  "scrollHeight",
]);

/** The computed-style properties whose used value is a layout length. */
const STYLE_LENGTHS = new Set([
  "width",
  "height",
  "top",
  "left",
  "right",
  "bottom",
  "inlineSize",
  "blockSize",
]);

/** The calls whose result is still a length when their argument is one, by their resolved last name. */
const LENGTH_KEEPERS = new Set([
  "abs",
  "round",
  "floor",
  "ceil",
  "trunc",
  "min",
  "max",
  "px",
  "parseFloat",
  "parseInt",
  "Number",
]);

/** The matchers that compare a number against an expectation. */
const COMPARISONS = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toBeCloseTo",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toMatchObject",
]);

/** The bound matchers, which read a tolerance or a radius when the value is a distance. */
const BOUNDS = new Set(["toBeGreaterThan", "toBeGreaterThanOrEqual", "toBeLessThan", "toBeLessThanOrEqual"]);

/** A CSS pixel length as a string, such as `"36px"`. */
const PIXEL_STRING = /^(-?\d*\.?\d+)px$/u;

/** What a value is, as far as layout goes: a measured box, a computed style, or a length. */
type Measure = "box" | "style" | "length";

/**
 * What each expression the evaluator keeps (`opaque`) is, layout-wise, as one analysis on the
 * bounded traversal: a measurement reached again while it is judged, or past the budget, is none.
 */
const MEASURES = new Analysis<Measure | undefined>(undefined);

/**
 * Whether each expected expression pins a pixel, through the box objects it holds, as one analysis
 * on the bounded traversal: an object that holds itself, or a walk past the budget, pins nothing.
 */
const PIXELS = new Analysis<boolean>(false);

/**
 * No pixel pins: a layout measurement (`getBoundingClientRect`, `offset*`, `client*`,
 * `scrollWidth`, `scrollHeight` or a computed width, height or inset, read directly, through
 * bindings, through a helper's or an `expect.poll` callback's return, or through arithmetic that
 * keeps it a length) is not asserted against a pixel number or a pixel string such as `"36px"`. A
 * pixel the test writes holds at one viewport, font and engine, and moves under a refactor that
 * keeps the layout right. Relations stay allowed: one measurement against another (below, inside,
 * unchanged after an action), against zero, a bound on an absolute distance (`Math.abs(a - b)`
 * below a tolerance or past a hit radius), or against a named constant, which states the relation
 * to the fixture or the contract it holds (`ROW_WIDTH`, `TARGET_SIZE`): a value `resolve.ts` marks
 * `named`. A ratio or a sign of lengths is no length. A measurement read inside a `page.evaluate`
 * or `locator.evaluate` callback counts as the value it returns. A value is a measurement, and an
 * expectation a pixel pin, when any alternative is; a bound exempts a distance only when every
 * alternative is one.
 *
 * Scope: follows what `resolve.ts` follows, so a measurement through a binding, a local function's
 * return, a page `evaluate` callback or a returned object's property counts. Beyond that: a value
 * through a call outside the fixed list (`Math.abs`, `round`, `min`, `max`, `px`, `parseFloat`…)
 * is not a length, and a named value is never read as a pixel number.
 */
export const noGeometryAssertions: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Forbid asserting layout measurements against pixel literals." },
    messages: {
      pixel:
        "This pins a measured layout length to a pixel number, which holds at one viewport and engine only. Assert a relation between measurements (below, inside, equal, unchanged), or prove the visual change with a PR screenshot.",
    },
    schema: [],
  },
  create(context) {
    /** Whether any alternative of an expression is a length. */
    const isLength = (node: ESTree.Node): boolean =>
      evaluate(context, node).some((alternative) => measureOf(alternative) === "length");

    /**
     * What one alternative is, layout-wise: a measured box, a computed style, a length, or none.
     * A member read off a box or a style, a call that measures or keeps a length, and arithmetic
     * on lengths are judged by the alternatives of what they read.
     */
    const measureOf = (alternative: Alt): Measure | undefined => {
      if (alternative.kind === "member") {
        if (LAYOUT_LENGTHS.has(alternative.key)) return "length";
        const object = measureOf(alternative.object);
        // A box list's entry, such as `getClientRects()[0]`, is a box.
        if (/^\d+$/u.test(alternative.key)) return object === "box" ? "box" : undefined;
        if (object === "box" && BOX_LENGTHS.has(alternative.key)) return "length";
        return object === "style" && STYLE_LENGTHS.has(alternative.key) ? "length" : undefined;
      }
      if (alternative.kind !== "opaque") return undefined;
      const expression = alternative.node;
      return MEASURES.run(
        context,
        expression,
        () => measureOfExpression(expression),
        () => undefined
      );
    };

    /** What an expression the evaluator keeps (`opaque`) is, layout-wise: one step of `MEASURES`. */
    const measureOfExpression = (expression: ESTree.Node): Measure | undefined => {
      switch (expression.type) {
        case "CallExpression": {
          const callees = evaluate(context, expression.callee);
          if (callees.some((callee) => callee.kind === "member" && BOX_METHODS.has(callee.key))) return "box";
          const names = callees.map((callee) => targetOf(callee)?.path.at(-1));
          if (names.some((name) => name === "getComputedStyle")) return "style";
          const keeps = names.some((name) => name !== undefined && LENGTH_KEEPERS.has(name));
          return keeps && expression.arguments.some((argument) => isLength(argument)) ? "length" : undefined;
        }
        case "BinaryExpression": {
          if (expression.left.type === "PrivateIdentifier") return undefined;
          const left = isLength(expression.left);
          const right = isLength(expression.right);
          switch (expression.operator) {
            case "+":
            case "-":
              return left || right ? "length" : undefined;
            case "*":
              return left !== right ? "length" : undefined;
            case "/":
            case "%":
              return left && !right ? "length" : undefined;
            default:
              return undefined;
          }
        }
        case "UnaryExpression":
          return (expression.operator === "-" || expression.operator === "+") && isLength(expression.argument)
            ? "length"
            : undefined;
        default:
          return undefined;
      }
    };

    /**
     * Whether one expected alternative pins a pixel: a non-zero number or pixel string the test
     * writes inline, or a box object with such a length. A value reached through a name (a named
     * constant, a property of one, a helper's return) states what the number is, so it pins nothing.
     */
    const pinsPixels = (alternative: Alt): boolean => {
      if (alternative.named) return false;
      switch (alternative.kind) {
        case "number":
          return alternative.value !== 0;
        case "string": {
          const match = PIXEL_STRING.exec(alternative.value);
          return match?.[1] !== undefined && Number(match[1]) !== 0;
        }
        case "object":
          return [...BOX_LENGTHS].some((key) => {
            const entry = entryFor(alternative, key);
            return entry !== undefined && entry !== "unknown" && pixelsIn(entry.value);
          });
        default:
          return false;
      }
    };

    /**
     * Whether any alternative of an expression pins a pixel: one step of `PIXELS` per expression,
     * which is all its result depends on.
     */
    const pixelsIn = (node: ESTree.Node): boolean =>
      PIXELS.run(
        context,
        node,
        () => anyViolates(evaluate(context, node), pinsPixels),
        () => false
      );

    /** Whether one alternative is `Math.abs(…)` in every alternative of its callee: a distance. */
    const isDistance = (alternative: Alt): boolean =>
      alternative.kind === "opaque" &&
      alternative.node.type === "CallExpression" &&
      isApi(context, alternative.node.callee, "Math.abs");

    return {
      CallExpression(node) {
        const assertion = assertionOf(context, node);
        const [expected] = assertion?.expected ?? [];
        if (assertion === undefined || expected === undefined || !COMPARISONS.has(assertion.matcher)) return;
        if (!pixelsIn(expected)) return;
        const measured = assertion.actuals.some((actual) => {
          const values = evaluate(context, actual);
          // A tolerance or radius bounds a distance only when every alternative is one.
          if (BOUNDS.has(assertion.matcher) && allQualify(values, isDistance)) return false;
          return anyViolates(values, (alternative) => measureOf(alternative) !== undefined);
        });
        if (measured) context.report({ node, messageId: "pixel" });
      },
    };
  },
};
