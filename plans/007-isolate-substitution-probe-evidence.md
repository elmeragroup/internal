# Plan 007: Discard diagnostic and provenance effects from rejected substitution probes

> Follow this self-contained plan in order and distinguish backend-contract proof from native reproduction.
> Drift check first: `git diff --stat 3994cd4..HEAD -- packages/api-extractor/src/parse/resolver.ts packages/api-extractor/test/substitution-fallback.test.ts packages/api-extractor/test/fixtures/substitution-fallback packages/api-extractor/README.md .changeset/substitution-probes.md`.
> Inspect `git status --short` and stop on unexplained changes to the cited code.

## Status

- Priority: P2
- Effort: S–M
- Risk: LOW
- Depends on: 001-typecheck-extractor-scripts
- Category: bug
- Original audit finding: 7
- Planned at: commit `3994cd4`, 2026-09-06
- Branch: `codex/plan-007-isolate-substitution-probe-evidence`
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

The semantic resolver tries a substitution's base type and then its constraint. A candidate is rejected
when it emits a fallback warning, but its warnings currently remain in the final result.
A successful string fallback can therefore say it used any, and exhausted probes can produce duplicate
misleading diagnostics. Speculative provenance can leak for the same reason. Keep evidence only from the
candidate whose model is actually returned.

Confidence is high in the parser contract defect and medium in its native compiler reachability.
The audit reproduced it with a backend double, not a stable source fixture from the pinned compiler.
Do not present a backend-double test as proof of a particular TypeScript source trigger.

## Current state

`packages/api-extractor/src/parse/resolver.ts:781` says rejected candidates should leave one warning at
the original location. The implementation at line 794 shares mutable evidence:

```ts
for (const candidate of [facts.substitutionBaseType, facts.substitutionConstraint]) {
  if (candidate === undefined) continue;
  const warningCount = context.warnings.length;
  const resolved = typeNode(candidate, undefined, undefined, { ...context });
  if (context.warnings.length > warningCount) continue;
  if (isUnauthoredAny(resolved)) continue;
  if (sourceNode !== undefined && authoredContainsPreservableKeyof(sourceNode, context)) {
    continue;
  }
  return resolved;
}
```

`src/parse/contracts.ts` declares `warnings: BackendWarningFact[]` and
`provenance: ProvenanceEntry[]`. Spreading context copies references to both arrays.
`src/parse/fallback.ts:94` pushes a warning and returns intrinsic any.
`resolveModule` later renders all accumulated warnings at `resolver.ts:103`.

The reproduced graph is:

- One exported value points to a type with `flags: ["Substitution"]`.
- Its `substitutionBaseType` has `isError: true`, so resolving it records fallback evidence.
- Its `substitutionConstraint` has intrinsic string.
- The final semantic type is string, but the returned warning says the extractor used any.

`src/parse/object-resolver.ts:391` exports `recordProvenance`, which merges entries at the same semantic
path, preserving declaration owners, readonly state, defaultInitializer, and reexportChain.
Use it to commit accepted provenance; a bare array push can bypass those merge rules.

Test exemplar `test/extractor.test.ts:98` implements a typed `BackendCompilerOperations` object.
`test/substitutions.test.ts` represents opaque handle identities this way:

```ts
// SAFETY: backend handles are intentionally opaque sentinels here.
const parameterType = {} as BackendTypeHandle;
```

Follow those conventions. Do not use `as unknown as`, module mocks, or a Proxy that returns arbitrary
defaults for every unimplemented operation.

## Commands you will need

