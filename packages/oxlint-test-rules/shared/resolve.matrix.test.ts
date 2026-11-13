import type { Rule } from "@oxlint/plugins";

import { noClassAssertions } from "../rules/no-class-assertions.ts";
import { noFixedDelay } from "../rules/no-fixed-delay.ts";
import { noGeometryAssertions } from "../rules/no-geometry-assertions.ts";
import { noSourceReadingTests } from "../rules/no-source-reading-tests.ts";
import { noTestRetry } from "../rules/no-test-retry.ts";
import { noWallClock } from "../rules/no-wall-clock.ts";
import { ruleTester } from "./rule-tester.ts";

/*
 * Unit under test: `resolve.ts`'s contract, at every entry point a rule reads a value through.
 * Oracle: the contract's list of steps, and its rule for alternatives. Each cell writes the entry
 * point's value through one step and expects the rule to judge it exactly as it judges the value
 * written directly (step 0); step 9 writes it as both arms of a condition. The alternatives dimension returns the step-0 value and another value
 * from one local function, in both orders: a violation fires when any alternative is one, and an
 * exemption holds only when every alternative qualifies, so each of those cells is a violation.
 * A cell a step cannot apply to is excluded with its reason.
 */

/** One way to write the entry point's value: setup statements, then the expression in the hole. */
type Writing = readonly [setup: string, expression: string];

/** A contract step's shapes for one entry point, or why the step does not apply there. */
type Cell = { readonly writings: ReadonlyArray<Writing> } | { readonly excluded: string };

/** The contract steps the matrix runs, by their number in `resolve.ts`. */
type Step =
  | "0 direct"
  | "1 wrapper"
  | "2 alias"
  | "3 destructured"
  | "4 member"
  | "5 local call"
  | "6 evaluate"
  | "7 import"
  | "8 global";

/** An entry point: the rule that reads it, the code around the hole, and the verdict for its value. */
type Entry = {
  readonly rule: Rule;
  readonly name: string;
  readonly filename?: string;
  readonly around: (hole: string) => string;
  readonly verdict: { readonly valid: true } | { readonly messageId: string };
  readonly cells: Readonly<Record<Step, Cell>>;
  /**
   * The alternatives dimension: the value the step-0 value is paired with, and the violation the
   * pair must report in either order, or why the dimension does not apply.
   */
  readonly alternatives:
    | { readonly other: string; readonly messageId: string }
    | { readonly excluded: string };
  /**
   * The product dimension, on the entries it runs on: a value that violates, one that does not,
   * the violation, and the operators a value's type cannot pass through, with their reasons.
   */
  readonly product?: {
    readonly violating: string;
    readonly benign: string;
    readonly messageId: string;
    readonly excluded: Readonly<Partial<Record<Operator, string>>>;
  };
};

const PAGE_ONLY =
  "a page evaluate callback returns page data, which never reaches this host-side entry point";
const OTHER_MODULE =
  "step 7 names an import's module and export; the imported value itself lives in another file";
const NOT_GLOBAL = "step 8 names globals, and this entry point's value is no global";
const MATCHER_KEY = "a matcher is a key read off the expect chain, so only step 4's static keys apply";
const NOT_A_STRING = "the value is no string, so a string operation yields another value entirely";

/** The product exclusions of a value that is no string: every operator that makes or reads a string. */
const STRING_OPERATORS_EXCLUDED = {
  template: NOT_A_STRING,
  "+": NOT_A_STRING,
  join: NOT_A_STRING,
  "string method": NOT_A_STRING,
} as const;

/** Where every matrix case is linted, unless its entry names a test file of its own. */
const MATRIX_FILE = "/repo/src/matrix.test.tsx";

/** A case's code: the setup statements, if any, then the code around the hole. */
function caseCode(setup: string, body: string): string {
  return setup === "" ? body : `${setup}\n${body}`;
}

/** A test body that fakes the timers before it schedules one. */
const FAKED_BODY = "() => {\n  vi.useFakeTimers();\n  setTimeout(fire, 100);\n}";

