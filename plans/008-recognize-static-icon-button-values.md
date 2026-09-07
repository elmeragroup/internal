# Plan 008: Recognize static JSX values in icon-button label enforcement

> Follow this self-contained plan in order and record the parser-backed checks you ran.
> Drift check first: `git diff --stat 3994cd4..HEAD -- packages/oxlint-plugin/rules/require-icon-button-label.js packages/oxlint-plugin/rules/require-icon-button-label.test.js`.
> Inspect `git status --short` and stop on unexplained differences from the current-state excerpts.

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none
- Category: bug / accessibility lint
- Original audit finding: 8
- Planned at: commit `3994cd4`, 2026-09-06
- Branch: `codex/plan-008-recognize-static-icon-button-values`
- Status: DONE

## Repository context

This is a pnpm workspace for Elmera Group build tooling, not a web application.
The public dependency direction is `@elmeragroup/internal` → `@elmeragroup/api-artifacts` →
`@elmeragroup/api-extractor`. The first package supplies consumer defaults, the second writes or checks
component API JSON, and the third produces a compiler-independent semantic model and provenance.
Private packages implement lint rules; `tooling/typescript` owns shared compiler configuration.

Work from the repository root. At planning time it was
`/Users/tommy.lunde.barvag/src/work/elmera/internal`; use the root of your own checkout instead.
Use Node from `.node-version` and pnpm from root `package.json`, currently Node 24.13.0 and pnpm 11.20.0.
TypeScript is pinned to 7.0.2 and Effect to 4.0.0-rc.111 in `pnpm-workspace.yaml`. Do not upgrade either.
TypeScript 7's native API differs from the old TypeScript compiler API; inspect the installed declarations
before using an API you remember from another version.

Read `AGENTS.md` and the affected package README. No separate ADR, CONTEXT.md, or product specification was
found during the audit. Use strict types, separate type imports, kebab-case filenames, and the existing
Oxfmt layout. Oxlint runs with `--deny-warnings`: warnings fail CI. Avoid module mocks. In api-extractor,
never add a file-wide disable or path-wide lint override. A necessary next-line exception names one rule
and includes a `--` reason; type assertions require an accurate `SAFETY:` comment.

If dependencies are already installed, do not reinstall by default. If absent, run
`pnpm install --frozen-lockfile` and expect exit 0 without manifest or lockfile changes. If registry access
or the pinned pnpm runtime is unavailable, report that environment failure. Do not change the package
manager pin or claim skipped checks passed. Direct installed binaries are acceptable for focused
diagnosis, but record any difference from the documented CI commands.

## Why this matters

The private Elmera rule detects unlabeled icon-only buttons, but equivalent static JSX syntax changes its
answer. An unlabeled `<Button size={"icon"} />` passes, while `<Button size="icon" />` reports.
The rule also treats the existence of aria-label as sufficient even when its known value is empty.
Handle statically known values consistently without attempting general JavaScript evaluation.

## Current state

`packages/oxlint-plugin/rules/require-icon-button-label.js:14`:

```js
function getStringAttrValue(attr) {
  if (!attr.value) return null;

  if (attr.value.type === "Literal") {
    return typeof attr.value.value === "string" ? attr.value.value : null;
  }

  if (attr.value.type === "JSXExpressionContainer" && attr.value.expression.type === "Identifier") {
    return attr.value.expression.name;
  }

  return null;
}
```

The helper misses an expression container whose expression is a string Literal.
Both `isIconSize` and `isIconVariant` call it. Size uses the prefix icon; variant uses exact icon.

At lines 6–7:

```js
function hasAriaLabel(node) {
  return node.attributes.some((attr) => attr.type === "JSXAttribute" && attr.name.name === "aria-label");
}
```

At lines 69–73, visible-content detection also accepts any string Literal child, including an empty one.
Account for this nearby loophole when testing statically empty labels; otherwise an empty expression child
can still suppress the expected report.

The rule only targets names ending in Button, including member names such as InputGroup.Button.
It deliberately accepts slot-provided labeling and known text-content components. These policies are
outside this fix.

Test exemplar in `require-icon-button-label.test.js`:

```js
import { createRuleTester } from "../rule-tester.js";
import requireIconButtonLabel from "./require-icon-button-label.js";

const tester = createRuleTester("tsx");
const error = { messageId: "missingAriaLabel" };

tester.run("elmera/require-icon-button-label", requireIconButtonLabel, {
  valid: [/* cases */],
  invalid: [/* cases with errors: [error] */],
});
```

The actual test has valid slotted calendar, visible-text, and labeled member-component cases.
`rule-tester.js` connects Oxlint RuleTester to Vitest. Use this parser-backed setup, not a hand-built AST
visitor invocation. The private package uses JavaScript and has no package-specific TypeScript command.

## Commands you will need

| Purpose                     | Command from root                                                                                  | Expected result                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Focused parser-backed tests | `pnpm --filter @elmeragroup/oxlint-plugin exec vitest run rules/require-icon-button-label.test.js` | All pass                                         |
| Whole Elmera lint suite     | `pnpm --filter @elmeragroup/oxlint-plugin test`                                                    | All pass; baseline was 155 tests across 12 files |
| Adjacent lint package       | `pnpm --filter @elmeragroup/oxlint-plugin-anti-slop test`                                          | All test files pass                              |
| Root lint                   | `pnpm lint`                                                                                        | Exit 0; build dependencies first if needed       |
| Full repository check       | `pnpm ci:checks`                                                                                   | Exit 0                                           |
| Hygiene                     | `git diff --check`                                                                                 | Exit 0                                           |

