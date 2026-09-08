# Plan 007: Detect dark variants before arbitrary and modified utilities

> Executor instructions: Read this entire plan before editing. Follow each step and its expected verification result. On a STOP condition, report the specific blocker instead of expanding scope. Update this plan's status and its row in plans/README.md when complete, unless a reviewing operator owns those updates.
>
> Drift check: `git diff --stat e9ad9b3..HEAD -- 'packages/oxlint-plugin/rules/no-tailwind-dark-variant.js' 'packages/oxlint-plugin/rules/no-tailwind-dark-variant.test.js' 'packages/oxlint-plugin/extract-strings.js' 'packages/oxlint-plugin/rule-tester.js' 'packages/internal/README.md' 'test/packed-consumer/lint.mjs' '.changeset/tailwind-dark-variants.md' 'plans/007-tailwind-dark-variants.md' 'plans/README.md'`
> If implementation files changed, compare the excerpts below to live code. If they no longer match, stop for reconciliation. New plan files alone are expected and do not indicate implementation drift. Also inspect `git status --short` for uncommitted edits before starting; the `plans/` directory is untracked on the advisor branch and is expected to appear there.

## Status

- Status: TODO
- Finding: 7 from the deep audit
- Priority: P2
- Effort: S, including regression coverage
- Fix risk: LOW
- Depends on: none
- Category: bug
- Planned at: commit `e9ad9b3`, 2026-09-08
- Reviewed: 2026-09-08 against `e9ad9b3` (review-plan pass; commands re-verified)
- Confidence: HIGH, reproduced during the audit

## Why this matters

`elmera/no-tailwind-dark-variant` exists so library source never styles on Tailwind's `dark:` axis; consumers enable it as an error (see `packages/internal/README.md:47`). Its matcher requires an ASCII letter immediately after `dark:`, so valid Tailwind classes such as `dark:[color:red]`, `dark:!bg-red-500` and `dark:-mt-1` bypass the prohibition. The same matcher also produces a false positive when the text `dark:` appears inside an arbitrary value such as `[content:'dark:literal']`. Consumers should receive the same diagnostic regardless of utility syntax, and only for real variant positions.

## Current state

- `packages/oxlint-plugin/rules/no-tailwind-dark-variant.js` — the rule. Lifted from kumo (MIT, Cloudflare); keep the attribution comment on line 1. The only change this plan makes to the rule is inside `hasDarkVariant`; the three visitors and `reportIfDark` stay as they are.
- `packages/oxlint-plugin/extract-strings.js` — shared helper that collects string literals, template quasis (cooked text), concatenations, arrays, objects, call arguments and conditionals. Out of scope; read it to understand what strings reach `hasDarkVariant`.
- `packages/oxlint-plugin/rule-tester.js` — `createRuleTester(lang)` wraps `oxlint/plugins-dev` `RuleTester` for vitest. Out of scope.
- `packages/oxlint-plugin/index.js:12,31` — registers the rule as `"no-tailwind-dark-variant"`. Out of scope; the rule name and message must not change.
- `packages/internal/src/oxlint.ts` — re-exports the plugin; `packages/internal/tsdown.config.ts` bundles the plugin into `dist/oxlint.mjs`. So the packed consumer sees this fix only after `pnpm build`.
- `test/packed-consumer/lint.mjs:24,40-45` — packed-consumer test asserts the rule is registered and reports `dark:bg-red-500` in `lint-input.ts`. Out of scope; it must keep passing unchanged.
- `packages/oxlint-plugin/rules/no-tailwind-dark-variant.test.js` — does not exist yet. The rule currently has no test file (12 test files exist in `rules/`; this rule is not among them).

The rule has no `Program` visitor and no per-file mutable state. Do not introduce any; `hasDarkVariant` is a pure `(string) => boolean`.

`packages/oxlint-plugin/rules/no-tailwind-dark-variant.js:8-13`:

```text
/**
 * @param {string} str
 */
function hasDarkVariant(str) {
  return /\bdark:[a-z]+[-\w]*/.test(str);
}
```

`packages/oxlint-plugin/rules/no-tailwind-dark-variant.js:54-80` (visitors; do not change):

