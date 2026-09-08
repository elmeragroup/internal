# Deep audit implementation plans

Prepared with the improve skill on 2026-09-08 against commit `e9ad9b3`.
Branch: `codex/deep-audit-plans`.

The user selected findings 1 through 9. Numbers match the audit report. These are implementation handoffs; no runtime, test, configuration or release implementation has been changed by the advisor.

Each plan stands alone and includes current excerpts, an allowed file list, regression cases, exact commands, a release decision and STOP conditions. Read the whole plan before editing. Establish a fresh baseline and reconcile drift before applying it.

## Execution order and status

| Plan                                               | Finding                                                                 | Priority | Effort | Depends on | Status |
| -------------------------------------------------- | ----------------------------------------------------------------------- | -------- | ------ | ---------- | ------ |
| [001](001-preserve-forwarded-facades.md)           | Keep forwarded facades prop-free during enrichment                      | P1       | S      | None       | DONE   |
| [002](002-safe-comment-removal.md)                 | Preserve executable syntax in comment-removal suggestions               | P1       | S      | None       | DONE   |
| [003](003-quoted-prop-defaults.md)                 | Preserve authored defaults for literal destructuring keys               | P1       | S      | None       | DONE   |
| [004](004-reject-unsupported-overloads.md)         | Reject unsupported multiple call signatures before generating artifacts | P1       | M      | None       | DONE   |
| [005](005-discard-component-candidate-warnings.md) | Discard diagnostics from rejected authored component candidates         | P2       | M      | None       | DONE   |
| [006](006-scope-aware-lint-types.md)               | Resolve lint type references in their lexical scope                     | P2       | M      | None       | TODO   |
| [007](007-tailwind-dark-variants.md)               | Detect dark variants before arbitrary and modified utilities            | P2       | S      | None       | TODO   |
| [008](008-structural-variant-props.md)             | Require a structural recipe-to-props connection                         | P2       | M      | None       | TODO   |
| [009](009-bind-packed-verification.md)             | Bind packed-consumer verification to the archive actually tested        | P3       | M      | None       | TODO   |

Status values: TODO, IN PROGRESS, DONE, BLOCKED with a reason, or REJECTED with a rationale. Update the relevant plan's completion notes with commands and results before marking it DONE.

## Dependency and coordination notes

No plan has a hard functional prerequisite on another. Execute 001 through 009 in order for the simplest integration process.

- 001 and 004 both change api-artifacts/src/checker.ts. Integrate 001 first, then reconcile 004's excerpts with that change.
- 003 and 004 both add cases to api-artifacts/test/component-source.test.ts. Apply them sequentially or coordinate test-file ownership.
- 002 and 006 both concern anti-slop maintenance documentation and may touch shared helpers. Integrate one before reviewing the other's diff.
- 003 and 005 change extractor behavior. Each owns a separate regression suite and must pass the complete extractor evidence gate; neither authorizes modifying immutable upstream output.
- 007 and 008 share the public package README. Keep their rule documentation edits separate and preserve both.
- 009 can be implemented independently in an isolated branch. Its regression tests use temporary fixtures and injected check callbacks, never live npm publication.
- Plans 001 through 008 have distinct umbrella-package Changeset filenames. Private workspaces never receive versions. Plan 009 needs no release because it changes only private release verification tooling.

All plans update this index; coordinate those status edits if executors run concurrently. This document does not dispatch any executor.

## Decisions made in these plans

- 002 keeps diagnostics for all slop comments. Suggestions stay for line comments and for block comments that start or end their line; only inline block comments with code on both sides lose the deletion suggestion. This avoids token-joining and automatic-semicolon-insertion hazards without introducing a lexer.
- 004 rejects more than one checker-visible public call signature with an actionable generation error. Merging overload contracts is deferred because a flat props list cannot faithfully express alternative required sets. One public overload plus its implementation remains supported.
- 005 isolates diagnostics from rejected authored candidates. It deliberately preserves selected-component diagnostic behavior and does not redesign the warning model.
- 006 uses local syntax and lexical scope only. It does not add TypeScript or Effect loads to lint entries.
- 008 recognizes a real local recipe-to-props type connection. It does not attempt cross-file type checking.
- 009 captures tested archive/report bytes before running checks. A later repack cannot substitute its identity into a receipt for the earlier archive. This does not claim protection against continuous hostile filesystem replacement.

## Audit baseline and limits

Source tree was clean at `e9ad9b3`. Audit verification passed:

- api-artifacts: 31 tests.
- internal: 1 test.
- oxlint-plugin: 190 tests in 12 files.
- oxlint-anti-slop: 14 test files.
- Formatting: 248 matched files.
- Compiler boundary: clear, using existing build declarations.
- Fixture catalog: 141 fixtures, 116 conformance fixtures.
- Repository policy: 30 passes and one initial timeout; the timed-out case passed on a targeted retry.

The audit used installed executables after pnpm's pinned-version bootstrap failed to fetch registry signature data. Some artifact tests used existing extractor build output. Full CI, fresh builds, packing, packed-consumer installation, registry advisory checks and exhaustive immutable fixture validation were not completed during the audit. Executors must establish a current baseline; these historical results do not substitute for implementation verification.

## Findings considered and rejected

- Nontransactional api-artifacts batch writes: documented behavior in packages/api-artifacts/README.md; rollback was not promised.
- Absolute/external artifact output paths: explicit local configuration, not an untrusted remote path boundary.
- Heuristic shortType labels: intentionally approximate collapsed-row presentation in checker.ts; full printed signatures remain available.
- Exact-name component recognition, anonymous empty dependency roots, class-expression generic omission and indexed-access fallback: documented extractor compatibility decisions, not proposed regressions.
- Pinned TypeScript/Effect runtimes and compiler-free lint/model entry requirements: intentional package architecture. No speculative dependency upgrade is planned.
- The local archive overlap in 009 is not described as a CI vulnerability; the publication workflow runs its steps sequentially.
- GitHub-token workflow-trigger behavior was investigated but not included as a confirmed defect; no workflow credential change is authorized.

## Direction options not selected

The audit also suggested a measured spike into sharing the two compiler project loads, and structured API drift details. Neither is an implementation plan in this batch. Correctness regression coverage should precede any shared-compiler refactor.

## Advisor changes

Only these nine plan files and this index were created. The branch was created at the user's request. Plans are unimplemented and no package Changeset is needed for the planning documents themselves.
