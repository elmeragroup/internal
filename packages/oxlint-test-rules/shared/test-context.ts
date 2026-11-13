import type { Context, ESTree } from "@oxlint/plugins";

import { memberName } from "./ast-names.ts";
import { descendants, isFunction, unwrap, within } from "./ast-walk.ts";
import { allAgree } from "./quantify.ts";
import { calleeApis, calleeTargets, evaluate, EVALUATES, returnedValues, variableOf } from "./resolve.ts";
import { isolated } from "./traversal.ts";

/**
 * Test context for the test-file rules: where a function is registered and how surely, which
 * setup hooks run before a body, which code a body reaches, and where a local function is called.
 * Test APIs are recognised through `calleeTargets`, so an aliased or namespace import (`it as
 * spec`, `vt.beforeEach`) is the same API.
 *
 * The execution model: a registration is `guaranteed` when every alternative of its callee is the
 * same API, and `possible` otherwise (`const hook = flag ? beforeEach : noop`). A call's position
 * in a body is `guaranteed` when nothing between it and the body branches (blocks and `try`
 * blocks run in order), and `possible` under an `if`, a loop, a `catch`, a `switch` case, a
 * condition or a logical operand. A call inside a nested function is not part of the body.
 */

/** The test API roots whose callback is one test. */
const TEST_ROOTS = new Set(["it", "test", "bench"]);

/** The setup hooks, in the order Vitest runs their kinds. */
const HOOK_APIS = ["beforeAll", "beforeEach"] as const;

/** A setup hook API. */
type HookApi = (typeof HOOK_APIS)[number];

/** The chain steps between `expect(…)` and its matcher that change how, not what, it asserts. */
const MODIFIERS = new Set(["not", "resolves", "rejects"]);

/** The `expect` entry points whose first argument is the value under assertion. */
const EXPECT_ENTRIES = new Set(["expect", "expect.soft", "expect.element", "expect.poll"]);

/** The parents under which a call may or may not run, whichever way its body goes. */
const BRANCHES = new Set([
  "IfStatement",
  "ConditionalExpression",
  "LogicalExpression",
  "SwitchCase",
  "CatchClause",
  "WhileStatement",
  "DoWhileStatement",
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
]);

/** How surely something happens when the code around it runs. */
export type Certainty = "guaranteed" | "possible";

/** One `expect(actual).matcher(...expected)` call, read off its syntax. */
type Assertion = {
  /**
   * The values under assertion: the entry call's first argument, or every value an `expect.poll`
   * callback returns.
   */
  readonly actuals: ReadonlyArray<ESTree.Node>;
  /** The matcher's name, such as `toBe` or `toHaveClass`. */
  readonly matcher: string;
  /** The matcher's arguments. */
  readonly expected: ReadonlyArray<ESTree.Node>;
};

/** One call that hands a function to a test API or a setup hook, and how surely that API runs it. */
type Registration = { readonly call: ESTree.CallExpression; readonly certainty: Certainty };

/** A setup hook registered in a suite. */
type Hook = {
  readonly fn: ESTree.Node;
  readonly api: HookApi;
  readonly call: ESTree.CallExpression;
  readonly certainty: Certainty;
};

/**
 * One way a body runs: the setup hooks that run before it, in order, or none when it may run
 * outside the runner (a `possible` registration's other alternatives may call it directly).
 */
type Execution = { readonly before: ReadonlyArray<Hook> };

/**
 * The first name every alternative of a callee reaches, through calls and members: `it` for
 * `spec(…)` with `import { it as spec }`, for `vt.it.each(rows)(…)` off a namespace import, and
 * `describe` for `describe.concurrent(…)`. One entry per alternative, `undefined` for one that
 * names no function.
 *
 * @param context - The rule context.
 * @param callee - A call's callee.
 * @returns The roots, one per alternative.
 */
export function runnerRoots(context: Context, callee: ESTree.Node): Array<string | undefined> {
  let chain: ESTree.Node = unwrap(callee);
  while (chain.type === "CallExpression") chain = unwrap(chain.callee);
  return calleeTargets(context, chain).map((target) => target?.path.at(0));
}

/** Every API a call may name in full, such as `vi.useFakeTimers` or `beforeEach`, one per alternative. */
function apisOf(context: Context, call: ESTree.Node): Array<string | undefined> {
  return call.type === "CallExpression" ? calleeApis(context, call.callee) : [];
}