const ENTRIES: ReadonlyArray<Entry> = [
  {
    rule: noFixedDelay,
    name: "callee (setTimeout)",
    around: (hole) => `${hole}(fire, 100);`,
    verdict: { messageId: "delay" },
    alternatives: { other: "noop", messageId: "delay" },
    product: {
      violating: "setTimeout",
      benign: "noop",
      messageId: "delay",
      excluded: STRING_OPERATORS_EXCLUDED,
    },
    cells: {
      "0 direct": { writings: [["", "setTimeout"]] },
      "1 wrapper": { writings: [["", "(setTimeout as typeof setTimeout)"]] },
      "2 alias": { writings: [["const later = setTimeout;", "later"]] },
      "3 destructured": { writings: [['const { "later": later } = { later: setTimeout };', "later"]] },
      "4 member": {
        writings: [
          ["const timers = { ...{ later: setTimeout } };", 'timers["later"]'],
          ["const list = [...[setTimeout]];", "list[0]"],
        ],
      },
      "5 local call": { writings: [["const pick = () => setTimeout;", "pick()"]] },
      "6 evaluate": { excluded: PAGE_ONLY },
      "7 import": {
        writings: [
          ['import { setTimeout as later } from "node:timers";', "later"],
          ['import * as timers from "node:timers";', "timers.setTimeout"],
          ['import * as timers from "node:timers";\nconst { "setTimeout": later } = timers;', "later"],
        ],
      },
      "8 global": {
        writings: [
          ["", "window.setTimeout"],
          ["", 'globalThis["setTimeout"]'],
        ],
      },
    },
  },
  {
    rule: noClassAssertions,
    name: "receiver (classList)",
    around: (hole) => `expect(${hole}.contains("h-9")).toBe(true);`,
    verdict: { messageId: "pinned" },
    alternatives: { other: "other.list", messageId: "pinned" },
    cells: {
      "0 direct": { writings: [["", "spinner.classList"]] },
      "1 wrapper": { writings: [["", "(spinner.classList as DOMTokenList)"]] },
      "2 alias": { writings: [["const list = spinner.classList;", "list"]] },
      "3 destructured": { writings: [["const { classList } = spinner;", "classList"]] },
      "4 member": {
        writings: [
          ["const parts = { ...{ list: spinner.classList } };", 'parts["list"]'],
          ["const lists = [...[spinner.classList]];", "lists[0]"],
        ],
      },
      "5 local call": { writings: [["const listOf = () => spinner.classList;", "listOf()"]] },
      "6 evaluate": { excluded: PAGE_ONLY },
      "7 import": { excluded: OTHER_MODULE },
      "8 global": { excluded: NOT_GLOBAL },
    },
  },
  {
    rule: noSourceReadingTests,
    name: "path (code module)",
    around: (hole) => `readFileSync(${hole}, "utf8");`,
    verdict: { messageId: "source" },
    alternatives: { other: '"a.json"', messageId: "source" },
    product: { violating: '"src/button.tsx"', benign: '"a.json"', messageId: "source", excluded: {} },
    cells: {
      "0 direct": { writings: [["", '"src/button.tsx"']] },
      "1 wrapper": { writings: [["", '("src/button.tsx" as string)']] },
      "2 alias": { writings: [['const file = "src/button.tsx";', "file"]] },
      "3 destructured": { writings: [['const { "file": file } = { file: "src/button.tsx" };', "file"]] },
      "4 member": {
        writings: [
          ['const files = { ...{ button: "src/button.tsx" } };', 'files["button"]'],
          ['const files = [...["a.json", "src/button.tsx"], "b.json"];', "files[1]"],
        ],
      },
      "5 local call": { writings: [['function source() {\n  return "src/button.tsx";\n}', "source()"]] },
      "6 evaluate": { writings: [["", 'await page.evaluate(() => "src/button.tsx")']] },
      "7 import": { excluded: OTHER_MODULE },
      "8 global": { excluded: NOT_GLOBAL },
    },
  },
  {
    rule: noTestRetry,
    name: "options (retry)",
    filename: "/repo/src/button.test.ts",
    around: (hole) => `it("opens", ${hole}, () => {});`,
    verdict: { messageId: "rerun" },
    alternatives: { other: "{ timeout: 1 }", messageId: "rerun" },
    product: {
      violating: "{ retry: 2 }",
      benign: "{ timeout: 1 }",
      messageId: "rerun",
      excluded: STRING_OPERATORS_EXCLUDED,
    },
    cells: {
      "0 direct": { writings: [["", "{ retry: 2 }"]] },
      "1 wrapper": { writings: [["", "({ retry: 2 } as Options)"]] },
      "2 alias": { writings: [["const flaky = { retry: 2 };", "flaky"]] },
      "3 destructured": { writings: [["const { flaky } = { flaky: { retry: 2 } };", "flaky"]] },
      "4 member": {
        writings: [
          ["const options = { ...{ flaky: { retry: 2 } } };", 'options["flaky"]'],
          ["", "[...[{ retry: 2 }]][0]"],
        ],
      },
      "5 local call": { writings: [["const make = () => ({ retry: 2 });", "make()"]] },
      "6 evaluate": { excluded: PAGE_ONLY },
      "7 import": { excluded: OTHER_MODULE },
      "8 global": { excluded: NOT_GLOBAL },
    },
  },
  {
    rule: noFixedDelay,
    name: "delay (zero)",
    around: (hole) => `await sleep(${hole});`,
    verdict: { valid: true },
    alternatives: { other: "100", messageId: "delay" },
    product: {
      violating: "100",
      benign: "0",
      messageId: "delay",
      excluded: {
        template: "a template makes a string, and a string delay is no number the rule reads",
        join: "join makes a string, and a string delay is no number the rule reads",
        "string method": NOT_A_STRING,
        "+": '`+ ""` makes a string; numeric `+` is the step-10 cell of the measurement entry',
      },
    },
    cells: {
      "0 direct": { writings: [["", "0"]] },
      "1 wrapper": { writings: [["", "(0 as number)"]] },
      "2 alias": { writings: [["const NONE = 0;", "NONE"]] },
      "3 destructured": { writings: [["const { none } = { none: 0 };", "none"]] },
      "4 member": {
        writings: [
          ["const delays = { ...{ none: 0 } };", 'delays["none"]'],
          ["const delays = [...[100, 0]];", "delays[1]"],
        ],
      },
      "5 local call": { writings: [["function none() {\n  if (flag) return 0;\n  return 0;\n}", "none()"]] },
      "6 evaluate": { excluded: PAGE_ONLY },
      "7 import": { excluded: OTHER_MODULE },
      "8 global": { excluded: NOT_GLOBAL },
    },
  },
  {
    rule: noClassAssertions,
    name: "expected class (supplied marker)",
    around: (hole) => `render(<Button className="marker-x" />);\nexpect(button).toHaveClass(${hole});`,
    verdict: { valid: true },
    alternatives: { other: '"other"', messageId: "pinned" },
    product: { violating: '"h-9"', benign: '"marker-x"', messageId: "pinned", excluded: {} },
    cells: {
      "0 direct": { writings: [["", '"marker-x"']] },
      "1 wrapper": { writings: [["", '("marker-x" as string)']] },
      "2 alias": {
        writings: [
          ['const marker = "marker-x";', "marker"],
          ['const id = "x";', "`marker-${id}`"],
        ],
      },
      "3 destructured": { writings: [['const { "marker": marker } = { marker: "marker-x" };', "marker"]] },
      "4 member": {
        writings: [
          ['const classes = { ...{ marker: "marker-x" } };', 'classes["marker"]'],
          ['const classes = [...["other", "marker-x"]];', "classes[1]"],
        ],
      },
      "5 local call": { writings: [['const marker = () => "marker-" + "x";', "marker()"]] },
      "6 evaluate": { excluded: PAGE_ONLY },
      "7 import": { excluded: OTHER_MODULE },
      "8 global": { excluded: NOT_GLOBAL },
    },
  },
  {
    rule: noGeometryAssertions,
    name: "measurement (offsetWidth)",
    around: (hole) => `expect(${hole}).toBe(320);`,
    verdict: { messageId: "pixel" },
    alternatives: { other: "3", messageId: "pixel" },
    product: {
      violating: "panel.offsetWidth",
      benign: "3",
      messageId: "pixel",
      excluded: {
        template: NOT_A_STRING,
        join: NOT_A_STRING,
        "string method": NOT_A_STRING,
        "+": '`+ ""` turns the length into a string; arithmetic on lengths is the measurement\'s own rule',
      },
    },
    cells: {
      "0 direct": { writings: [["", "panel.offsetWidth"]] },
      "1 wrapper": { writings: [["", "(panel.offsetWidth as number)"]] },
      "2 alias": { writings: [["const width = panel.offsetWidth;", "width"]] },
      "3 destructured": { writings: [["const { offsetWidth } = panel;", "offsetWidth"]] },
      "4 member": {
        writings: [
          ["const size = { ...{ width: panel.offsetWidth } };", 'size["width"]'],
          ["const sizes = [...[0, panel.offsetWidth]];", "sizes[1]"],
        ],
      },
      "5 local call": { writings: [["function widthOf() {\n  return panel.offsetWidth;\n}", "widthOf()"]] },
      "6 evaluate": { writings: [["", "await page.evaluate(() => document.body.offsetWidth)"]] },
      "7 import": { excluded: OTHER_MODULE },
      "8 global": { excluded: NOT_GLOBAL },
    },
  },
  {
    rule: noSourceReadingTests,
    name: "walk (code listing)",
    around: (hole) => `for (const file of ${hole}) readFileSync(file);`,
    verdict: { messageId: "source" },
    alternatives: { other: 'globSync("*.log")', messageId: "source" },
    cells: {
      "0 direct": { writings: [["", 'readdirSync(src).filter((name) => name.endsWith(".tsx"))']] },
      "1 wrapper": {
        writings: [["", '(readdirSync(src).filter((name) => name.endsWith(".tsx")) as string[])']],
      },
      "2 alias": {
        writings: [['const files = readdirSync(src).filter((name) => name.endsWith(".tsx"));', "files"]],
      },
      "3 destructured": {
        writings: [
          ['const { files } = { files: readdirSync(src).filter((name) => name.endsWith(".tsx")) };', "files"],
        ],
      },
      "4 member": {
        writings: [
          ['const walks = { ...{ code: globSync("**/*.tsx") } };', 'walks["code"]'],
          ['const walks = [...[globSync("*.log"), globSync("**/*.tsx")]];', "walks[1]"],
        ],
      },
      "5 local call": {
        writings: [
          [
            'function sources() {\n  return readdirSync(src).filter((name) => name.endsWith(".tsx"));\n}',
            "sources()",
          ],
        ],
      },
      "6 evaluate": { excluded: PAGE_ONLY },
      "7 import": { excluded: OTHER_MODULE },
      "8 global": { excluded: NOT_GLOBAL },
    },
  },
  {
    rule: noWallClock,
    name: "clock receiver (new Date)",
    around: (hole) => `log(${hole}.getTime() - start);`,
    verdict: { messageId: "budget" },
    alternatives: { other: "new Date(0)", messageId: "budget" },
    product: {
      violating: "new Date()",
      benign: "new Date(0)",
      messageId: "budget",
      excluded: STRING_OPERATORS_EXCLUDED,
    },
    cells: {
      "0 direct": { writings: [["", "new Date()"]] },
      "1 wrapper": { writings: [["", "(new Date() as Date)"]] },
      "2 alias": { writings: [["const now = new Date();", "now"]] },
      "3 destructured": { writings: [["const { now } = { now: new Date() };", "now"]] },
      "4 member": {
        writings: [
          ["const times = { ...{ now: new Date() } };", 'times["now"]'],
          ["const times = [...[new Date(0), new Date()]];", "times[1]"],
        ],
      },
      "5 local call": { writings: [["const now = () => new Date();", "now()"]] },
      "6 evaluate": { excluded: PAGE_ONLY },
      "7 import": { excluded: OTHER_MODULE },
      "8 global": { writings: [["", "new window.Date()"]] },
    },
  },
  {
    rule: noGeometryAssertions,
    name: "distance (Math.abs)",
    around: (hole) => `expect(${hole}).toBeLessThan(2);`,
    verdict: { valid: true },
    alternatives: { other: "a.offsetWidth", messageId: "pixel" },
    cells: {
      "0 direct": { writings: [["", "Math.abs(a.offsetWidth - b.offsetWidth)"]] },
      "1 wrapper": { writings: [["", "(Math.abs(a.offsetWidth - b.offsetWidth) as number)"]] },
      "2 alias": { writings: [["const delta = Math.abs(a.offsetWidth - b.offsetWidth);", "delta"]] },
      "3 destructured": {
        writings: [["const { delta } = { delta: Math.abs(a.offsetWidth - b.offsetWidth) };", "delta"]],
      },
      "4 member": {
        writings: [
          ["const gaps = { ...{ delta: Math.abs(a.offsetWidth - b.offsetWidth) } };", 'gaps["delta"]'],
          ["const gaps = [...[Math.abs(a.offsetWidth - b.offsetWidth)]];", "gaps[0]"],
        ],
      },
      "5 local call": {
        writings: [["function gap() {\n  return Math.abs(a.offsetWidth - b.offsetWidth);\n}", "gap()"]],
      },
      "6 evaluate": {
        writings: [
          ["", "await page.evaluate(() => Math.abs(document.body.offsetWidth - window.innerWidth))"],
        ],
      },
      "7 import": { excluded: OTHER_MODULE },
      "8 global": { writings: [["", "window.Math.abs(a.offsetWidth - b.offsetWidth)"]] },
    },
  },
  {
    rule: noGeometryAssertions,
    name: "matcher key (toBe)",
    around: (hole) => `expect(panel.offsetWidth)${hole}(320);`,
    verdict: { messageId: "pixel" },
    alternatives: { excluded: MATCHER_KEY },
    cells: {
      "0 direct": { writings: [["", ".toBe"]] },
      "1 wrapper": { excluded: MATCHER_KEY },
      "2 alias": { excluded: MATCHER_KEY },
      "3 destructured": { excluded: MATCHER_KEY },
      "4 member": {
        writings: [
          ["", '["toBe"]'],
          ["", '["not"]["toBe"]'],
          ["", ".not[`toBe`]"],
        ],
      },
      "5 local call": { excluded: MATCHER_KEY },
      "6 evaluate": { excluded: MATCHER_KEY },
      "7 import": { excluded: MATCHER_KEY },
      "8 global": { excluded: MATCHER_KEY },
    },
  },
  {
    rule: noFixedDelay,
    name: "test callback (faked body)",
    around: (hole) => `it("waits", ${hole});`,
    verdict: { valid: true },
    alternatives: { other: "() => {\n  setTimeout(fire, 100);\n}", messageId: "delay" },
    cells: {
      "0 direct": { writings: [["", FAKED_BODY]] },
      "1 wrapper": { writings: [["", `(${FAKED_BODY}) as () => void`]] },
      "2 alias": { writings: [[`const body = ${FAKED_BODY};`, "body"]] },
      "3 destructured": { writings: [[`const { body } = { body: ${FAKED_BODY} };`, "body"]] },
      "4 member": {
        writings: [
          [`const bodies = { ...{ waits: ${FAKED_BODY} } };`, 'bodies["waits"]'],
          [`const bodies = [...[${FAKED_BODY}]];`, "bodies[0]"],
        ],
      },
      "5 local call": { writings: [[`const make = () => ${FAKED_BODY};`, "make()"]] },
      "6 evaluate": { excluded: PAGE_ONLY },
      "7 import": { excluded: OTHER_MODULE },
      "8 global": { excluded: NOT_GLOBAL },
    },
  },
  {
    rule: noWallClock,
    name: "evaluate realm (page clock)",
    around: (hole) =>
      `it("ticks", async ({ page }) => {\n  await page.clock.install();\n  const start = await page.evaluate(${hole});\n  expect((await page.evaluate(${hole})) - start).toBe(1000);\n});`,
    verdict: { valid: true },
    alternatives: {
      excluded:
        "every alternative is a callback page.evaluate runs in the page, so pairing two changes no realm",
    },
    cells: {
      "0 direct": { writings: [["", "() => Date.now()"]] },
      "1 wrapper": { writings: [["", "((() => Date.now()) as () => number)"]] },
      "2 alias": { writings: [["const now = () => Date.now();", "now"]] },
      "3 destructured": { writings: [["const { now } = { now: () => Date.now() };", "now"]] },
      "4 member": {
        writings: [
          ["const reads = { ...{ now: () => Date.now() } };", 'reads["now"]'],
          ["const reads = [...[() => Date.now()]];", "reads[0]"],
        ],
      },
      "5 local call": { writings: [["const make = () => () => Date.now();", "make()"]] },
      "6 evaluate": { excluded: "this entry point is step 6's callback itself" },
      "7 import": { excluded: OTHER_MODULE },
      "8 global": { excluded: NOT_GLOBAL },
    },
  },
];

