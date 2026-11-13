import { ruleTester } from "../shared/rule-tester.ts";
import { noFixedDelay } from "./no-fixed-delay.ts";

/** A repository whose `useFakeTimeouts()` fakes `setTimeout` only and whose `wait(ms)` spins on frames. */
const REPO_HELPERS = [
  {
    realWaitHelpers: ["wait"],
    fakeClockHelpers: [{ name: "useFakeTimeouts", fakes: ["setTimeout"] }],
  },
];

/**
 * A delay built from a chain whose every link reads the one before it twice. The traversal charges
 * a link's whole unfolded computation, memo or not, so a 6-deep chain resolves and a 20-deep one
 * (2^20 unfolded steps) passes the budget and is `unknown`; either way each link is evaluated once.
 */
function sharedChain(depth: number): string {
  return [
    "const a0 = 1;",
    ...Array.from({ length: depth }, (_, index) => `const a${index + 1} = a${index} + a${index};`),
    `setTimeout(fire, a${depth});`,
  ].join("\n");
}

/**
 * A delay at the end of a 4000-link chain: past the evaluator's work budget, so the delay is
 * `unknown`, which is no evidence of a wait.
 */
const LONG_CHAIN = [
  "const a0 = 1;",
  ...Array.from({ length: 4000 }, (_, index) => `const a${index + 1} = a${index} + 1;`),
  "setTimeout(fire, a4000);",
].join("\n");

/** Two helpers that call each other, `a` waiting on the delay it forwards; `first` is analysed first. */
function mutualHelpers(first: string, second: string): string {
  return [
    "function a(ms) {",
    "  if (flag) return b(ms);",
    "  return new Promise((r) => setTimeout(r, ms));",
    "}",
    "function b(ms) {",
    "  return a(ms);",
    "}",
    first,
    second,
  ].join("\n");
}

/**
 * Helpers that call the next one twice, the last waiting: under a fake clock every run is covered.
 * Judging coverage once per call path would take 2^depth steps; past the budget it is `unknown`.
 */
function doubledHelpers(depth: number, faked: boolean): string {
  return [
    `function h${depth}() {\n  setTimeout(fire, 100);\n}`,
    ...Array.from(
      { length: depth },
      (_, index) => `function h${index}() {\n  h${index + 1}();\n  h${index + 1}();\n}`
    ),
    `it("x", () => {\n${faked ? "  vi.useFakeTimers();\n" : ""}  h0();\n});`,
  ].join("\n");
}

/** 450 aliases of 100, then waits on alias `first` and alias `second`, each on its own line. */
function aliasChain(first: number, second: number): string {
  return [
    "const v0 = 100;",
    ...Array.from({ length: 449 }, (_, index) => `const v${index + 1} = v${index};`),
    `setTimeout(fire, v${first});`,
    `setTimeout(fire, v${second});`,
  ].join("\n");
}

