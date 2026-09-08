# Plan 001: Keep forwarded facades prop-free during enrichment

> Executor instructions: Read this entire plan before editing. Follow each step and its expected verification result. On a STOP condition, report the specific blocker instead of expanding scope. Update this plan's status and its row in plans/README.md when complete, unless a reviewing operator owns those updates.
>
> Drift check (run first): `git diff --stat e9ad9b3..HEAD -- 'packages/api-artifacts/src/checker.ts' 'packages/api-artifacts/src/enrichment.ts' 'packages/api-artifacts/test/reexport-facade.test.ts' 'packages/internal/test/generate.test.ts' 'packages/api-artifacts/README.md' '.changeset/preserve-forwarded-facades.md' 'plans/001-preserve-forwarded-facades.md' 'plans/README.md'`
> If implementation files changed, compare the excerpts below to live code. If they no longer match, stop for reconciliation. New plan files alone are expected and do not indicate implementation drift. Also inspect `git status --short` for uncommitted edits before starting; at planning time the only untracked entry was `plans/`.

## Status

- Status: DONE
- Finding: 1 from the deep audit
- Priority: P1
- Effort: S, including regression coverage
- Fix risk: LOW
- Depends on: none
- Category: bug
- Planned at: commit `e9ad9b3`, 2026-09-08
- Reviewed: 2026-09-08 against `e9ad9b3` (excerpts corrected, bug re-reproduced, commands verified)
- Confidence: HIGH, reproduced twice against `e9ad9b3` (see "Reproduction evidence")

## Why this matters

`packages/api-artifacts/README.md` documents that a facade which only forwards a dependency's value publishes a part with no props, and the checker produces exactly that: `props: []` with `forwardedCount` covering every accepted prop. The enrichment pass then undoes it. When the forwarding dependency is listed in `includeExternalTypes`, `enrichPart` appends that dependency's documented props to the facade and decrements `forwardedCount`, so the published JSON contradicts the documented contract. The public umbrella generator in `packages/internal/src/index.ts` selects `@base-ui/react` by default, so every consumer that forwards a Base UI value through an authored module hits this under the default configuration.

## Reproduction evidence

Observed at `e9ad9b3` by calling `generateApiArtifacts` from `packages/api-artifacts/src/index.ts` on a fixture identical to `dependencyFiles` plus `focusableFacade` in `packages/api-artifacts/test/reexport-facade.test.ts`, plus a resolved local wrapper `src/wrapper.tsx` (`export function Wrapper(props: FocusableProps) { return Focusable(props); }` with a JSDoc line and `"use client"`).

| Part                        | `includeExternalTypes: []`   | `includeExternalTypes: ["dep-aria"]` (current, wrong for facades) | Required after fix with `["dep-aria"]`              |
| --------------------------- | ---------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| `Focusable` (forwarded)     | props `[]`, forwardedCount 2 | props `["isDisabled"]`, forwardedCount 1                          | props `[]`, forwardedCount 2                        |
| `useFocusable` (forwarded)  | props `[]`, forwardedCount 1 | props `["isDisabled"]`, forwardedCount 0                          | props `[]`, forwardedCount 1                        |
| `Wrapper` (resolved, local) | props `[]`, forwardedCount 2 | props `["isDisabled"]`, forwardedCount 1                          | unchanged: props `["isDisabled"]`, forwardedCount 1 |

`children` is never added because its declaration has no JSDoc description, which is why only `isDisabled` appears. The `Wrapper` row is the control: a resolved implementation that accepts dependency props must keep receiving them. Only forwarded values change.

## Current state

Files and roles:

