import type { Context, ESTree } from "@oxlint/plugins";

import { descendants, isFunction, isPromiseCallback } from "./ast-walk.ts";
import { allAgree } from "./quantify.ts";
import { calleeTargets, evaluate } from "./resolve.ts";
import {
  callSitesOf,
  executionsOf,
  owningBody,
  pageCallSitesOf,
  positionIn,
  renderSitesOf,
  runsInPage,
} from "./test-context.ts";
import type { Certainty } from "./test-context.ts";
import { Analysis, isolated } from "./traversal.ts";
import { entryFor, GLOBAL_OBJECTS } from "./value.ts";
import type { Alt, CalleeTarget } from "./value.ts";

/**
 * Simulated-clock tracking for the test-file rules.
 *
 * The model: every clock install or restore is an event that is `guaranteed` or `possible`. It is
 * `guaranteed` when every alternative of its callee is the same API, its call sits in its body
 * with no branch between them (`test-context.ts`'s `positionIn`), and, for an event in a setup
 * hook, the hook's registration is `guaranteed` too; anything else is `possible`. A call inside a
 * nested function of a body is no event of that body.
 *
 * Coverage is judged where time is captured: a clock read (`Date.now()`, `performance.now()`,
 * `process.hrtime()`, `new Date()` construction, and `date.getTime()` at its date's construction)
 * or a wait, each where it read the slot a fake clock replaces (`captureSite`): an alias of a
 * native (`const later = setTimeout`) keeps what the slot held where the alias ran. For every way the body around it runs (`executionsOf`), coverage folds from empty over
 * the events of the setup hooks that run first, then the body's own events before that point: a
 * `guaranteed` event replaces coverage with the APIs it fakes, and a `possible` one intersects it.
 * The capture is covered only when every run covers it. A capture in a helper is judged at every
 * call site, or, when the judged value came out of the helper through a known call (`Alt.via`), at
 * that call alone; in a local component at every JSX element that renders it; and in a page
 * `evaluate` callback at every `evaluate` call.
 *
 * The host (the test's own `Date`, timers and `performance`) and the page (code inside a page
 * `evaluate` callback) have separate clocks: `vi` changes the host's, `page.clock` the page's.
 */

/** A clock API a test can fake: one scheduling or reading API each. */
export type ClockApi = "setTimeout" | "setInterval" | "setImmediate" | "Date" | "performance" | "hrtime";

/** Where a clock read or wait runs: the test process, or a page `evaluate` callback. */
type ClockRealm = "host" | "page";

/** The fake-timer names that schedule or read time, each the API it fakes. `clear*` fakes nothing. */
const FAKEABLE: ReadonlySet<ClockApi> = new Set([
  "setTimeout",
  "setInterval",
  "setImmediate",
  "Date",
  "performance",
  "hrtime",
]);

/** Whether a `toFake` name is a clock API it fakes. */
function isFakeable(name: string | undefined): name is ClockApi {
  return [...FAKEABLE].some((api) => api === name);
}

/** What `vi.useFakeTimers()` fakes with no `toFake`: Vitest's default, every API here. */
const ALL_APIS: ReadonlySet<ClockApi> = FAKEABLE;

/** What Playwright's `clock.install()` and `pauseAt()` take over in the page. */
const PAGE_CLOCK_APIS: ReadonlySet<ClockApi> = new Set(["setTimeout", "setInterval", "Date", "performance"]);

/**
 * A helper the repository's tests call to install a fake clock, such as a `useFakeTimeouts()` that
 * fakes `setTimeout` only, and the clock APIs it leaves faked. Rules take these as an option, since
 * only the repository knows what its helpers fake.
 */
export type FakeClockHelper = {
  /** The helper's dotted name as a call spells it, module left off: `useFakeTimeouts`. */
  readonly name: string;
  /** The clock APIs a call to it leaves faked. */
  readonly fakes: ReadonlyArray<ClockApi>;
};

/** The JSON schema of a rule option that lists the repository's fake-clock helpers. */
export const FAKE_CLOCK_HELPERS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      fakes: {
        type: "array",
        items: { enum: ["setTimeout", "setInterval", "setImmediate", "Date", "performance", "hrtime"] },
      },
    },
    required: ["name", "fakes"],
    additionalProperties: false,
  },
} as const;

/** One clock change: the realm it changes, the APIs it leaves faked, and the API that makes it. */
type Change = { readonly realm: ClockRealm; readonly faked: ReadonlySet<ClockApi>; readonly api: string };

/** One clock event in one realm: its call, the APIs it surely leaves faked, and whether its callee is one API. */
type ClockEvent = {
  readonly call: ESTree.CallExpression;
  readonly realm: ClockRealm;
  readonly faked: ReadonlySet<ClockApi>;
  readonly sameApi: boolean;
};

