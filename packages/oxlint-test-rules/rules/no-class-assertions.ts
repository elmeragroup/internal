import type { ESTree, Rule } from "@oxlint/plugins";

import { memberName, nameChain, propertyKeyName } from "../shared/ast-names.ts";
import { descendants, unwrap } from "../shared/ast-walk.ts";
import { allQualify, firstViolation } from "../shared/quantify.ts";
import { calleeNames, evaluate, returnedValues } from "../shared/resolve.ts";
import { assertionOf, evidenceSets, reachOf } from "../shared/test-context.ts";
import { Analysis, pairKey } from "../shared/traversal.ts";
import type { EvidenceKey } from "../shared/traversal.ts";
import { stringValues } from "../shared/value.ts";
import type { Alt } from "../shared/value.ts";

/**
 * The classes a class string holds.
 *
 * @param text - A class string.
 * @returns Its whitespace-separated classes.
 */
function classesOf(text: string): string[] {
  return text.split(/\s+/u).filter((token) => token.length > 0);
}

/** The `classList` methods whose string arguments put a class on an element. */
const CLASS_WRITES = new Set(["add", "toggle", "replace"]);

/** A prop that hands a part its classes: `className`, `class`, or a part's `triggerClassName`. */
const CLASS_PROP = /^(?:class|className|[a-z][A-Za-z]*ClassName)$/u;

/**
 * Whether each list literal or call the evaluator keeps reads an element's classes, as one
 * analysis on the bounded traversal: a read reached again while it is judged, or past the budget,
 * reads none.
 */
const CLASS_READS = new Analysis<boolean>(false);

/**
 * The class each expected expression pins against one run's supplied evidence, as one analysis on
 * the bounded traversal keyed by both: a list that contains itself, or a walk past the budget, pins
 * nothing.
 */
const CLASS_PINS = new Analysis<string | undefined>(undefined);

/**
 * What a run supplies: the class tokens its supplied strings hold, and the symbols of supplied
 * values the evaluator holds by name only (an imported constant, a member of one), which an
 * assertion naming the same symbol names the same class.
 */
type Supplied = EvidenceKey & { readonly tokens: ReadonlySet<string>; readonly symbols: ReadonlySet<string> };

/**
 * The symbol of a value held by name only: an import as its module and export, a member of one
 * with its keys, a global by name, and a parameter or loop binding by where it is declared. Any
 * other value has none.
 *
 * @param alternative - One value alternative.
 * @returns The symbol, or `undefined`.
 */
function symbolOf(alternative: Alt): string | undefined {
  switch (alternative.kind) {
    case "import":
      return `import:${alternative.source}#${alternative.imported}`;
    case "global":
      return `global:${alternative.name}`;
    case "parameter":
      return `parameter:${alternative.fn.start}:${alternative.index}`;
    case "loop":
      return `loop:${alternative.iterable.start}`;
    case "member": {
      const object = symbolOf(alternative.object);
      return object === undefined ? undefined : `${object}.${alternative.key}`;
    }
    default:
      return undefined;
  }
}

/**
 * No class pins: an assertion on an element's classes (`toHaveClass`, `toHaveAttribute("class")`,
 * `className`, `classList` or `getAttribute("class")`, read directly or through a binding, in any
 * value an `expect.poll` callback returns, under any alias of `expect`) names only classes its own
 * test supplies: through a `className` prop (or a part's, such as `triggerClassName`), a props
 * object, `classList.add`, a `className` assignment or `setAttribute("class", …)`, in the test, the
 * setup hooks that run before it, or the fixtures and helpers they reach. A test registered more
 * than once must supply the class in every run, each with its own suite's hooks. An assertion in a
 * helper outside any test counts only what its own function reaches. That proves a consumer's class
 * reaches the right part. A component's own classes are its implementation, so assert the computed
 * style, role or state they produce instead. An expected value is exempt only when every
 * alternative qualifies: a string whose classes are supplied, an imported value (or a member of
 * one) or a parameter the test supplies under the same name, a pattern that matches a supplied
 * class, or a call the evaluator does not follow, such as an imported recipe's output, which is a
 * cross-check. A value the evaluator cannot resolve (`unknown`, a parameter or a loop binding it
 * cannot open) is no evidence of a pin. A call that only reshapes literals (`"h-9".trim()`) still
 * pins them. A value reads classes, and an attribute name is `"class"`, when any alternative is.
 *
 * Scope: follows what `resolve.ts` follows, for supplied classes, expected classes and class
 * reads alike, and finds a test, its runs and its setup hooks as `test-context.ts` does. Beyond
 * that: classes supplied through an `it.each` table outside the test callback are not followed,
 * and a call the evaluator cannot follow (an imported helper) counts as a cross-check whatever it
 * returns.
 */