- `packages/api-artifacts/src/checker.ts` — checker-owned facts per part. `PartSource` (line 102) carries source metadata; `partSourceFromInspection` (line 132) builds it from the extractor's `ComponentSourceResult` and currently drops the `resolved`/`forwarded` status. `LibraryPartApi.source` (line 368) exposes it to enrichment.
- `packages/api-artifacts/src/enrichment.ts` — `enrichPart` (line 47) appends documented selected-dependency props and decrements `forwardedCount` (lines 100-107). It has no way to tell a forwarded facade from a resolved wrapper.
- `packages/api-extractor/src/component-sources.ts` — read-only reference for the discriminated union `ComponentSourceResult` (`resolved` | `forwarded` | `unresolved`); do not modify.
- `packages/api-artifacts/src/model.ts` — `ApiPart` (line 19) is the serialized shape; it must not gain a field.
- `packages/internal/src/index.ts` — public generator; line 24 defaults `includeExternalTypes` to `["@base-ui/react"]`.

`PartSource` is exported from `checker.ts` for intra-package use only; `packages/api-artifacts/src/index.ts` does not re-export it, so adding a field to it is a private change.

`packages/api-artifacts/src/checker.ts:102`:

```ts
export type PartSource = {
  /** Repo-relative path of the file that declares the part. */
  sourcePath: string;
  rsc: RscStatus;
  /** Destructuring defaults, keyed by prop name. */
  defaults: ReadonlyMap<string, string>;
};
```

`packages/api-artifacts/src/checker.ts:132`:

```ts
function partSourceFromInspection(
  context: LibraryProject,
  partName: string,
  result: ComponentSourceResult,
  problems: ProblemLog
): PartSource | null {
  if (result.status === "unresolved") {
    problems.add(`${partName}: could not recover the authored implementation (${result.reason})`);
    return null;
  }
  const sourceFile = context.program.getSourceFile(result.filePath);
  if (sourceFile === undefined) {
    problems.add(`${partName}: could not load the authored implementation file (${result.filePath})`);
    return null;
  }
  return {
    sourcePath: path.relative(context.projectRoot, sourceFile.fileName).replaceAll("\\", "/"),
    rsc: readRscStatus(sourceFile),
    defaults: new Map(
      result.status === "resolved" ? result.defaults.map((entry) => [entry.name, entry.initializerText]) : []
    ),
  };
}
```

`packages/api-artifacts/src/checker.ts:363` (the type enrichment receives as `facts`):

```ts
export type LibraryPartApi = {
  /** Display name, e.g. `Dialog.Content`. */
  readonly name: string;
  /** Declaring file of the part's call signature, when it has one. */
  readonly declarationPaths: readonly string[];
  readonly source: PartSource | null;
  readonly forwarded: PartForwarded;
  /** Every prop the part accepts, in checker order, forwarded ones included. */
  readonly props: ReadonlyMap<string, TsSymbol>;
  /** The published rows, or `null` when the part could not be described. */
  readonly part: ApiPart | null;
};
```

`packages/api-artifacts/src/enrichment.ts:55`:

```text
  const root = roots.find((name) => current.name === name || current.name.startsWith(`${name}.`));
  const facts = component.partApis.find((part) => part.name === current.name);
  if (root === undefined || facts === undefined) return current;
  const selected = selectedProps(result, root, current.name);
  if (selected === undefined) return current;
  const names = new Set(current.props.map((prop) => prop.name));
```

`packages/api-artifacts/src/enrichment.ts:100`:

```text
  additions.sort((left, right) => left.name.localeCompare(right.name));
  if (additions.length > current.forwardedCount)
    throw new Error(`${current.name}: selected props exceed forwarded prop count`);
  return {
    ...current,
    props: [...current.props, ...additions],
    forwardedCount: current.forwardedCount - additions.length,
  };
```

`packages/api-extractor/src/component-sources.ts:39` (reference only):

```ts
export const ComponentSourceForwardedSchema = Schema.Struct({
  status: Schema.Literal("forwarded"),
  filePath: Schema.String,
  packageName: Schema.String,
});
```

`packages/api-artifacts/README.md:39`:

```text
A facade that only forwards a dependency's value, through named or `export *` re-export chains, an
exported import binding, or an authored `export const X = DepX` alias, publishes a part with no
props. Its `sourcePath` and `rsc` come from the innermost authored module that forwards the value,
and `forwardedFrom` names the declaring dependency together with the packages that declare the
forwarded props.
```

