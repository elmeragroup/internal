# Plan 003: Preserve nested generic signature identity during canonicalization

> Follow this self-contained plan in order. Stop on the listed conditions and report actual verification results.
> Drift check first: `git diff --stat 3994cd4..HEAD -- packages/api-extractor/src/canonical/equivalence.ts packages/api-extractor/test/canonicalization.test.ts packages/api-extractor/test/generic-equivalence.test.ts packages/api-extractor/test/fixtures/generic-equivalence packages/api-extractor/README.md .changeset/generic-equivalence.md`.
> Also inspect `git status --short`; compare changed code with the current-state excerpts before editing.

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: 001-typecheck-extractor-scripts; execute after 002 when practical
- Category: bug
- Original audit finding: 1
- Planned at: commit `3994cd4`, 2026-09-06
- Branch: `codex/plan-003-preserve-generic-signature-identity`
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

Canonicalization removes duplicate function members from extracted unions. Two independent defects let
different generic functions compare equal: rendering hides nested constraints/defaults, and one-sided
name substitution loses lexical binding identity. The result can omit an API signature entirely.
Fix comparison without changing the upstream-compatible text renderer or the public semantic model.

## Current state

`src/canonical/equivalence.ts:87`, relative to `packages/api-extractor`:

```ts
if (
  (renames === undefined || renames.size === 0) &&
  !isRenderFastPathExcluded(left) &&
  !isRenderFastPathExcluded(right) &&
  renderType(left) === renderType(right)
)
  return true;
```

The exclusion helper at line 400 excludes only function, typeOperator, union, and intersection.
An object/array/tuple containing one of those shapes still takes the fast path.

`src/canonical/render.ts:71` deliberately renders type-parameter names without constraints/defaults:

```ts
const typeParameters = signature.typeParameters ?? [];
const prefix =
  typeParameters.length === 0 ? "" : `<${typeParameters.map((parameter) => parameter.name).join(", ")}>`;
```

`equivalence.ts:83` compares parameter references with
`left.name === (renames?.get(right.name) ?? right.name)`. At line 244 a nested signature copies the outer
right-to-left name map and assigns its parameter names to the left names:

```ts
const renames = new Map<string, string>(outerRenames);
for (const [index, parameter] of right.entries()) {
  const leftParameter = left[index];
  if (leftParameter !== undefined) renames.set(parameter.name, leftParameter.name);
}
```

The audit reproduced these failures without changing files:

1. Direct generic functions constrained to string versus number compare unequal. Put those functions
   under an object property and the objects compare equal. Wrap those objects as callback parameters and
   `canonicalizeUnionMembers` removes one callback.
2. These two signatures compare equal, although the second inner argument refers to its outer generic:

```ts
<T>(value: <T>(value: T) => T) => void
<U>(value: <V>(value: U) => V) => void
```

`src/canonical/canonicalize.ts:110` removes function members using
`areFunctionsEquivalentIgnoringAny`. It intentionally prefers a concrete overload to an otherwise
equivalent unaliased-any fallback. Do not remove that policy.

Existing exemplar in `test/canonicalization.test.ts`:

```ts
function callback(parameterType: SemanticType): SemanticType {
  return {
    kind: "function",
    callSignatures: [
      {
        parameters: [{ name: "value", type: parameterType, optional: false }],
        returnValueType: { kind: "intrinsic", intrinsic: "void" },
      },
    ],
  };
}
```

Use typed `SemanticType` objects or `satisfies SemanticType`. Type parameter declarations need
`{ kind: "typeParameter", name, ... }`, matching the existing alpha-renaming test. Do not copy the audit's
minimal untyped probes into production tests without completing the model types.

## Commands you will need