/**
 * Read a matcher call as an assertion: `expect(x).toBe(y)`, `expect.soft(x, m).not.toEqual(y)`,
 * `expect(x)["not"]["toBe"](y)`, `await expect.element(x).toHaveClass(y)` or
 * `expect.poll(() => x).toBe(y)`, under any alias of `expect`. Matcher and modifier keys are read
 * with `memberName`.
 *
 * @param context - The rule context.
 * @param call - Any call expression.
 * @returns The assertion, or `undefined` when the call is not a matcher on an `expect` chain.
 */
export function assertionOf(context: Context, call: ESTree.CallExpression): Assertion | undefined {
  const callee = unwrap(call.callee);
  const matcher = memberName(callee);
  if (callee.type !== "MemberExpression" || matcher === undefined) return undefined;
  let subject = unwrap(callee.object);
  while (subject.type === "MemberExpression" && MODIFIERS.has(memberName(subject) ?? "")) {
    subject = unwrap(subject.object);
  }
  const entries = apisOf(context, subject).filter(
    (entry) => entry !== undefined && EXPECT_ENTRIES.has(entry)
  );
  if (subject.type !== "CallExpression" || entries.length === 0) return undefined;
  const [first] = subject.arguments;
  if (first === undefined) return { actuals: [], matcher, expected: call.arguments };
  if (!entries.includes("expect.poll")) return { actuals: [first], matcher, expected: call.arguments };
  // Each alternative of the poll argument: a callback stands for what it returns, anything else for itself.
  const actuals = evaluate(context, first).flatMap((alternative) =>
    alternative.kind === "function" ? returnedValues(context, alternative.fn) : [first]
  );
  return { actuals: [...new Set(actuals)], matcher, expected: call.arguments };
}

/**
 * The functions one file registers: tests and hooks by every registration, page callbacks by call;
 * and, by function, every call whose callee may be it and every JSX element whose tag may be it,
 * each callee and tag read through `evaluate`.
 */
type Registry = {
  readonly tests: ReadonlyMap<ESTree.Node, ReadonlyArray<Registration>>;
  readonly hooks: ReadonlyArray<Hook>;
  readonly page: ReadonlyMap<ESTree.Node, ReadonlyArray<ESTree.CallExpression>>;
  readonly calls: ReadonlyMap<ESTree.Node, ReadonlyArray<ESTree.CallExpression>>;
  readonly renders: ReadonlyMap<ESTree.Node, ReadonlyArray<ESTree.JSXOpeningElement>>;
};

/** Each file's registry, built once per program. */
const REGISTRIES = new WeakMap<ESTree.Node, Registry>();

/** Add a value to a map of lists. */
function addTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  map.set(key, [...(map.get(key) ?? []), value]);
}

/**
 * The functions a file hands to a test API (`it`, `test`, `bench`), a setup hook or a page
 * `evaluate` call, found from the calls forwards: every argument is evaluated, so a callback bound
 * to a name, held in an object or returned by a local function counts as well as an inline one.
 * Every registration is kept.
 */
function registryOf(context: Context): Registry {
  const program = context.sourceCode.ast;
  const cached = REGISTRIES.get(program);
  if (cached !== undefined) return cached;
  const registry = isolated(() => buildRegistry(context, program));
  REGISTRIES.set(program, registry);
  return registry;
}

/** The registry of one file, built from its calls and JSX elements. */
function buildRegistry(context: Context, program: ESTree.Node): Registry {
  const tests = new Map<ESTree.Node, Registration[]>();
  const hooks: Hook[] = [];
  const page = new Map<ESTree.Node, ESTree.CallExpression[]>();
  const calls = new Map<ESTree.Node, ESTree.CallExpression[]>();
  const renders = new Map<ESTree.Node, ESTree.JSXOpeningElement[]>();
  /** Every function a callee or tag may be. */
  const functionsOf = (node: ESTree.Node): ESTree.Node[] =>
    evaluate(context, node).flatMap((alternative) =>
      alternative.kind === "function" ? [alternative.fn] : []
    );
  for (const node of descendants(context, program, "into-functions")) {
    if (node.type === "JSXOpeningElement") {
      for (const fn of new Set(functionsOf(node.name))) addTo(renders, fn, node);
      continue;
    }
    if (node.type !== "CallExpression") continue;
    for (const fn of new Set(functionsOf(node.callee))) addTo(calls, fn, node);
    const roots = runnerRoots(context, node.callee);
    const isTest = roots.some((root) => root !== undefined && TEST_ROOTS.has(root));
    const apis = apisOf(context, node);
    const hookApis = HOOK_APIS.filter((api) => apis.includes(api));
    const isEvaluate = EVALUATES.has(memberName(node.callee) ?? "");
    if (!isTest && hookApis.length === 0 && !isEvaluate) continue;
    const testCertainty: Certainty = allAgree(roots) !== undefined && isTest ? "guaranteed" : "possible";
    const hookCertainty: Certainty = allAgree(apis) === undefined ? "possible" : "guaranteed";
    for (const argument of node.arguments) {
      for (const alternative of evaluate(context, argument)) {
        if (alternative.kind !== "function") continue;
        const fn = alternative.fn;
        if (isTest) addTo(tests, fn, { call: node, certainty: testCertainty });
        for (const api of hookApis) hooks.push({ fn, api, call: node, certainty: hookCertainty });
        if (isEvaluate) addTo(page, fn, node);
      }
    }
  }
  return { tests, hooks, page, calls, renders };
}