/** Each file's clock events, in source order, found once per program and helper list. */
const EVENTS = new WeakMap<ESTree.Node, Map<string, ReadonlyArray<ClockEvent>>>();

/** Every element of every set, kept only where all sets have it. */
function intersect(sets: ReadonlyArray<ReadonlySet<ClockApi>>): ReadonlySet<ClockApi> {
  const [first, ...rest] = sets;
  if (first === undefined) return new Set();
  return new Set([...first].filter((api) => rest.every((set) => set.has(api))));
}

/** Nothing faked: what an option the evaluator cannot read surely fakes. */
const NONE: ReadonlySet<ClockApi> = new Set();

/**
 * The APIs one `toFake` value alternative surely fakes. Vitest 5.1 passes the list to its fake
 * timers, which fake every API for an empty list, and Vitest fakes its default (every API) for
 * `undefined`. A list surely fakes each element whose every alternative is the same fakeable name;
 * a list that may be empty (one with an unopened spread and no such element) surely fakes nothing.
 */
function fakedByToFake(context: Context, list: Alt): ReadonlySet<ClockApi> {
  if (list.kind === "undefined") return ALL_APIS;
  if (list.kind !== "array") return NONE;
  if (list.complete && list.elements.length === 0) return ALL_APIS;
  return new Set(
    list.elements.flatMap((element) => {
      if (element === null) return [];
      const names = evaluate(context, element).map((name) =>
        name.kind === "string" ? name.value : undefined
      );
      const api = allAgree(names);
      return isFakeable(api) ? [api] : [];
    })
  );
}

/**
 * The APIs one `toNotFake` value alternative surely fakes: every API but the ones the list may
 * name, so only a complete list whose every element is a known string fakes anything.
 */
function fakedByToNotFake(context: Context, list: Alt): ReadonlySet<ClockApi> {
  if (list.kind !== "array" || !list.complete) return NONE;
  const kept = new Set<string>();
  for (const element of list.elements) {
    if (element === null) continue;
    const names = evaluate(context, element);
    const strings = names.flatMap((name) => (name.kind === "string" ? [name.value] : []));
    if (strings.length !== names.length) return NONE;
    for (const name of strings) kept.add(name);
  }
  return new Set([...ALL_APIS].filter((api) => !kept.has(api)));
}

/**
 * The APIs one options alternative of `vi.useFakeTimers(options)` surely fakes, as Vitest 5.1
 * reads them: no options (`undefined` or `null`) or neither key fakes every API; `toFake` fakes
 * its list; `toNotFake` fakes every API but its list. Both keys at once, or a `toNotFake` key whose
 * value is `undefined` (Vitest then adds its own `toFake`), make the install throw, which fakes
 * nothing; so does an alternative the evaluator cannot open.
 */
function fakedByOptions(context: Context, options: Alt): ReadonlySet<ClockApi> {
  if (options.kind === "undefined" || options.kind === "null") return ALL_APIS;
  const toFake = entryFor(options, "toFake");
  const toNotFake = entryFor(options, "toNotFake");
  if (toFake === "unknown" || toNotFake === "unknown") return NONE;
  if (toFake !== undefined && toNotFake !== undefined) return NONE;
  if (toFake !== undefined) {
    return intersect(evaluate(context, toFake.value).map((list) => fakedByToFake(context, list)));
  }
  if (toNotFake !== undefined) {
    return intersect(
      evaluate(context, toNotFake.value).map((list) =>
        list.kind === "undefined" ? NONE : fakedByToNotFake(context, list)
      )
    );
  }
  return ALL_APIS;
}

/**
 * The APIs a `vi.useFakeTimers(options)` call surely fakes, intersected over every alternative of
 * the options. The project's own `test.fakeTimers` config, which Vitest merges under the options,
 * lives in another file and is not read.
 */
function fakedBy(context: Context, call: ESTree.CallExpression): ReadonlySet<ClockApi> {
  const [options] = call.arguments;
  if (options === undefined) return ALL_APIS;
  return intersect(evaluate(context, options).map((alternative) => fakedByOptions(context, alternative)));
}

/**
 * The clock change one callee alternative makes: `vi.useFakeTimers()` fakes its `toFake` list or
 * every API; a configured fake-clock helper fakes the APIs it lists; `vi.useRealTimers()` fakes
 * nothing; Playwright's `clock.install()` and `pauseAt()` fake the page's timers, `Date` and
 * `performance`, and `setFixedTime()` the page's `Date`.
 */
