# Plan 005: Discard diagnostics from rejected authored component candidates

> Executor instructions: Read this entire plan before editing. Follow each step and its expected verification result. On a STOP condition, report the specific blocker instead of expanding scope. Update this plan's status and its row in plans/README.md when complete, unless a reviewing operator owns those updates.
>
> Drift check: `git diff --stat e9ad9b3..HEAD -- 'packages/api-extractor/src/parse/resolver.ts' 'packages/api-extractor/src/parse/component.ts' 'packages/api-extractor/src/parse/component-authorship.ts' 'packages/api-extractor/src/parse/contracts.ts' 'packages/api-extractor/src/parse/object-resolver.ts' 'packages/api-extractor/test/component-candidate-warnings.test.ts' 'packages/api-extractor/README.md' '.changeset/discard-component-candidate-warnings.md' 'plans/005-discard-component-candidate-warnings.md' 'plans/README.md'`
> (`component.ts`, `component-authorship.ts`, `contracts.ts` and `object-resolver.ts` are read-only references for the excerpts below; they are not in Scope.)
> If implementation files changed, compare the excerpts below to live code. If they no longer match, stop for reconciliation. New plan files alone are expected and do not indicate implementation drift. Also inspect `git status --short` for uncommitted edits before starting.

## Status

- Status: TODO
- Finding: 5 from the deep audit
- Priority: P2
- Effort: M, including regression coverage
- Fix risk: MED
- Depends on: none
- Category: bug
- Planned at: commit `e9ad9b3`, 2026-09-08
- Confidence: HIGH, reproduced during the audit

## Why this matters

`resolveExport` in `packages/api-extractor/src/parse/resolver.ts` resolves an export's authored first parameter speculatively, as candidate component props, before `componentNode` decides whether the export is a component. That speculative resolution pushes into the shared `base.warnings` array. When the candidate is rejected (`notAComponent`) or left `uncertain`, its warnings stay published even though the props representation they describe was never returned. A capitalized ordinary function `Factory(props: { (): string; foo: string }): string` therefore reports `omitted-callable-members` twice: once legitimately at `Factory/callSignatures/0/parameters/props` and once spuriously at the root path `Factory`. The lowercase twin `factory` reports it once. The README already promises at `packages/api-extractor/README.md:56` that "Diagnostics from a discarded speculative candidate are not published"; this plan makes that true.

Reproduced during plan review at `e9ad9b3` by running `ProjectExtractor.extractModule` from source against a temporary project; the exact observed output is in "Reproduction evidence" below.

## Current state

Files and roles:

- `packages/api-extractor/src/parse/resolver.ts` — `resolveExport` (line 111 onward) resolves the export root (`resolvedType`), then the authored props candidates (`authoredPropsTypes`), then runs `componentNode`. Only this file changes.
- `packages/api-extractor/src/parse/contracts.ts:17` — `ResolverContext.warnings: BackendWarningFact[]` is the single mutable warning sink every `typeNode` call pushes into. Contexts are spread copies (`{ ...base, ... }`), so passing a different array in the spread redirects that subtree's warnings.
- `packages/api-extractor/src/parse/component.ts:49-54` — `componentNode` returns `recognition.outcome` of `"transformed"`, `"notAComponent"` or `"uncertain"`.
- `packages/api-extractor/src/parse/component-authorship.ts:113` — `inspectAuthoredSymbol` only recovers candidates for `default` or capitalized export names, which is why lowercase exports never get a speculative warning.
- `packages/api-extractor/src/parse/object-resolver.ts:656-673` — `recordOmittedCallableMembers` sets `structuralPath: [...context.provenancePath]`; the authored contexts use `provenancePath: semanticPath`, which is why the spurious warning lands at the export root path.
- `packages/api-extractor/src/parse/fallback.ts:60-65` — renders the `omitted-callable-members` message. Do not change it.
- `packages/api-extractor/README.md:54-56` — documents the `warnings` result field and the guarantee this plan enforces.