for (const entry of ENTRIES) {
  const cases = Object.entries(entry.cells).flatMap(([step, cell]) =>
    "excluded" in cell
      ? []
      : cell.writings.map(([setup, expression], index) => {
          const testCase = {
            name: `${entry.name} × step ${step}${cell.writings.length > 1 ? ` (${index + 1})` : ""}`,
            code: caseCode(setup, entry.around(expression)),
            filename: entry.filename ?? MATRIX_FILE,
          };
          return testCase;
        })
  );
  const verdict = entry.verdict;
  const direct = entry.cells["0 direct"];
  const alternatives = entry.alternatives;
  const alternativeCases =
    "excluded" in alternatives || "excluded" in direct
      ? []
      : direct.writings.flatMap(([setup, value]) =>
          [
            [value, alternatives.other],
            [alternatives.other, value],
          ].map(([first, second], order) => ({
            name: `${entry.name} × alternatives (${order === 0 ? "value first" : "value second"})`,
            code: caseCode(
              setup,
              `function pick() {\n  if (flag) return ${first};\n  return ${second};\n}\n${entry.around("pick()")}`
            ),
            filename: entry.filename ?? MATRIX_FILE,
            errors: [{ messageId: alternatives.messageId }],
          }))
        );
  // Step 9: the value as both arms of a condition, judged as the value itself. A hole that is a
  // matcher key, not an expression, takes no condition.
  const conditionCases =
    "excluded" in direct
      ? []
      : direct.writings.flatMap(([setup, value]) =>
          /^[.[]/u.test(value)
            ? []
            : [
                {
                  name: `${entry.name} × step 9 condition`,
                  code: caseCode(setup, entry.around(`(flag ? ${value} : ${value})`)),
                  filename: entry.filename ?? MATRIX_FILE,
                },
              ]
        );
  cases.push(...conditionCases);
  ruleTester.run(`contract matrix: ${entry.name}`, entry.rule, {
    valid: "valid" in verdict ? cases : [],
    invalid: [
      ...("messageId" in verdict
        ? cases.map((testCase) => ({ ...testCase, errors: [{ messageId: verdict.messageId }] }))
        : []),
      ...alternativeCases,
    ],
  });
}

/*
 * The product dimension. Unit under test: the evaluator's operators, each of which maps over the
 * cartesian product of its operands' alternatives. Oracle: the quantifier in `quantify.ts`. Each
 * cell writes one operand as a condition between a violating and a non-violating value, in both
 * orders, under one operator; whichever order, one alternative of the result violates, so the cell
 * is a violation. An operator a value's type cannot pass through is excluded with its reason.
 */

/** The operators the product dimension runs, by the contract step that computes them. */
type Operator =
  | "member read"
  | "object spread"
  | "array spread"
  | "call return"
  | "template"
  | "+"
  | "join"
  | "string method"
  | "wrapper";

/**
 * One operator over an operand whose alternatives are `first` and `second`, as setup and the
 * expression in the hole. `benign` is a non-violating value for the operator to override.
 */
const OPERATORS = {
  "member read": (first, second) => ["", `(flag ? { k: ${first} } : { k: ${second} }).k`],
  "object spread": (first, second, benign) => [
    `const box = { k: ${benign}, ...(flag ? { k: ${first} } : { k: ${second} }) };`,
    "box.k",
  ],
  "array spread": (first, second) => ["", `[...(flag ? [${first}] : [${second}])][0]`],
  "call return": (first, second) => ["", `(flag ? () => (${first}) : () => (${second}))()`],
  template: (first, second) => ["", `\`\${flag ? ${first} : ${second}}\``],
  "+": (first, second) => ["", `(flag ? ${first} : ${second}) + ""`],
  join: (first, second) => ["", `[flag ? ${first} : ${second}].join("")`],
  "string method": (first, second) => ["", `(flag ? ${first} : ${second}).trim()`],
  wrapper: (first, second) => ["", `((flag ? ${first} : ${second}) as never)`],
} satisfies Readonly<Record<Operator, (first: string, second: string, benign: string) => Writing>>;

for (const entry of ENTRIES) {
  const product = entry.product;
  if (product === undefined) continue;
  const invalid = Object.entries(OPERATORS).flatMap(([operator, write]) =>
    operator in product.excluded
      ? []
      : [
          [product.violating, product.benign],
          [product.benign, product.violating],
        ].map(([first, second], order) => {
          const [setup, expression] = write(first ?? "", second ?? "", product.benign);
          return {
            name: `${entry.name} × product ${operator} (${order === 0 ? "violating first" : "violating second"})`,
            code: caseCode(setup, entry.around(expression)),
            filename: entry.filename ?? MATRIX_FILE,
            errors: [{ messageId: product.messageId }],
          };
        })
  );
  ruleTester.run(`contract matrix product: ${entry.name}`, entry.rule, { valid: [], invalid });
}

/*
 * The execution dimension. Unit under test: `fake-clock.ts`'s fold over guaranteed and possible
 * events. Oracle: its model: a guaranteed event replaces coverage, a possible one intersects it,
 * and coverage starts empty. Each kind of event (install, restore, hook registration, test
 * registration) is written once guaranteed and once possible, under a wait and under a clock read.
 */

/** One event kind written guaranteed and possible: the code around a capture, and its verdicts. */
type ExecutionCell = {
  readonly name: string;
  readonly guaranteed: { readonly code: (capture: string) => string; readonly covered: boolean };
  readonly possible: { readonly code: (capture: string) => string; readonly covered: boolean };
};

const EXECUTION_CELLS: ReadonlyArray<ExecutionCell> = [
  {
    name: "install",
    guaranteed: {
      code: (capture) => `it("a", () => {\n  vi.useFakeTimers();\n  ${capture}\n});`,
      covered: true,
    },
    possible: {
      code: (capture) => `it("a", () => {\n  (flag ? vi.useFakeTimers : noop)();\n  ${capture}\n});`,
      covered: false,
    },
  },
  {
    name: "restore",
    guaranteed: {
      code: (capture) => `it("a", () => {\n  vi.useFakeTimers();\n  vi.useRealTimers();\n  ${capture}\n});`,
      covered: false,
    },
    possible: {
      code: (capture) =>
        `it("a", () => {\n  vi.useFakeTimers();\n  (flag ? vi.useRealTimers : noop)();\n  ${capture}\n});`,
      covered: false,
    },
  },
  {
    name: "hook registration",
    guaranteed: {
      code: (capture) => `beforeEach(() => vi.useFakeTimers());\nit("a", () => {\n  ${capture}\n});`,
      covered: true,
    },
    possible: {
      code: (capture) =>
        `(flag ? beforeEach : noop)(() => vi.useFakeTimers());\nit("a", () => {\n  ${capture}\n});`,
      covered: false,
    },
  },
  {
    name: "test registration",
    guaranteed: {
      code: (capture) =>
        `const run = flag ? it : it;\nbeforeEach(() => vi.useFakeTimers());\nrun("a", () => {\n  ${capture}\n});`,
      covered: true,
    },
    possible: {
      code: (capture) =>
        `beforeEach(() => vi.useFakeTimers());\n(flag ? it : direct)("a", () => {\n  ${capture}\n});`,
      covered: false,
    },
  },
];

/** The captures the execution dimension judges: a wait and a clock read. */
const CAPTURES: ReadonlyArray<{ readonly rule: Rule; readonly capture: string; readonly messageId: string }> =
  [
    { rule: noFixedDelay, capture: "setTimeout(fire, 100);", messageId: "delay" },
    { rule: noWallClock, capture: "const s = Date.now();\n  log(Date.now() - s);", messageId: "budget" },
  ];

for (const { rule, capture, messageId } of CAPTURES) {
  const cases = EXECUTION_CELLS.flatMap((cell) =>
    (["guaranteed", "possible"] as const).map((certainty) => ({
      name: `${cell.name} × ${certainty}`,
      code: cell[certainty].code(capture),
      filename: MATRIX_FILE,
      covered: cell[certainty].covered,
    }))
  );
  ruleTester.run(`contract matrix execution: ${messageId}`, rule, {
    valid: cases.filter((testCase) => testCase.covered).map(({ covered: _, ...testCase }) => testCase),
    invalid: cases
      .filter((testCase) => !testCase.covered)
      .map(({ covered: _, ...testCase }) => ({ ...testCase, errors: [{ messageId }] })),
  });
}
