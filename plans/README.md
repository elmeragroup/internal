# Implementation plans

Prepared on 2026-09-06 against commit `3994cd4` using the improve skill.
The user selected all eight numbered audit findings. Each plan contains its own repository context,
verified original-state excerpts, scope, regression cases, implementation decisions, commands, stop
conditions, and maintenance notes. Execution and subsequent review records appear below.

## Execution order and status

Plan numbers follow the recommended execution order, not the original finding numbers.
Use the audit-finding column to match the earlier report.

| Plan                                                    | Audit finding | Outcome                                                                                  | Priority | Effort | Depends on | Status |
| ------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------- | -------- | ------ | ---------- | ------ |
| [001](001-typecheck-extractor-scripts.md)               | 6             | Include every extractor script in the type-check gate                                    | P2       | S–M    | —          | DONE   |
| [002](002-preserve-mixed-import-boundaries.md)          | 5             | Preserve runtime default imports in the Effect boundary check                            | P2       | S      | 001        | DONE   |
| [003](003-preserve-generic-signature-identity.md)       | 1             | Preserve nested generic signature identity during canonicalization                       | P1       | M      | 001        | DONE   |
| [004](004-align-versioning-and-package-verification.md) | 2             | Let coordinated version PRs pass package verification without enabling stable publishing | P1       | M      | —          | DONE   |
| [005](005-parse-client-directives-as-syntax.md)         | 3             | Classify client directives from the parsed module prologue                               | P2       | S      | —          | DONE   |
| [006](006-recover-authored-component-sources.md)        | 4             | Recover authored component implementations without losing public prop semantics          | P1       | L      | 001, 005   | DONE   |
| [007](007-isolate-substitution-probe-evidence.md)       | 7             | Discard diagnostic and provenance effects from rejected substitution probes              | P2       | S–M    | 001        | DONE   |
| [008](008-recognize-static-icon-button-values.md)       | 8             | Recognize static JSX values in icon-button label enforcement                             | P2       | S      | —          | DONE   |

Effort S means hours, M roughly a day, and L multiple days including tests and review.
Statuses: TODO, IN PROGRESS, DONE, BLOCKED with a reason, or REJECTED with a rationale.

The script-coverage fix comes first because it strengthens verification for the remaining extractor work.
The runtime correctness findings retain P1 priority even though foundational P2 checks precede them.

## Dependency and integration notes

- **001 → 002, 003, 007.** Explicit script type checking should exist before further extractor changes.
  These plans describe their implementation independently; the prerequisite supplies a gate, not hidden context.
- **001 + 005 → 006.** The source-inspection change needs explicit script coverage and the corrected AST
  classifier. Its `checker.ts` excerpt predates 005; the plan explicitly describes that expected drift.
- **004 and 008 are independent.** They can be implemented in isolated checkouts alongside the first work.
- Prefer 002 before 003 so architectural checks are trustworthy during comparison work.
- Changes to extractor code require the complete package gate. All final integrations require repository
  checks. Runtime/public API changes also require local packing and the installed-consumer check.
- Several plans touch the same package README and add changesets. Do not edit those files concurrently in
  one checkout. Use isolated checkouts, integrate one change at a time, recheck drift, and resolve only
  overlapping documentation/status edits during integration.
- A shared `plans/README.md` must have one writer during parallel execution. Executors report status to
  the coordinator rather than racing to change the index.

Recommended serial order is the table order. The important hard edges are the arrows above; unrelated
plans need not wait for all preceding numbers.

## Decisions made during detailed planning

### Release verification

Plan 004 keeps automatic Changesets version PRs and adds a fixed group for the three public packages.
Packaging and installed-consumer verification accept coordinated stable or canary versions; publication
remains canary-only through the manual workflow. A generic `packages:pack` command keeps
`canary:pack` as a compatibility alias. No stable publishing, registry action, or version bump is authorized.

