import type { Context, ESTree, Scope, Variable } from "@oxlint/plugins";

import { memberName, moduleExportName, propertyKeyName } from "./ast-names.ts";
import { descendants, isFunction, unwrap } from "./ast-walk.ts";
import { mutationsIn } from "./mutations.ts";
import type { Mutation } from "./mutations.ts";
import { allAgree } from "./quantify.ts";
import { staticText } from "./static-text.ts";
import { Analysis } from "./traversal.ts";
import {
  alternatives,
  combine,
  derive,
  entryFor,
  fromPrimitive,
  nullishness,
  plain,
  primitives,
  targetOf,
  truthiness,
  UNDEFINED,
  UNKNOWN,
  withDefault,
} from "./value.ts";
import type { Alt, CalleeTarget, Entry } from "./value.ts";

/**
 * An abstract evaluator for the test-file rules: every value an expression may hold, read off the
 * file alone. Rules reach every value they judge (a callee, a receiver, a path, an options object,
 * a delay, an expected class, a measurement, a walk) through `evaluate` or `calleeTargets`, every
 * key through `memberName` or `propertyKeyName`, and judge the alternatives through `quantify.ts`.
 *
 * `evaluate` returns alternatives (`Alt`), at most 64; more is `unknown`. Every compound operation
 * maps over the cartesian product of its operands' alternatives through `product`, the one way
 * operands combine, so no operation picks one operand alternative, flattens them, or merges them.
 * The evaluator follows exactly these steps, and nothing else:
 *
 * 1. Wrappers: parentheses, `await`, optional chains, `!` and TypeScript `as`/`satisfies`.
 * 2. A `const`, or a `let`/`var` that is never reassigned, to its initializer, through any chain
 *    of such aliases. A reassigned binding is `unknown`. An object or array literal the code
 *    changes in place (an assigned, updated or deleted member, or a mutating method such as
 *    `push`), through its own binding or any value this list resolves to it (an alias, a
 *    property, a local function's return), stays that literal, but every member read off it is
 *    `unknown`; a literal only pushed to (spread arguments included) keeps its written elements and
 *    leaves its end `unknown`. A change through a value the list does not resolve to the literal,
 *    such as a parameter, is not followed (`mutationsOf`).
 * 3. A key destructured from an object pattern (`const { a: b } = value`, `const { "a": b } =
 *    value`) to that member of each alternative of the value, as step 4 reads it; with a default
 *    (`const { a = 0 } = value`), to the default where the member is `undefined`, and to both
 *    where it may be (a value the list does not hold).
 * 4. A static member read (`a.b`, `a["b"]`, `` a[`b`] ``, `a[0]`) of each alternative: an object
 *    literal's last property with the key, after its spreads (each spread alternative builds its
 *    own object, last wins inside it; a key a spread the evaluator cannot open may set is
 *    `unknown`, a spread of `null` or `undefined` sets nothing, and a key no property sets is
 *    `undefined`); an array literal's element, after its spreads (an index at or past an unopened
 *    spread is `unknown`); a namespace import's export; and, off any other value, a `member` of it
 *    that keeps the key.
 * 5. A call to a local function (a declaration, or a function bound by step 2) to every value its
 *    body returns: an arrow's expression body, or each `return` in a block body. Each value
 *    records the call in `via`, so a consumer can judge it at the invocation that produced it.
 *    A call to `.extend(…)` on `it` or `test` (`const test = base.extend({ … })`) is that test API.
 * 6. A call to a static `evaluate`, `evaluateHandle`, `$eval` or `$$eval` member with a function
 *    argument to every value that callback returns.
 * 7. An import to its module and imported name, and a dynamic `import()` of a string to that
 *    module's namespace, whose members step 4 reads.
 * 8. A global name to itself, whatever local binding holds it (`const later = setTimeout` is
 *    `setTimeout`), and a member of `globalThis`, `window` or `self` to the global it names;
 *    `undefined`, `NaN` and `Infinity` to their values, and `void x` to `undefined`. A JSX tag
 *    (`<Later />`) reads its component binding as an identifier does, and a member tag
 *    (`<fixtures.Later />`) is read as step 4 reads `fixtures.Later`.
 * 9. A condition (`c ? a : b`) to the alternatives of both arms. A logical expression (`a || b`,
 *    `a ?? b`, `a && b`) to what JavaScript returns for each left alternative: the left operand
 *    where it decides (`a ?? b` for a non-nullish `a`, `a || b` for a truthy one, `a && b` for a
 *    falsy one), the right operand's alternatives where it does not, and both where the left is a
 *    value the list does not hold.
 * 10. Primitive operations with JavaScript semantics on typed primitive alternatives (string,
 *     number, boolean, `null`, `undefined`): template literals and `+` (string conversion when a
 *     side is a string, numeric addition otherwise), `-`, `*`, `/`, `%`, unary `-`; and the string
 *     methods `concat`, `trim`, `trimStart`, `trimEnd`, `toLowerCase`, `toUpperCase`, and an array
 *     literal's `join` (elements converted as `join` does: `null` and `undefined` are empty).
 *     An operation on an alternative that is no typed primitive keeps the expression (`opaque`);
 *     any other method call on a string is `opaque` too.
 *
 * The evaluator is one analysis on `traversal.ts`'s bounded traversal, which states how every
 * analysis walks: its memo, cycle cuts and budget. A cycle cut here is `unknown`, so a
 * self-referencing binding stops, and, for a call back into a function whose returns are being
 * read, `opaque` (the call itself); a walk past its budget is `unknown`. Values live in
 * `value.ts`, whose `derive` is the one way provenance (`named`, `via`) is marked; the literal
 * mutations of step 2 live in `mutations.ts`. A rule that classifies values recursively (a
 * measurement, a class read, a path) does so as its own `Analysis` on the same traversal, so it
 * shares the evaluator's budget. A parameter evaluates to itself (`parameter`), a `for…of` or
 * `for…in` binding to its iterable (`loop`), a call the evaluator does not follow to itself
 * (`opaque`), and anything else the list does not name to `opaque`. An alternative reached through
 * a property read (steps 3 and 4) keeps its container's `via`; one reached through a name (a
 * binding in steps 2 and 3, a property of a named value, a return in steps 5 and 6, or a step-10
 * result with a named operand) is marked `named`.
 *
 * `unknown` is never evidence: no rule grants an exemption on it, and no rule reports on it.
 */

