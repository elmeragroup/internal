# @elmeragroup/oxlint-test-rules

Private implementation of `@elmeragroup/internal/oxlint/tests`: lint rules for the shapes a test may
not take because they flake or pin the implementation. The root `.oxlintrc.json` registers the
plugin as `tests` and turns the rules on for `**/*.test.*` files, helpers under `test/` directories
and test-runner configs.

The rules came from `elmeragroup/fuse` (`tooling/oxlint-plugin-fuse`, PR #605), with Fuse's own paths
and helpers turned into options.

## Rules

| Rule                      | Reports                                                                                                                                                              | Options                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `no-test-retry`           | `retry`, `repeats` or `retries` that may be other than `0` or `false` on a test, suite or `vi.setConfig`; in a file not named `*.test.*` or `*.spec.*`, any such key | none                                                 |
| `no-wall-clock`           | a real-clock capture (`Date.now()`, `performance.now()`, `process.hrtime()`, `new Date()`) that is subtracted or asserted                                            | `fakeClockHelpers`                                   |
| `no-fixed-delay`          | a non-zero `setTimeout`, timer import, `sleep`, `delay`, `page.waitForTimeout` or live `Effect.sleep` outside a fake clock or polling loop                           | `waitHelpers`, `realWaitHelpers`, `fakeClockHelpers` |
| `no-source-reading-tests` | `readFileSync`, `readFile` or `readFileString` of a code module the test did not write, or a `?raw` import of one                                                    | none                                                 |
| `no-class-assertions`     | an assertion on an element's class the test did not supply                                                                                                           | none                                                 |
| `no-geometry-assertions`  | a measured layout length asserted against a pixel number or pixel string                                                                                             | none                                                 |

Each rule's JSDoc states its full scope: what it allows (`Date.now() - HOUR`, `retry: 0`, a zero
delay, a delay under `vi.useFakeTimers()`, a class the test passed in, a relation between two
measurements) and what it does not follow. `no-fixed-delay` and `no-wall-clock` do not follow a test
registered through a local wrapper that forwards its body to `it`, or a timer or clock read in a
class method (`new C().m()`): each is judged without its test's fake clock.

### Options

- `waitHelpers` (`no-fixed-delay`): helpers whose first argument is a delay on the global timers, so a
  fake clock takes them over. Default `["sleep", "delay"]`; a configured list replaces it.
- `realWaitHelpers` (`no-fixed-delay`): helpers whose first argument is a delay that waits for real
  under any fake clock, such as one that spins on animation frames. Default none. A helper in both
  lists waits for real.
- `fakeClockHelpers` (`no-fixed-delay`, `no-wall-clock`): the repository's own fake-clock installers
  and the clock APIs each fakes, as `[{ "name": "useFakeTimeouts", "fakes": ["setTimeout"] }]`.
  `vi.useFakeTimers()` (with Vitest 5.1's `toFake` and `toNotFake` semantics) and Playwright's
  `page.clock` are built in. Default none.

## Design

Precision comes before recall. A rule targets the junk shape, not every use of an API: a false
positive is always a bug, and a false negative is fixed when ordinary code or a plain refactor
produces it.

The rules read every value through one evaluator, `shared/resolve.ts`, which opens with a numbered
contract of exactly what it follows: wrappers, bindings and in-place mutation through aliases,
destructuring with defaults, members and spreads, local returns, page `evaluate` callbacks, imports,
globals, conditions, short-circuit logic and primitive operations. Each rule's scope reads "follows
what `resolve.ts` follows" plus that rule's own limits. A value the evaluator cannot know
(`unknown`, including an evaluation past its work budget) is never evidence: no rule reports on it
and none grants an exemption on it.

Every recursive analysis, the evaluator's and each rule's own (a measurement, a class read, a path,
a clock's coverage), is an `Analysis` on one bounded traversal, `shared/traversal.ts`: memoized
per file, cut at cycles, and charged against one work budget whether its results are cached or not,
so a verdict depends neither on cache warmth nor on order. Add a rule's recursive classifier the
same way, keyed by everything its result depends on; `shared/traversal.guard.test.ts` runs every
rule on self-referencing and doubled values and fails on a crash or a run that does not finish.

- `shared/value.ts` holds the values and their pure operations; `derive` is the one way provenance
  (`named`, `via`) is marked. `shared/mutations.ts` indexes in-place mutations.
- `shared/quantify.ts` is the one rule for alternatives: a value violates when any alternative does,
  and earns an exemption only when every alternative qualifies and none is unknown.
- `shared/source-paths.ts` is `no-source-reading-tests`' path model: spelling, listed files, and
  paths the test wrote.
- `shared/fake-clock.ts` models clock installs and restores as guaranteed or possible events, judged
  where time is captured, and a capture a helper returns at the call that returned it.
- `shared/test-context.ts` finds tests, setup hooks and their order, and where a helper runs: every
  call whose callee, and every JSX element whose tag, the evaluator resolves to it.
- `shared/resolve.matrix.test.ts` crosses every contract step with every place a rule reads a value,
  and expects the same verdict as writing the value directly.

## Tests

Run the rule-tester suites and type-check with Node 24:

```sh
pnpm --filter @elmeragroup/oxlint-test-rules test
pnpm --filter @elmeragroup/oxlint-test-rules type-check
```

Each rule has a sibling `rules/<rule-name>.test.ts` suite.