## Conventions and test pattern

Read root README.md and AGENTS.md before implementation, plus `packages/api-artifacts/README.md`. Match strict typing, kebab-case filenames, separate type imports, `.oxlintrc.json` and `.oxfmtrc.json` (print width 110, double quotes, trailing commas es5). Lint uses `--deny-warnings`. Fix the underlying issue before adding an exception; a necessary next-line disable names one rule with a `--` reason.

Keep dependency direction internal -> api-artifacts -> api-extractor. Internal owns consumer defaults; api-artifacts owns generation policy; api-extractor owns semantic extraction. This fix is artifact policy and stays inside `api-artifacts`. Check mode must not write or create directories. Preserve all existing serialized fields and checker-authoritative printed types, required flags and forwarded counts except where this plan explicitly changes behavior.

Test pattern: `packages/api-artifacts/test/reexport-facade.test.ts` builds a temporary project per test through `projectFixtures` from `test/support/project-fixture.ts` (cleanup runs in `afterEach`), merges the `dependencyFiles` stub package `dep-aria` with authored files through `facade(...)`, and calls `generateApiArtifacts(options(root, [component]))`. `options` returns `{ projectRoot, tsconfigPath: "tsconfig.json", components }`; spread extra generator options onto it, e.g. `{ ...options(root, [focusableComponent]), includeExternalTypes: ["dep-aria"] }`. The shared expected part is:

```ts
const focusablePart = {
  name: "Focusable",
  rsc: "client",
  sourcePath: "src/focusable/focusable.tsx",
  props: [],
  forwardedFrom: ["dep-aria"],
  forwardedCount: 2,
};
```

The stub `dep-aria/index.d.ts` documents `isDisabled` (`/** Whether the element is disabled. */`) and leaves `children` undocumented, which is exactly what makes the selected-dependency case enrich today. Do not remove that documentation to make a test pass.

## Commands you will need

Run from the repository root. Node 24.13.0 (`.node-version`), pnpm 11.20.0 (`packageManager` in root `package.json`). Preserve the pinned TypeScript 7.0.2 and Effect 4.0.0-rc.111 catalog versions.

| Purpose                            | Command                                                                                                            | Expected                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Runtime                            | `node --version && pnpm --version`                                                                                 | `v24.13.0`, `11.20.0`                       |
| Install (if `node_modules` absent) | `pnpm install --frozen-lockfile`                                                                                   | exit 0, no lockfile diff                    |
| Build workspace                    | `pnpm build`                                                                                                       | exit 0                                      |
| Focused facade suite               | `pnpm --filter @elmeragroup/api-artifacts test test/reexport-facade.test.ts`                                       | 1 test file; 10 tests pass at `e9ad9b3`     |
| api-artifacts suite                | `pnpm --filter @elmeragroup/api-artifacts test`                                                                    | 4 files, 31 tests pass at `e9ad9b3`         |
| internal suite                     | `pnpm build && pnpm --filter @elmeragroup/internal test`                                                           | 1 test passes at `e9ad9b3`                  |
| Workspace gate                     | `pnpm ci:checks`                                                                                                   | exit 0                                      |
| Package verification               | `pnpm packages:pack && pnpm test:packed-consumer`                                                                  | exit 0, in that order                       |
| Format check for docs              | `pnpm exec oxfmt --check packages/api-artifacts/README.md plans/001-preserve-forwarded-facades.md plans/README.md` | "All matched files use the correct format." |

Command notes verified during review:

- Do not put `--` before the test path. `pnpm --filter @elmeragroup/api-artifacts test -- test/reexport-facade.test.ts` runs the entire suite (31 tests), so a filter written that way silently proves nothing about the file you meant.
- `pnpm --filter @elmeragroup/internal test` runs vitest directly and does not rebuild. `packages/internal/src/index.ts` dynamically imports `@elmeragroup/api-artifacts`, which resolves to `packages/api-artifacts/dist`, so run `pnpm build` after changing `api-artifacts` sources or the internal test exercises stale code.
- The audit ran focused tests with installed executables because pnpm's pinned-version bootstrap could not fetch signature data. A failed bootstrap is an environment blocker, not evidence that a dependency upgrade is needed. Record it; do not bypass signature validation. Establish the full fresh-build/packed baseline before attributing unrelated failures to this change.

