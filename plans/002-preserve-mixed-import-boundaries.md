# Plan 002: Preserve runtime default imports in the Effect boundary check

> Executor instructions: Read this entire plan, then follow the steps in order. Each verification states
> its expected result, including deliberate failing regressions before a fix. Stop on the listed conditions.
> This file is self-contained; you do not need the audit conversation or another plan's implementation details.
>
> Drift check, run first: `git diff --stat 3994cd4..HEAD -- packages/api-extractor/scripts/boundary-scanner.ts packages/api-extractor/test/boundary.test.ts`.
> Also run `git status --short`. Compare any changed in-scope code with the excerpts below. Stop on a
> substantive mismatch; do not overwrite unrelated work. A prerequisite's documented changes are expected.

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: 001-typecheck-extractor-scripts
- Category: bug / architecture checks
- Original audit finding: 5
- Planned at: commit `3994cd4`, 2026-09-06
- Branch: `codex/plan-002-preserve-mixed-import-boundaries`
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

The extractor deliberately keeps its parser and canonicalizer independent of Effect at runtime.
A scanner follows relative runtime imports to catch indirect Effect dependencies. It incorrectly
discards an import that has a runtime default binding plus only type-qualified named bindings.
The checker can therefore report a clean architecture while an ordinary import pulls Effect into it.

## Current state

`packages/api-extractor/scripts/boundary-scanner.ts:165`:

```ts
function isTypeOnlySpecifierContext(beforeSpecifier: string): boolean {
  const before = currentStatement(beforeSpecifier);
  if (/^(?:import|export)\s+type\b/u.test(before)) return true;
  const inline = /\{([^}]*)\}\s*$/u.exec(before)?.[1];
  if (inline === undefined) return false;
  const bindings = inline
    .split(",")
    .map((binding) => binding.trim())
    .filter((binding) => binding.length > 0);
  return bindings.length > 0 && bindings.every((binding) => /^type\s+/u.test(binding));
}
```

`scanValueModuleSpecifiers` calls that helper before retaining an edge. `effectImportViolations`
then follows retained relative paths and reports `effect` or `effect/*`.
Read-only reproduction:

```ts
scanValueModuleSpecifiers('import Default, { type Thing } from "./bridge.js";');
// Actual: []; required: ["./bridge.js"]
```

Existing tests in `test/boundary.test.ts:106` already protect statement-local classification and
type-only imports. Its transitive test at line 132 creates a temporary parse leaf and an Effect-using
helper, calls `effectImportViolations([leafPath])`, and deletes the directory in `finally`.

Preserve that style:

```ts
expect(effectImportViolations([leafPath])).toEqual([{ path: helperPath, reason: "Effect import effect" }]);
```

This is a lexical enforcement tool, not an authorization boundary for hostile source input. Do not
describe the finding as arbitrary code execution or introduce a dependency migration to fix it.

## Commands you will need

| Purpose                         | Command from root                                                                | Expected result                                              |
| ------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Focused tests                   | `pnpm --filter @elmeragroup/api-extractor exec vitest run test/boundary.test.ts` | All pass after fix                                           |
| Type check                      | `pnpm --filter @elmeragroup/api-extractor type-check`                            | Exit 0; prerequisite 001 includes scanner scripts explicitly |
| Build before declaration checks | `pnpm --filter @elmeragroup/api-extractor build`                                 | Exit 0                                                       |
| Architecture gate               | `pnpm --filter @elmeragroup/api-extractor check:boundary`                        | Exit 0                                                       |
| Complete package gate           | `pnpm --filter @elmeragroup/api-extractor check:all`                             | Exit 0                                                       |
| Repository gate                 | `pnpm ci:checks`                                                                 | Exit 0                                                       |
| Hygiene                         | `git diff --check`                                                               | Exit 0                                                       |

## Scope

Modify only `boundary-scanner.ts` and `boundary.test.ts`. Do not change parser imports, lint exceptions,
public declarations, compiler pins, fixture evidence, or dependency resolution behavior.
Plan 001 must land first; its only relevant effect is explicit type checking of all script files.
This plan changes development enforcement only and needs no package-release changeset.

## Required behavior

| Import form                                                          | Retained as a runtime edge?  |
| -------------------------------------------------------------------- | ---------------------------- |
| `import Default, { type Thing } from "./bridge.js"`                  | Yes                          |
| `import Default, { type Thing as T, type Other } from "./bridge.js"` | Yes                          |
| `import Default, {} from "./bridge.js"`                              | Yes                          |
| `import Default from "./bridge.js"`                                  | Yes                          |
| `import Default, * as NS from "./bridge.js"`                         | Yes                          |
| `import { value, type Thing } from "./bridge.js"`                    | Yes                          |
| `import { type Thing, type Other } from "./bridge.js"`               | No, preserve existing policy |
| `import type Default from "./bridge.js"`                             | No                           |
| `export type { Thing } from "./bridge.js"`                           | No                           |
| `import "./bridge.js"` or literal dynamic import / require           | Yes                          |