| Purpose               | Command from root                                                                                                 | Expected result                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Focused model tests   | `pnpm --filter @elmeragroup/api-extractor exec vitest run test/canonicalization.test.ts`                          | Existing 13 baseline cases and new regressions pass |
| Native integration    | `pnpm --filter @elmeragroup/api-extractor exec vitest run test/generic-equivalence.test.ts test/generics.test.ts` | All pass                                            |
| Fixture discovery     | `pnpm --filter @elmeragroup/api-extractor check:catalog`                                                          | Exit 0                                              |
| Fixture compilation   | `pnpm --filter @elmeragroup/api-extractor test:fixtures`                                                          | Status pass                                         |
| Type check            | `pnpm --filter @elmeragroup/api-extractor type-check`                                                             | Exit 0                                              |
| Complete package gate | `pnpm --filter @elmeragroup/api-extractor check:all`                                                              | Exit 0, including conformance and timing            |
| Repository gate       | `pnpm ci:checks`                                                                                                  | Exit 0                                              |
| Installed consumer    | `pnpm canary:pack && pnpm test:packed-consumer`                                                                   | Exit 0; local archives only                         |
| Hygiene               | `git diff --check`                                                                                                | Exit 0                                              |

## Scope

Modify the paths in the drift check only. The fixture directory is new and may contain `input.ts` and
`tsconfig.json`; do not add oracle files. The README change is a short guarantee about nested generic
comparison if needed. Add one patch changeset for `@elmeragroup/api-extractor`.

Do not change `render.ts`, `canonicalize.ts`, the public model/schema, resolver behavior, backend handles,
existing fixture outputs, reference pins, or timing budgets. Do not sort every union or change object
identity deduplication: the current canonicalizer deliberately does not deduplicate arbitrary equal
object values by structure.

## Required implementation design

### Structural comparison

Remove the render-identity shortcut for recursive containers, including generic type arguments.
The simplest auditable implementation is to remove the initial shortcut and let the existing structural
branches compare arrays, tuples, objects, compounds, operators, functions, and named arguments.
Keep rendering for the remaining fallback cases whose established comparison uses it.
This plan deliberately does not redesign class/component comparison: those kinds also contain nested
information, but their current fallback renders unnamed values as `class` or an empty string. The
guarantee here covers function signatures and the container/type-argument paths exercised by the new
regressions. Do not claim every semantic node now has complete structural equality.
Do not add a recursive renderability walk that costs as much as the comparison unless measurements justify it.

Preserve alias identity: an aliased type does not become equal to its inline expansion merely because
their shapes match. Preserve readonly container flags, optional props, unordered compound comparison, and
the special strict treatment of authored `keyof any`.

### Lexical generic bindings

Replace the one-sided string replacement map with paired lexical environments.
Each side maps its locally visible parameter names to an internal binding identity. When comparing a
signature, allocate one shared identity for each corresponding left/right parameter pair, then extend
both environments without mutating the parent. All parameters in the signature must be registered before
comparing their constraints and defaults.

For a type-parameter occurrence:

- If both names resolve to bound identities, compare those identities.
- If one resolves and the other does not, they are unequal.
- If neither is bound, preserve equality by exact free-name spelling.
- An inner declaration shadows the same spelling only within that signature.
- Sibling signatures must not inherit each other's bindings.

Preserve the binding-sensitive optimization in `membersAreEquivalentUnordered`, currently around
line 331: its structural-key multiset rejection is disabled when renames are active. After replacing the
rename map, disable this rejection whenever either lexical environment contains active bindings, unless
the keys themselves have been normalized by binding identity. Raw name-based keys must not reject an
otherwise equivalent reordered union such as `T | string` versus `string | U` under paired bindings.

A private object or symbol can represent identity. Keep it local to comparison; never store it in the
serializable semantic model. Remove the old optional internal rename parameter from exported comparison
wrappers if no outside caller uses it; the audit found only same-file recursive users. Verify that before
changing the internal function signatures.

## Steps

### Step 1: Add failing typed model cases for both defects

Add helpers for generic functions, nested callback objects, and alpha-renamed signatures beside the
existing typed constructors. Test strict and any-wildcard comparison separately.
Demonstrate lost union members through the public canonicalization helper, not only through equality.