/** The callee names that run a callback in the page and hand back what it returns. */
export const EVALUATES: ReadonlySet<string> = new Set(["evaluate", "evaluateHandle", "$eval", "$$eval"]);

/** The test APIs whose `.extend(fixtures)` is the same API with fixtures (Vitest's and Playwright's). */
const EXTENDABLE_TEST_APIS: ReadonlySet<string> = new Set(["it", "test"]);

/** The string methods step 10 assembles from a string receiver. */
const STRING_METHODS = new Map<string, (text: string) => string>([
  ["trim", (text) => text.trim()],
  ["trimStart", (text) => text.trimStart()],
  ["trimEnd", (text) => text.trimEnd()],
  ["toLowerCase", (text) => text.toLowerCase()],
  ["toUpperCase", (text) => text.toUpperCase()],
]);

/** The arithmetic step 10 computes on numbers, by operator; `+` on a string side concatenates first. */
const ARITHMETIC = new Map<string, (left: number, right: number) => number>([
  ["+", (left, right) => left + right],
  ["-", (left, right) => left - right],
  ["*", (left, right) => left * right],
  ["/", (left, right) => left / right],
  ["%", (left, right) => left % right],
]);

/** The globals whose value the evaluator knows (step 8). */
const GLOBAL_VALUES = new Map<string, Alt>([
  ["undefined", UNDEFINED],
  ["NaN", plain({ kind: "number", value: Number.NaN })],
  ["Infinity", plain({ kind: "number", value: Number.POSITIVE_INFINITY })],
]);

/** Each function's returned expressions, which depend on its syntax alone. */
const RETURNS = new WeakMap<ESTree.Node, ESTree.Node[]>();