`resolvedType` resolution is authoritative for ordinary functions and its warnings must stay. This plan buffers only the speculative authored-candidate warnings and appends them to `base.warnings` when recognition is `transformed`; it discards them for `notAComponent` and `uncertain`. It does not redesign the warning model for selected components (a transformed component currently emits both a `.../parameters/props` warning from `resolvedType` and a root-path warning from the authored props; both stay).

`packages/api-extractor/src/parse/resolver.ts:142-166`:

```text
  const componentContext = {
    ...base,
    symbolStack: entry.symbolStack ?? [entry.name],
  };
  const authored = recoverAuthoredComponent(entry.symbol, componentContext);
  const authoredProvenance: ProvenanceEntry[] = [];
  const authoredPropsTypes = authored.propNodes.map((authoredProps) =>
    typeNode(base.operations.typeAtNode(authoredProps), authoredProps, undefined, {
      ...base,
      provenance: authoredProvenance,
      provenancePath: semanticPath,
      provenancePropertyContainer: "componentProps",
      propertyDepth: 0,
      symbolStack,
      ...definedFields({ bindingDefaults: authored.bindingDefaults }),
    })
  );
  // The authored export context is applied BEFORE the component transform,
  // matching upstream's ordering: repair the resolved root's public name, then
  // let the transform reshape functions into components.
  const namedOutputType = publicExportName(resolvedType, entry);
  const transformedComponent = componentNode(namedOutputType, entry.name, authoredPropsTypes);
  const resolvedOutputType = transformedComponent.type;
  if (transformedComponent.recognition.outcome === "uncertain")
    recordUncertainComponentRecognition(base, entry, symbolFacts, transformedComponent.recognition);
```

`recoverAuthoredComponent` itself pushes no warnings (the only `warnings.push` call sites in `src/parse` are in `resolver.ts`, `object-resolver.ts` and `fallback.ts`), so `componentContext` may keep using `base.warnings`; only the `authoredPropsTypes` contexts need the buffer.

`packages/api-extractor/src/parse/resolver.ts:73-92` (how the shared sink is created; module-walk warnings lead the list):

```text
  const warnings: BackendWarningFact[] = [];
  const context: Context = {
    operations: session.compiler,
    filePath,
    warnings,
    ...
  };
  ...
  for (const warning of draft.warnings ?? []) context.warnings.push(warning);
  const exports = draft.exports.map((entry) => resolveExport(entry, context));
```

`packages/api-extractor/src/parse/component.ts:49-54`:

```text
  if (!isComponentExportName(exportName)) return passThrough(type, "notAComponent");
  const functions = collectComponentFunctions(type);
  if (functions === undefined) {
    return isPartialComponentUnion(type)
      ? { type, recognition: { outcome: "uncertain", reason: "mixed-component-union" } }
      : passThrough(type, "notAComponent");
```

`packages/api-extractor/README.md:54-56`:

```text
- `warnings`: recoverable losses in the returned model. A warning has a stable `code`, location, and
  code-specific fields; `message` explains what failed, what the extractor did, and what a maintainer
  can do next. Diagnostics from a discarded speculative candidate are not published.
```

### Reproduction evidence

Temporary project (`tsconfig.json` copied from `packages/api-extractor/test/fixtures/basic/tsconfig.json` with `"include": ["input.ts"]`), `input.ts`:

```ts
export interface ReactElement {
  readonly tag: string;
}
export function Card(props: { (): string; foo: string }): ReactElement {
  return { tag: props.foo };
}
declare function pick():
  ((props: { (): string; foo: string }) => ReactElement) | ((props: { (): string; bar: string }) => number);
export const Mixed = pick();
export function Factory(props: { (): string; foo: string }): string {
  return props.foo;
}
export function factory(props: { (): string; foo: string }): string {
  return props.foo;
}
```