Comments and line breaks must not change the default-binding answer. Preserve the current
`currentStatement` protection so an earlier type-only statement cannot influence the next statement.
Do not change the existing treatment of named-only type imports as part of this targeted fix.

## Steps

### Step 1: Add the direct counterexample

Extend the existing statement-classification test or add a closely named test alongside it.
Assert the runtime edge for a default binding plus inline type bindings. Add the default-plus-renamed-type
and multiline/comment variations. Retain existing named-only type cases as negative controls.

**Verify:** run the focused tests. New mixed-import assertions fail against the original scanner;
existing cases continue to pass. A parser/setup failure is not the intended red result.

### Step 2: Add the transitive regression

Use the existing temporary graph pattern. The parse leaf imports a default value and a type from
`../bridge.js`; the real fixture file is `bridge.ts`, exercising existing .js-to-.ts source resolution.
The bridge imports `effect` and exports a default value. Assert exactly one violation at the bridge.
Add a control whose leaf uses a wholly type-only import and produces no violation.

These files are temporary test data, not repository fixture oracles. Always remove them in `finally`.

**Verify:** focused tests show the transitive mixed-import case fails before the fix and the type-only
control passes.

### Step 3: Correct type-only classification

Keep the helper's whole-statement type-only test first. Before accepting a brace list as all-type-only,
establish that there is no runtime default binding preceding that brace list. Inspect the complete import
clause, not just the text inside braces. Make the smallest readable adjustment within the existing scanner.
Do not add TypeScript native imports to the parser or replace the whole scanner with an unreviewed parser.

**Verify:** all required-behavior table cases pass in `boundary.test.ts`, and package type checking exits 0.

### Step 4: Verify the actual package graph

Build fresh declarations and run `check:boundary`, followed by `check:all` and `pnpm ci:checks`.
If the tightened scanner reveals an existing forbidden import, report the real dependency chain instead
of exempting it. Removing a real dependency is a separate change requiring expanded scope.

**Verify:** all commands exit 0 without new exclusions or lint disables.

## Test plan

Add direct tests for default-plus-inline-type forms and one real temporary transitive graph test.
Test comments, aliases, preceding type-only statements, side-effect imports, and fully type-only controls.
Retain existing source-extension, public-declaration, fresh-build, and transitive graph tests unchanged.

## Done criteria

- [ ] Mixed default/type imports retain their module specifier.
- [ ] The transitive fixture reports the Effect import at the bridge.
- [ ] Fully type-only controls retain the current no-runtime-edge behavior.
- [ ] Type checking, `check:boundary`, `check:all`, and `pnpm ci:checks` pass.
- [ ] No dependencies, exemptions, runtime sources, or evidence files changed.
- [ ] Only scoped files and status records changed.

## STOP conditions

Stop if fixing the case requires general module parsing outside the scoped helper, if a newly detected
real Effect dependency needs source changes, or if the proposed fix changes named-only type import policy.
Stop if 001 has not landed or its equivalent explicit script gate is missing. After two failed fix attempts,
return the exact scanner input and output rather than weakening the assertion.

## Maintenance notes

Every future import-syntax enhancement needs both a direct classification test and a graph traversal test.
Keep classification statement-local. A correct list of strings is necessary but not sufficient: the graph
test proves the architecture gate actually consumes that list.

## Extractor evidence rules

The extractor README distinguishes semantics from evidence. Preserve these rules even if a gate fails:

- `packages/api-extractor/test/fixtures/**/output.json` is immutable upstream evidence. Never rewrite it,
  delete it, or redirect it through an alias.
- `output.tsgo.json` records a reviewed TypeScript 7 divergence accompanied by `ts7-oracle.json`.
  `warnings.tsgo.json` records reviewed diagnostics. Do not invent these files just to bless a regression.
- `conformance.json` is generated evidence. Use the documented report scripts only after explaining the
  precise semantic change. If an existing oracle must change outside this plan's scope, stop with the diff
  and explanation. Do not mass-refresh warnings or timing reports.
- The fixture catalog discovers directories with `input.*`. Do not add a second inventory or add budget
  metadata for an ordinary new semantic fixture. Use a new input-only fixture and direct assertions when
  this plan calls for a new case.
- Preserve `test/fixtures/timing-boundary.json`, existing IPC ceilings, and rendering compatibility.
  Timing gates enforce deterministic counters and request/byte budgets, not faster milliseconds.
- Native compiler imports belong in `src/backend/ts7/**`. Public extractor types must not expose compiler
  handles. `src/parse/**` and `src/canonical/**` remain synchronous and Effect-free, including transitive
  runtime imports.

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

## Review follow-up, 2026-09-07

Review reopened this plan after valid Unicode and escaped default identifiers, plus a default named
`type`, still disappeared from the boundary graph. Fresh implementation and review agents verified
the correction: only complete named-only clauses qualify for inline type erasure, and the type modifier
is distinguished from the runtime default binding. Twelve new cases failed before the fix; the full
boundary suite passes 40 tests afterward. Seventeen independent classifier probes also pass.

Final combined-branch gates and implementation commits are recorded in `plans/README.md`.