/** The evaluator, reading literals through the file's mutations. */
const VALUES = new Analysis<Alt[]>([UNKNOWN]);

/** The evaluator the mutation index reads targets with: literals as written. */
const VALUES_AS_WRITTEN = new Analysis<Alt[]>([UNKNOWN]);

/**
 * The variable an identifier reads, through the scopes around it. A JSX tag such as `<InlineMenu />`
 * reads the component binding of its name; a lowercase tag such as `<button>` is an intrinsic
 * element and reads none.
 *
 * @param context - The rule context.
 * @param identifier - An identifier reference or a JSX tag name.
 * @returns The variable, or `undefined` for a global or an intrinsic tag.
 */
export function variableOf(context: Context, identifier: ESTree.Node): Variable | undefined {
  if (identifier.type !== "Identifier" && identifier.type !== "JSXIdentifier") return undefined;
  // A lowercase tag names an intrinsic element; the object of a member tag (`<fixtures.Widget />`) is a binding.
  if (
    identifier.type === "JSXIdentifier" &&
    identifier.parent.type !== "JSXMemberExpression" &&
    /^[a-z]/u.test(identifier.name)
  )
    return undefined;
  for (
    let scope: Scope | null = context.sourceCode.getScope(identifier);
    scope !== null;
    scope = scope.upper
  ) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
  }
  return undefined;
}

/**
 * The values a function returns (step 5): an arrow's expression body, or the argument of each
 * `return` in its block body, nested functions aside.
 *
 * @param context - The rule context.
 * @param fn - A function node.
 * @returns The returned expressions.
 */
export function returnedValues(context: Context, fn: ESTree.Node): ESTree.Node[] {
  if (!isFunction(fn)) return [];
  const cached = RETURNS.get(fn);
  if (cached !== undefined) return cached;
  const body = fn.body;
  const returned =
    body === null
      ? []
      : body.type !== "BlockStatement"
        ? [body]
        : descendants(context, body, "this-function").flatMap((node) =>
            node.type === "ReturnStatement" && node.argument !== null ? [node.argument] : []
          );
  RETURNS.set(fn, returned);
  return returned;
}

/** The name an import specifier takes from its module: a name, `default` or `*`. */
function importedName(specifier: ESTree.Node): string | undefined {
  if (specifier.type === "ImportDefaultSpecifier") return "default";
  if (specifier.type === "ImportNamespaceSpecifier") return "*";
  return specifier.type === "ImportSpecifier" ? moduleExportName(specifier.imported) : undefined;
}

/** Alternatives read through a name. */
function named(values: ReadonlyArray<Alt>): Alt[] {
  return values.map((value) => derive(value, { _tag: "name" }));
}

/**
 * The evaluator over one analysis: the rule context fixed, literals read through `mutationsOf`.
 * Every step runs on the bounded traversal, so its memo, cycle cuts and budget are the analysis's.
 */