Component recognition matches the return type name exactly (`component.ts:11`), so a local `interface ReactElement` is enough; a temporary project under the OS temp directory cannot resolve `react`, so do not import it. Observed `extractModule` warnings at `e9ad9b3`, in order (`code`, `structuralPath`, `parsedSymbolStack` without the file path):

```text
omitted-callable-members ["Card","callSignatures","0","parameters","props"] ["Card","parameter: props"]
omitted-callable-members ["Card"]                                             ["Card"]
omitted-callable-members ["Mixed","callSignatures","0","parameters","props"] ["Mixed","parameter: props"]
omitted-callable-members ["Mixed","callSignatures","0","parameters","props"] ["Mixed","parameter: props"]
uncertain-component-recognition name="Mixed"                                 ["Mixed"]
omitted-callable-members ["Factory","callSignatures","0","parameters","props"] ["Factory","parameter: props"]
omitted-callable-members ["Factory"]                                           ["Factory"]
omitted-callable-members ["factory","callSignatures","0","parameters","props"] ["factory","parameter: props"]
```

Export kinds: `Card: component`, `Mixed: union`, `Factory: function`, `factory: function`. Extracting the same file twice in one `ProjectExtractor` scope produced identical warning lists (8 each).

The defect is the second `Factory` line (root path, symbol stack without `parameter: props`). After the fix the list must be identical except that line is gone: `Card` keeps both warnings (transformed), `Mixed` keeps its two resolved-type warnings plus the uncertainty warning (its `const` initializer is not a React wrapper, so it has no authored candidate at all), `factory` is unchanged.

## Conventions and test pattern

Read root README.md and AGENTS.md before implementation, plus the affected package README where present. Match strict typing, kebab-case filenames, separate type imports, .oxlintrc.json and .oxfmtrc.json. Lint uses --deny-warnings. Fix the underlying issue before adding an exception; in api-extractor no file-wide disable or path override is allowed, and any necessary next-line disable names one rule with a -- reason.

Only src/backend/ts7 may import TypeScript's unstable native API. parse and canonical must stay Effect-free through transitive value imports. Fatal failures remain typed Effect errors; recoverable losses use stable structured warning codes, with prose rendered in src/parse/fallback.ts. Reuse a scoped ProjectExtractor per project and preserve isolated extraction sessions. Never edit upstream output.json or the timing-boundary baseline. Do not refresh reviewed evidence merely to make a check pass.

Use the public-service helper `extractFixture` from `packages/api-extractor/test/support/extract.ts` (it opens a project, calls `extractModule`, and closes the scope; this is the API whose `warnings` the test asserts). Do not use `inspectNative` from `test/support/component-source.ts`; that calls `inspectComponentSources`, which does not return warnings.

```text
/** Opens one project, extracts one module through the public service, and closes the project. */
export function extractFixture(
  project: OpenProjectOptions,
  filePath: string,
  options?: ExtractorOptions
): Promise<ExtractionResult> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const extractor = yield* ProjectExtractor;
        return yield* extractor.extractModule(filePath, options);
      }).pipe(Effect.provide(ProjectExtractor.live(project)))
    )
  );
}
```

Call it as `extractFixture({ tsconfigPath }, inputPath)`. For temporary inputs use `createTemporaryRoot(prefix)` from `packages/api-extractor/test/support/temp-dirs.ts` and remove the root with `rmSync(root, { recursive: true, force: true })` in `finally`, exactly as `packages/api-extractor/test/conformance-report.test.ts:73-114` does. Write `tsconfig.json` and `input.ts` into that root before extracting. For the repeated-extraction case, provide `ProjectExtractor.live` once and call `extractModule` twice inside the same `Effect.scoped` block (see the `Effect.gen` shape above). For warning-assertion style, model after `packages/api-extractor/test/classes-and-callables.test.ts:195-215`, which filters `result.warnings` by `code` and compares `structuralPath.join("/")` and sorted `memberNames`.