## Scope

Only modify these paths. The changeset file is new; no other new files.

- `packages/api-artifacts/src/checker.ts` — `PartSource` and `partSourceFromInspection` only.
- `packages/api-artifacts/src/enrichment.ts` — `enrichPart` only.
- `packages/api-artifacts/test/reexport-facade.test.ts`
- `packages/internal/test/generate.test.ts`
- `packages/api-artifacts/README.md` — the facade paragraph at line 39 only.
- `.changeset/preserve-forwarded-facades.md` (create)
- `plans/001-preserve-forwarded-facades.md`
- `plans/README.md`

Out of scope, even though related:

- `packages/api-artifacts/src/model.ts` — `ApiPart` is the public JSON shape; no new field.
- `packages/api-artifacts/src/index.ts` — no new exports; `PartSource` stays package-private.
- `packages/api-extractor/**` — `ComponentSourceResult` already carries the status; nothing to change there. If it appears necessary, see STOP conditions.
- `.changeset/forwarded-facade-parts.md` — the existing release note for the facade feature; leave it untouched and add a separate file.
- `packages/internal/src/index.ts` — the `@base-ui/react` default is correct; the internal test must exercise it, not override it.
- Dependency versions, lockfiles, public export maps, upstream fixture `output.json` files, immutable timing evidence, publication credentials.

Build outputs in ignored `dist/`, `.turbo/`, `.cache/`, `.artifacts/` directories are normal verification products, not source changes.

## Git workflow

The advisor branch is `codex/deep-audit-plans`. For implementation, use an isolated branch such as `codex/fix-preserve-forwarded-facades` from the operator's approved base; keep unrelated working changes intact. Do not create a second implementation branch if the operator already supplied one. Do not commit, push, publish or open a PR unless the operator requested that action. If a commit is requested, use a conventional subject such as `fix: keep forwarded facades prop-free during enrichment` (recent history: `Publish Re-Export-Only Facades as Forwarded Parts (#5)`, `chore: version packages (#3)`).

## Steps

### Step 1: Reproduce the contract violation in the facade suite

In `packages/api-artifacts/test/reexport-facade.test.ts`, add a test inside the existing `describe` that builds `facade(focusableFacade)` and calls `generateApiArtifacts({ ...options(root, [focusableComponent]), includeExternalTypes: ["dep-aria"] })`. Assert with `toEqual` that `result.components[0]?.parts` is exactly the same two-element array the first test expects (`focusablePart` and the `useFocusable` part with `forwardedCount: 1`). Reuse the constants; do not copy the object literals with altered values.

Do not change `dependencyFiles`, `focusableFacade`, or `focusablePart`.

**Verify:** `pnpm --filter @elmeragroup/api-artifacts test test/reexport-facade.test.ts`

Expected: 11 tests run, 10 pass, the new one fails on the `toEqual` assertion showing `Focusable` with `props: [{ name: "isDisabled", ... }]` and `forwardedCount: 1`, and `useFocusable` with `props: [{ name: "isDisabled", ... }]` and `forwardedCount: 0`. If it fails for any other reason (import, type, fixture setup), fix the test, not the source, before continuing.

### Step 2: Retain the forwarding status on `PartSource` and honor it in `enrichPart`

In `packages/api-artifacts/src/checker.ts`:

1. Add a readonly discriminator to `PartSource`, for example `readonly origin: "resolved" | "forwarded";` with a one-line JSDoc stating that forwarded values accept only dependency-declared props and are never enriched. Keep the name short and match the extractor's vocabulary (`resolved`/`forwarded`).
2. In `partSourceFromInspection`, populate it from `result.status` in the final `return`. After the `unresolved` early return, `result.status` is exactly `"resolved" | "forwarded"`, so no cast or `SAFETY:` comment is needed.

