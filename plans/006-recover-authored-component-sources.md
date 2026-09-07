# Plan 006: Recover authored component implementations without losing public prop semantics

> Follow this self-contained plan in order. It deliberately specifies a larger source-inspection change
> instead of guessing implementation metadata from existing provenance.
> Drift check first: `git diff --stat 3994cd4..HEAD -- packages/api-extractor/src/component-sources.ts packages/api-extractor/src/index.ts packages/api-extractor/src/extractor.ts packages/api-extractor/src/backend/contracts.ts packages/api-extractor/src/backend/ts7/node-facts.ts packages/api-extractor/src/parse/component-source.ts packages/api-extractor/test/component-source.test.ts packages/api-extractor/test/fixtures/component-source packages/api-extractor/test/lifecycle.test.ts packages/api-extractor/test/package.test.ts packages/api-extractor/README.md packages/api-artifacts/src/checker.ts packages/api-artifacts/src/generate.ts packages/api-artifacts/src/enrichment.ts packages/api-artifacts/test/component-source.test.ts packages/api-artifacts/test/generate.test.ts packages/api-artifacts/README.md test/packed-consumer.mjs .changeset/component-sources.md`.
> Inspect `git status --short`. Plan 005's AST-classifier change is expected; stop on other unexplained drift.

## Status

- Priority: P1
- Effort: L
- Risk: MED
- Depends on: 001-typecheck-extractor-scripts and 005-parse-client-directives-as-syntax
- Category: bug / architecture
- Original audit finding: 4
- Planned at: commit `3994cd4`, 2026-09-06
- Branch: `codex/plan-006-recover-authored-component-sources`
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

Artifact generation currently uses a component's public call-signature declaration as its implementation.
For React wrappers that declaration lives in React's types, not the authored component. Source links point
into node_modules, client/server status is read from a declaration file, and destructured defaults vanish.
Fixing only the source path is insufficient: keep the checker-backed public props while independently
recovering the implementation that supplies source metadata.

This is larger than the initial medium estimate. Investigation established that the existing public
provenance is not enough for a complete fix. The plan therefore adds one narrowly scoped source-inspection
operation to the extractor service and integrates it into artifact generation.

## Current state

`packages/api-artifacts/src/checker.ts:470`:

```ts
const signature = callSignature(checker, request.type);
const source = signature === null ? null : readPartSource(context, signature);
const declarationPaths = signature?.declaration === undefined ? [] : [signature.declaration.path];
```

`readPartSource` resolves `signature.declaration`, reads that node's source file, and looks for
destructuring defaults on its first parameter. `describePart` uses this source for RSC, sourcePath, and
defaultValue while the same public signature supplies accepted props.

A read-only extraction of existing `NestedWrapped` and `GenericWrapped` in
`packages/api-extractor/test/fixtures/react-wrapper-provenance/input.tsx` returned React's
`@types/react/index.d.ts` as source. Those fixtures do not themselves prove missing defaults, because
their shown implementations have no defaults. Add explicit default-bearing regressions in this plan.

The extractor already has strong React identity rules in `src/parse/react-policy.ts`:

```ts
export function isReactWrapperCall(facts: ParserSymbolOrigin | undefined): boolean {
  if (facts?.identity === undefined) return false;
  return reactWrapperCallNames.has(facts.identity.name) && isReactApiSymbol(facts, facts.identity.name);
}
```

It recognizes only actual React memo/forwardRef origins, not arbitrary same-name functions.
Reuse it. Do not implement another string-name recognizer in api-artifacts.

`src/parse/component-authorship.ts` recovers parameters and defaults for semantic extraction, but its
contract is intentionally different: direct exports include overload implementations, whereas wrapper
identifiers use checker-visible public signatures. It also drops zero-parameter functions.
`src/parse/component-object.ts` does not invoke that recovery for member sources.
Do not alter those semantic rules to implement source inspection.

`src/extractor.ts` currently exposes:

```ts
export type ProjectExtractorService = {
  readonly extractModule: (
    filePath: string,
    options?: ExtractorOptions
  ) => Effect.Effect<ExtractionResult, ExtractionErrors>;
};
```

It already owns `openExtraction`, `guardedExtractionSession`, `classifyThrown`, and scoped cleanup.
Its result is schema-decoded at the boundary. Follow that pattern.