## Commands you will need

Run commands from the repository root. Use Node 24.13.0 from .node-version and pnpm 11.20.0 from package.json. Preserve the pinned TypeScript 7.0.2 and Effect 4.0.0-rc.111 catalog versions.

- Check runtime: `node --version` should report v24.13.0; `pnpm --version` should report 11.20.0.
- If dependencies are absent: `pnpm install --frozen-lockfile` must exit 0 without a lockfile diff. Do not upgrade dependencies to unblock installation.
- Prepare the baseline: `pnpm build` must exit 0. This ensures workspace exports point to current compiled code before consumer tests.
- Focused regression command: `pnpm --filter @elmeragroup/api-extractor exec vitest run test/component-candidate-warnings.test.ts`. Do not use `pnpm --filter ... test -- <file>`: verified at `e9ad9b3` that form ignores the file argument and runs the whole suite (51 files, 628 tests, about two minutes).
- Package tests: `pnpm --filter @elmeragroup/api-extractor test` must exit 0 (all 51 existing files plus the new one).
- Extractor evidence gate: `pnpm --filter @elmeragroup/api-extractor check:all` must exit 0.
- Workspace gate: `pnpm ci:checks` must exit 0.
- Package verification: `pnpm packages:pack && pnpm test:packed-consumer` must exit 0, in that order.

During plan review `pnpm --filter @elmeragroup/api-extractor exec vitest run ...` and the full package test run both worked with the installed toolchain. If pnpm's pinned-version bootstrap fails to fetch signature data in your environment, that is an environment blocker, not evidence that a dependency upgrade is needed; record it and do not bypass signature validation. No complete fresh-build/packed baseline was run during the audit, so establish it before attributing unrelated failures to this change.

## Scope

Only modify these paths. Listed new test/helper files may be created.

- `packages/api-extractor/src/parse/resolver.ts`
- `packages/api-extractor/test/component-candidate-warnings.test.ts`
- `packages/api-extractor/README.md`
- `.changeset/discard-component-candidate-warnings.md`
- `plans/005-discard-component-candidate-warnings.md`
- `plans/README.md`

Everything else is out of scope, including dependency versions, lockfiles, unrelated source refactors, public export maps, upstream fixture output.json files, immutable timing evidence and publication credentials. Build outputs in ignored dist/.cache/.artifacts directories are normal verification products, not source changes.

## Git workflow

The advisor branch is `codex/deep-audit-plans`. For implementation, use an isolated branch such as `codex/fix-discard-component-candidate-warnings` from the operator's approved base; keep unrelated working changes intact. Do not create a second implementation branch if the operator already supplied one. Do not commit, push, publish or open a PR unless the operator requested that action. If a commit is requested, use a conventional subject such as `fix: discard diagnostics from rejected authored component candidates`.

## Steps

### Step 1: Reproduce rejected-candidate warning leakage

Create `packages/api-extractor/test/component-candidate-warnings.test.ts`. Use the `input.ts` from "Reproduction evidence" verbatim, written into a `createTemporaryRoot("api-extractor-candidate-warnings-")` directory together with the `basic` tsconfig (include only `input.ts`). Extract through `extractFixture` from `./support/extract.ts` so the test executes source, not `dist`. Do not add fixture directories or oracle files.

Write these cases (each an `it`):