The plan includes a real installed-CLI Changesets test in a disposable Git workspace and stable/canary
consumer verification. It does not solve the conflict by skipping checks on version PRs.

### Component source inspection

Plan 006 was expanded from the audit's initial M estimate to L after examining the available contracts.
Existing public provenance identifies declarations and prop facts, but cannot reliably identify render
implementations across aliases, zero-parameter wrappers, overloads, and object members.

The chosen additive `inspectComponentSources` service method uses a separate source-only resolver with
the existing React identity policy. It preserves semantic parameter selection and checker-backed accepted
props. Its explicit unresolved cases include declaration-only components, ambiguous exports, and default
expressions the current module draft cannot represent. These cases produce an actionable error instead
of misleading metadata. Extending arbitrary default-expression support is outside the chosen scope.

### Generic comparison

Plan 003 contains both independently reproduced defects from audit finding 1: nested lossy-render
comparison and incorrect lexical alpha-renaming. It preserves renderer bytes and existing class/component
fallback behavior rather than promising complete structural equality for every semantic node.

### Substitution diagnostics

Plan 007 has a proven backend-contract regression. A stable native TypeScript source trigger was not
established by the audit. The plan requires direct contract/provenance tests and records native reachability
separately. It preserves downstream authored-type reconstruction when probes are rejected.

## How to dispatch a fresh executor

Give the executor exactly one plan file and the checkout. Ask it to:

1. Read the entire plan and AGENTS.md.
2. Confirm the planned commit and run the scoped drift check before editing.
3. Run the stated baseline and reproduce the described failure.
4. Implement only the allowed scope and run each verification gate.
5. Report changed files, regression results, full checks, and any remaining limitation.
6. Update its status row only if it owns the index.

Do not give it the improve advisor role for implementation: that role is read-only. Use a normal coding
executor, or the improve skill's explicit executor workflow. The original planning delivery dispatched no implementation agents. Subsequent execution and
review follow-ups are recorded below.

Example task text:

> Implement `plans/NNN-name.md` in this checkout. Treat the plan as self-contained requirements.
> Follow its drift check, scope, regression cases, commands, and stop conditions. Preserve unrelated work.
> Do not publish or push. Report the result and actual verification commands before marking completion.

Replace the placeholder with the chosen real filename. If the operator authorizes commits separately,
follow the plan's conventional-commit and branch guidance.

## Verification baseline from the audit

These are historical observations at `3994cd4`, not proof that a future implementation passes:

- Root repository-policy suite: 5 tests passed.
- Canonicalization suite: 13 tests passed.
- Private Elmera lint package: 155 tests across 12 files passed.
- Anti-slop package: all 14 test files passed.
- Root release-script type checking passed.
- Existing extractor project type checking passed during plan preparation.
- Explicitly checking the omitted fixture runner produced TS2339 for `entry.fixture`.
- Read-only probes confirmed nested generic equality failures, RSC misclassification, wrong wrapper
  source paths, mixed-import omission, and the Changesets version-plan conflict.
- Registry audits reported no known runtime or development dependency vulnerabilities.

The full build, conformance/timing gates, and packed-consumer workflow were not rerun during the audit.
Every executor must run the checks required by its plan. Do not turn these historical green results into
a claim of complete baseline verification.

## Findings considered and rejected

- Artifact batch rollback and confinement to projectRoot: existing documentation deliberately permits
  per-file atomic writes and explicit output paths. No plan changes that contract.
- Transactional evidence-writer cleanup failures after commit: documented success-with-notice behavior,
  not a failed transaction.
- Retaining transaction state when timed-out filesystem work cannot be cancelled: deliberate recovery
  behavior; deleting state prematurely would be unsafe.
- Replacing immutable upstream outputs to match new code: never a valid fix.
- Making every lint rule type-aware: consumer-specific syntax restrictions are mostly intentional, and
  broad evaluation adds cost without an evidence-backed need.