/**
 * How surely a node runs when a body runs: `guaranteed` when only blocks and `try` blocks lie
 * between them, `possible` under a branch, or `undefined` when a nested function lies between them
 * or the node is outside the body.
 *
 * @param node - Any AST node.
 * @param body - A function or the program.
 * @returns The certainty, or `undefined`.
 */
export function positionIn(node: ESTree.Node, body: ESTree.Node): Certainty | undefined {
  let certainty: Certainty = "guaranteed";
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent === body) return certainty;
    if (isFunction(parent)) return undefined;
    if (BRANCHES.has(parent.type)) certainty = "possible";
  }
  return undefined;
}

/** The suite a call is written in: the nearest function around it, or the module. */
function suiteOf(call: ESTree.Node): ESTree.Node {
  for (let parent = call.parent; parent !== null; parent = parent.parent) {
    if (isFunction(parent) || parent.type === "Program") return parent;
  }
  return call;
}

/** The suites around a call, outermost first. */
function suitesAround(call: ESTree.Node): ESTree.Node[] {
  const suites: ESTree.Node[] = [];
  for (let suite: ESTree.Node | null = call.parent; suite !== null; suite = suite.parent) {
    if (suite.type === "Program" || isFunction(suite)) suites.unshift(suite);
  }
  return suites;
}

/** The hooks of one kind registered in a suite, in source order, each as surely as it is registered. */
function hooksIn(context: Context, suite: ESTree.Node, api: HookApi): Hook[] {
  return registryOf(context)
    .hooks.filter((hook) => hook.api === api && suiteOf(hook.call) === suite)
    .flatMap((hook): Hook[] => {
      const position = positionIn(hook.call, suite);
      if (position === undefined) return [];
      return [{ ...hook, certainty: position === "guaranteed" ? hook.certainty : "possible" }];
    })
    .sort((left, right) => left.call.start - right.call.start);
}

/**
 * The setup hooks that run before code a call registers, in Vitest's order: every `beforeAll`,
 * outermost suite first, then every `beforeEach`, outermost suite first, and within one suite in
 * the order they are registered. Hooks of sibling suites do not run.
 */
function hooksAround(context: Context, call: ESTree.Node): Hook[] {
  const suites = suitesAround(call);
  return HOOK_APIS.flatMap((api) => suites.flatMap((suite) => hooksIn(context, suite, api)));
}

/**
 * The registered test or setup hook a node runs in: the nearest function around it that the file
 * hands to a test API or a hook, inline or through a binding.
 *
 * @param context - The rule context.
 * @param node - Any AST node.
 * @returns The body, or `undefined` outside any.
 */
export function owningBody(context: Context, node: ESTree.Node): ESTree.Node | undefined {
  const { tests, hooks } = registryOf(context);
  for (let parent: ESTree.Node | null = node; parent !== null; parent = parent.parent) {
    if (isFunction(parent) && (tests.has(parent) || hooks.some((hook) => hook.fn === parent))) return parent;
  }
  return undefined;
}

/**
 * Every way a registered test or setup hook runs. A test runs once per registration, after the
 * hooks around that registration; a hook runs after the hooks that precede it around its own
 * registration. A `possible` registration adds a run with no hooks, since its callee's other
 * alternatives may call the body directly.
 *
 * @param context - The rule context.
 * @param body - A test or hook callback.
 * @returns The runs, or none for a function nothing registers.
 */