1. `Factory` and `factory` each have exactly one `omitted-callable-members` warning, at `Factory/callSignatures/0/parameters/props` and `factory/callSignatures/0/parameters/props`, with `memberNames` `["foo"]`; no warning has `structuralPath` equal to `["Factory"]` or `["factory"]`.
2. `Card` (transformed) keeps both warnings: one at `Card/callSignatures/0/parameters/props` and one at `Card`. This pins the deliberately unchanged selected-component behavior.
3. `Mixed` (uncertain) has exactly one `uncertain-component-recognition` warning with `name: "Mixed"` and exactly two `omitted-callable-members` warnings, both at `Mixed/callSignatures/0/parameters/props`; the export kind is `union`.
4. Total warning count is 7 and the `code` order is `omitted-callable-members` x6 then `uncertain-component-recognition` last-but-one as in the evidence list minus the removed root `Factory` line (assert the full ordered list of `[code, structuralPath ?? name]` pairs).
5. Extracting the same file twice inside one `Effect.scoped` block yields identical warning lists, and the export kinds are `Card: component`, `Mixed: union`, `Factory: function`, `factory: function`.

Before the fix, cases 1 and 4 must fail on their assertions only (the spurious `["Factory"]` warning is present; count is 8); cases 2, 3 and 5 already pass.

**Verify:** `pnpm --filter @elmeragroup/api-extractor exec vitest run test/component-candidate-warnings.test.ts`

Expected: exit 1; cases 1 and 4 fail on assertion, the others pass; no import, compile or setup error.

### Step 2: Isolate speculative warning collection

In `resolveExport` (`resolver.ts:146-166`), allocate `const authoredWarnings: BackendWarningFact[] = [];` next to `authoredProvenance`, and pass `warnings: authoredWarnings` in the spread context given to `typeNode` for `authoredPropsTypes` (alongside `provenance: authoredProvenance`). Leave `componentContext` on `base` (it pushes nothing). Immediately after `componentNode(...)` and before the `uncertain` check, add:

```ts
if (transformedComponent.recognition.outcome === "transformed")
  for (const warning of authoredWarnings) base.warnings.push(warning);
```

Because authored resolution already runs after `resolvedType` today and `transformed` and `uncertain` are mutually exclusive, this keeps the existing warning order for retained warnings exactly. Add a two-line comment explaining that a rejected or uncertain candidate's props were never published, so its diagnostics are dropped. Do not deduplicate warnings by code or message anywhere, do not touch `recordUncertainComponentRecognition`, and do not change `resolvedType` resolution. `BackendWarningFact` is already imported in `resolver.ts:8`.

**Verify:** `pnpm --filter @elmeragroup/api-extractor exec vitest run test/component-candidate-warnings.test.ts`

Expected: exit 0, all five cases pass.

### Step 3: Protect selected candidates and session isolation

Run the whole package suite and the extractor evidence gate. Edit `packages/api-extractor/README.md:56` so the sentence reads, for example: "Diagnostics from a speculative component-props candidate are published only when the export is recognized as a component; a rejected or uncertain candidate contributes none." Keep the surrounding bullet structure.

Seven fixtures carry non-empty `warnings.tsgo.json` oracles: `react-mui-overridable-component`, `external-union-type-name-preservation`, `class-members-visibility-and-signatures`, `react-component-overload-any-callback-deduplication`, `react-component-union-variants`, `interface-extends-basic-resolution`, `symbol-double-underscore-name-preservation`. Review at `e9ad9b3` found none whose warnings come from a rejected candidate (their capitalized roots are transformed components, type-only exports, or carry `parameter:` symbol stacks from `resolvedType`), so `test:conformance` is expected to pass unchanged. If it reports a warning-oracle difference, that is the evidence STOP condition: report the exact diff; do not run `report:warnings`.

**Verify:** `pnpm --filter @elmeragroup/api-extractor test` then `pnpm --filter @elmeragroup/api-extractor check:all`

Expected: both exit 0 with no changes under `test/fixtures/`.

### Step 4: Complete the release note and final gates

Create `.changeset/discard-component-candidate-warnings.md` with this frontmatter and a short consumer-facing explanation of the corrected behavior:

```yaml
---
"@elmeragroup/internal": patch
---
```

Only the umbrella package receives a release. Do not version a private workspace or edit package versions/lockfiles.