- Adding generic caches or refactoring all large modules: no measured performance or maintainability
  case justified those changes during this audit.
- Package-manager bootstrap fetch/signature-verification failure: an environment/network issue, not
  evidence that the repository was tampered with.
- Fixture-budget metadata validation as a separate issue: existing plan/budget tests already cover the
  concrete concern examined.
- Changeset versioning conflict as intentional separation of workflows: rejected that explanation
  because the mandatory package check demonstrably rejects the version planner's output.
- Reusing existing public provenance as the entire wrapper fix: rejected after examining implementation
  versus declaration identity, zero-prop recovery, and object-member behavior.

## Direction options not selected for implementation

The user selected numbered defects 1–8, not the separate product options:

- Callable components with static component children need an explicit inventory/selection design.
- Resuming partially completed publication needs verified registry-state handling.

No implementation plans were created for those options. Plan 006 preserves the current callable-root
versus object-member selection behavior, and plan 004 does not implement publication retries.

## Plan review record

Fresh-context reviewers checked 001–005 and 006; an independent reviewer also checked 007–008.
Corrections included the real child-process exemplar, binding-sensitive compound comparison, temporary Git
requirements for Changesets, the complete stable-test workspace, README scope for RSC behavior,
source alias/default-expression/module-warning policies, source-only nested-binding defaults,
and preserving successful downstream resolution after failed substitution probes.

Before marking a plan DONE, record the implementation commit, exact commands, outcomes, and any evidence
changes authorized separately. A plan with unrun required gates remains incomplete.

## Branch review follow-up, 2026-09-07

The operator authorized fixes, full verification, pushing `feat/improve`, and pull-request monitoring.
Review of the eight implementation commits at `4be7cb4` reopened plans 002 and 006:

- Plan 002: retain mixed runtime imports with Unicode or escaped default names and a default named `type`.
- Plan 006: distinguish real bodies from inline object return types, and follow property/namespace aliases.

Fresh implementation agents corrected separate source areas, and an independent reviewer checked both
fixes. The coordinator verified the combined branch. Both reopened plans are complete again.

### Implementation commits

| Plan | Initial implementation | Review correction                                |
| ---- | ---------------------- | ------------------------------------------------ |
| 001  | `c4edf16`              | No additional defect found                       |
| 002  | `d4329ff`              | `91ee648`                                        |
| 003  | `64e7887`              | No additional defect found                       |
| 004  | `7769214`              | Independent stable and canary integration passed |
| 005  | `955e133`              | No additional defect found                       |
| 006  | `4be7cb4`              | `409802c`                                        |
| 007  | `6f0c69b`              | No additional defect found                       |
| 008  | `a695f93`              | No additional defect found                       |

### Combined branch verification

The coordinator ran these commands with Node 24.13.0 and pnpm 11.20.0 against the final source changes:

| Command                                              | Result                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --filter @elmeragroup/api-extractor check:all` | Passed: 611 tests across 50 files, format/lint/build/type-check, 141-fixture catalog, 42 fixture projects, conformance, boundary, and all timing gates |
| `pnpm ci:checks`                                     | Passed: all 15 Turbo tasks, none cached                                                                                                                |
| `pnpm packages:pack`                                 | Passed after building all three public packages                                                                                                        |
| `pnpm test:packed-consumer`                          | Passed umbrella imports, extraction, dependency defaults, drift checks, and consumer declaration compilation without workspace links                   |
| `git diff --check`                                   | Passed                                                                                                                                                 |

The artifact suite passed 21 tests; root repository-policy tests passed 21 tests. Independent stable and
canary integration results are recorded in plan 004. No immutable oracle, timing report, budget, package
version, dependency pin, or lockfile changed during the review corrections.

The initial pnpm bootstrap failed inside the network sandbox. Running the pinned tools with authorized
network access resolved it; no signature check was disabled and no toolchain version was changed.