function evaluator(
  context: Context,
  values: Analysis<Alt[]>,
  mutationsOf: (literal: ESTree.Node) => ReadonlyArray<Mutation>
) {
  const opaque = (node: ESTree.Node): Alt[] => [plain({ kind: "opaque", node })];

  /** A property's values, reached through a read off a container. */
  const narrow = (projected: ReadonlyArray<Alt>, container: Alt): Alt[] =>
    projected.map((value) => derive(value, { _tag: "projection", container }));

  /** An object literal's entries, one list per combination of its spreads' alternatives. */
  const objectAlternatives = (node: ESTree.ObjectExpression): Alt[] => {
    // A literal the code changes in place keeps its identity, but nothing it holds is known.
    if (mutationsOf(node).length > 0)
      return [plain({ kind: "object", node, entries: [{ _tag: "unopened-spread" }] })];
    const parts: Array<ReadonlyArray<Alt>> = node.properties.map((property): ReadonlyArray<Alt> => {
      if (property.type === "SpreadElement") return evaluateNode(property.argument);
      const key = propertyKeyName(property);
      return [
        plain({
          kind: "object",
          node: property,
          entries:
            key === undefined
              ? [{ _tag: "unopened-spread" }]
              : [{ _tag: "property", key, value: property.value, property }],
        }),
      ];
    });
    return combine(parts, (combination) => [
      plain({
        kind: "object",
        node,
        entries: combination.flatMap((part): Entry[] => {
          if (part.kind === "object") return [...part.entries];
          // Spreading `null` or `undefined` sets nothing.
          return part.kind === "null" || part.kind === "undefined" ? [] : [{ _tag: "unopened-spread" }];
        }),
      }),
    ]);
  };

  /** An array literal's elements, one list per combination of its spreads' alternatives. */
  const arrayAlternatives = (node: ESTree.ArrayExpression): Alt[] => {
    const mutations = mutationsOf(node);
    // Any change but a `push` may reorder or replace what the literal holds.
    if (mutations.some((mutation) => mutation.kind === "other"))
      return [plain({ kind: "array", node, elements: [], complete: false })];
    const parts: Array<ReadonlyArray<Alt>> = node.elements.map((element): ReadonlyArray<Alt> =>
      element?.type === "SpreadElement"
        ? evaluateNode(element.argument)
        : [plain({ kind: "array", node, elements: [element], complete: true })]
    );
    // A `push` appends: the written elements stay, but the end of the list is not known.
    const pushed = mutations.length > 0;
    return combine(parts, (combination) => {
      const elements: Array<ESTree.Node | null> = [];
      for (const part of combination) {
        if (part.kind !== "array") return [plain({ kind: "array", node, elements, complete: false })];
        elements.push(...part.elements);
        if (!part.complete) return [plain({ kind: "array", node, elements, complete: false })];
      }
      return [plain({ kind: "array", node, elements, complete: !pushed })];
    });
  };

  /** What one alternative holds under a key (step 4). */
  const memberOf = (container: Alt, key: string, at: ESTree.Node): Alt[] => {
    switch (container.kind) {
      case "object": {
        const entry = entryFor(container, key);
        if (entry === "unknown") return [UNKNOWN];
        return entry === undefined ? [UNDEFINED] : narrow(evaluateNode(entry.value), container);
      }
      case "array": {
        const index = Number(key);
        if (!Number.isInteger(index)) return [plain({ kind: "member", object: container, key, at })];
        if (index >= container.elements.length) return container.complete ? [UNDEFINED] : [UNKNOWN];
        const element = container.elements[index];
        return element === null || element === undefined
          ? [UNDEFINED]
          : narrow(evaluateNode(element), container);
      }
      case "import":
        return container.imported === "*"
          ? [plain({ kind: "import", source: container.source, imported: key })]
          : [plain({ kind: "member", object: container, key, at })];
      case "unknown":
        return [UNKNOWN];
      default:
        return [plain({ kind: "member", object: container, key, at })];
    }
  };

  /** Every value a member read off an expression may hold (step 4). */
  const projectionOf = (object: ESTree.Node, key: string, at: ESTree.Node): Alt[] =>
    combine([evaluateNode(object)], ([container]) =>
      container === undefined ? [UNKNOWN] : memberOf(container, key, at)
    );

  /** Every value a function returns, each evaluated, with the function on the active path. */
  const returnsOf = (fn: ESTree.Node): Alt[] =>
    values.pass(
      fn,
      () => alternatives(...returnedValues(context, fn).map((value) => evaluateNode(value))),
      () => [UNKNOWN]
    );

  /** One callee alternative called with the call's arguments (steps 5, 6 and 10). */
  const callOne = (call: ESTree.CallExpression, callee: Alt): Alt[] => {
    if (callee.kind === "function") {
      // A call back into a function whose returns are being read is the call itself.
      if (values.cutsBackTo(callee.fn)) return opaque(call);
      return returnsOf(callee.fn).map((value) => derive(value, { _tag: "return", call }));
    }
    if (callee.kind !== "member") return opaque(call);
    const receiver = callee.object;
    // `base.extend(fixtures)` on a test API is that API, so a test or hook it registers is one.
    if (callee.key === "extend" && EXTENDABLE_TEST_APIS.has(targetOf(receiver)?.path.at(0) ?? ""))
      return [receiver];
    if (EVALUATES.has(callee.key)) {
      const callbacks = combine(
        call.arguments.map((argument) => evaluateNode(argument)),
        (combination) => combination.filter((argument) => argument.kind === "function")
      );
      if (callbacks.length > 0) {
        return alternatives(
          ...callbacks.map((callback) =>
            callback.kind === "function" ? named(returnsOf(callback.fn)) : [UNKNOWN]
          )
        );
      }
      return opaque(call);
    }
    const map = STRING_METHODS.get(callee.key);
    if (map !== undefined && receiver.kind === "string")
      return [fromPrimitive(map(receiver.value), [receiver])];
    if (callee.key === "concat" && receiver.kind === "string") {
      return combine(
        call.arguments.map((argument) => evaluateNode(argument)),
        (combination) => {
          const operands = primitives(combination);
          return operands === undefined
            ? opaque(call)
            : [fromPrimitive(receiver.value.concat(...operands.map(String)), [receiver, ...combination])];
        }
      );
    }
    if (callee.key === "join" && receiver.kind === "array") {
      if (!receiver.complete) return opaque(call);
      const [separator] = call.arguments;
      return combine(
        [
          separator === undefined ? [fromPrimitive(",")] : evaluateNode(separator),
          ...receiver.elements.map((element) => (element === null ? [UNDEFINED] : evaluateNode(element))),
        ],
        ([glue, ...items]) => {
          const operands = primitives(items);
          if (glue?.kind !== "string" || operands === undefined) return opaque(call);
          const text = operands
            .map((value) => (value === null || value === undefined ? "" : String(value)))
            .join(glue.value);
          return [fromPrimitive(text, [glue, ...items])];
        }
      );
    }
    return opaque(call);
  };

  /** A template literal's values (step 10). */
  const templateOf = (node: ESTree.TemplateLiteral): Alt[] =>
    combine(
      node.expressions.map((part) => evaluateNode(part)),
      (combination) => {
        const operands = primitives(combination);
        if (operands === undefined) return opaque(node);
        let text = "";
        node.quasis.forEach((quasi, index) => {
          text += staticText(quasi);
          if (index < operands.length) text += String(operands[index]);
        });
        return [fromPrimitive(text, combination)];
      }
    );

  /** A binary operation's values (step 10). */
  const binaryOf = (node: ESTree.BinaryExpression | ESTree.PrivateInExpression): Alt[] => {
    const arithmetic = ARITHMETIC.get(node.operator);
    if (node.left.type === "PrivateIdentifier" || arithmetic === undefined) return opaque(node);
    return combine([evaluateNode(node.left), evaluateNode(node.right)], (combination) => {
      const operands = primitives(combination);
      if (operands === undefined) return opaque(node);
      const [left, right] = operands;
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- step 10's `+` converts to strings exactly when a side is a string
      if (node.operator === "+" && (typeof left === "string" || typeof right === "string")) {
        return [fromPrimitive(String(left) + String(right), combination)];
      }
      return [fromPrimitive(arithmetic(Number(left), Number(right)), combination)];
    });
  };

  /**
   * A logical expression's values (step 9): each left alternative JavaScript returns as it is, the
   * right operand's alternatives where JavaScript evaluates it, and both where the evaluator cannot
   * tell which.
   */
  const logicalOf = (node: ESTree.LogicalExpression): Alt[] => {
    const right = (): Alt[] => evaluateNode(node.right);
    const lists = evaluateNode(node.left).map((left): ReadonlyArray<Alt> => {
      const decides =
        node.operator === "??"
          ? { nullish: "right", present: "left", either: "both" }[nullishness(left)]
          : node.operator === "||"
            ? { falsy: "right", truthy: "left", either: "both" }[truthiness(left)]
            : { falsy: "left", truthy: "right", either: "both" }[truthiness(left)];
      if (decides === "left") return [left];
      return decides === "right" ? right() : [left, ...right()];
    });
    return alternatives(...lists);
  };

  /**
   * A destructured member's values (step 3): the member of each alternative of the value, with a
   * property's default applied as `withDefault` applies it.
   */
  const destructuredOf = (
    init: ESTree.Node,
    key: string,
    fallback: ESTree.Node | undefined,
    at: ESTree.Node
  ): Alt[] =>
    combine([named(evaluateNode(init))], ([container]) => {
      if (container === undefined) return [UNKNOWN];
      const members = memberOf(container, key, at);
      return fallback === undefined ? members : withDefault(members, () => named(evaluateNode(fallback)));
    });

  /** What a variable's single definition holds (steps 2, 3 and 7), the variable on the active path. */
  const definitionOf = (variable: Variable): Alt[] => {
    const [def, ...others] = variable.defs;
    if (def === undefined || others.length > 0) return [UNKNOWN];
    switch (def.type) {
      case "ImportBinding": {
        const declaration = def.parent;
        const imported = importedName(def.node);
        return declaration?.type === "ImportDeclaration" && imported !== undefined
          ? [plain({ kind: "import", source: declaration.source.value, imported })]
          : [UNKNOWN];
      }
      case "Parameter": {
        const params = isFunction(def.node) ? def.node.params : [];
        const index = params.findIndex(
          (param) => param === def.name || (param.type === "AssignmentPattern" && param.left === def.name)
        );
        return [plain({ kind: "parameter", fn: def.node, index })];
      }
      case "FunctionName":
        return [plain({ kind: "function", fn: def.node })];
      case "Variable":
        break;
      default:
        return [UNKNOWN];
    }
    const declarator = def.node;
    if (declarator.type !== "VariableDeclarator") return [UNKNOWN];
    if (variable.references.some((reference) => reference.isWrite() && !reference.init)) return [UNKNOWN];
    if (declarator.init === null) {
      const loop = declarator.parent.parent;
      return loop?.type === "ForOfStatement" || loop?.type === "ForInStatement"
        ? [plain({ kind: "loop", iterable: loop.right })]
        : [UNKNOWN];
    }
    if (declarator.id.type === "Identifier") return named(evaluateNode(declarator.init));
    if (declarator.id.type !== "ObjectPattern") return [UNKNOWN];
    for (const property of declarator.id.properties) {
      if (property.type !== "Property") continue;
      const withFallback = property.value.type === "AssignmentPattern" ? property.value : undefined;
      const target = withFallback?.left ?? property.value;
      if (target !== def.name) continue;
      const key = propertyKeyName(property);
      if (key === undefined) return [UNKNOWN];
      return destructuredOf(declarator.init, key, withFallback?.right, property);
    }
    return [UNKNOWN];
  };

  /** What an identifier's binding holds (steps 2, 3, 7 and 8), a JSX component tag's included. */
  const bindingOf = (identifier: ESTree.Node): Alt[] => {
    if (identifier.type !== "Identifier" && identifier.type !== "JSXIdentifier") return [UNKNOWN];
    const variable = variableOf(context, identifier);
    // An environment global (the config's `env` or `globals`) has a variable with no definition.
    if (variable === undefined || variable.defs.length === 0) {
      const known = GLOBAL_VALUES.get(identifier.name);
      return [known ?? plain({ kind: "global", name: identifier.name, at: identifier })];
    }
    return values.pass(
      variable,
      () => definitionOf(variable),
      () => [UNKNOWN]
    );
  };

  /** Every value one unwrapped expression may hold, the expression already on the active path. */
  const expressionOf = (expression: ESTree.Node): Alt[] => {
    if (isFunction(expression)) return [plain({ kind: "function", fn: expression })];
    switch (expression.type) {
      case "Literal": {
        if ("regex" in expression) {
          return [plain({ kind: "regex", pattern: expression.regex.pattern, flags: expression.regex.flags })];
        }
        const value = expression.value;
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ESTree tags every literal kind `Literal`; the value's type is the only tag a bigint literal has
        if (typeof value === "bigint") return opaque(expression);
        return [fromPrimitive(value)];
      }
      case "Identifier":
      case "JSXIdentifier":
        return bindingOf(expression);
      case "JSXMemberExpression":
        return projectionOf(expression.object, expression.property.name, expression);
      case "MemberExpression": {
        const key = memberName(expression);
        return key === undefined ? opaque(expression) : projectionOf(expression.object, key, expression);
      }
      case "CallExpression":
        return combine([evaluateNode(expression.callee)], ([callee]) =>
          callee === undefined ? [UNKNOWN] : callOne(expression, callee)
        );
      case "ConditionalExpression":
        return alternatives(evaluateNode(expression.consequent), evaluateNode(expression.alternate));
      case "LogicalExpression":
        return logicalOf(expression);
      case "ImportExpression":
        return combine([evaluateNode(expression.source)], ([source]) =>
          source?.kind === "string"
            ? [plain({ kind: "import", source: source.value, imported: "*" })]
            : opaque(expression)
        );
      case "ObjectExpression":
        return objectAlternatives(expression);
      case "ArrayExpression":
        return arrayAlternatives(expression);
      case "TemplateLiteral":
        return templateOf(expression);
      case "BinaryExpression":
        return binaryOf(expression);
      case "UnaryExpression":
        if (expression.operator === "void") return [UNDEFINED];
        if (expression.operator !== "-") return opaque(expression);
        return combine([evaluateNode(expression.argument)], ([operand]) =>
          operand?.kind === "number" ? [fromPrimitive(-operand.value, [operand])] : opaque(expression)
        );
      default:
        return opaque(expression);
    }
  };

  /** Every value an expression may hold: one kept step of the analysis per unwrapped expression. */
  const evaluateNode = (node: ESTree.Node): Alt[] => {
    const expression = unwrap(node);
    return values.run(
      context,
      expression,
      () => expressionOf(expression),
      () => [UNKNOWN]
    );
  };

  return evaluateNode;
}