| Purpose               | Command from root                                                                                                                   | Expected result    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Focused regression    | `pnpm --filter @elmeragroup/api-extractor exec vitest run test/substitution-fallback.test.ts test/substitutions.test.ts`            | All pass after fix |
| Related behavior      | `pnpm --filter @elmeragroup/api-extractor exec vitest run test/extractor.test.ts test/generics.test.ts test/type-operators.test.ts` | All pass           |
| Type check            | `pnpm --filter @elmeragroup/api-extractor type-check`                                                                               | Exit 0             |
| Complete package gate | `pnpm --filter @elmeragroup/api-extractor check:all`                                                                                | Exit 0             |
| Repository gate       | `pnpm ci:checks`                                                                                                                    | Exit 0             |
| Installed consumer    | `pnpm canary:pack && pnpm test:packed-consumer`                                                                                     | Exit 0             |
| Hygiene               | `git diff --check`                                                                                                                  | Exit 0             |

## Scope

Change only resolver.ts, the new test, an optional new input-only native fixture directory, the short
README guarantee, and an extractor patch changeset. Do not change warning schemas/codes/text, the backend
substitution representation, existing warning oracles, type operator reconstruction, provenance merging,
or external-package warning admission. `recordProvenance` is a dependency to reuse, not a file to modify.

## Required evidence transaction

For each candidate, allocate fresh local warning and provenance arrays. Pass those arrays in the child
context, preserving all other resolver policy and recursion state exactly as before.

Reject the candidate, with no evidence merge, if any of these occurs:

1. Its local warning array is nonempty.
2. Its result is an unauthored any.
3. The original source contains preservable keyof syntax and the existing guard rejects the probe.

Only after all acceptance checks pass may its provenance be merged into the parent through
`recordProvenance`. Accepted candidates necessarily have no local warnings; do not remove parent warnings
that existed before probing. If no candidate is accepted, return undefined and let the existing caller
continue its normal authored-keyof reconstruction and shape dispatch. That continuation may resolve
successfully without a warning. Only when the original substitution has no remaining resolvable shape
should it produce the single original fallback diagnostic; do not force a warning on successful reconstruction.

Do not clone compiler sessions, roll back caches, catch fatal errors, or claim callbacks are transactional.
The fix isolates only the evidence owned by this speculative resolver operation.
A thrown compiler error must still escape through the existing typed failure path.

## Steps

### Step 1: Build a typed backend regression

Create `test/substitution-fallback.test.ts` using the backend interface from `src/backend/contracts.ts`
and `resolveModule` from `src/parse/resolver.ts`. Define explicit opaque symbol/type handles and a small
typed operations object modeled on `test/extractor.test.ts`.

Required operations include a root symbol pointing to the substitution type, type facts for base and
constraint, stable symbol facts/documentation, typeToString for the diagnostic, empty signatures/properties
where irrelevant, and explicit project ownership. Unsupported test paths should throw a clear error.
Call resolveModule with a real-shaped BackendModuleDraft and a BackendExtractionSession whose
`compiler` is this double; no native process is needed.

Assert both returned model and returned warning array. Add a preexisting draft warning to a separate case
to prove the fix does not clear unrelated diagnostics.

**Verify:** the focused regression fails because the string result still has the rejected-base warning.
The model assertion must already pass before the fix.

### Step 2: Isolate candidate evidence and merge only accepted provenance

Implement the transaction described above inside substitutionFallback. Preserve candidate order and every
existing acceptance check. Ensure the keyof rejection happens before provenance commit.
Do not change the original caller's fallback or the human warning renderer.

**Verify:** the original regression now returns string and no probe warning; the preexisting draft-warning
case preserves that warning exactly. Package type checking exits 0.

### Step 3: Cover rejected and accepted provenance

Extend the double with a candidate that records property provenance before a later nested unsupported type
emits a warning. Give discarded and selected declarations distinct source paths. Choose model paths that
could overlap, so the final semantic-path filter cannot accidentally hide a leak.