In `packages/api-artifacts/src/enrichment.ts`, in `enrichPart`, immediately after `if (root === undefined || facts === undefined) return current;` add an early return when `facts.source?.origin === "forwarded"`. It must come before `selectedProps` and before any `readPartPropFact` call so forwarded facades skip type printing entirely. Do not:

- infer forwarding from `current.props.length === 0` or `current.forwardedCount > 0` (the `Wrapper` control in "Reproduction evidence" starts with `props: []` and must still enrich);
- touch `enrichComponents` (warnings must still be collected for facade components);
- alter `forwardedFrom`, `forwardedCount`, or `withForwardedValue`;
- serialize the new field anywhere. `describePart` builds `ApiPart` field by field, so nothing changes there; confirm no `...source` spread is introduced.

**Verify:** `pnpm --filter @elmeragroup/api-artifacts test test/reexport-facade.test.ts`

Expected: 11 tests pass. Then `pnpm --filter @elmeragroup/api-artifacts type-check` exits 0.

### Step 3: Cover every facade form, the resolved control, and the public default

Add to `packages/api-artifacts/test/reexport-facade.test.ts`, each with `includeExternalTypes: ["dep-aria"]`:

1. Extend the existing `it.each` over the three forwarding forms (`export *`, exported import binding, value alias) so each form also runs with selection, asserting `[focusablePart]` — either a second `it.each` or an extra `selected: boolean` dimension; keep the unselected cases.
2. The `Group.Focusable` member case with selection, asserting `{ ...focusablePart, name: "Group.Focusable", sourcePath: "src/focusable/group.tsx" }`.
3. A resolved local wrapper control: `src/wrapper.tsx` containing `"use client";`, an import of `Focusable` and `type FocusableProps` from `dep-aria`, and a JSDoc-documented `export function Wrapper(props: FocusableProps) { return Focusable(props); }`. Assert the part has `sourcePath: "src/wrapper.tsx"`, exactly one prop named `isDisabled` with `origin: { packageName: "dep-aria" }`, `forwardedFrom: ["dep-aria"]`, and `forwardedCount: 1`. This test must pass both before and after Step 2; it exists to prove the fix is keyed on forwarding status, not on empty props.

In `packages/internal/test/generate.test.ts`, add a second `it` next to the existing one, following its `mkdtemp` / `try` / `finally { rm }` shape:

- Write `node_modules/@base-ui/react/package.json` (`{ "name": "@base-ui/react", "version": "0.0.0", "type": "module", "main": "./index.js", "types": "./index.d.ts" }`), `node_modules/@base-ui/react/index.js` (`export function Toggle() {}`), and `node_modules/@base-ui/react/index.d.ts` declaring `export interface ToggleProps { /** Whether the toggle is pressed. */ pressed?: boolean; }` and `export declare function Toggle(props: ToggleProps): null;`. Returning `null` avoids needing React in the fixture.
- Write `src/toggle.tsx` with `"use client";` and `export { Toggle } from "@base-ui/react";`, and `index.ts` with `export { Toggle } from "./src/toggle";`.
- Use a `tsconfig.json` like the api-artifacts fixture: `strict: true`, `types: []`, `module: "ESNext"`, `moduleResolution: "Bundler"`, `skipLibCheck: true`, `include: ["index.ts", "src/**/*.tsx"]`.
- Call the internal `generateApiArtifacts` with `projectRoot`, `tsconfigPath`, `components: [{ slug: "toggle", entryFile: "index.ts", exportNames: ["Toggle"], outputFile: "api.json" }]` and no `includeExternalTypes` key, so the `@base-ui/react` default applies.
- Assert `result.components[0]?.parts` equals `[{ name: "Toggle", rsc: "client", sourcePath: "src/toggle.tsx", props: [], forwardedFrom: ["@base-ui/react"], forwardedCount: 1 }]`.