Artifact enrichment currently creates a separate `ProjectExtractor.live` scope in
`src/enrichment.ts` only when external packages were selected. Full semantic extraction solely for
source discovery would introduce unrelated warnings or require silently discarding them. The new
operation must inspect source without running semantic resolution.

## Chosen contract

Create `packages/api-extractor/src/component-sources.ts` with schemas and derived public types.
Export these through the package index. The following is the required shape, with schema definitions
matching it:

```ts
type ComponentSourceRequest = {
  readonly exportName: string;
  readonly memberName?: string;
};

type ComponentSourceResult =
  | {
      readonly status: "resolved";
      readonly filePath: string;
      readonly defaults: readonly {
        readonly name: string;
        readonly initializerText: string;
      }[];
    }
  | {
      readonly status: "unresolved";
      readonly reason:
        | "export-not-found"
        | "member-not-found"
        | "no-implementation"
        | "unsupported-wrapper"
        | "unsupported-default-expression"
        | "unresolved-export"
        | "ambiguous-export"
        | "cycle"
        | "ambiguous-implementation";
    };
```

Add `inspectComponentSources(filePath, requests)` to `ProjectExtractorService`, returning an Effect of an
ordered readonly result array with the same typed extraction errors as `extractModule`. Each request has
exactly one result at the same index, including duplicates. A resolved filePath is absolute and points
to the authored implementation file. Defaults preserve authored initializer text and public property names.
No compiler handle, AST object, RSC policy, or warning-admission option crosses this boundary.

This is an additive public method, not a replacement for extractModule or a change to semantic JSON.
Missing exports/members and unsupported source shapes use unresolved results. Compiler/project failures
use the existing typed errors. Empty requests return an empty result without a semantic walk.

The source operation uses the existing normalized module draft, so its supported export inventory has
an explicit limit. Named exports and symbol-backed default exports can resolve. A default expression
omitted by the current module walker, such as an anonymous wrapper call that yields a
`missing-default-export-symbol` draft warning, returns `unsupported-default-expression` for a `default`
request. Do not return `export-not-found` when that warning proves a default expression exists. Extending
the backend module inventory to retain arbitrary default expressions is outside this plan.

Module walking itself can produce warnings even though semantic resolution is skipped. Before resolving
a request, inspect draft warnings concerning its export name: ambiguous-star warnings return
`ambiguous-export`; other unresolved-re-export warnings return `unresolved-export`. Unrelated module-walk
warnings do not block a different explicit request. Missing-default warnings apply only to `default`.
Preserve full extraction/enrichment warning admission unchanged. A resolved source result must never
quietly pick an ambiguous export just because the compiler kept one candidate.

## Commands you will need

| Purpose                 | Command from root                                                                                                                                 | Expected result                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Extractor source tests  | `pnpm --filter @elmeragroup/api-extractor exec vitest run test/component-source.test.ts test/component-authorship.test.ts test/lifecycle.test.ts` | All pass                                |
| Public package contract | `pnpm --filter @elmeragroup/api-extractor exec vitest run test/package.test.ts`                                                                   | All pass after a fresh extractor build  |
| Extractor build         | `pnpm --filter @elmeragroup/api-extractor build`                                                                                                  | Exit 0; new public types emitted        |
| Artifact source tests   | `pnpm --filter @elmeragroup/api-artifacts exec vitest run test/component-source.test.ts test/generate.test.ts`                                    | All pass                                |
| Extractor gate          | `pnpm --filter @elmeragroup/api-extractor check:all`                                                                                              | Exit 0, unchanged semantic evidence     |
| Artifact type check     | `pnpm --filter @elmeragroup/api-artifacts type-check`                                                                                             | Exit 0                                  |
| Repository gate         | `pnpm ci:checks`                                                                                                                                  | Exit 0                                  |
| Installed consumer      | `pnpm canary:pack && pnpm test:packed-consumer`                                                                                                   | Exit 0, including the new public method |
| Hygiene                 | `git diff --check`                                                                                                                                | Exit 0                                  |

## Scope

Only paths listed in the drift check may change. The new fixture directory may contain input/source files
and a tsconfig, never copied upstream oracles. Add new tests at the specified paths rather than appending
everything to existing large suites. The changeset should describe the additive extractor API as a minor
release and the artifact correction as a patch, following the coordinated release policy in effect.