export const noClassAssertions: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Forbid assertions on class names the test did not supply." },
    messages: {
      pinned:
        "This pins the component's own class `{{token}}`, which a behavior-preserving refactor changes. Assert the computed style, role or state it produces; a class assertion is for a className the test passes in.",
    },
    schema: [],
  },
  create(context) {
    const suppliedByRoots = new Map<string, Supplied>();

    /** Every alternative a supplied value may be, a class callback's returns included. */
    const suppliedValues = (value: ESTree.Node): Alt[] =>
      evaluate(context, value).flatMap((alternative) =>
        alternative.kind === "function"
          ? returnedValues(context, alternative.fn).flatMap((returned) => evaluate(context, returned))
          : [alternative]
      );

    /**
     * The classes one run's evidence supplies: its test, the setup hooks that run before it, and
     * every fixture or helper they reach; outside a test, its own function's reach. Every value a
     * supplied class may be is supplied: a string's tokens, and a named value's symbol.
     */
    const suppliedBy = (roots: ReadonlyArray<ESTree.Node>): Supplied => {
      const key = roots.map((root) => `${root.start}:${root.end}`).join(",");
      const cached = suppliedByRoots.get(key);
      if (cached !== undefined) return cached;
      const tokens = new Set<string>();
      const symbols = new Set<string>();
      const add = (value: ESTree.Node): void => {
        const values = suppliedValues(value);
        for (const text of stringValues(values)) for (const token of classesOf(text)) tokens.add(token);
        for (const alternative of values) {
          const symbol = symbolOf(alternative);
          if (symbol !== undefined) symbols.add(symbol);
        }
      };
      for (const region of reachOf(context, roots)) {
        for (const node of descendants(context, region, "into-functions")) {
          if (node.type === "JSXAttribute" && CLASS_PROP.test(nameChain(node.name).join("."))) {
            const value = node.value;
            if (value?.type === "JSXExpressionContainer" && value.expression.type !== "JSXEmptyExpression") {
              add(value.expression);
            } else if (value !== null) {
              add(value);
            }
          } else if (node.type === "Property" && CLASS_PROP.test(propertyKeyName(node) ?? "")) {
            add(node.value);
          } else if (node.type === "AssignmentExpression" && memberName(node.left) === "className") {
            add(node.right);
          } else if (node.type === "CallExpression") {
            const callee = unwrap(node.callee);
            const method = memberName(callee);
            const [name, value] = node.arguments;
            if (callee.type !== "MemberExpression") continue;
            if (CLASS_WRITES.has(method ?? "") && evaluate(context, callee.object).some(isClassList)) {
              for (const argument of node.arguments) add(argument);
            } else if (
              method === "setAttribute" &&
              name !== undefined &&
              value !== undefined &&
              namesClass(name)
            ) {
              add(value);
            }
          }
        }
      }
      const supplied: Supplied = { _tag: "evidence", tokens, symbols };
      suppliedByRoots.set(key, supplied);
      return supplied;
    };

    /** Whether an alternative is an element's `classList`. */
    const isClassList = (alternative: Alt): boolean =>
      alternative.kind === "member" && alternative.key === "classList";

    /**
     * Whether one alternative reads an element's classes: `.className` or `.classList`, the
     * string or list methods after it (`.split(" ")`, `Array.from(…)`, `[...…]`), or
     * `getAttribute(name)` where any alternative of the name is `"class"`.
     */
    const readsClasses = (alternative: Alt): boolean => {
      if (alternative.kind === "member") {
        return (
          alternative.key === "className" ||
          alternative.key === "classList" ||
          readsClasses(alternative.object)
        );
      }
      const node =
        alternative.kind === "array" || alternative.kind === "opaque" ? alternative.node : undefined;
      if (node === undefined) return false;
      return CLASS_READS.run(
        context,
        node,
        () => nodeReadsClasses(node),
        () => false
      );
    };

    /** Whether a list literal or a call the evaluator keeps reads classes: one step of `CLASS_READS`. */
    const nodeReadsClasses = (node: ESTree.Node): boolean => {
      if (node.type === "ArrayExpression") {
        return node.elements.some(
          (element) =>
            element?.type === "SpreadElement" &&
            evaluate(context, element.argument).some((spread) => readsClasses(spread))
        );
      }
      if (node.type !== "CallExpression") return false;
      const [argument] = node.arguments;
      if (calleeNames(context, node.callee).includes("Array.from")) {
        return argument !== undefined && evaluate(context, argument).some((from) => readsClasses(from));
      }
      return evaluate(context, node.callee).some((callee) => {
        if (callee.kind !== "member") return false;
        if (callee.key === "getAttribute") return argument !== undefined && namesClass(argument);
        return readsClasses(callee.object);
      });
    };

    /** Whether any alternative of an attribute name is `"class"`. */
    const namesClass = (node: ESTree.Node): boolean =>
      evaluate(context, node).some((name) => name.kind === "string" && name.value === "class");

    /**
     * The classes one actual alternative asks about when it is a membership test:
     * `x.classList.contains(arg)`, or `includes(arg)` on a read of the classes such as
     * `x.className.split(/\s+/).includes(arg)`. Every argument is a class it asks about.
     */
    const membershipOf = (alternative: Alt): ReadonlyArray<ESTree.Node> => {
      if (alternative.kind !== "opaque" || alternative.node.type !== "CallExpression") return [];
      const call = alternative.node;
      const asks = evaluate(context, call.callee).some(
        (callee) =>
          callee.kind === "member" &&
          ((callee.key === "contains" && isClassList(callee.object)) ||
            (callee.key === "includes" && readsClasses(callee.object)))
      );
      return asks ? call.arguments : [];
    };

    /**
     * The class one expected alternative pins against what a run supplies, or `undefined` when it
     * qualifies: a string whose every token is supplied, a named value the run supplies by the
     * same symbol, a pattern that matches a supplied class, a list whose every element qualifies,
     * a call the evaluator does not follow (an imported recipe's output), which is a cross-check,
     * or a value the evaluator cannot know (`unknown`), which is no evidence of a pin.
     */
    const pinnedBy = (alternative: Alt, supplied: Supplied, spelling: string): string | undefined => {
      // `spelling` is the expected expression's own text, so the step's key (that expression and
      // the supplied evidence) covers everything the result depends on.
      const symbol = symbolOf(alternative);
      if (symbol !== undefined && supplied.symbols.has(symbol)) return undefined;
      switch (alternative.kind) {
        // A value the evaluator cannot resolve (a parameter, a loop binding) pins nothing provable.
        case "unknown":
        case "parameter":
        case "loop":
          return undefined;
        case "string": {
          const tokens = classesOf(alternative.value);
          if (tokens.length === 0) return '""';
          return tokens.find((token) => !supplied.tokens.has(token));
        }
        case "regex": {
          const pattern = new RegExp(alternative.pattern, alternative.flags);
          return [...supplied.tokens].some((token) => pattern.test(token))
            ? undefined
            : `/${alternative.pattern}/${alternative.flags}`;
        }
        case "array": {
          if (!alternative.complete) return spelling;
          for (const element of alternative.elements) {
            if (element === null) continue;
            const pinned = pinnedIn(element, supplied);
            if (pinned !== undefined) return pinned;
          }
          return undefined;
        }
        case "opaque":
          return alternative.node.type === "CallExpression" || alternative.node.type === "NewExpression"
            ? undefined
            : spelling;
        default:
          return spelling;
      }
    };

    /**
     * The class an expected expression pins against a run's supplied evidence: the first
     * alternative's pin, `undefined` only when every alternative qualifies. One step of
     * `CLASS_PINS` per expression and evidence; a pin is reported by the expression's own text.
     */
    const pinnedIn = (node: ESTree.Node, supplied: Supplied): string | undefined => {
      const expression = unwrap(node);
      return CLASS_PINS.run(
        context,
        pairKey(expression, supplied),
        () =>
          firstViolation(evaluate(context, expression), (alternative) =>
            pinnedBy(alternative, supplied, context.sourceCode.getText(expression))
          ),
        () => undefined
      );
    };

    /**
     * The expected classes a call asserts, or `undefined` for a call that asserts no classes:
     * `toHaveClass`'s classes, `toHaveAttribute("class", value)`'s value, a membership test's
     * classes, or the expectation compared with a read of the classes.
     */
    const expectedClassesOf = (node: ESTree.CallExpression): ReadonlyArray<ESTree.Node> | undefined => {
      const assertion = assertionOf(context, node);
      if (assertion === undefined || assertion.actuals.length === 0) return undefined;
      const { matcher, expected } = assertion;
      const [first, second] = expected;
      if (matcher === "toHaveClass") {
        // A trailing options object (`{ exact: true }`) configures the matcher; it names no class.
        return expected.filter(
          (argument) => !allQualify(evaluate(context, argument), (option) => option.kind === "object")
        );
      }
      if (matcher === "toHaveAttribute" && first !== undefined && namesClass(first)) {
        return second === undefined ? [] : [second];
      }
      const classes = assertion.actuals.flatMap((actual) => {
        const actuals = evaluate(context, actual);
        const asked = actuals.flatMap(membershipOf);
        if (asked.length > 0) return asked;
        return first !== undefined && actuals.some((value) => readsClasses(value)) ? [first] : [];
      });
      return classes.length > 0 ? classes : undefined;
    };

    return {
      CallExpression(node) {
        const expected = expectedClassesOf(node);
        if (expected === undefined) return;
        // The exemption must hold in every run of the assertion's test, each with its own hooks.
        for (const roots of evidenceSets(context, node)) {
          const pinned = firstViolation(expected, (entry) => pinnedIn(entry, suppliedBy(roots)));
          if (pinned === undefined) continue;
          context.report({ node, messageId: "pinned", data: { token: pinned } });
          return;
        }
      },
    };
  },
};