Run `pnpm ci:checks` and then `pnpm packages:pack && pnpm test:packed-consumer`. Inspect `git diff --check`, `git diff --name-only` and `git status --short`; every changed source/document must be in Scope. Run `pnpm exec oxfmt --check plans/005-discard-component-candidate-warnings.md plans/README.md` after updating plan status. Do not mark DONE with a failed or skipped required gate.

**Verify:** `git diff --check`

Expected: exit 0; all preceding final commands exit 0. Record the actual commands/results in the completion notes, including any blocked check.

## Test plan

One new file, `packages/api-extractor/test/component-candidate-warnings.test.ts`, exercising the public service (`extractFixture`) against a temporary project created with `createTemporaryRoot` and removed in `finally`. Cases are enumerated in Step 1: rejected capitalized candidate (`Factory`) versus lowercase twin (`factory`), retained transformed-candidate diagnostics (`Card`), uncertain union (`Mixed`), exact ordered warning list, and repeated extraction in one scope. Assert structured fields (`code`, `structuralPath`, `memberNames`, `name`, export `kind`); never assert `message` text or snapshot the whole result.

Run `pnpm --filter @elmeragroup/api-extractor exec vitest run test/component-candidate-warnings.test.ts` after the implementation and expect every case to pass. In Step 1 only, failure must be the intended assertion, not a compiler/import/runtime/setup failure. Keep the new regressions after the fix; do not replace assertions with snapshots that merely accept current output.

## Done criteria

- [ ] Capitalized and lowercase ordinary functions each emit one legitimate parameter warning. Rejected/uncertain authored guesses add none. Selected-component diagnostics, module-walk order and isolated-session behavior remain covered.
- [ ] `pnpm --filter @elmeragroup/api-extractor exec vitest run test/component-candidate-warnings.test.ts` exits 0 and the five cases from Step 1 exist.
- [ ] `git status --short packages/api-extractor/test/fixtures` prints nothing (no oracle or fixture changed).
- [ ] `pnpm --filter @elmeragroup/api-extractor check:all` exits 0.
- [ ] `pnpm ci:checks` exits 0.
- [ ] `pnpm packages:pack && pnpm test:packed-consumer` exits 0.
- [ ] `git diff --check` exits 0, and changed paths match Scope.
- [ ] The umbrella patch changeset exists with the consumer-facing fix description.
- [ ] This plan and its index row reflect the actual completion state; no skipped gate is described as passing.

## STOP conditions

Stop if this requires changing semantic output, warning schemas/codes, canonical paths, or any stored warning/oracle evidence. Structural warning evidence needs an explicitly reviewed extension of this scope; report it instead of updating expected output to pass.

Also stop if implementation excerpts have drifted, a required check fails twice after a focused reasonable fix attempt, or the fix requires an out-of-scope file. Report pre-existing/environment failures separately. Never modify immutable evidence, suppress a diagnostic, or weaken a test just to obtain a green run.

Stop as well if any of these assumptions proves false: `recoverAuthoredComponent` (or anything it calls) pushes to `context.warnings`; `authoredPropsTypes` contexts are not the only place the speculative candidate is resolved; the pre-fix reproduction does not show the root-path `["Factory"]` warning; or removing that warning changes any existing test in `packages/api-extractor/test/` other than the new file.

## Maintenance notes

Every future speculative resolution path must own a diagnostic buffer and decide explicitly when it is published. Preserve module-walk warnings and typed failures; do not suppress genuine losses with global deduplication.

Reviewers should check that only the `authoredPropsTypes` contexts receive the buffer and that the append happens for `transformed` only. Deferred out of this plan: a transformed component still emits the `resolvedType` warning at `<Export>/callSignatures/0/parameters/props`, a path that does not exist in the component output, next to the authored root-path warning. Relocating or collapsing those is a warning-model change with fixture-oracle impact and needs its own plan.

## Completion notes

Not implemented. Record the implementing revision, regression results, full gate results and any reviewed scope changes here.