```text
    return {
      JSXAttribute(node) {
        const name = node.name.type === "JSXIdentifier" ? node.name.name : undefined;
        if (name !== "className" && name !== "class") return;

        if (node.value) {
          reportIfDark(node, extractStrings(node.value));
        }
      },
      Literal(node) {
        if (typeof node.value !== "string" || !hasDarkVariant(node.value) || isInsideJsxAttribute(node)) {
          return;
        }

        context.report({ node, messageId: RULE_NAME });
      },
      TemplateLiteral(node) {
        if (isInsideJsxAttribute(node)) {
          return;
        }

        const strings = extractStrings(node);
        if (strings.some(hasDarkVariant)) {
          context.report({ node, messageId: RULE_NAME });
        }
      },
    };
```

Behavior of the current regex that the replacement must preserve:

- `\b` before `dark` treats `-` as a boundary, so `not-dark:bg-red-500` and `group-dark:bg-red-500` are reported today. The new matcher must treat a variant segment that is exactly `dark` or ends with `-dark` as the dark axis so those stay reported. `darkish:bg-red-500` and `dark-mode` (no colon) are not reported today and must stay valid.
- A bare `dark:` with nothing after it (for example the cooked quasi `"dark:"` in `` `dark:${x}` ``) is not reported today and stays not reported. This is a known limitation, recorded in Maintenance notes; do not try to fix it here.
- `dark:bg-red-500!` (Tailwind v4 trailing important) is already reported and stays reported.

Behavior the replacement intentionally changes:

- Newly reported: `dark:[color:red]`, `dark:!bg-red-500`, `dark:-mt-1`, `hover:dark:[color:red]`, `dark:[&>span]:text-red-500`, `[&:hover]:dark:text-red-500`.
- No longer reported (false positive removed): `dark:` text inside brackets, for example `[content:'dark:literal']` or `before:content-['dark:x']`.

## Conventions and test pattern

Read root README.md and AGENTS.md before implementation. The plugin is plain ESM JavaScript with JSDoc types; match that, do not convert to TypeScript. Kebab-case filenames. Root `pnpm lint` runs `oxlint . --deny-warnings` over this package with the `typescript`, `oxc`, `import` and `unicorn` plugins from `.oxlintrc.json`, so idioms such as `str.indexOf(x) === 0` or `str.charAt(i)` may be flagged; prefer `startsWith`/`endsWith`, `str[i]`, and `for...of`. Fix the underlying issue before adding a lint exception.

Keep the lint implementation private and bundled through internal's explicit lint entry. Use the existing `defineRule`/`createOnce` pattern already present in the file and the shared `createRuleTester`. Lint entries must not load TypeScript or Effect (no new imports are needed). Preserve the kumo license attribution on line 1.

Use this existing string-rule test as the structural pattern, `packages/oxlint-plugin/rules/no-primitive-colors.test.js:1-12`:

```text
import { createRuleTester } from "../rule-tester.js";
import noPrimitiveColors from "./no-primitive-colors.js";

const tester = createRuleTester("tsx");
const error = { messageId: "no-primitive-colors" };

tester.run("elmera/no-primitive-colors", noPrimitiveColors, {
  valid: [
    {
      name: "role token",
      code: `const x = "bg-background text-foreground";\n`,
    },
```

Each case is `{ name, code }` in `valid` and `{ name, code, errors: [error] }` in `invalid`. The `errors` array length is the exact diagnostic count.

## Commands you will need

Run commands from the repository root. Use Node 24.13.0 from `.node-version` and pnpm 11.20.0 from `package.json` (`packageManager`). Preserve the pinned TypeScript 7.0.2 and Effect 4.0.0-rc.111 catalog versions.

| Purpose                            | Command                                                                                | Expected on success                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Check runtime                      | `node --version && pnpm --version`                                                     | `v24.13.0` and `11.20.0`                                                |
| Install (if `node_modules` absent) | `pnpm install --frozen-lockfile`                                                       | exit 0, no lockfile diff                                                |
| Baseline build                     | `pnpm build`                                                                           | exit 0                                                                  |
| Focused rule test                  | `pnpm --filter @elmeragroup/oxlint-plugin test rules/no-tailwind-dark-variant.test.js` | `Test Files 1 passed (1)`                                               |
| Plugin suite                       | `pnpm --filter @elmeragroup/oxlint-plugin test`                                        | exit 0; `Test Files 13 passed (13)` once the new file exists (12 today) |
| Lint                               | `pnpm lint`                                                                            | exit 0                                                                  |
| Format check                       | `pnpm exec oxfmt --check <changed files>`                                              | `All matched files use the correct format.`                             |
| Workspace gate                     | `pnpm ci:checks`                                                                       | exit 0                                                                  |
| Package verification               | `pnpm packages:pack && pnpm test:packed-consumer`                                      | exit 0, in that order                                                   |