function changeOf(
  context: Context,
  call: ESTree.CallExpression,
  target: CalleeTarget | undefined,
  helpers: ReadonlyArray<FakeClockHelper>
): Change | undefined {
  if (target === undefined) return undefined;
  const api = target.path.join(".");
  const pageClock = target.path.at(-2) === "clock" ? target.path.at(-1) : undefined;
  if (api === "vi.useFakeTimers") return { realm: "host", faked: fakedBy(context, call), api };
  const helper = helpers.find((candidate) => candidate.name === api);
  if (helper !== undefined) return { realm: "host", faked: new Set(helper.fakes), api };
  if (api === "vi.useRealTimers") return { realm: "host", faked: new Set(), api };
  if (pageClock === "install" || pageClock === "pauseAt")
    return { realm: "page", faked: PAGE_CLOCK_APIS, api: `clock.${pageClock}` };
  if (pageClock === "setFixedTime")
    return { realm: "page", faked: new Set(["Date"]), api: "clock.setFixedTime" };
  return undefined;
}

/**
 * The events a call makes, one per realm any of its callee's alternatives changes. The faked set
 * is what every changing alternative leaves faked; an alternative that changes nothing leaves the
 * coverage as it was, which the `possible` fold accounts for.
 */
function clockEventsOf(
  context: Context,
  call: ESTree.CallExpression,
  helpers: ReadonlyArray<FakeClockHelper>
): ClockEvent[] {
  const changes = calleeTargets(context, call.callee).map((target) =>
    changeOf(context, call, target, helpers)
  );
  const sameApi = allAgree(changes.map((change) => change?.api)) !== undefined;
  return (["host", "page"] as const).flatMap((realm) => {
    const made = changes.flatMap((change) => (change?.realm === realm ? [change.faked] : []));
    return made.length === 0 ? [] : [{ call, realm, faked: intersect(made), sameApi }];
  });
}

/** Fold events over a coverage: a guaranteed event replaces it, a possible one intersects it. */
function fold(
  coverage: ReadonlySet<ClockApi>,
  events: ReadonlyArray<{ readonly faked: ReadonlySet<ClockApi>; readonly certainty: Certainty }>
): ReadonlySet<ClockApi> {
  return events.reduce<ReadonlySet<ClockApi>>(
    (before, event) => (event.certainty === "guaranteed" ? event.faked : intersect([before, event.faked])),
    coverage
  );
}

/** Every clock event in the file, found from its calls once per program and helper list. */
function eventsOf(context: Context, helpers: ReadonlyArray<FakeClockHelper>): ReadonlyArray<ClockEvent> {
  const program = context.sourceCode.ast;
  const byHelpers = EVENTS.get(program) ?? new Map<string, ReadonlyArray<ClockEvent>>();
  EVENTS.set(program, byHelpers);
  const key = JSON.stringify(helpers);
  const cached = byHelpers.get(key);
  if (cached !== undefined) return cached;
  const events = isolated(() =>
    descendants(context, program, "into-functions").flatMap((node) =>
      node.type === "CallExpression" ? clockEventsOf(context, node, helpers) : []
    )
  );
  byHelpers.set(key, events);
  return events;
}

/** A body's events in a realm, before a point, in source order, each with its certainty. */
function eventsIn(
  context: Context,
  helpers: ReadonlyArray<FakeClockHelper>,
  body: ESTree.Node,
  realm: ClockRealm,
  before: number,
  registered: Certainty
): Array<{ readonly faked: ReadonlySet<ClockApi>; readonly certainty: Certainty; readonly start: number }> {
  return eventsOf(context, helpers)
    .filter((event) => event.realm === realm && event.call.start < before)
    .flatMap((event) => {
      const position = positionIn(event.call, body);
      if (position === undefined) return [];
      const certainty: Certainty =
        event.sameApi && position === "guaranteed" && registered === "guaranteed" ? "guaranteed" : "possible";
      return [{ faked: event.faked, certainty, start: event.call.start }];
    })
    .sort((left, right) => left.start - right.start);
}

/** Where a local function runs when it is no test or hook: its call sites and the elements that render it. */
function runSitesOf(context: Context, fn: ESTree.Node): ESTree.Node[] {
  return [...callSitesOf(context, fn), ...renderSitesOf(context, fn)];
}

/**
 * The function a capture's time is judged in: a test or hook body, a page callback, or a local
 * helper or component something calls or renders.
 */
function judgeOf(context: Context, node: ESTree.Node): ESTree.Node | undefined {
  const body = owningBody(context, node);
  for (let parent = node.parent; parent !== null && parent !== body; parent = parent.parent) {
    if (!isFunction(parent) || isPromiseCallback(parent)) continue;
    if (pageCallSitesOf(context, parent).length > 0 || runSitesOf(context, parent).length > 0) return parent;
  }
  return body;
}

/** One coverage question: the clock API, its realm, and the repository's fake-clock helpers. */
type Question = {
  readonly api: ClockApi;
  readonly realm: ClockRealm;
  readonly helpers: ReadonlyArray<FakeClockHelper>;
};