Do not change the semantic model, provenance schema, existing component-authorship parameter semantics,
React identity policy, callable-compound inventory behavior, package versions, dependency pins, warning
codes, artifact data shape, or external-prop selection. Do not add a new package.

Plan 005 changes `readRscStatus` to take a SourceFile. That known drift is expected and required.
Plan 001 expands script checking; it should not otherwise affect this work.

## Steps

### Step 1: Add artifact regressions that state the complete source contract

Create temporary test projects containing actual React types available from the workspace. Use
`test/generate.test.ts` cleanup style. Resolve/link the existing React and @types/react installations into
the temporary test project's node_modules as needed; do not install or invent fake wrapper declarations.
All public prop declarations must have JSDoc so tests fail on source metadata rather than the unrelated
documentation gate.

Include one nested memo/forwardRef component with an exact client directive and a destructuring default,
and one `memo(Render)` whose render implementation is imported from a different local file.
Assert exact sourcePath, RSC, defaultValue, accepted prop names/types, and required flags.
Before this step, run `pnpm --filter @elmeragroup/api-extractor build` if compiled dependency output is
missing or stale. Include a direct-component preservation case with
`{ options: { enabled } = {} }`: the existing artifact reader records the outer `options` default, even
though the extractor's semantic binding-default helper does not. This default must survive the refactor.

**Verify:** `pnpm --filter @elmeragroup/api-artifacts exec vitest run test/component-source.test.ts test/generate.test.ts`
fails on the documented wrong source/defaults while existing cases pass. Keep these regressions runnable
before the new service API exists.

### Step 2: Add neutral backend facts needed for source following

Extend `BackendNodeFacts` with optional facts for:

- A referenced value symbol, distinct from the expression's type symbol.
- A transparent inner expression for parentheses, assertions, non-null expressions, and satisfies.
- Whether a function-like declaration has an implementation body.
- Source-inspection parameter defaults that preserve the artifact reader's outer-property semantics.

Populate those facts only for appropriate syntax kinds in `backend/ts7/node-facts.ts`.
Do not assume `session.symbolAt` normalizes aliases: it wraps the checker symbol, and `symbolHandle` only
interns it. For the new referenced-value fact, inspect alias flags and resolve the target with the pinned
checker's `getAliasedSymbol`, then intern that target with `session.symbolHandle`. Keep this normalization
local to the new observation; do not change existing semantic `symbolFacts` behavior. For shorthand assignments, the
pinned checker exposes `getShorthandAssignmentValueSymbol(node)`; use its referenced variable rather than
the object-property symbol. For explicit property assignments, follow their initializer.
Do not treat a wrapper's type symbol, such as MemoExoticComponent, as its authored variable symbol.

Existing facts already provide filePath, parameter handles, initializers, call arguments, and calleeFacts.
Reuse those. Add a separate optional `sourceBindingDefaults` observation for parameters: for a binding
element with an initializer, use its identifier propertyName when present, even when its bound value is
another binding pattern. Otherwise use an identifier bound name. This preserves the existing artifact
case `{ options: { enabled } = {} }` as `options` → `{}`. Keep semantic `bindingDefaults` unchanged, because
it intentionally filters nested patterns. Avoid unnecessary compiler reads for unrelated node kinds.

**Verify:** run `pnpm --filter @elmeragroup/api-extractor exec vitest run test/component-source.test.ts test/node-kind-table.test.ts test/boundary.test.ts`
and `pnpm --filter @elmeragroup/api-extractor type-check`. Backend-backed tests cover direct, shorthand,
explicit, aliased, transparent-expression, and nested-binding-default facts. Existing semantic facts stay compatible.

### Step 3: Implement a pure requested-source resolver

Create `src/parse/component-source.ts`. It uses only backend contracts, pure model types, and
`isReactWrapperCall`. It must not import Effect or compiler modules. Do not fabricate a full
ResolverContext: the operation needs compiler facts and breadcrumbs, not semantic warning buffers.

Apply the requested-name warning/default-expression policy above, then start from the requested export
in the module draft. If memberName is present, find that member on the
root's public type, even when the object has unrelated noncomponent siblings. Follow declaration/value
references with cycle detection:

- Function/arrow/expression with a body: resolve its file and first parameter's sourceBindingDefaults.
- Overloaded function: choose the single implementation with a body, not an overload declaration.
- Variable or property assignment: follow initializer.
- Shorthand/identifier/property alias: follow the normalized referenced value symbol.
- Transparent syntax: follow the inner expression.
- A verified React memo or forwardRef call: follow only argument zero, recursively.
- Unknown calls: unresolved unsupported-wrapper; never inspect arbitrary callbacks.
- Zero parameters: resolved source with empty defaults.
- No body: unresolved no-implementation.
- Cycles or multiple competing implementations: explicit corresponding unresolved result.

Track visited symbols and nodes per request, not globally across the service. Preserve requested order.
Comparator callbacks are never a source candidate.

**Verify:** `pnpm --filter @elmeragroup/api-extractor exec vitest run test/component-source.test.ts test/component-authorship.test.ts`
passes. Backend-double tests cover every branch, including cycles and zero props. Native tests prove
React alias identity and shorthand semantics. Existing component-authorship assertions remain unchanged.

### Step 4: Expose the scoped service operation

Add the public schemas/types and method. Reuse the existing opened project and acquire/release extraction
session infrastructure in `extractor.ts`. Read the module draft and call the pure source resolver.
Do not call `resolveModuleDraft` or materialize the semantic model for this operation.
Map thrown compiler/resolver failures through the same typed-error boundary, and schema-check results.

Add lifecycle coverage for successful inspection, unresolved results, thrown backend failure, and
repeated calls sharing one project. Existing extractModule behavior must be unchanged.
Update `test/package.test.ts`'s exact `Reflect.ownKeys(extractor)` assertion, which currently expects only
`extractModule`, to permit exactly the existing method plus `inspectComponentSources`. Keep its rejection
of instrumentation/internal service members.

**Verify:** run `pnpm --filter @elmeragroup/api-extractor build`, then
`pnpm --filter @elmeragroup/api-extractor exec vitest run test/component-source.test.ts test/lifecycle.test.ts test/package.test.ts`,
then `pnpm --filter @elmeragroup/api-extractor check:boundary`. All exit 0 and public declarations contain
no compiler types.

### Step 5: Separate artifact discovery from description and inspect sources once

Extend internal PartRequest with structured exportName/memberName identity. Keep display name separately.
Do not split a display string on dots to recover identity. Preserve the current callable-root versus
object-members selection policy.

Refactor checker internals into discovery of accepted prop facts followed by description using supplied
PartSource. Keep its existing public checker signature, prop map, printing, required flags, forwarded
count, JSDoc gate, and ordering as the authority for accepted props.

In `generate.ts`, open one extractor service scope across the inventory, inspect sources for each entry,
then describe parts with those recovered facts. Resolve each returned filePath through the already-open
artifact compiler program; obtain its SourceFile and call the AST classifier supplied by plan 005.
Compute artifact sourcePath relative to projectRoot and create the defaults map from returned entries.

For unresolved source inspection, add an actionable problem naming the component and reason before any
artifact write. Do not fall back to React's signature declaration. Declaration-only components have no
authored implementation and must now fail with this explicit diagnostic; document this limitation.
This tightens previously misleading output rather than silently inventing source metadata.

**Verify:** `pnpm --filter @elmeragroup/api-artifacts exec vitest run test/component-source.test.ts test/generate.test.ts`
passes. Original wrapper regressions and zero-prop wrappers work; unresolved cases fail before changing
an existing output file, and the nested outer-property default preservation case still passes.

### Step 6: Reuse the service for optional enrichment without changing warnings

Move extractor ownership out of `enrichComponents`. Supply the already-open service or precomputed
extraction results to enrichment. Source inspection runs independently of includeExternalTypes.
Full extractModule calls still run only when external packages are selected, and their warnings still
flow through the current allowedWarningCodes check unchanged.

This design adds a second compiler project for default artifact generation, but only one extractor
project per inventory. Do not open one per part or per source file. Keep both projects scoped and closed
on success, validation failure, typed failure, and interruption.

**Verify:** `pnpm --filter @elmeragroup/api-artifacts test` and
`pnpm --filter @elmeragroup/api-artifacts type-check` exit 0. Generation with no selected packages has no
new semantic warning failures; the selected-dependency test still rejects unapproved warnings and returns
approved diagnostics. Multiple inventory entries reuse one scope. Write/check and validation tests pass.

### Step 7: Verify native edge cases and distribution

Complete the test matrix below. Extend `test/packed-consumer.mjs` to call the new inspection method through
the installed extractor entry and assert compiler-free results for an authored component.
Keep Node's type-stripping-disabled check and existing declaration compilation.

