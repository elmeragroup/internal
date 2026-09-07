# Plan 001: Include every extractor script in the type-check gate

> Executor instructions: Read this entire plan, then follow the steps in order. Each verification states
> its expected result, including deliberate failing regressions before a fix. Stop on the listed conditions.
> This file is self-contained; you do not need the audit conversation or another plan's implementation details.
>
> Drift check, run first: `git diff --stat 3994cd4..HEAD -- packages/api-extractor/tsconfig.json packages/api-extractor/scripts/typecheck-fixtures.ts packages/api-extractor/test/script-typecheck.test.ts`.
> Also run `git status --short`. Compare any changed in-scope code with the excerpts below. Stop on a
> substantive mismatch; do not overwrite unrelated work. A prerequisite's documented changes are expected.

## Status

- Priority: P2
- Effort: S–M
- Risk: LOW
- Depends on: none
- Category: dx / tests
- Original audit finding: 6
- Planned at: commit `3994cd4`, 2026-09-06
- Branch: `codex/plan-001-typecheck-extractor-scripts`
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

The extractor's scripts run fixture, boundary, conformance, and timing gates, but its TypeScript project
only lists source, tests, and Vitest configuration. Scripts are checked accidentally when a test imports
them. The standalone fixture runner is therefore omitted, and it reads a property that does not exist.
A fixture compilation failure reports `undefined` as the fixture identity. Explicit coverage prevents
more consequential errors in future CLI-only code from surviving the ordinary package check.

## Current state

`packages/api-extractor/tsconfig.json:13`:

```json
"include": ["src", "test", "vitest.config.ts"],
"exclude": ["test/fixtures/module-imports-only/**"]
```

`packages/api-extractor/scripts/fixture-plans.ts:192`:

```ts
export const packageFixtureTypecheckPlan: readonly { readonly project: string }[] = deriveTypecheckProjects(
  fixtureTreeRoot,
  fixtureBudgets
).map((project) => ({ project }));
```

`packages/api-extractor/scripts/typecheck-fixtures.ts:18`:

```ts
if (result.status !== 0) {
  const detail = [result.stdout, result.stderr].filter((value) => value.length > 0).join("\n");
  throw new Error(`Fixture type-check failed for ${entry.fixture} (${entry.project}).\n${detail}`);
}
```

The direct check below produced exactly `TS2339: Property 'fixture' does not exist on type
'{ readonly project: string; }'`. The current package project check passed.

`packages/api-extractor/tsconfig.build.json` overrides inclusion to `["src"]`, excludes tests, disables
incremental compilation, and emits JavaScript and declarations under `dist`. Keep that emission boundary.
Root `scripts/tsconfig.json` checks the root release scripts only. It does not cover package scripts.
The existing package `type-check` command is already a dependency of its CI task through `turbo.json`;
expanding the existing project is sufficient. Do not add another redundant gate.

Test convention from `packages/api-extractor/test/boundary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
```

That suite resolves paths from `import.meta.dirname` and isolates temporary files with `mkdtempSync`
plus `finally` cleanup. For direct child-process setup, use `scripts/typecheck-fixtures.ts` as the
exemplar: `process.execPath`, a package-local compiler path, explicit encoding, and checks of both
`result.error` and exit status.

## Commands you will need

| Purpose                   | Command from repository root                                                                                                                                                                                                                                                               | Expected result                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Existing project baseline | `pnpm --filter @elmeragroup/api-extractor type-check`                                                                                                                                                                                                                                      | Exit 0 before modification                                                  |
| Demonstrate hidden error  | `node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --target ES2022 --module Preserve --moduleResolution Bundler --types node --allowImportingTsExtensions --resolveJsonModule --skipLibCheck --allowJs --checkJs packages/api-extractor/scripts/typecheck-fixtures.ts` | Before fix: exit 1, TS2339 at entry.fixture; after fix: exit 0              |
| Project file inventory    | `node node_modules/typescript/bin/tsc --noEmit --incremental false --listFilesOnly -p packages/api-extractor/tsconfig.json`                                                                                                                                                                | Includes every authored script in the supported source extensions after fix |
| Focused regression        | `pnpm --filter @elmeragroup/api-extractor exec vitest run test/script-typecheck.test.ts`                                                                                                                                                                                                   | All cases pass                                                              |
| Fixture compilation       | `pnpm --filter @elmeragroup/api-extractor test:fixtures`                                                                                                                                                                                                                                   | JSON reports status pass                                                    |
| Full package gate         | `pnpm --filter @elmeragroup/api-extractor check:all`                                                                                                                                                                                                                                       | Exit 0                                                                      |
| Repository gate           | `pnpm ci:checks`                                                                                                                                                                                                                                                                           | Exit 0                                                                      |
| Change hygiene            | `git diff --check`                                                                                                                                                                                                                                                                         | Exit 0                                                                      |

