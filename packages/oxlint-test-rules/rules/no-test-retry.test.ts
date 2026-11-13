import { ruleTester } from "../shared/rule-tester.ts";
import { noTestRetry } from "./no-test-retry.ts";

const TEST = "/repo/src/button.test.ts";
const CONFIG = "/repo/vitest.config.ts";

/**
 * A recursive call graph with two calls per level: `f0` may return a sum the evaluator cannot
 * compute, so the test reruns. Every level reads the next twice, so a walk that re-read a level
 * instead of keeping it would take 2^levels steps: 6 levels resolve within the budget, and 24
 * levels pass it, which is `unknown` and reports nothing, but completes.
 */
function recursiveGraph(levels: number): string {
  return [
    "function f0(n) {\n  return n ? f1(n) + f1(n) : 0;\n}",
    ...Array.from(
      { length: levels - 2 },
      (_, index) => `function f${index + 1}(n) {\n  return f${index + 2}(n) + f${index + 2}(n);\n}`
    ),
    `function f${levels - 1}(n) {\n  return f0(n - 1);\n}`,
    'it("x", { retry: f0(1) }, () => {});',
  ].join("\n");
}

ruleTester.run("no-test-retry", noTestRetry, {
  valid: [
    // Reviewer repro: a helper's retry parameter is what its call sites pass.
    {
      code: 'function register(name, retry) {\n  it(name, { retry }, body);\n}\nregister("once", 0);',
      filename: TEST,
    },
    // A parameter no call sets, or one set to `undefined`, reruns nothing provable.
    { code: "function register(name, retry) {\n  it(name, { retry }, body);\n}", filename: TEST },
    {
      code: 'function register(name, retry) {\n  it(name, { retry }, body);\n}\nregister("once");',
      filename: TEST,
    },
    { code: 'it("opens", { timeout: 30_000 }, () => {});', filename: TEST },
    // A product's retry policy under test is data, not a rerun of the test.
    { code: 'const policy = { retry: 3 };\nit("retries reads", () => run(policy));', filename: TEST },
    { code: 'headers({ "retry-after": "30" });', filename: TEST },
    { code: 'const opts = { timeout: 5_000 };\nit("opens", { ...opts }, () => {});', filename: TEST },
    { code: "export default defineConfig({ test: { testTimeout: 30_000 } });", filename: CONFIG },
    // A rerun count of zero, or `false`, reruns nothing.
    { code: 'it("opens", { retry: 0 }, () => {});', filename: TEST },
    { code: 'describe("menu", { retry: 0 }, () => {});', filename: TEST },
    { code: "export default defineConfig({ test: { retry: 0 } });", filename: CONFIG },
    // A destructuring default applies when the member is missing.
    { code: 'const { retry = 0 } = {};\nit("once", { retry }, () => {});', filename: TEST },
    // `??`, `||` and `&&` return the operand JavaScript returns, not both.
    { code: 'const retries = 0;\nit("once", { retry: retries ?? 3 }, () => {});', filename: TEST },
    { code: 'const off = false;\nit("once", { retry: off || 0 }, () => {});', filename: TEST },
    { code: 'const on = 2;\nit("once", { retry: on && 0 }, () => {});', filename: TEST },
    // A write through an alias changes the object the test receives.
    {
      code: 'const opts = { retry: 2 };\nconst alias = opts;\nalias.retry = 0;\nit("once", opts, () => {});',
      filename: TEST,
    },
    // Hang: a recursive graph past the budget completes as `unknown`.
    { code: recursiveGraph(24), filename: TEST },
    // A value the evaluator cannot know is no evidence of a rerun.
    { code: 'let retry = 2;\nretry = 0;\nit("once", { retry }, () => {});', filename: TEST },
  ],
  invalid: [
    // A call site that passes a rerun makes the helper's retry rerun.
    {
      code: 'function register(name, retry) {\n  it(name, { retry }, body);\n}\nregister("once", 0);\nregister("flaky", 2);',
      filename: TEST,
      errors: [{ messageId: "rerun", line: 2 }],
    },
    // A destructuring default applies when the member is missing, and only then.
    {
      code: 'const { retry = 2 } = {};\nit("x", { retry }, () => {});',
      filename: TEST,
      errors: [{ messageId: "rerun" }],
    },
    {
      code: 'const { retry = 0 } = { retry: 3 };\nit("x", { retry }, () => {});',
      filename: TEST,
      errors: [{ messageId: "rerun" }],
    },
    // `??` falls through on `undefined`, `||` on a falsy value.
    {
      code: 'const retries = undefined;\nit("x", { retry: retries ?? 3 }, () => {});',
      filename: TEST,
      errors: [{ messageId: "rerun" }],
    },
    {
      code: 'const off = 0;\nit("x", { retry: off || 2 }, () => {});',
      filename: TEST,
      errors: [{ messageId: "rerun" }],
    },
    // A write through an alias of another object leaves this one's rerun known.
    {
      code: 'const opts = { retry: 2 };\nconst other = { retry: 0 };\nconst alias = other;\nalias.retry = 1;\nit("x", opts, () => {});',
      filename: TEST,
      errors: [{ messageId: "rerun" }],
    },
    // A recursive graph within the budget resolves, each level evaluated once per walk.
    { code: recursiveGraph(6), filename: TEST, errors: [{ messageId: "rerun" }] },
    // A spread of alternatives, one of which reruns.
    {
      code: 'const opts = { ...(flag ? { retry: 2 } : {}) };\nit("x", opts, () => {});',
      filename: "/repo/src/button.test.ts",
      errors: [{ messageId: "rerun" }],
    },
    // A runner stored in an object property.
    {
      code: 'const api = { spec: it };\napi.spec("x", { retry: 2 }, () => {});',
      filename: TEST,
      errors: [{ messageId: "rerun" }],
    },
    // Options reached through an expanded array spread.
    {
      code: 'it("x", [...[{ retry: 2 }]][0], () => {});',
      filename: TEST,
      errors: [{ messageId: "rerun" }],
    },
    // A runner off a namespace import.
    {
      code: 'import * as vt from "vitest";\nvt.it("x", { retry: 2 }, () => {});',
      filename: TEST,
      errors: [{ messageId: "rerun" }],
    },
    {
      code: 'import * as vt from "vitest";\nvt.describe.each([1])("s %d", { repeats: 2 }, () => {});',
      filename: TEST,
      errors: [{ messageId: "rerun" }],
    },
    { code: 'it("opens", { retry: 2 }, () => {});', filename: TEST, errors: [{ messageId: "rerun" }] },
    { code: 'describe("menu", { repeats: 5 }, () => {});', filename: TEST, errors: [{ messageId: "rerun" }] },
    {
      code: 'it.each([1, 2])("row %d", { retry: 1 }, () => {});',
      filename: TEST,
      errors: [{ messageId: "rerun" }],
    },
    { code: "vi.setConfig({ retry: 3 });", filename: TEST, errors: [{ messageId: "rerun" }] },
    // Options held in a binding or spread from another object still reach the test.
    {
      code: 'const opts = { retry: 2 };\nit("opens", opts, () => {});',
      filename: TEST,
      errors: [{ messageId: "rerun" }],
    },
    {
      code: 'const flaky = { retry: 2 };\nit("opens", { ...flaky, timeout: 5_000 }, () => {});',
      filename: TEST,
      errors: [{ messageId: "rerun" }],
    },
    // An aliased runner import is still a test.
    {
      code: 'import { it as spec } from "vitest";\nspec("x", { retry: 2 }, () => {});',
      filename: TEST,
      errors: [{ messageId: "rerun" }],
    },
    {
      code: 'import { describe as suite } from "vitest";\nsuite.concurrent("menu", { repeats: 3 }, () => {});',
      filename: TEST,
      errors: [{ messageId: "rerun" }],
    },
    // One shared options object reports once, however many tests take it.
    {
      code: 'const opts = { retry: 2 };\nit("a", opts, () => {});\nit("b", opts, () => {});',
      filename: TEST,
      errors: [{ messageId: "rerun" }],
    },
    {
      code: "export default defineConfig({ test: { retry: process.env.CI ? 2 : 0 } });",
      filename: CONFIG,
      errors: [{ messageId: "rerun" }],
    },
    {
      code: "export default defineConfig({ retries: 2 });",
      filename: "/repo/apps/docs/playwright.config.ts",
      errors: [{ messageId: "rerun" }],
    },
  ],
});
