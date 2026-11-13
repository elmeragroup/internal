import { ruleTester } from "../shared/rule-tester.ts";
import { noWallClock } from "./no-wall-clock.ts";

ruleTester.run("no-wall-clock", noWallClock, {
  valid: [
    // A capture offset by a value the file does not hold as a number builds a timestamp; it measures nothing.
    'import { HOUR } from "./constants.ts";\nit("a", () => {\n  const cutoff = Date.now() - HOUR;\n  log(cutoff);\n});',
    'it("a", () => {\n  const daysAgo = (days) => new Date(Date.now() - days * 86_400_000);\n  log(daysAgo(2));\n});',
    // The age of a fixture date, and the difference of two dates derived from one injected now.
    'it("a", () => {\n  const born = new Date("2000-01-01");\n  log(Date.now() - born.getTime());\n});',
    'it("a", () => {\n  const now = new Date();\n  const tomorrow = addDays(now, 1);\n  expect(tomorrow.getTime() - now.getTime()).toBe(86_400_000);\n});',
    // `vi.setSystemTime` without fake timers installs a clock that fakes Date (Vitest 5.1).
    'beforeEach(() => {\n  vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));\n});\nit("a", () => {\n  const start = Date.now();\n  vi.setSystemTime(start + 5000);\n  expect(Date.now() - start).toBe(5000);\n});',
    // `vitest` is exported beside `vi` with the same API.
    'import { vitest } from "vitest";\nit("a", () => {\n  vitest.useFakeTimers();\n  const start = Date.now();\n  vitest.advanceTimersByTime(5);\n  expect(Date.now() - start).toBe(5);\n});',
    // Playwright registers hooks as `test.beforeEach` and `test.beforeAll`.
    'test.beforeEach(async ({ page }) => {\n  await page.clock.install();\n});\ntest("t", async ({ page }) => {\n  const start = await page.evaluate(() => Date.now());\n  await page.clock.runFor(1000);\n  expect((await page.evaluate(() => Date.now())) - start).toBe(1000);\n});',
    // A test registered through an extended `test` runs its own body and its suite's hooks.
    'import { test as base } from "vitest";\nconst test = base.extend({});\ntest("a", () => {\n  vi.useFakeTimers();\n  const start = Date.now();\n  vi.advanceTimersByTime(5);\n  expect(Date.now() - start).toBe(5);\n});',
    'import { test as base } from "@playwright/test";\nconst test = base.extend({});\ntest.beforeEach(async ({ page }) => {\n  await page.clock.install();\n});\ntest("t", async ({ page }) => {\n  const start = await page.evaluate(() => Date.now());\n  await page.clock.runFor(1000);\n  expect((await page.evaluate(() => Date.now())) - start).toBe(1000);\n});',
    // A clock read captured after the install is the fake clock.
    'it("x", () => {\n  vi.useFakeTimers();\n  const now = Date.now;\n  expect(now()).toBe(0);\n});',
    // A capture read off a helper's returned object or list is judged at the call that returned it.
    'const times = () => ({ now: Date.now() });\nit("x", () => {\n  const seed = times().now;\n  vi.useFakeTimers();\n  vi.setSystemTime(seed);\n  expect(times().now).toBe(seed);\n});',
    'const times = () => [Date.now()];\nit("x", () => {\n  const seed = times()[0];\n  vi.useFakeTimers();\n  vi.setSystemTime(seed);\n  expect(times()[0]).toBe(seed);\n});',
    // A helper's capture is judged at the call that produces the asserted value: the seed is read
    // before the install, the asserted time after it.
    'function now() {\n  return Date.now();\n}\nit("x", () => {\n  const seed = now();\n  vi.useFakeTimers();\n  vi.setSystemTime(seed);\n  expect(now()).toBe(seed);\n});',
    // A configured fake-clock helper covers the APIs it names.
    {
      code: 'it("a", () => {\n  useFakeClock();\n  const start = Date.now();\n  log(Date.now() - start);\n});',
      options: [{ fakeClockHelpers: [{ name: "useFakeClock", fakes: ["Date"] }] }],
    },
    // An installer that is the same API in every alternative is guaranteed.
    'it("a", () => {\n  const install = flag ? vi.useFakeTimers : vi.useFakeTimers;\n  install();\n  const s = Date.now();\n  log(Date.now() - s);\n});',
    // A date constructed under the fake clock keeps its simulated time after a restore.
    'it("a", () => {\n  vi.useFakeTimers();\n  const at = new Date();\n  vi.useRealTimers();\n  log(at.getTime() - start);\n});',
    // An install earlier in the same setup hook covers a read later in it.
    "beforeEach(() => {\n  vi.useFakeTimers();\n  const s = Date.now();\n  log(Date.now() - s);\n});",
    // A hook bound to one API registers its install surely.
    'const hook = beforeEach;\nhook(() => {\n  vi.useFakeTimers();\n});\nit("a", () => {\n  const s = Date.now();\n  log(Date.now() - s);\n});',
    // A reused body every suite fakes is covered at every registration.
    'const body = () => {\n  const s = Date.now();\n  log(Date.now() - s);\n};\ndescribe("a", () => {\n  beforeEach(() => vi.useFakeTimers());\n  it("x", body);\n});\ndescribe("b", () => {\n  beforeEach(() => vi.useFakeTimers());\n  it("y", body);\n});',
    // An install inside a try block runs in order with the body.
    'it("a", () => {\n  try {\n    vi.useFakeTimers();\n    const s = Date.now();\n    log(Date.now() - s);\n  } finally {\n    vi.useRealTimers();\n  }\n});',
    // A fixed date's time is no clock read.
    "const fixed = new Date(0);\nlog(fixed.getTime() - start);",
    // A read under the fake clock stays simulated after the clock is restored.
    'it("a", () => {\n  vi.useFakeTimers();\n  vi.setSystemTime(0);\n  const at = Date.now();\n  vi.useRealTimers();\n  expect(at - 0).toBe(0);\n});',
    // `toFake` that names Date in every alternative covers Date.
    'it("a", () => {\n  vi.useFakeTimers(flag ? { toFake: ["Date"] } : { toFake: ["Date", "setTimeout"] });\n  const s = Date.now();\n  log(Date.now() - s);\n});',
    // A self-referencing callee resolves to nothing and cannot crash the rule.
    "var now = now.next;\nlog(now() - start);",
    // The spread comes last, so its toFake (Date) wins.
    'it("a", () => {\n  const defaults = { toFake: ["Date"] };\n  vi.useFakeTimers({ toFake: ["setTimeout"], ...defaults });\n  const s = Date.now();\n  log(Date.now() - s);\n});',
    // `toFake` names Date, so Date reads are simulated.
    'it("a", () => {\n  vi.useFakeTimers({ toFake: ["Date"] });\n  const start = Date.now();\n  vi.setSystemTime(start + 100);\n  expect(Date.now() - start).toBe(100);\n});',
    // A restore in a teardown hook ends nothing inside the test.
    'afterEach(() => {\n  vi.useRealTimers();\n});\nit("a", () => {\n  vi.useFakeTimers();\n  const start = Date.now();\n  vi.advanceTimersByTime(5);\n  expect(Date.now() - start).toBe(5);\n});',
    // A cycle in a local clock function stops.
    "const now = () => now();\nlog(now() - start);",
    "const scratch = join(tmpdir(), `flags-${Date.now()}`);",
    "await page.clock.pauseAt(Date.now() + 1000);",
    "vi.setSystemTime(Date.now());",
    // A difference of two dates the test wrote is calendar arithmetic, not a measurement.
    "expect(end.getTime() - start.getTime()).toBe(DAY);",
    // Under a simulated clock, elapsed time is what the test advanced.
    'it("debounces", () => {\n  vi.useFakeTimers();\n  const start = Date.now();\n  vi.advanceTimersByTime(100);\n  expect(Date.now() - start).toBe(100);\n});',
    'describe("timer", () => {\n  beforeEach(() => {\n    vi.useFakeTimers();\n  });\n  it("waits", () => {\n    const start = performance.now();\n    vi.advanceTimersByTime(50);\n    expect(performance.now() - start).toBe(50);\n  });\n});',
    'it("ticks", async ({ page }) => {\n  await page.clock.install();\n  const start = await page.evaluate(() => Date.now());\n  await page.clock.runFor(1000);\n  expect((await page.evaluate(() => Date.now())) - start).toBe(1000);\n});',
    // A capture offset by a number seeds a timestamp, before or after now; it measures nothing.
    "const hourAgo = new Date(Date.now() - 3_600_000);",
    "const HOUR = 3_600_000;\nconst stamp = Date.now() - HOUR;",
    "const ts = Date.now();\nlog(ts - 1000);",
  ],
  invalid: [
    // Reviewer repro: a native clock read captured at module level stays real after the install.
    {
      code: 'const now = Date.now;\nconst later = setTimeout;\nit("x", () => {\n  vi.useFakeTimers();\n  later(cb, 100);\n  expect(now()).toBe(0);\n});',
      errors: [{ messageId: "budget", line: 6 }],
    },
    {
      code: 'const RealDate = Date;\nit("x", () => {\n  vi.useFakeTimers();\n  expect(new RealDate()).toBe(0);\n});',
      errors: [{ messageId: "budget", line: 4 }],
    },
    // The projected capture asserted is the one taken before the install.
    {
      code: 'const times = () => ({ now: Date.now() });\nit("x", () => {\n  const start = times().now;\n  vi.useFakeTimers();\n  times();\n  expect(start).toBeGreaterThan(0);\n});',
      errors: [{ messageId: "budget", line: 6 }],
    },
    // The asserted value comes from the call before the install.
    {
      code: 'function now() {\n  return Date.now();\n}\nit("x", () => {\n  const start = now();\n  vi.useFakeTimers();\n  now();\n  expect(start).toBeGreaterThan(0);\n});',
      errors: [{ messageId: "budget", line: 8 }],
    },
    // An installer that may be a no-op is a possible install, which covers nothing.
    {
      code: 'it("a", () => {\n  const install = flag ? vi.useFakeTimers : noop;\n  install();\n  const s = Date.now();\n  log(Date.now() - s);\n});',
      errors: [{ messageId: "budget" }],
    },
    // A restore that may run intersects coverage away.
    {
      code: 'it("a", () => {\n  vi.useFakeTimers();\n  const restore = flag ? vi.useRealTimers : noop;\n  restore();\n  const s = Date.now();\n  log(Date.now() - s);\n});',
      errors: [{ messageId: "budget" }],
    },
    // A restore under a branch is possible and ends coverage.
    {
      code: 'it("a", () => {\n  vi.useFakeTimers();\n  if (flag) vi.useRealTimers();\n  const s = Date.now();\n  log(Date.now() - s);\n});',
      errors: [{ messageId: "budget" }],
    },
    // An install under a branch is possible and starts no coverage.
    {
      code: 'it("a", () => {\n  if (flag) vi.useFakeTimers();\n  const s = Date.now();\n  log(Date.now() - s);\n});',
      errors: [{ messageId: "budget" }],
    },
    // A hook that may be a no-op registers its install possibly.
    {
      code: 'const hook = flag ? beforeEach : noop;\nhook(() => {\n  vi.useFakeTimers();\n});\nit("a", () => {\n  const s = Date.now();\n  log(Date.now() - s);\n});',
      errors: [{ messageId: "budget" }],
    },
    // A test registered through a callee that may not be the runner may run without its hooks.
    {
      code: 'const run = flag ? it : direct;\nbeforeEach(() => vi.useFakeTimers());\nrun("a", () => {\n  const s = Date.now();\n  log(Date.now() - s);\n});',
      errors: [{ messageId: "budget" }],
    },
    // Each toFake element counts only when every alternative names the API.
    {
      code: 'it("a", () => {\n  vi.useFakeTimers({ toFake: [flag ? "Date" : "setTimeout"] });\n  const s = Date.now();\n  log(Date.now() - s);\n});',
      errors: [{ messageId: "budget" }],
    },
    // A spread of alternatives builds one options object per alternative.
    {
      code: 'it("a", () => {\n  vi.useFakeTimers({ ...(flag ? { toFake: ["setTimeout"] } : {}) });\n  const s = Date.now();\n  log(Date.now() - s);\n});',
      errors: [{ messageId: "budget" }],
    },
    // A reused body is judged at every registration, each with its own suite's hooks.
    {
      code: 'const body = () => {\n  const s = Date.now();\n  log(Date.now() - s);\n};\ndescribe("a", () => {\n  beforeEach(() => vi.useFakeTimers());\n  it("x", body);\n});\ndescribe("b", () => {\n  it("y", body);\n});',
      errors: [{ messageId: "budget" }],
    },
    // A date constructed before the install captured the wall clock.
    {
      code: 'it("a", () => {\n  const at = new Date();\n  vi.useFakeTimers();\n  log(at.getTime() - start);\n});',
      errors: [{ messageId: "budget" }],
    },
    // A read before the hook's own install is on the wall clock.
    {
      code: "beforeEach(() => {\n  const s = Date.now();\n  vi.useFakeTimers();\n  log(Date.now() - s);\n});",
      errors: [{ messageId: "budget" }],
    },
    // A bound new Date() is the current time.
    { code: "const date = new Date();\nlog(date.getTime() - start);", errors: [{ messageId: "budget" }] },
    // One alternative read of the clock is a budget, in either return order.
    {
      code: "function now() {\n  if (flag) return 0;\n  return Date.now();\n}\nlog(now() - start);",
      errors: [{ messageId: "budget" }],
    },
    {
      code: "function now() {\n  if (flag) return Date.now();\n  return 0;\n}\nlog(now() - start);",
      errors: [{ messageId: "budget" }],
    },
    // A read before the fake clock is installed is a wall-clock read, whatever follows.
    {
      code: 'it("a", () => {\n  const at = Date.now();\n  vi.useFakeTimers();\n  expect(Date.now() - at).toBeLessThan(5);\n});',
      errors: [{ messageId: "budget" }],
    },
    // `toFake` covers only what every alternative fakes.
    {
      code: 'it("a", () => {\n  vi.useFakeTimers(flag ? { toFake: ["Date"] } : { toFake: ["setTimeout"] });\n  const s = Date.now();\n  log(Date.now() - s);\n});',
      errors: [{ messageId: "budget" }],
    },
    // `page.clock` fakes the page's clock, never the test's own Date.
    {
      code: 'it("t", async ({ page }) => {\n  await page.clock.install();\n  const s = Date.now();\n  log(Date.now() - s);\n});',
      errors: [{ messageId: "budget" }],
    },
    // Global prefixes name the same clock.
    {
      code: "const start = window.performance.now();\nlog(globalThis.performance.now() - start);",
      errors: [{ messageId: "budget" }],
    },
    // The own toFake comes last and wins over the spread, so Date stays real.
    {
      code: 'it("a", () => {\n  const defaults = { toFake: ["Date"] };\n  vi.useFakeTimers({ ...defaults, toFake: ["setTimeout"] });\n  const s = Date.now();\n  log(Date.now() - s);\n});',
      errors: [{ messageId: "budget" }],
    },
    // The page clock pair: without page.clock, Date.now in the page is the wall clock.
    {
      code: 'it("ticks", async ({ page }) => {\n  const start = await page.evaluate(() => Date.now());\n  expect((await page.evaluate(() => Date.now())) - start).toBe(1000);\n});',
      errors: [{ messageId: "budget" }],
    },
    // A local clock function hides nothing.
    {
      code: "const now = () => performance.now();\nconst start = now();\nrender();\nexpect(now() - start).toBeLessThan(50);",
      errors: [{ messageId: "budget" }],
    },
    {
      code: "function now() {\n  const t = Date.now();\n  return t;\n}\nlog(now() - start);",
      errors: [{ messageId: "budget" }],
    },
    // A fake clock that leaves an API real does not cover it.
    {
      code: 'it("a", () => {\n  useFakeTimeouts();\n  const start = performance.now();\n  expect(performance.now() - start).toBeLessThan(50);\n});',
      options: [{ fakeClockHelpers: [{ name: "useFakeTimeouts", fakes: ["setTimeout"] }] }],
      errors: [{ messageId: "budget" }],
    },
    // Without options, an unnamed helper fakes nothing.
    {
      code: 'it("a", () => {\n  useFakeTimeouts();\n  const start = Date.now();\n  log(Date.now() - start);\n});',
      errors: [{ messageId: "budget" }],
    },
    {
      code: 'it("a", () => {\n  vi.useFakeTimers({ toFake: ["setTimeout"] });\n  const start = Date.now();\n  log(Date.now() - start);\n});',
      errors: [{ messageId: "budget" }],
    },
    // Restoring real timers ends the fake clock from there on.
    {
      code: 'it("a", () => {\n  vi.useFakeTimers();\n  vi.useRealTimers();\n  const start = Date.now();\n  log(Date.now() - start);\n});',
      errors: [{ messageId: "budget" }],
    },
    // An aliased expect still asserts.
    {
      code: 'import { expect as check } from "vitest";\ncheck(performance.now()).toBeLessThan(deadline);',
      errors: [{ messageId: "budget" }],
    },
    {
      code: "const start = performance.now();\nrender();\nexpect(performance.now() - start).toBeLessThan(50);",
      errors: [{ messageId: "budget" }],
    },
    {
      code: "const start = Date.now();\nawait run();\nconst end = Date.now();\nconst elapsed = end - start;",
      errors: [{ messageId: "budget" }],
    },
    {
      code: "const before = new Date().getTime();\nawait run();\nreport(new Date().getTime() - before);",
      errors: [{ messageId: "budget" }],
    },
    { code: "expect(performance.now()).toBeLessThan(deadline);", errors: [{ messageId: "budget" }] },
    {
      code: "const [s] = process.hrtime();\nlog(process.hrtime.bigint() - t0);",
      errors: [{ messageId: "budget" }],
    },
    // An alias of an alias still reads the clock.
    {
      code: "const t0 = Date.now();\nconst start = t0;\nlog(Date.now() - start);",
      errors: [{ messageId: "budget" }],
    },
    // A fake clock in another test leaves this one on the wall clock.
    {
      code: 'it("a", () => {\n  vi.useFakeTimers();\n});\nit("b", () => {\n  const start = Date.now();\n  expect(Date.now() - start).toBeLessThan(5);\n});',
      errors: [{ messageId: "budget" }],
    },
    // Two captures subtracted measure the time between them, offset exemption or not.
    {
      code: "const start = Date.now();\nwork();\nlog(Date.now() - start);",
      errors: [{ messageId: "budget" }],
    },
  ],
});