**Verify:** focused model tests fail specifically on the nested-constraint and lexical-scope cases.
Existing alpha-renaming and concrete-over-any assertions remain green.

### Step 2: Replace the unsafe render shortcut

Route recursive shapes through the existing structural comparisons. Add corresponding nested-default and
nested-operator cases so the fix cannot be limited to one function-in-object example. Keep the renderer
unchanged.

**Verify:** focused tests now pass nested constraint/default cases; lexical shadowing tests may still fail
until step 3. `git diff -- packages/api-extractor/src/canonical/render.ts` is empty.

### Step 3: Introduce paired lexical binding environments

Implement the binding rules above, threading one comparison context through recursive functions.
Register declaration pairs before comparing constraints/defaults, and use child environments for nested
signatures. Keep wildcard-any behavior separate from parameter identity. Do not make a bound generic
match an unbound parameter merely because their names render equally.

**Verify:** every focused model test passes in both operand orders. Package type checking exits 0.
Tests must include an equivalent shadowing control so an implementation that rejects every nested generic
cannot pass.

### Step 4: Exercise the native extractor

Create the input-only `generic-equivalence` fixture. Export callback unions containing generic functions
with different constraints and defaults, plus equivalent alpha-renamed controls. Use
`test/generics.test.ts` and `test/support/extract.ts` as the pattern for opening the real scoped service.
Assert the actual retained members and their constraints/defaults; do not snapshot an unexplained JSON blob.

The compiler may simplify some source-level examples before the model sees them. Keep the direct typed
model regressions mandatory. If the compiler normalizes one example, choose another valid source shape
that still exercises a union of enclosing callback functions; never assert a shape the compiler does not
produce. Record that distinction.

**Verify:** the native integration tests, `check:catalog`, and `test:fixtures` exit 0. New fixture inputs
contain valid TypeScript under their own configuration.

### Step 5: Check compatibility and package behavior

Run full package and repository gates, then pack and test the installed consumer. Read any conformance
difference before doing anything to evidence. Add a patch changeset describing preservation of distinct
generic signatures.

**Verify:** all final commands exit 0. `git diff --name-only` contains only scoped files. No existing
oracle or timing file changed.

## Test plan

Cover this matrix with explicit assertions:

- Direct versus nested string/number constraints.
- Nested distinct generic defaults with the same constraint.
- Object property, array element, tuple element, and external generic argument containers.
- Nested operators whose rendered operands match but semantic resolution differs.
- Equivalent single-scope alpha renaming.
- Equivalent shadowing on both sides.
- Inner-versus-outer reference inequality in both comparison directions.
- Free versus bound parameters with identical names.
- Constraints/defaults referring to outer parameters and earlier parameters.
- Sibling signatures with reused names and different scopes.
- Reordered unions and intersections under paired generic bindings, in strict/wildcard modes and both
  operand directions, including `<T>(value: T | string)` versus `<U>(value: string | U)`.
- Union member counts remain two for unequal callbacks and one for equivalent callbacks.
- Idempotence and concrete-over-any behavior remain as before.

## Done criteria

- [ ] Both original reproductions now compare unequal and preserve distinct union members.
- [ ] Positive alpha-renaming and shadowing controls still compare equal.
- [ ] New native tests pass with exact semantic assertions.
- [ ] `render.ts` and the public schemas are unchanged.
- [ ] All verification gates pass without changing existing evidence or budgets.
- [ ] A patch changeset exists for the extractor.
- [ ] Scoped changes and status results are recorded.

## STOP conditions

Stop if the fix requires altering the text renderer, serialized generic representation, alias semantics,
or existing immutable output. Stop if native extraction has already erased the distinguishing information
and resolving that needs backend changes. Report any timing budget failure with the counter difference;
do not raise the ceiling. Stop on unaccounted conformance changes or after two failed correction attempts.

## Maintenance notes

Keep structural identity distinct from display rendering. Any future semantic node kind must state how
comparison handles nested types and lexical bindings. Review new shortcut proposals against both negative
and positive cases; a faster comparison that silently drops a signature is incorrect.

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