export function executionsOf(context: Context, body: ESTree.Node): Execution[] {
  const { tests, hooks } = registryOf(context);
  const registrations = tests.get(body);
  if (registrations !== undefined) {
    return registrations.flatMap((registration): Execution[] => [
      { before: hooksAround(context, registration.call) },
      ...(registration.certainty === "possible" ? [{ before: [] }] : []),
    ]);
  }
  return hooks
    .filter((hook) => hook.fn === body)
    .flatMap((hook): Execution[] => {
      const around = hooksAround(context, hook.call);
      const index = around.findIndex((other) => other.fn === hook.fn && other.call === hook.call);
      return [
        { before: index < 0 ? [] : around.slice(0, index) },
        ...(hook.certainty === "possible" ? [{ before: [] }] : []),
      ];
    });
}

/**
 * The page `evaluate` calls a function is handed to, inline or through a binding: where a page
 * callback runs, as a call site is where a helper runs.
 *
 * @param context - The rule context.
 * @param fn - A function node.
 * @returns The `evaluate` calls, or none for a function no `evaluate` receives.
 */
export function pageCallSitesOf(context: Context, fn: ESTree.Node): ReadonlyArray<ESTree.CallExpression> {
  return registryOf(context).page.get(fn) ?? [];
}

/**
 * Whether a node runs in the page: inside a function the file hands to a page `evaluate` call,
 * inline or through a binding.
 *
 * @param context - The rule context.
 * @param node - Any AST node.
 * @returns Whether it runs in the page rather than the test process.
 */
export function runsInPage(context: Context, node: ESTree.Node): boolean {
  const { page } = registryOf(context);
  for (let parent: ESTree.Node | null = node.parent; parent !== null; parent = parent.parent) {
    if (isFunction(parent) && page.has(parent)) return true;
  }
  return false;
}

/**
 * The code an assertion's evidence may come from, once per way its test runs: the test and the
 * setup hooks that run before it; or, for an assertion in a helper outside any test, only the
 * function it sits in (the module for top-level code). An exemption holds only when every set
 * grants it.
 *
 * @param context - The rule context.
 * @param node - The assertion.
 * @returns One list of roots per run.
 */
export function evidenceSets(context: Context, node: ESTree.Node): ESTree.Node[][] {
  const { tests } = registryOf(context);
  for (let parent: ESTree.Node | null = node; parent !== null; parent = parent.parent) {
    if (isFunction(parent) && tests.has(parent)) {
      const test = parent;
      return executionsOf(context, test).map((execution) => [
        test,
        ...execution.before.map((hook) => hook.fn),
      ]);
    }
  }
  return [[suiteOf(node)]];
}

/**
 * The code reachable from roots: the roots themselves, plus the declaration of every local binding
 * they read (JSX component tags included), followed transitively.
 *
 * @param context - The rule context.
 * @param roots - Test callbacks, hook callbacks, or any nodes.
 * @returns The roots and each reached declaration, none nested in another.
 */
export function reachOf(context: Context, roots: ReadonlyArray<ESTree.Node>): ESTree.Node[] {
  const regions = [...roots];
  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index];
    if (region === undefined) break;
    for (const node of descendants(context, region, "into-functions")) {
      if (node.type !== "Identifier" && node.type !== "JSXIdentifier") continue;
      // Every definition a binding has: one for a `const`, one per declaration otherwise.
      for (const def of variableOf(context, node)?.defs ?? []) {
        if (def.type !== "Variable" && def.type !== "FunctionName") continue;
        const declaration = def.node;
        if (regions.some((seen) => within(declaration, seen))) continue;
        regions.push(declaration);
      }
    }
  }
  return regions;
}

/**
 * Where a local function is called: every call whose callee may be it, however the callee reaches
 * it (its name, an alias, an object property, a destructured binding, a local function's return).
 *
 * @param context - The rule context.
 * @param fn - A function node.
 * @returns The call expressions, or none for a function no call reaches.
 */
export function callSitesOf(context: Context, fn: ESTree.Node): ReadonlyArray<ESTree.CallExpression> {
  return registryOf(context).calls.get(fn) ?? [];
}

/**
 * Where a local component is rendered: every JSX element whose tag may be it, which runs the
 * component as a call site runs a helper. A lowercase tag is an intrinsic element and renders none.
 *
 * @param context - The rule context.
 * @param fn - A function node.
 * @returns The opening elements, or none for a function no element renders.
 */
export function renderSitesOf(context: Context, fn: ESTree.Node): ReadonlyArray<ESTree.JSXOpeningElement> {
  return registryOf(context).renders.get(fn) ?? [];
}