## Scope

Only the three paths in the drift check may change. Create `test/script-typecheck.test.ts`.
Keep the root TypeScript configuration, build configuration, package exports, fixture catalog, fixtures,
release scripts, package versions, and lint rules unchanged. This is verification tooling, so it needs
no package-release changeset; explain the `no-changeset` classification in a PR if asked to open one.

## Implementation decisions

Add `"scripts"` to the existing package project's `include` array. Keep all existing include and exclude
entries. Do not solve this by importing the runner from a test: that would reproduce the accidental
coverage mechanism. Do not disable strictness or add a property to every plan entry merely to retain the
old message. The available project path is already a useful identity.

Use a failure message shaped as `Fixture type-check failed for <project>.\n<compiler detail>`.
Preserve the underlying compiler stdout and stderr, the failure exit, and the success summary.

## Steps

### Step 1: Establish the hidden error and coverage baseline

Run the existing project baseline, the direct runner check, and the project inventory command.
Confirm that `scripts/typecheck-fixtures.ts` is absent from the project inventory and that the standalone
check reports TS2339. Record existing unrelated failures before making a change.

**Verify:** the first command exits 0; the second fails on the documented property; the inventory omits
the runner. If any of those facts differs, inspect drift instead of manufacturing the failure.

### Step 2: Add a coverage regression that cannot import its way to success

Create `test/script-typecheck.test.ts`. Recursively discover authored `.ts`, `.tsx`, `.mts`, `.cts`,
`.js`, `.jsx`, `.mjs`, and `.cjs` files under the package's `scripts` directory, excluding declaration
files and generated/ignored dependency directories if present. All current scripts are `.ts`; the other
extensions preserve coverage if a future entry point uses another supported source format. Run the installed
compiler with `--noEmit --incremental false --listFilesOnly -p <absolute package tsconfig>` in a child
process and parse its line-oriented absolute paths. Normalize separators consistently on both sides.
Assert that every discovered script is listed. Do not import script modules into this test.

This checks the compiler's actual root/dependency inventory rather than comparing a copied include array.
It remains useful if configuration layout changes later.

**Verify:** the focused regression fails and names the omitted runner. It must not fail because its
child process could not find the compiler or because TypeScript diagnostics were treated as file paths.

### Step 3: Expand the type-check roots and correct the diagnostic

Add `scripts` to `tsconfig.json`. Replace `entry.fixture` with the project-only failure message.
Run the project type check and read every new diagnostic. Only the documented error is pre-authorized for
correction by this plan; if additional errors require unrelated changes, stop and return their locations.

**Verify:** the focused regression and direct runner check both exit 0. The compiler inventory contains
`scripts/typecheck-fixtures.ts` and every discovered script. `pnpm --filter @elmeragroup/api-extractor
type-check` exits 0.

### Step 4: Exercise real fixture projects and preserve package emission

Run `test:fixtures` and the complete package gate. Confirm that package build output remains under
`dist` and contains no emitted scripts or test directory. The existing build configuration already
provides this restriction; do not change it to make the new check pass.

**Verify:** `test:fixtures`, `check:all`, and `pnpm ci:checks` exit 0. Run
`node -e 'const fs=require("node:fs"); if(fs.existsSync("packages/api-extractor/dist/scripts") ||
fs.existsSync("packages/api-extractor/dist/test")) process.exit(1)'` and expect exit 0.

## Test plan

The mandatory new test asserts actual compiler inclusion for all scripts without importing those scripts.
The standalone TypeScript command is the regression for the nonexistent property. Do not add a fragile
assertion that compares the whole source file or a test that merely repeats the message implementation.
Existing fixture compilation exercises the successful runner path. Keep compiler error detail intact on
inspection; do not introduce child-process mocking just for this small message correction.

## Done criteria

- [ ] The standalone runner check exits 0.
- [ ] The new inventory test passes and includes every authored extractor script.
- [ ] Package type checking and real fixture compilation exit 0.
- [ ] `check:all` and `pnpm ci:checks` exit 0.
- [ ] Build output does not contain `dist/scripts` or `dist/test`.
- [ ] Existing fixture data and oracle files are untouched.
- [ ] Only scoped files and plan status records changed.

## STOP conditions

Stop if compiler inclusion introduces errors outside the allowed diagnostic correction, if expanding
the include array causes fixture programs to be compiled under a different configuration, or if package
emission starts including scripts. Do not broaden exclusions or weaken checks to hide new errors.
Stop after two unsuccessful attempts to resolve a verification failure and report the exact failing
command. Infrastructure failures do not justify changing pins.

## Maintenance notes

Keep this inventory test whenever script entry points are added. The important distinction is between
verification roots and emitted package roots. A future configuration split is acceptable only if CI still
checks every executable script and the regression follows that actual command.

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