/**
 * Every place the file changes an object or array literal in place, as `mutations.ts` indexes it,
 * with targets read by this evaluator as written.
 *
 * @param context - The rule context.
 * @param literal - An object or array literal.
 * @returns Its mutations, in source order.
 */
export function mutationsOf(context: Context, literal: ESTree.Node): ReadonlyArray<Mutation> {
  return mutationsIn(context, literal, (target) => evaluator(context, VALUES_AS_WRITTEN, () => [])(target));
}

/**
 * Every value an expression may hold, by the steps in this module's contract.
 *
 * @param context - The rule context.
 * @param node - Any expression.
 * @returns The alternatives, never empty, at most 64.
 */
export function evaluate(context: Context, node: ESTree.Node): Alt[] {
  const values = evaluator(context, VALUES, (literal) => mutationsOf(context, literal))(node);
  return values.length === 0 ? [UNKNOWN] : [...values];
}

/**
 * The target of every alternative a callee may hold, in order: one entry per alternative, with
 * `undefined` for an alternative that names no function, so a rule can tell whether every
 * alternative is the same API.
 *
 * @param context - The rule context.
 * @param callee - A call's callee, or any expression that names a function.
 * @returns One target, or `undefined`, per alternative.
 */
export function calleeTargets(context: Context, callee: ESTree.Node): Array<CalleeTarget | undefined> {
  return evaluate(context, callee).map(targetOf);
}

/**
 * The API each alternative of a callee names in full, module left off, such as
 * `vi.useFakeTimers`: one entry per alternative, `undefined` for one that names no function.
 *
 * @param context - The rule context.
 * @param callee - A call's callee.
 * @returns One API, or `undefined`, per alternative.
 */
export function calleeApis(context: Context, callee: ESTree.Node): Array<string | undefined> {
  return calleeTargets(context, callee).map((target) => target?.path.join("."));
}

/**
 * Whether a callee is one API in every alternative, such as `Math.abs` or `JSON.parse`.
 *
 * @param context - The rule context.
 * @param callee - A call's callee.
 * @param api - The API's dotted name, module left off.
 * @returns Whether every alternative names that API.
 */
export function isApi(context: Context, callee: ESTree.Node, api: string): boolean {
  return allAgree(calleeApis(context, callee)) === api;
}