ruleTester.run("no-fixed-delay", noFixedDelay, {
  valid: [
    // An alias captured after the install is the fake timer.
    'it("x", () => {\n  vi.useFakeTimers();\n  const later = setTimeout;\n  later(cb, 100);\n});',
    // Building a closure schedules nothing; the closure waits where it is called, here on a fake clock.
    'function makeLater(ms) {\n  return () => new Promise((r) => setTimeout(r, ms));\n}\nconst later = makeLater(100);\nit("x", async () => {\n  vi.useFakeTimers();\n  const p = later();\n  await vi.advanceTimersByTimeAsync(100);\n  await p;\n});',
    // Hang: coverage that must hold on every one of 2^20 call paths passes the budget: unknown.
    doubledHelpers(20, true),
    doubledHelpers(3, true),
    // A JSX member tag renders the component it names, under the test's fake clock.
    'function Widget() {\n  useEffect(() => {\n    setTimeout(fire, 500);\n  }, []);\n  return null;\n}\nconst fixtures = { Widget };\nit("a", () => {\n  vi.useFakeTimers();\n  render(<fixtures.Widget />);\n});',
    // A destructuring default applies when the member is missing.
    "const { ms = 0 } = {};\nsetTimeout(tick, ms);",
    // A delay the evaluator cannot know is no evidence of a wait.
    "let ms = 1;\nms = 0;\nsetTimeout(tick, ms);",
    "var delay = delay;\nawait sleep(delay);",
    // A missing or `undefined` native timer delay is 0.
    "setTimeout(tick, undefined);",
    "setTimeout(tick, void 0);",
    // A walk past the evaluator's work budget is unknown.
    LONG_CHAIN,
    sharedChain(20),
    // Vitest's fake timers fake every API for an empty `toFake`, and all but the listed ones for `toNotFake`.
    'it("a", () => {\n  vi.useFakeTimers({ toFake: [] });\n  setTimeout(fire, 100);\n});',
    'it("a", () => {\n  vi.useFakeTimers({ toNotFake: ["Date"] });\n  setTimeout(fire, 100);\n});',
    // A covered helper held in an object property, or destructured from one, runs where it is called.
    'const helpers = {\n  wait() {\n    return new Promise((r) => setTimeout(r, 100));\n  },\n};\nit("fake", async () => {\n  vi.useFakeTimers();\n  await helpers.wait();\n});',
    'const { wait } = { wait: () => new Promise((r) => setTimeout(r, 100)) };\nit("fake", async () => {\n  vi.useFakeTimers();\n  await wait();\n});',
    // An install earlier in the same setup hook covers a wait later in it.
    "beforeEach(() => {\n  vi.useFakeTimers();\n  setTimeout(fire, 100);\n});",
    // A test body bound to a name is the test, and its clock install counts.
    'const body = () => {\n  vi.useFakeTimers();\n  setTimeout(fire, 100);\n};\nit("x", body);',
    // The hooks around the call that registers a bound body apply to it.
    'const body = () => {\n  setTimeout(fire, 100);\n};\ndescribe("s", () => {\n  beforeEach(() => {\n    vi.useFakeTimers();\n  });\n  it("x", body);\n});',
    // A restore inside a nested function never counts, called or not.
    'it("a", () => {\n  vi.useFakeTimers();\n  const off = () => vi.useRealTimers();\n  setTimeout(fire, 100);\n});',
    // Every alternative is zero.
    "function pick() {\n  if (flag) return 0;\n  return 0;\n}\nawait sleep(pick());",
    // A self-referencing callee resolves to nothing and cannot crash the rule.
    "var wait = wait.next;\nwait(100);",
    // A poll on state the loop reassigns.
    'let status = "pending";\nwhile (status !== "ready") {\n  await sleep(50);\n  status = await getStatus();\n}',
    // Hooks run outer suite first, so the inner install wins over the outer restore.
    'describe("outer", () => {\n  describe("inner", () => {\n    beforeEach(() => {\n      vi.useFakeTimers();\n    });\n    it("t", () => {\n      setTimeout(fire, 100);\n    });\n  });\n  beforeEach(() => {\n    vi.useRealTimers();\n  });\n});',
    // A helper only faked tests call through an alias is covered.
    'function wait() {\n  return new Promise((r) => setTimeout(r, 100));\n}\nconst waitFake = wait;\nit("fake", async () => {\n  vi.useFakeTimers();\n  await waitFake();\n});',
    // Hooks and vi under a namespace import.
    'import * as vt from "vitest";\nvt.describe("s", () => {\n  vt.beforeEach(() => {\n    vt.vi.useFakeTimers();\n  });\n  vt.it("t", () => {\n    setTimeout(fire, 100);\n  });\n});',
    // One macrotask turn: ordering, not a guess at duration.
    "await new Promise((resolve) => setTimeout(resolve, 0));",
    "await new Promise((resolve) => setTimeout(resolve));",
    "setTimeout(() => step());",
    // A poll repeats until its condition holds.
    "while (!done) {\n  await new Promise((resolve) => setTimeout(resolve, 20));\n}",
    "function* survivors() {\n  for (let i = 0; i < 30 && alive(pid); i += 1) {\n    yield* Effect.sleep(Duration.millis(100));\n  }\n}",
    "for (const attempt of ATTEMPTS) {\n  if (await ready()) break;\n  await sleep(50);\n}",
    // A wrapper forwards its caller's delay.
    "const counted = (handler, delay) => setTimeout(handler, delay);",
    // Effect.sleep under it.effect runs on the test clock.
    'it.effect("retries", () => Effect.gen(function* () {\n  yield* Effect.sleep("1 second");\n}));',
    "vi.advanceTimersByTime(500);",
    "const NONE = 0;\nawait sleep(NONE);",
    // A poll on a flag, and an early exit on a checked condition.
    "let done = false;\nwhile (!done) {\n  await sleep(20);\n  done = await ready();\n}",
    "while (true) {\n  if (await ready()) break;\n  await sleep(20);\n}",
    // A helper only faked tests call is covered by their clock.
    'function wait() {\n  return new Promise((r) => setTimeout(r, 100));\n}\nit("fake", async () => {\n  vi.useFakeTimers();\n  const p = wait();\n  await vi.advanceTimersByTimeAsync(100);\n  await p;\n});',
    // A configured fake-clock helper fakes the timers.
    {
      code: 'it("a", () => {\n  useFakeTimeouts();\n  setTimeout(fire, 100);\n});',
      options: REPO_HELPERS,
    },
    // Without options, an unnamed helper is no wait: precision over recall.
    'import { wait } from "../../test/animation-frames";\nit("a", async () => {\n  await wait(160);\n});',
    // Naming the wait helpers replaces the defaults.
    { code: 'it("a", async () => {\n  await sleep(160);\n});', options: [{ waitHelpers: ["pause"] }] },
    // A configured wait helper is judged like `sleep`.
    {
      code: 'it("a", async () => {\n  vi.useFakeTimers();\n  await pause(160);\n});',
      options: [{ waitHelpers: ["pause"] }],
    },
    'it("a", () => {\n  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });\n  setTimeout(fire, 100);\n});',
    // A simulated clock makes the timer's delay simulated time.
    'it("debounces", () => {\n  vi.useFakeTimers();\n  setTimeout(fire, 100);\n  vi.advanceTimersByTime(100);\n});',
    'describe("toast", () => {\n  beforeEach(() => {\n    vi.useFakeTimers();\n  });\n  it("closes", async () => {\n    setTimeout(close, 5000);\n  });\n});',
    // A helper's forwarded delay is judged at its call sites: zero, polling or a fake clock there waits nothing.
    "const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\nawait pause(0);",
    "const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\nwhile (!done) {\n  await pause(20);\n}",
    'const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\nit("a", async () => {\n  vi.useFakeTimers();\n  const p = pause(100);\n  await vi.advanceTimersByTimeAsync(100);\n  await p;\n});',
    "const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));\nawait pause();",
    // A lowercase JSX tag is an intrinsic element, never a render of the same-named local.
    'const button = () => {\n  setTimeout(fire, 100);\n};\nit("faked", () => {\n  vi.useFakeTimers();\n  button();\n});\nit("real", () => {\n  render(<button type="button">x</button>);\n});',
    // A component the test renders under fake timers runs its timers on the fake clock.
    'function Later() {\n  useEffect(() => {\n    setTimeout(fire, 500);\n  }, []);\n  return null;\n}\nit("a", () => {\n  vi.useFakeTimers();\n  render(<Later />);\n});',
  ],
  invalid: [
    // Reviewer repro: a native timer captured at module level stays real after the install.
    {
      code: 'const now = Date.now;\nconst later = setTimeout;\nit("x", () => {\n  vi.useFakeTimers();\n  later(cb, 100);\n  expect(now()).toBe(0);\n});',
      errors: [{ messageId: "delay", line: 5 }],
    },
    // Captured earlier in the test than the install, too.
    {
      code: 'it("x", () => {\n  const later = setTimeout;\n  vi.useFakeTimers();\n  later(cb, 100);\n});',
      errors: [{ messageId: "delay", line: 4 }],
    },
    // The closure waits for real where it is called without a fake clock, with the delay it was built with.
    {
      code: 'function makeLater(ms) {\n  return () => new Promise((r) => setTimeout(r, ms));\n}\nconst later = makeLater(100);\nit("x", async () => {\n  await later();\n});',
      errors: [{ messageId: "delay", line: 6, column: 8 }],
    },
    // A helper's default applies to an explicit `undefined` as to a missing argument.
    {
      code: "const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));\nawait pause(undefined);",
      errors: [{ messageId: "delay", line: 2, column: 6 }],
    },
    // A JSX member tag renders the component it names on the wall clock.
    {
      code: 'function Widget() {\n  useEffect(() => {\n    setTimeout(fire, 500);\n  }, []);\n  return null;\n}\nconst fixtures = { Widget };\nit("a", () => {\n  render(<fixtures.Widget />);\n});',
      errors: [{ messageId: "delay", line: 3 }],
    },
    // Unfaked helpers wait for real: the first uncovered call path decides, however deep.
    { code: doubledHelpers(3, false), errors: [{ messageId: "delay", line: 2 }] },
    { code: doubledHelpers(20, false), errors: [{ messageId: "delay", line: 2 }] },
    // The budget is charged for kept results too: v449 is past it in either order, v200 is not.
    { code: aliasChain(200, 449), errors: [{ messageId: "delay", line: 451 }] },
    { code: aliasChain(449, 200), errors: [{ messageId: "delay", line: 452 }] },
    // A destructuring default that is not zero waits.
    { code: "const { ms = 100 } = {};\nsetTimeout(tick, ms);", errors: [{ messageId: "delay" }] },
    // `toNotFake` leaves the listed API real; `toFake` beside it makes Vitest throw, which fakes nothing.
    {
      code: 'it("a", () => {\n  vi.useFakeTimers({ toNotFake: ["setTimeout"] });\n  setTimeout(fire, 100);\n});',
      errors: [{ messageId: "delay" }],
    },
    {
      code: 'it("a", () => {\n  vi.useFakeTimers({ toFake: ["setTimeout"], toNotFake: [] });\n  setTimeout(fire, 100);\n});',
      errors: [{ messageId: "delay" }],
    },
    // A helper named as a real wait waits for real, even when it is also a default wait helper.
    {
      code: 'it("a", async () => {\n  vi.useFakeTimers();\n  await sleep(100);\n});',
      options: [{ realWaitHelpers: ["sleep"] }],
      errors: [{ messageId: "delay" }],
    },
    // A helper held in an object property waits for real in a test with no fake clock.
    {
      code: 'const helpers = {\n  wait() {\n    return new Promise((r) => setTimeout(r, 100));\n  },\n};\nit("fake", async () => {\n  vi.useFakeTimers();\n  await helpers.wait();\n});\nit("real", async () => {\n  await helpers.wait();\n});',
      errors: [{ messageId: "delay", line: 3, column: 30 }],
    },
    // Mutually recursive helpers forward the delay whichever is analysed first.
    {
      code: mutualHelpers("await a(0);", "await b(100);"),
      errors: [{ messageId: "delay", line: 9, column: 6 }],
    },
    {
      code: mutualHelpers("await b(100);", "await a(0);"),
      errors: [{ messageId: "delay", line: 8, column: 6 }],
    },
    // A wait under a possible install is a real wait.
    {
      code: 'it("a", () => {\n  const install = flag ? vi.useFakeTimers : noop;\n  install();\n  setTimeout(fire, 100);\n});',
      errors: [{ messageId: "delay" }],
    },
    // A hook that may be a no-op does not cover the wait.
    {
      code: 'const hook = flag ? beforeEach : noop;\nhook(() => vi.useFakeTimers());\nit("a", () => {\n  setTimeout(fire, 100);\n});',
      errors: [{ messageId: "delay" }],
    },
    // A wait before the hook's own install is real.
    {
      code: "beforeEach(() => {\n  setTimeout(fire, 100);\n  vi.useFakeTimers();\n});",
      errors: [{ messageId: "delay" }],
    },
    // A callee that may be setTimeout, in either return order.
    {
      code: "function pick() {\n  if (flag) return noop;\n  return setTimeout;\n}\npick()(fire, 100);",
      errors: [{ messageId: "delay" }],
    },
    {
      code: "function pick() {\n  if (flag) return setTimeout;\n  return noop;\n}\npick()(fire, 100);",
      errors: [{ messageId: "delay" }],
    },
    // `toFake` clearTimeout alone fakes nothing.
    {
      code: 'it("a", () => {\n  vi.useFakeTimers({ toFake: ["clearTimeout"] });\n  setTimeout(fire, 100);\n});',
      errors: [{ messageId: "delay" }],
    },
    // An install inside a nested function never counts, called or not.
    {
      code: 'it("a", () => {\n  function install() {\n    vi.useFakeTimers();\n  }\n  setTimeout(fire, 100);\n});',
      errors: [{ messageId: "delay" }],
    },
    {
      code: 'it("a", () => {\n  const install = () => vi.useFakeTimers();\n  install();\n  setTimeout(fire, 100);\n});',
      errors: [{ messageId: "delay" }],
    },
    // A later install replaces the earlier one's coverage.
    {
      code: 'it("a", () => {\n  vi.useFakeTimers();\n  vi.useFakeTimers({ toFake: ["Date"] });\n  setTimeout(fire, 100);\n});',
      errors: [{ messageId: "delay" }],
    },
    // A global timer through a local alias or an object property.
    { code: "const later = setTimeout;\nlater(fire, 100);", errors: [{ messageId: "delay" }] },
    {
      code: "const timers = { later: setTimeout };\ntimers.later(fire, 100);",
      errors: [{ messageId: "delay" }],
    },
    // One non-zero alternative makes the delay real, in either return order.
    {
      code: "function pick() {\n  if (flag) return 0;\n  return 100;\n}\nawait sleep(pick());",
      errors: [{ messageId: "delay" }],
    },
    {
      code: "function pick() {\n  if (flag) return 100;\n  return 0;\n}\nawait sleep(pick());",
      errors: [{ messageId: "delay" }],
    },
    // A namespace hook that restores real timers leaves the test waiting for real.
    {
      code: 'import * as vt from "vitest";\nvt.describe("s", () => {\n  vt.beforeEach(() => {\n    vt.vi.useFakeTimers();\n    vt.vi.useRealTimers();\n  });\n  vt.it("t", () => {\n    setTimeout(fire, 100);\n  });\n});',
      errors: [{ messageId: "delay" }],
    },
    // A countdown is a counter, not a condition.
    { code: "let i = 3;\nwhile (i--) {\n  await sleep(100);\n}", errors: [{ messageId: "delay" }] },
    // Faking setInterval leaves setTimeout real.
    {
      code: 'it("a", () => {\n  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });\n  setTimeout(fire, 100);\n});',
      errors: [{ messageId: "delay" }],
    },
    // The outer install runs first and the inner restore after it, whatever the source order.
    {
      code: 'describe("outer", () => {\n  describe("inner", () => {\n    beforeEach(() => {\n      vi.useRealTimers();\n    });\n    it("t", () => {\n      setTimeout(fire, 100);\n    });\n  });\n  beforeEach(() => {\n    vi.useFakeTimers();\n  });\n});',
      errors: [{ messageId: "delay" }],
    },
    // A real test that calls the helper through its alias waits for real.
    {
      code: 'function wait() {\n  return new Promise((r) => setTimeout(r, 100));\n}\nconst waitFake = wait;\nit("fake", async () => {\n  vi.useFakeTimers();\n  await wait();\n});\nit("real", async () => {\n  await waitFake();\n});',
      errors: [{ messageId: "delay" }],
    },
    // A global prefix names the same timer.
    { code: "window.setTimeout(fire, 100);", errors: [{ messageId: "delay" }] },
    { code: "globalThis.setTimeout(fire, 100);", errors: [{ messageId: "delay" }] },
    // Callback timers imported from node:timers, aliases included, wait for real even under a fake clock.
    {
      code: 'import { setTimeout } from "node:timers";\nsetTimeout(fire, 100);',
      errors: [{ messageId: "delay" }],
    },
    {
      code: 'import { setTimeout as later } from "timers";\nit("a", () => {\n  vi.useFakeTimers();\n  later(fire, 100);\n});',
      errors: [{ messageId: "delay" }],
    },
    // A key destructured from a namespace import of the promise timers.
    {
      code: 'import * as timers from "node:timers/promises";\nconst { setTimeout: wait } = timers;\nawait wait(100);',
      errors: [{ messageId: "delay" }],
    },
    { code: "await new Promise((resolve) => setTimeout(resolve, 100));", errors: [{ messageId: "delay" }] },
    { code: "await new Promise((r) => { setTimeout(() => r(), 50); });", errors: [{ messageId: "delay" }] },
    { code: "setTimeout(() => button.click(), 200);", errors: [{ messageId: "delay" }] },
    {
      code: 'import { setTimeout } from "node:timers/promises";\nawait setTimeout(100);',
      errors: [{ messageId: "delay" }],
    },
    // An aliased import is the same timer.
    {
      code: 'import { setTimeout as wait } from "node:timers/promises";\nawait wait(100);',
      errors: [{ messageId: "delay" }],
    },
    { code: "await sleep(250);", errors: [{ messageId: "delay" }] },
    { code: "const SETTLE = 300;\nawait delay(SETTLE);", errors: [{ messageId: "delay" }] },
    { code: "await page.waitForTimeout(1000);", errors: [{ messageId: "delay" }] },
    {
      code: 'it.live("waits", () => Effect.gen(function* () {\n  yield* Effect.sleep(Duration.millis(200));\n}));',
      errors: [{ messageId: "delay" }],
    },
    // A loop around the test does not make a delay inside its own callback a poll.
    {
      code: "for (const row of rows) {\n  it(row, async () => {\n    await sleep(100);\n  });\n}",
      errors: [{ messageId: "delay" }],
    },
    // A loop over items is not a poll: it waits a fixed time per item.
    {
      code: "for (const name of names) {\n  await sleep(100);\n  await check(name);\n}",
      errors: [{ messageId: "delay" }],
    },
    {
      code: "for (let i = 0; i < 3; i += 1) {\n  await sleep(100);\n}",
      errors: [{ messageId: "delay" }],
    },
    // A fake clock in another test leaves this one waiting for real.
    {
      code: 'it("a", () => {\n  vi.useFakeTimers();\n});\nit("b", async () => {\n  await sleep(100);\n});',
      errors: [{ messageId: "delay" }],
    },
    // A counter is no condition.
    { code: "let i = 0;\nwhile (i++ < 3) {\n  await sleep(100);\n}", errors: [{ messageId: "delay" }] },
    {
      code: "for (let attempt = 0; attempt < MAX; attempt += 1) {\n  await sleep(100);\n}",
      errors: [{ messageId: "delay" }],
    },
    {
      code: "for (const name of names) {\n  if (count++ > 3) break;\n  await sleep(100);\n}",
      errors: [{ messageId: "delay" }],
    },
    // A namespace import of the promise timers.
    {
      code: 'import * as timers from "node:timers/promises";\nawait timers.setTimeout(100);',
      errors: [{ messageId: "delay" }],
    },
    {
      code: 'import { scheduler } from "node:timers/promises";\nawait scheduler.wait(100);',
      errors: [{ messageId: "delay" }],
    },
    // A fake clock that fakes only Date leaves the timers real.
    {
      code: 'it("a", async () => {\n  vi.useFakeTimers({ toFake: ["Date"] });\n  await sleep(1000);\n});',
      errors: [{ messageId: "delay" }],
    },
    // Restoring real timers ends the fake clock.
    {
      code: 'it("a", async () => {\n  vi.useFakeTimers();\n  vi.useRealTimers();\n  await sleep(100);\n});',
      errors: [{ messageId: "delay" }],
    },
    // A promise timer waits for real under a fake clock.
    {
      code: 'import { setTimeout as wait } from "node:timers/promises";\nit("a", async () => {\n  vi.useFakeTimers();\n  await wait(100);\n});',
      errors: [{ messageId: "delay" }],
    },
    // A helper that a faked test and a real test both call waits for real in the second.
    {
      code: 'function wait() {\n  return new Promise((r) => setTimeout(r, 100));\n}\nit("fake", async () => {\n  vi.useFakeTimers();\n  await wait();\n});\nit("real", async () => {\n  await wait();\n});',
      errors: [{ messageId: "delay" }],
    },
    // A configured frame-spinning `wait(ms)` waits for real, fake timers or not.
    {
      code: 'import { wait } from "../../test/animation-frames";\nit("a", async () => {\n  await wait(160);\n});',
      options: REPO_HELPERS,
      errors: [{ messageId: "delay" }],
    },
    {
      code: 'import { wait } from "../../test/animation-frames";\nit("a", async () => {\n  useFakeTimeouts();\n  await wait(160);\n});',
      options: REPO_HELPERS,
      errors: [{ messageId: "delay" }],
    },
    // A configured wait helper outside a fake clock waits for real.
    {
      code: 'it("a", async () => {\n  await pause(160);\n});',
      options: [{ waitHelpers: ["pause"] }],
      errors: [{ messageId: "delay" }],
    },

    // A delay forwarded through a local helper is reported at the call that sets it.
    {
      code: "const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\nawait pause(160);",
      errors: [{ messageId: "delay", line: 2, column: 6 }],
    },
    {
      code: "function pause(ms) {\n  return new Promise((resolve) => setTimeout(resolve, ms));\n}\nawait pause(160);",
      errors: [{ messageId: "delay", line: 4, column: 6 }],
    },
    {
      code: "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\nawait sleep(160);",
      errors: [{ messageId: "delay", line: 2, column: 6 }],
    },
    {
      code: "const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\nawait pause(160);\nawait pause(5000);",
      errors: [
        { messageId: "delay", line: 2, column: 6 },
        { messageId: "delay", line: 3, column: 6 },
      ],
    },
    // Coverage is judged at each call: only the call in the unfaked test waits.
    {
      code: 'const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\nit("fake", async () => {\n  vi.useFakeTimers();\n  const p = pause(100);\n  await vi.advanceTimersByTimeAsync(100);\n  await p;\n});\nit("real", async () => {\n  await pause(100);\n});',
      errors: [{ messageId: "delay", line: 9, column: 8 }],
    },
    // Through a chain of helpers, only the outermost call that sets the delay reports.
    {
      code: "const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\nconst nap = (ms) => pause(ms);\nawait nap(50);",
      errors: [{ messageId: "delay", line: 3, column: 6 }],
    },
    // The helper's timer sets no delay, so a disable above it allows no caller's wait.
    {
      code: "const pause = (ms) =>\n  new Promise((resolve) => {\n    // oxlint-disable-next-line no-fixed-delay -- the debounce contract\n    setTimeout(resolve, ms);\n  });\nawait pause(150);\nawait pause(9000);",
      errors: [
        { messageId: "delay", line: 6, column: 6 },
        { messageId: "delay", line: 7, column: 6 },
      ],
    },
    // A parameter's default is the delay a call that omits the argument sets.
    {
      code: "const pause = (ms = 160) => new Promise((resolve) => setTimeout(resolve, ms));\nawait pause();",
      errors: [{ messageId: "delay", line: 2, column: 6 }],
    },
    // A delay a helper writes itself is reported at the timer that writes it.
    {
      code: "const hold = () => new Promise((resolve) => setTimeout(resolve, 100));\nawait hold();",
      errors: [{ messageId: "delay", line: 1, column: 44 }],
    },
    // A component rendered without fake timers runs its timers on the wall clock.
    {
      code: 'function Later() {\n  useEffect(() => {\n    setTimeout(fire, 500);\n  }, []);\n  return null;\n}\nit("a", () => {\n  render(<Later />);\n});',
      errors: [{ messageId: "delay" }],
    },
    // A shared chain within the budget resolves.
    { code: sharedChain(6), errors: [{ messageId: "delay" }] },
  ],
});