Do not put `--` between `test` and the file path. `pnpm --filter … test -- rules/x.test.js` passes the literal `--` to vitest and runs the entire suite (verified: 12 files, 190 tests), so a "focused" failure would not be focused. Without `--`, vitest runs only the named file (verified: 1 file). The whole plugin suite takes under a second, so running it is also acceptable.

Root `oxfmt --check` (the first half of `pnpm ci:checks`) covers `plans/**`, `.changeset/**` and `packages/internal/README.md`; only `packages/oxlint-anti-slop/**` and build directories are ignored. Every Markdown file this plan touches must pass it.

The audit ran focused tests with installed executables because pnpm's pinned-version bootstrap could not fetch signature data. A failed bootstrap is an environment blocker, not evidence that a dependency upgrade is needed. Record it; do not bypass signature validation. The audit did not run a complete fresh-build/packed baseline, so establish it before attributing unrelated failures to this change.

## Scope

Only modify these paths. The test file is new.

- `packages/oxlint-plugin/rules/no-tailwind-dark-variant.js` — only `hasDarkVariant` and any private helper it needs
- `packages/oxlint-plugin/rules/no-tailwind-dark-variant.test.js` (create)
- `packages/internal/README.md` — one sentence near the plugin configuration example (lines 38-52)
- `.changeset/tailwind-dark-variants.md` (create)
- `plans/007-tailwind-dark-variants.md`
- `plans/README.md`

Everything else is out of scope, including `packages/oxlint-plugin/extract-strings.js`, `packages/oxlint-plugin/rule-tester.js`, `packages/oxlint-plugin/index.js`, `test/packed-consumer/lint.mjs`, dependency versions, lockfiles, unrelated source refactors, public export maps, upstream fixture `output.json` files, immutable timing evidence and publication credentials. Build outputs in ignored `dist/`, `.cache/`, `.artifacts/` directories are normal verification products, not source changes.

## Git workflow

The advisor branch is `codex/deep-audit-plans`. For implementation, use an isolated branch such as `codex/fix-tailwind-dark-variants` from the operator's approved base; keep unrelated working changes intact. Do not create a second implementation branch if the operator already supplied one. Do not commit, push, publish or open a PR unless the operator requested that action. If a commit is requested, use a conventional subject such as `fix: detect dark variants before arbitrary and modified utilities` (recent history uses `chore:`/`docs:` prefixes and title-case PR merges).

## Steps

### Step 1: Pin missed class forms with a failing test file

Create `packages/oxlint-plugin/rules/no-tailwind-dark-variant.test.js` following the `no-primitive-colors.test.js` shape:

```js
import { createRuleTester } from "../rule-tester.js";
import noTailwindDarkVariant from "./no-tailwind-dark-variant.js";

const tester = createRuleTester("tsx");
const error = { messageId: "no-tailwind-dark-variant" };

tester.run("elmera/no-tailwind-dark-variant", noTailwindDarkVariant, {
  valid: [/* cases from the Test plan */],
  invalid: [/* cases from the Test plan, each with errors: [error] */],
});
```

Include every case listed in the Test plan below, using the three string positions: a plain literal (`const x = "…";`), a `className` attribute (`const el = <div className="…" />;` and `<div className={cn("…")} />`), and a template literal outside JSX (``const x = `…`;``). Use `name` values that quote the class form so failures are readable.

**Verify:** `pnpm --filter @elmeragroup/oxlint-plugin test rules/no-tailwind-dark-variant.test.js`

Expected: the file loads and runs (no import, syntax or setup failure). Exactly these cases fail: the newly-reported invalid forms (arbitrary `[…]`, `!` prefix, `-` prefix, stacked variants with brackets) and the valid `[content:'dark:literal']` case. Already-supported forms (`dark:bg-red-500`, `dark:bg-red-500!`, `not-dark:bg-red-500`) and the other valid cases pass. If a different set fails, re-check the case text before touching the rule.

### Step 2: Match top-level variant segments

In `packages/oxlint-plugin/rules/no-tailwind-dark-variant.js`, replace the regex in `hasDarkVariant` with a small scan. Keep the JSDoc signature `(str: string) => boolean`. Target shape (the algorithm is load-bearing, exact code is not):