Do not invent a `type-check` command for this private JS package. Root lint and the parser-backed suite
are its direct checks; the repository gate covers the workspace.

## Scope

Change only the rule and its existing test. Keep the public rule name, messageId, options schema, and
package registration unchanged. The package is private, so no package-release changeset is required.
Do not edit the other lint package, dependency versions, consumer source, or global lint configuration.

## Required behavior

Recognize the same static strings in direct attributes and expression containers. A template literal with
no expressions is also statically known and can use its cooked text; templates with interpolations remain
dynamic. Preserve the rule's current identifier-name heuristic for size/variant in this narrowly scoped
change, but do not reuse that heuristic to claim an aria-label identifier's runtime content is known.

For aria-label:

- A known nonempty string after trimming counts as a label.
- A known empty/whitespace-only string does not.
- Bare aria-label, and literal null/false, provide no usable name.
- Unresolved dynamic expressions such as `aria-label={label}` or a translation call retain the current
  permissive behavior; do not report merely because static evaluation is impossible.
- Do not turn arbitrary expressions into strings or evaluate user code.

For children, known empty/whitespace-only string literals and static templates are not visible text.
Preserve existing treatment of calls, dynamic templates, named text components, and slots.
This is targeted static normalization, not a complete accessible-name computation or dataflow analysis.

## Steps

### Step 1: Add failing parser-backed equivalence cases

Add invalid cases for `size={"icon"}`, `size={"icon-sm"}`, and `variant={"icon"}`, including
InputGroup.Button. Add corresponding direct-attribute controls and labeled valid forms.
Use exactly one expected missingAriaLabel diagnostic per invalid element.

**Verify:** the focused test fails for expression-string cases while direct-string controls pass.
Failure must come from a missing report, not malformed JSX.

### Step 2: Normalize static attribute strings

Add a small local helper or extend the existing one to unwrap static expression literals.
Use AST discriminants and existing JavaScript conventions. Preserve the current identifier heuristic for
size/variant separately from actual static-value extraction. Avoid a generic evaluator or a shared utility
refactor across unrelated rules.

For the required no-substitution template support, use their cooked value, handling an absent cooked value as unknown
rather than fabricating text. Keep dynamic templates unclassified for size/variant.

**Verify:** direct and expression versions produce identical outcomes. Existing named-component,
slot, and visible-text tests remain green.

### Step 3: Reject known empty labels without rejecting dynamic labels

Replace presence-only acceptance with the specified known-value policy.
Add invalid cases for empty/whitespace labels in direct and expression syntax, static empty templates,
bare attributes, literal null, and false. Add valid dynamic-label and translation-call controls.
A valid label must still suppress the rule regardless of icon syntax.

Update static string-child handling so `{""}` or `{" "}` cannot independently count as visible text.
Keep static text that is actually nonempty accepted.

**Verify:** the focused suite passes all empty-label and dynamic-label cases. The rule emits no autofix:
it cannot invent a meaningful accessible name.

### Step 4: Run all lint-rule checks and document the local contract

Update the rule's internal docs description if necessary to mention static expression values and nonempty
labels. Keep the existing messageId so consumers' assertions and tooling remain compatible.
Run both private lint suites and repository checks.

**Verify:** all commands exit 0, no global configuration changed, and only the two scoped files plus status
records appear in `git diff --name-only`.

## Test plan

Test the following combinations without exploding them into redundant snapshots:

- size and variant with direct strings, expression strings, and static templates.
- Button, InputGroup.Button, and another name ending in Button.
- Empty, whitespace, nonempty, null, false, bare, and dynamic aria-label forms.
- Empty expression-string children versus actual visible text.
- Translation-call labels and dynamic text controls.
- Slot exception remains valid.
- Non-icon sizes and names not ending in Button remain unaffected.
- Existing identifier-based size/variant behavior remains unchanged.

## Done criteria

- [ ] `size={"icon"}` and `size="icon"` are equivalent to the rule.
- [ ] Known empty labels do not suppress the missing-label report.
- [ ] Known empty string children do not count as visible text.
- [ ] Dynamic labels and existing slot/text policies retain their behavior.
- [ ] Rule name/messageId/options are unchanged and no autofix invents labels.
- [ ] Focused tests, both lint suites, and repository checks pass.
- [ ] Only the two allowed files and status records changed.

## STOP conditions

Stop if the parser represents static literals differently from the tested AST shapes or if implementing the
fix needs general expression evaluation. Do not expand into aria-labelledby resolution, cross-file constants,
spread ordering, or full accessible-name analysis. Report any consumer-policy conflict instead of changing
slot or identifier conventions. Stop after two failed corrective attempts.

## Maintenance notes

Keep static-value extraction separate from unresolved-value policy. Every new accepted syntax needs
equivalent valid and invalid parser-backed cases. A rule that cannot know a dynamic label's value should
not pretend to know it; this fix only closes cases whose values are explicit in the source.

## Git and handoff workflow

Use an isolated checkout if other executors are working concurrently. Preserve unrelated changes.
Use the branch named in this plan, with the repository's `codex/` prefix.
Conventional commit example from this repository: `docs: add repository agent guidance`.
Create commits only if the operator authorized them for this execution; a plan is not authorization to
push, publish, open a PR, or run a release. Do not add Co-Authored-By trailers.

The plan and `plans/README.md` are the only documentation files outside the listed implementation scope
that you may update for status and verification results. Mark only this plan's row. Record commands,
results, and any intentionally unrun gates. Use TODO → IN PROGRESS → DONE or BLOCKED with a concrete reason.
If a coordinating reviewer owns the index, send those results to the reviewer instead.