/**
 * Each question's coverage analysis, by question: a site's coverage is kept per file. A site
 * reached again while its own coverage is judged (a recursive helper) is not covered; a walk past
 * the budget counts as covered, which reports nothing.
 */
const COVERAGE = new Map<string, Analysis<boolean>>();

/** Whether every run of the code around a node fakes the question's API in its realm. */
function coveredAt(context: Context, question: Question, node: ESTree.Node): boolean {
  const key = JSON.stringify(question);
  const analysis = COVERAGE.get(key) ?? new Analysis<boolean>(true);
  COVERAGE.set(key, analysis);
  return analysis.run(
    context,
    node,
    () => judgedAt(context, question, node, []),
    () => false
  );
}

/**
 * Whether every run of the code around a node fakes the question's API, judged at the node's
 * judge. `via` is the chain of local calls that carried the judged value out, outermost first: a
 * helper whose call is its last link is judged at that call alone.
 */
function judgedAt(
  context: Context,
  question: Question,
  node: ESTree.Node,
  via: ReadonlyArray<ESTree.CallExpression>
): boolean {
  const { api, realm, helpers } = question;
  const judge = judgeOf(context, node);
  if (judge === undefined) return false;
  const executions = executionsOf(context, judge);
  if (executions.length > 0) {
    return executions.every((execution) => {
      const fromHooks = execution.before.flatMap((hook) =>
        eventsIn(context, helpers, hook.fn, realm, Number.POSITIVE_INFINITY, hook.certainty)
      );
      const fromBody = eventsIn(context, helpers, judge, realm, node.start, "guaranteed");
      return fold(new Set(), [...fromHooks, ...fromBody]).has(api);
    });
  }
  // A page callback runs where an `evaluate` call hands it over; a helper or component, where it
  // is called or rendered, or only at the call that produced the judged value when that is known.
  const handedOver = pageCallSitesOf(context, judge);
  if (handedOver.length > 0) return handedOver.every((site) => coveredAt(context, question, site));
  const sites = runSitesOf(context, judge);
  const producer = via.at(-1);
  if (producer !== undefined && sites.includes(producer))
    return judgedAt(context, question, producer, via.slice(0, -1));
  return sites.length > 0 && sites.every((site) => coveredAt(context, question, site));
}

/**
 * Where a value read the slot a fake clock replaces for an API: Vitest's fake timers replace the
 * global `setTimeout`, `setInterval`, `setImmediate`, `Date` and `performance`, and `process.hrtime`.
 * A value read from the slot before the install keeps the real one, so `const later = setTimeout`
 * at module scope stays real in a faked test, while `const p = process; p.hrtime()` reads the slot
 * when it is called. The read is the global's (or `globalThis.X`'s) identifier for a global slot,
 * and the `hrtime` member read for `process.hrtime`.
 *
 * @param alternative - A callee or constructor alternative that names the API.
 * @param api - The clock API.
 * @returns The node that read the slot, or `undefined` when the alternative reads none.
 */
export function captureSite(alternative: Alt, api: ClockApi): ESTree.Node | undefined {
  for (let value: Alt = alternative; ;) {
    if (value.kind === "global") return api !== "hrtime" && value.name === api ? value.at : undefined;
    if (value.kind !== "member") return undefined;
    if (api === "hrtime" && value.key === "hrtime") return value.at;
    if (
      api !== "hrtime" &&
      value.key === api &&
      value.object.kind === "global" &&
      GLOBAL_OBJECTS.has(value.object.name)
    )
      return value.at;
    value = value.object;
  }
}

/**
 * Whether a capture's time is simulated: every run of the code around it fakes the API in the
 * capture's own clock, the page's inside a page `evaluate` callback and the test's elsewhere.
 *
 * @param context - The rule context.
 * @param capture - Where time is read or a wait is scheduled.
 * @param api - The clock API the capture uses.
 * @param helpers - The repository's fake-clock helpers, beside Vitest's and Playwright's own APIs.
 * @param via - The local calls whose returns carried the captured value to where it is judged,
 *   outermost first (`Alt.via`): a capture in a helper is then judged at the call that produced
 *   it rather than at every call of the helper. Default none.
 * @returns Whether a simulated clock covers it.
 */
export function isSimulated(
  context: Context,
  capture: ESTree.Node,
  api: ClockApi,
  helpers: ReadonlyArray<FakeClockHelper>,
  via: ReadonlyArray<ESTree.CallExpression> = []
): boolean {
  const question: Question = { api, realm: runsInPage(context, capture) ? "page" : "host", helpers };
  return via.length === 0 ? coveredAt(context, question, capture) : judgedAt(context, question, capture, via);
}