Update the README paragraph at `packages/api-artifacts/README.md:39` by appending one sentence, for example: "Selecting that dependency through `includeExternalTypes` does not add its documented props to the facade; enrichment applies only to parts with a resolved implementation." Keep the paragraph's existing wrap width.

**Verify:** `pnpm build && pnpm --filter @elmeragroup/api-artifacts test && pnpm --filter @elmeragroup/internal test`

Expected: all api-artifacts tests pass (31 at baseline plus the new cases), internal reports 2 tests passing.

### Step 4: Release note and final gates

Create `.changeset/preserve-forwarded-facades.md`:

```yaml
---
"@elmeragroup/internal": patch
---
```

followed by a short consumer-facing paragraph: `generateApiArtifacts` no longer adds selected dependency props to a re-export-only facade; such parts keep `props: []` and their full `forwardedCount` even when the forwarding dependency (including the default `@base-ui/react`) is listed in `includeExternalTypes`. Only the umbrella package receives a release. Do not version a private workspace or edit package versions or lockfiles.

Then run, in order, and record each result in "Completion notes":

1. `pnpm ci:checks`
2. `pnpm packages:pack && pnpm test:packed-consumer`
3. `git diff --check`
4. `git status --short` and `git diff --name-only` — every changed or new path must appear in Scope.
5. After updating this plan's status and its `plans/README.md` row: `pnpm exec oxfmt --check packages/api-artifacts/README.md plans/001-preserve-forwarded-facades.md plans/README.md`

**Verify:** all five commands exit 0. Do not mark DONE with a failed or skipped required gate.

## Test plan

New cases, all in existing files:

- `packages/api-artifacts/test/reexport-facade.test.ts`: selected `dep-aria` for the named re-export chain (both `Focusable` and `useFocusable`), the three `it.each` forwarding forms, the `Group.Focusable` member, and the resolved `Wrapper` control. Every facade assertion uses `toEqual` against the whole part so a stray prop or changed `forwardedCount` fails.
- `packages/internal/test/generate.test.ts`: public default path with a stub `@base-ui/react`, no `includeExternalTypes` override, whole-part `toEqual`.

Pattern: the existing tests in the same files. Verification: `pnpm --filter @elmeragroup/api-artifacts test test/reexport-facade.test.ts` and `pnpm build && pnpm --filter @elmeragroup/internal test`, all passing. In Step 1 only, the single failure must be the intended `toEqual` assertion. Keep the regressions after the fix; do not replace assertions with snapshots that merely accept current output.

## Done criteria

- [x] With `includeExternalTypes` naming the forwarding dependency, every forwarded facade part has `props: []` and unchanged `sourcePath`, `rsc`, `forwardedFrom`, `forwardedCount`; the resolved `Wrapper` control still gains `isDisabled`.
- [x] `grep -n "origin" packages/api-artifacts/src/model.ts` shows only the pre-existing `ApiPropOrigin`/`origin` prop fields; `ApiPart` gained no field. `grep -n "PartSource" packages/api-artifacts/src/index.ts` returns nothing.
- [x] `pnpm --filter @elmeragroup/api-artifacts test test/reexport-facade.test.ts` exits 0 and the named cases exist.
- [x] `pnpm build && pnpm --filter @elmeragroup/internal test` exits 0 with 2 tests.
- [x] `pnpm ci:checks` exits 0.
- [x] `pnpm packages:pack && pnpm test:packed-consumer` exits 0.
- [x] `git diff --check` exits 0 and changed paths match Scope.
- [x] `.changeset/preserve-forwarded-facades.md` exists with the `@elmeragroup/internal: patch` frontmatter and consumer-facing text; `.changeset/forwarded-facade-parts.md` is unchanged.
- [x] This plan and its `plans/README.md` row reflect the actual completion state; no skipped gate is described as passing.

## STOP conditions

Stop and report, do not improvise, if:

- Preserving the forwarding status appears to require a new field on `ApiPart`, a change to `packages/api-artifacts/src/model.ts`, or any change under `packages/api-extractor/`.
- `partSourceFromInspection` receives `status: "resolved"` for the forwarding fixtures (the Step 1 test then fails differently than described). That is a lower-layer discrepancy in the extractor's source inspection; report it rather than inferring forwarding from paths or `node_modules` segments.
- The excerpts in "Current state" no longer match live code.
- A required check fails twice after one focused, reasonable fix attempt; report environment or pre-existing failures separately from failures this change introduced.
- The internal fixture cannot resolve the stub `@base-ui/react` under the described `tsconfig.json`; report the exact diagnostic instead of adding React or widening `include`.

Never modify immutable evidence, suppress a diagnostic, or weaken a test to obtain a green run.

## Maintenance notes

- Any new enrichment or post-processing pass over `ApiPart`s must check `LibraryPartApi.source.origin` before adding props; the resolved/forwarded distinction is the only signal, since both kinds can start with `props: []`.
- Reviewers should confirm the early return sits before `selectedProps`/`readPartPropFact` (no wasted type printing for facades) and that `enrichComponents` still pushes warnings for facade components.
- The `selected props exceed forwarded prop count` guard in `enrichPart` becomes unreachable for forwarded parts; leave it, it still protects resolved parts.
- Compiler and source-inspection semantics stay in `api-extractor`; this change is private artifact policy in `api-artifacts`.

## Completion notes

Implemented uncommitted on `codex/deep-audit-plans` at base `e9ad9b3` (operator override: no commit).

`PartSource.origin` is `"resolved" | "forwarded"`, copied from `result.status` after the unresolved
early return. `enrichPart` returns the checker part unchanged when `facts.source?.origin ===
"forwarded"`, before `selectedProps` / `readPartPropFact`. `ApiPart` and public exports are
unchanged. `.changeset/forwarded-facade-parts.md` is unchanged.

Step 1: `pnpm --filter @elmeragroup/api-artifacts test test/reexport-facade.test.ts` — 11 tests, 10
passed, new case failed as specified (`Focusable` gained `isDisabled` with `forwardedCount: 1`;
`useFocusable` gained `isDisabled` with `forwardedCount: 0`).

Step 2: same command — 11 passed. `pnpm --filter @elmeragroup/api-artifacts type-check` exit 0.

Step 3: `pnpm build && pnpm --filter @elmeragroup/api-artifacts test && pnpm --filter
@elmeragroup/internal test` — api-artifacts 4 files / 37 tests (31 baseline + 6 new); internal 2
tests.

Gates:

1. `pnpm ci:checks` — first run failed on pre-existing `test/release-version.test.mjs` 5s timeouts
   (`plans only the umbrella release`, `does not release private changes to
@elmeragroup/api-extractor`). Targeted `pnpm test:repo-policy` then passed (31 tests). Second
   `pnpm ci:checks` exit 0 (15 turbo tasks; oxfmt 259 files).
2. `pnpm packages:pack && pnpm test:packed-consumer` — exit 0. Packed
   `@elmeragroup/internal@0.1.0`; consumer declarations and tree-shaking passed.
3. `git diff --check` — exit 0.
4. Changed/new paths match Scope: `checker.ts`, `enrichment.ts`, `reexport-facade.test.ts`,
   `packages/internal/test/generate.test.ts`, `packages/api-artifacts/README.md`,
   `.changeset/preserve-forwarded-facades.md`, this plan, `plans/README.md`. Other `plans/*.md`
   files were already untracked at start.
5. `pnpm exec oxfmt --check` on the three doc files — exit 0 after formatting this plan's
   completion notes.

Deviation: the selected `Group.Focusable` case needed `allowedWarningCodes:
["unsupported-type-fallback"]`. `includeExternalTypes` is what runs `extractModule`; the existing
unselected Group fixture never extracts, so it never sees the extractor fallback on `{ Focusable:
(props: FocusableProps) => ReactNode }`. The part still `toEqual`s `{ ...focusablePart, name:
"Group.Focusable", sourcePath: "src/focusable/group.tsx" }`.