1. Split `str` on any whitespace (`/\s+/`) into class tokens; skip empty tokens. Tailwind classes never contain whitespace, so splitting unconditionally is correct and keeps an unbalanced bracket in one token from swallowing the rest of the string.
2. For each token, walk characters tracking bracket depth for `[`/`]` and `(`/`)`. A backslash escapes the next character (skip it without changing depth). At depth 0, an unescaped `:` ends a variant segment.
3. A segment is the dark axis when it equals `dark` or ends with `-dark` (this preserves today's reporting of `not-dark:` and `group-dark:`).
4. Return `true` when a dark segment is followed by a non-empty remainder (another variant or a utility). A dark segment with nothing after the colon does not count.

Do not change `reportIfDark`, the visitors, `RULE_NAME`, the message text, the `meta` block or the imports. Do not add a Tailwind dependency or a utility-name list.

**Verify:** `pnpm --filter @elmeragroup/oxlint-plugin test rules/no-tailwind-dark-variant.test.js`

Expected: `Test Files 1 passed (1)`; every valid and invalid case passes with the exact diagnostic count.

### Step 3: Run the plugin suite and lint

Run all plugin tests to confirm other class-string rules are unaffected, then root lint so the new scanner passes `--deny-warnings`.

**Verify:** `pnpm --filter @elmeragroup/oxlint-plugin test && pnpm lint`

Expected: `Test Files 13 passed (13)`; `pnpm lint` exits 0 with no warnings.

### Step 4: Document coverage and add the release note

In `packages/internal/README.md`, directly after the `jsPlugins` configuration code block (currently lines 38-52, the block that lists `"elmera/no-tailwind-dark-variant": "error"`), add one sentence such as: "`no-tailwind-dark-variant` reports the `dark:` variant in any position, including before arbitrary values (`dark:[color:red]`), important or negative utilities and stacked variants; `dark:` text inside an arbitrary value is not reported." Keep it to one or two lines; plan 008 also edits this README, so do not restructure surrounding sections.

Create `.changeset/tailwind-dark-variants.md`:

```md
---
"@elmeragroup/internal": patch
---

`elmera/no-tailwind-dark-variant` now reports `dark:` before arbitrary values, important and negative utilities, and in stacked variant chains (for example `dark:[color:red]`, `dark:!bg-red-500`, `dark:-mt-1`, `hover:dark:[color:red]`). Text such as `dark:` inside an arbitrary value is no longer reported.
```

Only the umbrella package receives a release. Do not version a private workspace or edit package versions or lockfiles.

**Verify:** `pnpm exec oxfmt --check packages/internal/README.md .changeset/tailwind-dark-variants.md packages/oxlint-plugin/rules/no-tailwind-dark-variant.js packages/oxlint-plugin/rules/no-tailwind-dark-variant.test.js`

Expected: `All matched files use the correct format.` Run `pnpm exec oxfmt packages/…` (write mode) on those four files only if the check fails.

### Step 5: Final gates and scope audit

Run `pnpm build`, then `pnpm ci:checks`, then `pnpm packages:pack && pnpm test:packed-consumer`. Inspect `git diff --check`, `git diff --name-only`, and `git status --short`; every changed or new file must be in Scope. Update this plan's Status and Completion notes and the 007 row in `plans/README.md`, then run `pnpm exec oxfmt --check plans/007-tailwind-dark-variants.md plans/README.md`. Do not mark DONE with a failed or skipped required gate.

**Verify:** `git diff --check && git status --short`

Expected: `git diff --check` exits 0; `git status --short` lists only in-scope paths (plus the untracked `plans/` directory if it is not yet committed); all preceding gate commands exited 0. Record the actual commands and results in Completion notes, including any blocked check.

## Test plan

New file `packages/oxlint-plugin/rules/no-tailwind-dark-variant.test.js`, `createRuleTester("tsx")`, rule name `elmera/no-tailwind-dark-variant`, `errors: [{ messageId: "no-tailwind-dark-variant" }]` (exactly one diagnostic per invalid case).

Invalid cases (as plain literals unless noted):

- `dark:bg-red-500` — already reported; control
- `dark:bg-red-500!` — already reported; control
- `not-dark:bg-red-500` — already reported via the `-` word boundary; must stay reported
- `dark:[color:red]` — arbitrary property (newly reported)
- `dark:!bg-red-500` — important prefix (newly reported)
- `dark:-mt-1` — negative utility (newly reported)
- `hover:dark:[color:red]` — preceding variant plus arbitrary value
- `dark:[&>span]:text-red-500` — arbitrary variant after dark
- `[&:hover]:dark:text-red-500` — colon inside brackets before dark; the bracket must not split the segment
- `flex dark:bg-red-500 p-2` — dark token in the middle of a class list
- `<div className="dark:[color:red]" />` — JSX attribute string
- `<div className={cn("p-2", "dark:!bg-red-500")} />` — JSX attribute expression; exactly one diagnostic on the attribute
- ``const x = `flex ${gap} dark:-mt-1`;`` — template literal outside JSX

Valid cases:

- `bg-background text-foreground` — ordinary classes
- `darkish:bg-red-500` — different variant name
- `dark-mode text-dark` — `dark` without a variant colon
- `dark:` — bare token with no utility (documented limitation, stays valid)
- `[content:'dark:literal']` — `dark:` inside an arbitrary value (currently a false positive; must become valid)
- `before:content-['dark:x']` — `dark:` inside brackets after a real variant
- `bg-[url(a:b)] dark\\:escaped` — escaped colon and a colon inside parentheses do not create a dark segment (in the JS source the class string is `"bg-[url(a:b)] dark\\:escaped"`)
- `<div className="dark-mode" />` and ``const x = `dark-${tone}`;`` — non-variant forms in the other positions

In Step 1 the failing set must be exactly the newly-reported invalid cases and the `[content:'dark:literal']` valid case, not a compiler, import, runtime or setup failure. Keep the regressions after the fix; do not replace assertions with snapshots that merely accept current output. `test/packed-consumer/lint.mjs` continues to cover the `dark:bg-red-500` path through the packed package; do not edit it.

## Done criteria

- [ ] `packages/oxlint-plugin/rules/no-tailwind-dark-variant.test.js` exists and `grep -c "dark:\[color:red\]\|dark:!bg-red-500\|dark:-mt-1\|not-dark:\|content:'dark:literal'" packages/oxlint-plugin/rules/no-tailwind-dark-variant.test.js` reports at least 5
- [ ] `pnpm --filter @elmeragroup/oxlint-plugin test` exits 0 with 13 test files
- [ ] `grep -n "/\\\\bdark:\[a-z\]" packages/oxlint-plugin/rules/no-tailwind-dark-variant.js` returns no match (old regex removed) and line 1 still carries the kumo attribution
- [ ] `git diff --name-only -- packages/oxlint-plugin/index.js packages/oxlint-plugin/extract-strings.js test/packed-consumer/lint.mjs` is empty; rule name and message unchanged
- [ ] `pnpm lint` exits 0
- [ ] `pnpm ci:checks` exits 0
- [ ] `pnpm packages:pack && pnpm test:packed-consumer` exits 0
- [ ] `git diff --check` exits 0, and changed paths match Scope
- [ ] `.changeset/tailwind-dark-variants.md` exists with the `"@elmeragroup/internal": patch` frontmatter and passes `oxfmt --check`
- [ ] This plan and its index row reflect the actual completion state; no skipped gate is described as passing

## STOP conditions

Stop and report (do not improvise) if:

- The `hasDarkVariant` or visitor excerpts in Current state do not match the live file.
- Satisfying the test matrix appears to need a Tailwind dependency, any change to `extract-strings.js`, or a new interpretation of which string nodes are visited. This plan changes only variant recognition inside `hasDarkVariant`.
- `pnpm lint` flags the new scanner and the only fix you can find is a disable comment. Report the rule name and the flagged line instead.
- The Step 1 failing set differs from the expected set after re-checking case text, or a required check fails twice after a focused fix attempt.
- The fix requires an out-of-scope file.

Report pre-existing or environment failures (for example the pnpm signature bootstrap issue) separately from failures caused by this change. Never modify immutable evidence, suppress a diagnostic, or weaken a test just to obtain a green run.

## Maintenance notes

- Future utility syntax should be tested at the RuleTester boundary in the new test file. The rule parses variant position and bracket boundaries; it must not grow a list of utility names.
- Known limitation kept from the current rule: a template literal whose quasi ends in a bare `dark:` followed by an expression (`` `dark:${utility}` ``) is not reported, because `extractStrings` returns cooked quasis separately. Fixing that would mean interpreting expression boundaries in `extract-strings.js`, which is shared by other rules; deferred.
- Reviewer focus: the diff to the rule file should be limited to `hasDarkVariant` (plus a private helper). Confirm `not-dark:` stays reported and `[content:'dark:literal']` stops being reported; those two cases distinguish this matcher from both the old regex and a naive `token.startsWith("dark:")`.
- Plan 008 also edits `packages/internal/README.md`. Whichever lands second must preserve the other's sentence.

## Completion notes

Not implemented. Record the implementing revision, regression results, full gate results and any reviewed scope changes here.