Assert that rejected declaration/default/readonly metadata does not enter the final provenance and that an
accepted candidate retains its evidence. Include a mandatory case rejected by the keyof guard through
the existing backend contract, without exposing private resolver functions. Give the root declaration a
source type handle whose node facts have `kind: "typeOperator"`, `operator: "keyof"`, and one operand child.
Supply `typeAtNode` for that child and its normal operand facts. This makes
`authoredContainsPreservableKeyof` in `parse/authored-node.ts` reject the candidate. Follow the existing
type-operator test patterns for the rest of the operand facts, and assert that downstream reconstruction
retains the authored operator without committing rejected probe evidence.

**Verify:** focused tests assert exact declaration owners/paths and absence of the discarded source.
Tests must fail when local provenance is replaced with the parent array. Do not achieve passing assertions
by using a candidate that never records provenance.

### Step 4: Cover exhaustion and fatal errors

Test base failure followed by constraint failure on an original substitution with no intrinsic, named,
authored-operator, or other resolvable fallback shape. Require exactly the original fallback warning, with
the original type text/location and final any model. Separately retain the successful downstream-keyof
reconstruction control without requiring a warning. Test a first successful candidate, a missing base, and
an unauthored-any candidate that emits no warning. Ensure the second candidate is not read when the first
is accepted. A backend exception must propagate rather than becoming an ordinary unresolved candidate.

**Verify:** focused and related suites pass. Existing generic/type-operator behavior is unchanged.

### Step 5: Investigate a native compiler trigger without manufacturing evidence

Use a new input-only fixture only if the pinned compiler exposes a valid conditional/substitution type
that exercises this path. Follow `test/support/extract.ts` to open the real scoped service and inspect
the final model plus diagnostics. Do not modify existing fixtures to force unsupported syntax.

The backend-double regression is the mandatory acceptance proof for this internal contract. A native
fixture is strongly preferred but not a reason to invent an invalid or unstable oracle. If no reliable
native trigger is found, record the attempted source shapes and the remaining reachability uncertainty
in the handoff; do not claim native coverage.

**Verify:** when a fixture is added, `check:catalog` and `test:fixtures` pass and its direct test exercises
the intended path. Otherwise the handoff explicitly states that only backend-contract coverage exists.

### Step 6: Run evidence and distribution gates

Run full package/repository/consumer checks. Add a patch changeset explaining removal of diagnostics from
discarded probes. Add one README sentence to the warning guarantee if useful, without describing the
internal probing algorithm as public API.

**Verify:** all commands exit 0 and no existing oracle was changed. If actual warning evidence differs,
report its exact semantic justification before refreshing it under separate scope.

## Test plan

Mandatory cases: failed base then string constraint; preserved unrelated warning; successful first base;
missing base; silent unauthored-any rejection; two failed candidates with one original warning;
discarded provenance at overlapping semantic paths; retained accepted provenance; original keyof guard;
fatal compiler exception propagation. Native source coverage is tracked separately as described above.

## Done criteria

- [ ] Successful fallback carries no discarded candidate warning.
- [ ] Exhaustion with no remaining resolvable shape reports only the original fallback diagnostic.
- [ ] Successful downstream authored reconstruction remains warning-free when it loses no information.
- [ ] Unrelated warnings and accepted provenance survive unchanged.
- [ ] Discarded provenance never contaminates the final model paths.
- [ ] Fatal failures and candidate ordering retain their behavior.
- [ ] All required checks pass without changing existing evidence.
- [ ] Native reachability coverage or its limitation is explicitly recorded.
- [ ] Patch changeset and status results are complete.

## STOP conditions

Stop if evidence isolation requires changing warning types, public provenance, compiler behavior, or
existing fallback selection policy. Do not silently drop warnings from non-speculative resolution.
Stop if you cannot construct a typed backend regression that produces the documented mismatch.
Do not present a speculative native source as a reproduced bug. Stop after two failed correction attempts.

## Maintenance notes

Any future speculative branch must commit evidence only after accepting its result. Preserve
recordProvenance merge semantics. Keep warning tests coupled to the model they describe, so a truthful
warning cannot become a stale narrative about a discarded intermediate result.

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