Update the two package READMEs to state implementation-source semantics, supported wrappers, and explicit
failure for unresolved/declaration-only sources. Add the changeset.

**Verify:** extractor check:all, artifact type/tests, pnpm ci:checks, and packed-consumer verification
all pass. Existing semantic oracle bytes and warnings are unchanged. New source-inspection tests have
their own direct assertions, not generated semantic oracle replacements.

## Test plan

Mandatory matrix, with exact file/default/prop assertions where applicable:

- Direct function, arrow, and zero-parameter implementations.
- memo, forwardRef, nested combinations, and aliased React imports.
- Re-exported/renamed values and an implementation in another local file.
- Overloaded render function: implementation defaults, public accepted props unchanged.
- Explicit object member, shorthand member, and object with noncomponent metadata siblings.
- Transparent parentheses/assertion/satisfies forms.
- Same-name non-React memo and arbitrary custom wrapper: not unwrapped.
- Comparator containing different defaults: ignored.
- Missing export/member, declaration-only source, alias cycle, ambiguous body: deterministic unresolved result.
- Symbol-backed default exports versus unsupported expression defaults, and requested versus unrelated
  module-walk warnings, including ambiguous-star exports.
- Outer-property defaults on nested bindings remain present in direct and wrapped implementations.
- Result order and repeated requests.
- No selected packages versus selected dependency enrichment with accepted/rejected warnings.
- No writes on source-inspection failure; all scopes released.
- Public packed import and declarations for the new method.
- Existing semantic authorship and provenance tests unchanged.

## Done criteria

- [ ] Supported wrappers identify their actual implementation file and defaults.
- [ ] Checker-backed prop acceptance, required flags, printing, and forwarded counts remain authoritative.
- [ ] Source-only inspection returns no semantic fallback warnings and exposes no compiler handles.
- [ ] Unknown wrappers/cycles/declaration-only sources fail explicitly rather than publish false metadata.
- [ ] One extractor project is reused across inventory and optional enrichment.
- [ ] Existing semantic extraction and evidence remain unchanged.
- [ ] All tests, lifecycle/boundary checks, and installed-consumer checks pass.
- [ ] README behavior, changeset, and status results are complete.

## STOP conditions

Stop if following aliases requires facts unavailable from the pinned compiler, if correct source recovery
requires changing existing semantic parameter selection, or if a new public schema would expose handles.
Stop if the change alters accepted props or warning admission instead of just source metadata.
Do not broaden wrapper recognition beyond proven React identity, expand compound-component inventory,
or raise IPC budgets. Report any existing oracle difference before changing evidence.

If supporting a documented consumer pattern requires another source-result variant, describe that pattern
and proposed contract rather than returning a misleading best guess. Stop after two failed corrective
attempts with a concrete reproducer.

## Maintenance notes

Source inspection and semantic prop extraction answer different questions. Keep that distinction visible
when adding overload or wrapper support. New wrappers must use the shared React identity policy and need
source, lifecycle, and accepted-prop regressions. Public source metadata must stay serializable and
independent of the compiler implementation.

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

Review reopened this plan for two native counterexamples. A semicolon-free declaration returning an
inline object type was mistaken for a function body, and the same overload shape produced a false
ambiguous-implementation result. Namespace and object property aliases also failed source recovery.

The corrected backend follows property-access symbols and reads actual AST body presence. Native
regressions and artifact generation tests cover aliases, overload defaults, declaration-only failure,
and preservation of existing output when validation fails.

Reading every function body initially changed a stored semantic materialization count from 306 to 308.
The review fix therefore extends the original implementation scope to `backend/ts7/facts.ts`,
`backend/ts7/project.ts`, and `backend/ts7/session.ts`, alongside the already-listed contracts and
extractor files. An internal per-session `componentSources` option enables body reads only during
source inspection. Ordinary semantic extraction keeps its existing work and cached facts remain
isolated. Lifecycle coverage asserts three source sessions followed by a semantic session with source
mode absent. No public option, dependency, semantic oracle, timing report, or budget changed.

Fresh review confirmed the session boundary. The Node 24 Issue 14 timing check passes with the stored
851 requests, 3,956,738 bytes received, and 618 materialized nodes. Final combined-branch gates and
implementation commits are recorded in `plans/README.md`.
