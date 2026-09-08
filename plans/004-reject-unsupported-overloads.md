# Plan 004: Reject unsupported multiple call signatures before generating artifacts

> Executor instructions: Read this entire plan before editing. Follow each step and confirm its expected verification result before moving on. On a STOP condition, report the specific blocker instead of expanding scope. Update this plan's completion notes and its row in plans/README.md when complete, unless a reviewing operator owns those updates.
>
> Drift check (run first): `git diff --stat e9ad9b3..HEAD -- packages/api-artifacts/src/checker.ts packages/api-artifacts/test/component-source.test.ts packages/api-artifacts/README.md .changeset/reject-unsupported-overloads.md`
> If any listed file changed, compare the "Current state" excerpts below with the live code. If they no longer match, STOP for reconciliation. Plan 001 also edits `checker.ts`; if it has landed, re-read `extractPart` in full before continuing. Also inspect `git status --short` for uncommitted edits before starting.

## Status

- Status: DONE
- Finding: 4 from the deep audit
- Priority: P1
- Effort: M, including regression coverage
- Fix risk: MED
- Depends on: none (coordinate with 001 and 003, which touch the same two files)
- Category: bug
- Planned at: commit `e9ad9b3`, 2026-09-08
- Confidence: HIGH, reproduced during the audit

## Why this matters

`extractPart` in `packages/api-artifacts/src/checker.ts` reads `signatures[0]` from the checker and ignores every other call signature. For a component declared with two or more public overloads, the published artifact silently drops props accepted only by later overloads and marks first-overload-only props as universally required. The flat `ApiPart.props` list cannot describe alternative call contracts, so this plan does not invent a merging policy. It fails generation with a named, actionable diagnostic whenever a requested part exposes more than one checker-visible call signature, before any artifact is written. A single public overload declaration plus its implementation exposes exactly one call signature and stays supported.

## Current state

Files and roles:

- `packages/api-artifacts/src/checker.ts` — checker-backed part discovery and prop extraction. `callSignature` (line 214) is used both as a callable-existence test during discovery (`componentPartRequests`, lines 307 and 314) and as the signature source in `extractPart` (line 466). `describePart` (line 384) adds the existing `no call signature` problem when it receives `null`.
- `packages/api-artifacts/src/generate.ts` — `describeComponent` (line 107) calls `extractPart` once per discovered part; `generateApiArtifacts` fails the whole inventory when `problems` is non-empty (line 144), before enrichment and before any write.
- `packages/api-artifacts/src/errors.ts` — `ProblemLog` (`add(message)`, `problems` getter) and `ApiArtifactsError`, whose message is `API artifact generation failed:\n` followed by the problems joined by newlines.
- `packages/api-artifacts/test/component-source.test.ts` — the regression suite for implementation-source behavior; it already contains the single-overload control test (line 113) and a "no write on failure" test (line 276).
- `packages/api-artifacts/README.md` — package documentation; the paragraph starting at line 33 describes call-signature and implementation behavior and is where the new limitation belongs.

`packages/api-artifacts/src/checker.ts:214-217`:

```text
function callSignature(checker: Checker, type: Type): Signature | null {
  const signatures = checker.getSignaturesOfType(type, SignatureKind.Call);
  return signatures[0] ?? null;
}
```

`packages/api-artifacts/src/checker.ts:466-484` (the start of `extractPart`; the function continues to line 505 and ends by returning `{ name, declarationPaths, source, forwarded, props, part: describePart(...) }`):

```text
export function extractPart(
  context: LibraryProject,
  request: PartRequest,
  sourceResult: ComponentSourceResult,
  problems: ProblemLog
): LibraryPartApi {
  const source = partSourceFromInspection(context, request.name, sourceResult, problems);
  const { checker } = context;
  const signature = callSignature(checker, request.type);
  const declarationPaths = signature?.declaration === undefined ? [] : [signature.declaration.path];
  const parameter = signature?.getParameters()[0];
  const declared = parameter === undefined ? undefined : checker.getTypeOfSymbol(parameter);
  const propsType = declared === undefined || declared.isErrorType() ? null : declared;
  const props = new Map<string, TsSymbol>();
  if (propsType !== null) {
    for (const property of checker.getPropertiesOfType(propsType)) {
      props.set(property.name, property);
    }
  }
```

`packages/api-artifacts/src/checker.ts:485-488` (how the zero-prop case builds `forwarded`; reuse this exact call in the early return):

```text
  const forwarded = withForwardedValue(
    props.size === 0 ? emptyForwarded : forwardedOfProps(context, props.values()),
    sourceResult
  );
```

`packages/api-artifacts/src/checker.ts:363-373` (the return type; every field is required):

```text
export type LibraryPartApi = {
  readonly name: string;
  readonly declarationPaths: readonly string[];
  readonly source: PartSource | null;
  readonly forwarded: PartForwarded;
  readonly props: ReadonlyMap<string, TsSymbol>;
  readonly part: ApiPart | null;
};
```

`packages/api-artifacts/src/generate.ts:144-146`:

```text
          if (problems.problems.length > 0) {
            return yield* Effect.fail(new ApiArtifactsError(problems.problems));
          }
```

Existing problem-message style in `checker.ts` (match it: `<part name>: <what> — <why or hint>`):

```text
problems.add(`${request.name}: no call signature — it does not look like a component`);
problems.add(`${request.name}: props type is unresolvable`);
```

Why the count excludes the implementation: TypeScript exposes only the overload declarations as call signatures of a function with overloads; the implementation signature is not part of the type. `export function X(props: P): R` followed by `export function X({ ... }: P) { ... }` therefore has one call signature, which is what the existing control test at `component-source.test.ts:113` relies on. Two overload declarations plus an implementation expose two.

React wrappers stay supported: in `packages/api-artifacts/node_modules/@types/react/index.d.ts`, `ExoticComponent` (line 570) and `FunctionComponent` (line 1060) each declare exactly one call signature, and `ForwardRefExoticComponent`/`MemoExoticComponent` extend them without adding one. The existing `memo`/`forwardRef` tests in `component-source.test.ts` are the guard for this.

## Conventions and test pattern

Read root `README.md` and `AGENTS.md` before implementation, plus `packages/api-artifacts/README.md`. Match strict typing, kebab-case filenames, separate type imports, `.oxlintrc.json` and `.oxfmtrc.json`. Lint runs with `--deny-warnings`. Fix the underlying issue before adding a lint exception.

Keep the dependency direction internal -> api-artifacts -> api-extractor. Check mode must not write or create directories. Generation must validate the whole inventory before writing and must not prune other files. Preserve all existing serialized fields and checker-authoritative printed types, required flags and forwarded counts except where this plan explicitly changes behavior.

Test conventions in `packages/api-artifacts/test/component-source.test.ts`:

- Each test creates a temporary project with `fixture({ "file.ts": "source" })` from `./support/project-fixture.ts` and calls `generateApiArtifacts(options(root, [{ slug, entryFile, exportNames, outputFile }]))`.
- Failures are asserted as `await expect(generateApiArtifacts(...)).rejects.toThrow(/<Part>: <message> \(<reason>\)/u)` — see lines 261-274.
- No-write-on-failure is asserted by generating a valid artifact first, overwriting it with `"keep me\n"`, re-running with a failing second component, and reading the file back — see lines 276-325 (`does not write artifacts when source inspection cannot recover an implementation`). Model the mixed-inventory test on it.
- The single-overload control test is `uses the implementation of an overload with a semicolon-free object return type` at lines 113-155. Do not modify it; it must keep passing.
- Check-mode no-write assertions live in `packages/api-artifacts/test/generate.test.ts:88-103` (`mode: "check"`, `stat(dir)` rejects with `ENOENT`). That file is out of scope; reproduce the `stat` pattern inside `component-source.test.ts` if you add a check-mode case.

## Commands you will need

Run commands from the repository root. Use Node 24.13.0 from `.node-version` and pnpm 11.20.0 from `package.json` `packageManager`. Preserve the pinned TypeScript 7.0.2 and Effect 4.0.0-rc.111 catalog versions in `pnpm-workspace.yaml`.

| Purpose                   | Command                                                                                                                                                         | Expected on success                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Runtime check             | `node --version && pnpm --version`                                                                                                                              | `v24.13.0` and `11.20.0`                             |
| Install (only if missing) | `pnpm install --frozen-lockfile`                                                                                                                                | exit 0, no lockfile diff                             |
| Baseline build            | `pnpm build`                                                                                                                                                    | exit 0 (tests import the built `api-extractor` dist) |
| Focused regression        | `pnpm --filter @elmeragroup/api-artifacts exec vitest run test/component-source.test.ts`                                                                        | all tests in the file pass                           |
| Package type-check        | `pnpm --filter @elmeragroup/api-artifacts type-check`                                                                                                           | exit 0                                               |
| Package tests             | `pnpm --filter @elmeragroup/api-artifacts test`                                                                                                                 | exit 0                                               |
| Lint                      | `pnpm lint`                                                                                                                                                     | exit 0                                               |
| Workspace gate            | `pnpm ci:checks`                                                                                                                                                | exit 0                                               |
| Package verification      | `pnpm packages:pack && pnpm test:packed-consumer`                                                                                                               | exit 0, in that order                                |
| Formatting of edited docs | `pnpm exec oxfmt --check packages/api-artifacts/README.md .changeset/reject-unsupported-overloads.md plans/004-reject-unsupported-overloads.md plans/README.md` | "All matched files use the correct format."          |

The audit ran focused tests with installed executables because pnpm's pinned-version bootstrap could not fetch signature data. A failed bootstrap is an environment blocker, not evidence that a dependency upgrade is needed. Record it; do not bypass signature validation. The audit did not run a complete fresh-build/packed baseline, so establish it (`pnpm build` then the package tests) before attributing unrelated failures to this change.

## Scope

**In scope** (the only files you may modify; the changeset file is created):

- `packages/api-artifacts/src/checker.ts`
- `packages/api-artifacts/test/component-source.test.ts`
- `packages/api-artifacts/README.md`
- `.changeset/reject-unsupported-overloads.md`
- `plans/004-reject-unsupported-overloads.md`
- `plans/README.md`

**Out of scope** (do not touch, even though they look related):

- `packages/api-artifacts/src/enrichment.ts:37` reads `type.callSignatures[0]` from the extractor model. It runs only after the `problems` check in `generate.ts`, so a rejected part never reaches it. Leave it.
- `componentPartRequests` discovery in `checker.ts` (lines 278-333). It must keep treating any type with at least one call signature as a part, so that an overloaded export reaches `extractPart` and gets the named diagnostic instead of disappearing or producing `no renderable parts were found`.
- `packages/api-extractor/**` — semantic overload extraction is correct there and is not the problem.
- `packages/api-artifacts/test/generate.test.ts` and `reexport-facade.test.ts` — put the new cases in `component-source.test.ts` only.
- `packages/api-artifacts/src/model.ts` — no schema change; no opt-out option is added to `GenerateApiArtifactsOptions`.
- Dependency versions, lockfiles, public export maps, upstream fixture `output.json` files, timing evidence, workflows and publication credentials. Build outputs in ignored `dist/`, `.cache/`, `.artifacts/` and `.turbo/` directories are normal verification products.

## Git workflow

The advisor branch is `codex/deep-audit-plans`. For implementation, use an isolated branch such as `codex/fix-reject-unsupported-overloads` from the operator's approved base; keep unrelated working changes intact. Do not create a second implementation branch if the operator already supplied one. Do not commit, push, publish or open a PR unless the operator requested that action. If a commit is requested, use a conventional subject such as `fix: reject unsupported multiple call signatures before generating artifacts` (recent history uses `fix:`, `chore:` and `docs:` prefixes).

## The diagnostic

Use this exact message shape everywhere (implementation, tests, README, changeset). `N` is the actual count of call signatures the checker returns for the part's type:

```text
<part name>: <N> call signatures — API artifacts describe one public props contract; keep one public overload
```

Example: `Overloaded: 2 call signatures — API artifacts describe one public props contract; keep one public overload`.

## Steps

### Step 1: Pin the fail-closed contract with a failing regression test

In `packages/api-artifacts/test/component-source.test.ts`, inside the existing `describe("component implementation source", ...)`, add a test named `rejects a part with more than one public call signature` using this fixture:

```ts
"render.ts": `"use client";
export type LabelProps = {
  /** Visible label. */
  label: string;
};
export type IconProps = {
  /** Icon name. */
  icon: string;
};
export function Overloaded(props: LabelProps): { type: "span"; props: { children: string }; key: null };
export function Overloaded(props: IconProps): { type: "span"; props: { children: string }; key: null };
export function Overloaded(props: LabelProps | IconProps) {
  return { type: "span", props: { children: "label" in props ? props.label : props.icon }, key: null };
}
`,
"entry.ts": `export { Overloaded } from "./render.ts";`,
```

Request `{ slug: "overloaded", entryFile: "entry.ts", exportNames: ["Overloaded"], outputFile: "docs/overloaded/api.json" }` and assert:

```ts
).rejects.toThrow(/Overloaded: 2 call signatures — API artifacts describe one public props contract/u);
```

Two overload declarations plus one implementation is exactly two call signatures; do not count the implementation. The existing test at line 113 is the single-signature control; do not add another.

**Verify:** `pnpm --filter @elmeragroup/api-artifacts exec vitest run test/component-source.test.ts`

Expected: exactly one failure, the new test, and its failure is the assertion (generation currently resolves successfully using the first overload). If the failure is a compile, import or fixture-setup error, fix the test, not the implementation.

### Step 2: Validate signature cardinality in `extractPart` before reading props

In `packages/api-artifacts/src/checker.ts`, change `extractPart` so that it queries the checker once and rejects more than one signature before touching parameters. Target shape (replace the two lines `const signature = callSignature(checker, request.type);` and the following `declarationPaths` line):

```ts
const signatures = checker.getSignaturesOfType(request.type, SignatureKind.Call);
if (signatures.length > 1) {
  problems.add(
    `${request.name}: ${signatures.length} call signatures — API artifacts describe one public props contract; keep one public overload`
  );
  return {
    name: request.name,
    declarationPaths: [],
    source,
    forwarded: withForwardedValue(emptyForwarded, sourceResult),
    props: new Map<string, TsSymbol>(),
    part: null,
  };
}
const signature = signatures[0] ?? null;
const declarationPaths = signature?.declaration === undefined ? [] : [signature.declaration.path];
```

Rules:

- Keep `partSourceFromInspection` as the first statement so source-inspection problems are still recorded alongside the new one.
- Return early; do not call `describePart` for a rejected part, otherwise it would add a second, misleading `no call signature` problem.
- Zero signatures and one signature keep the existing path unchanged (`signatures[0] ?? null` reproduces `callSignature`'s behavior).
- Leave `callSignature` and its two discovery call sites untouched, or, if you prefer one helper, keep discovery semantics as "at least one call signature". Do not make discovery reject overloads.
- Do not flatten or union the overload parameter types.

**Verify:** `pnpm --filter @elmeragroup/api-artifacts exec vitest run test/component-source.test.ts` → all tests pass, including the Step 1 test and the untouched single-overload control at line 113. Then `pnpm --filter @elmeragroup/api-artifacts type-check` → exit 0.

### Step 3: Complete the regression matrix

Add these tests to `component-source.test.ts`, following the Step 1 shape:

1. `rejects an overloaded namespace member`: `export function Item(...)` with two overloads plus implementation and `export const Menu = { Item };` in `menu.ts`; request `exportNames: ["Menu"]`; assert `/Menu\.Item: 2 call signatures — /u`. This proves discovery still finds the member and the diagnostic uses the dotted part name.
2. `rejects an overload without a props parameter`: overloads `export function Toggle(): R;` and `export function Toggle(props: ToggleProps): R;` plus implementation; assert `/Toggle: 2 call signatures — /u`.
3. `does not write artifacts when another part has multiple call signatures`: copy the structure of lines 276-325 — generate a valid `Button` artifact, overwrite it with `"keep me\n"`, re-run with the valid `Button` plus the overloaded component from Step 1, assert the rejection, and assert `readFile(output)` is still `"keep me\n"`. Additionally assert that `stat(path.join(root, "docs/overloaded"))` rejects with `{ code: "ENOENT" }` (import `stat` from `node:fs/promises`; the file already imports `readFile` and `writeFile`).
4. `rejects multiple call signatures in check mode without creating directories`: same fixture as Step 1 with `{ ...options(root, [...]), mode: "check" }`; assert the rejection and that `stat(path.join(root, "docs"))` rejects with `{ code: "ENOENT" }`.

**Verify:** `pnpm --filter @elmeragroup/api-artifacts exec vitest run test/component-source.test.ts` → all pass, five new tests total. Then `pnpm --filter @elmeragroup/api-artifacts test` → exit 0.

### Step 4: Document the limitation

In `packages/api-artifacts/README.md`, extend the paragraph that starts at line 33 (`Each part's \`sourcePath\`, \`rsc\`, and prop \`defaultValue\` come from the authored implementation...`) or add a short paragraph directly after it stating: a part must expose exactly one public call signature; one overload declaration plus its implementation is one signature and is supported; two or more overload declarations fail generation with `<part>: <N> call signatures — API artifacts describe one public props contract; keep one public overload`, because the flat props list cannot represent alternative required sets. Do not describe an opt-out; none exists.

**Verify:** `pnpm exec oxfmt --check packages/api-artifacts/README.md` → "All matched files use the correct format."

### Step 5: Add the release note and run the final gates

Create `.changeset/reject-unsupported-overloads.md`, matching the existing `.changeset/forwarded-facade-parts.md` format:

```markdown
---
"@elmeragroup/internal": patch
---

`generateApiArtifacts` now fails with `<part>: <N> call signatures — API artifacts describe one public props contract; keep one public overload` when a requested part declares more than one public call signature, instead of silently publishing only the first overload's props and required flags. One overload declaration plus its implementation remains supported.
```

Only the umbrella package receives a release. Do not version a private workspace or edit package versions or lockfiles.

Then run, in order: `pnpm lint`, `pnpm ci:checks`, `pnpm packages:pack && pnpm test:packed-consumer`, `git diff --check`, `git diff --name-only`, `git status --short`. Every changed path must be in Scope. Update this plan's completion notes and the `plans/README.md` row, then run the formatting command from the table on the edited documents. Do not mark DONE with a failed or skipped required gate.

**Verify:** `git diff --check` → exit 0; every preceding command exits 0; `git diff --name-only` lists only in-scope paths.

## Test plan

New tests in `packages/api-artifacts/test/component-source.test.ts` (five):

- Two disjoint documented overloads plus implementation → rejected with the exact message and count 2 (Step 1).
- Overloaded namespace member → rejected as `Menu.Item` (Step 3.1).
- Overload without a props parameter → rejected (Step 3.2).
- Mixed inventory with one valid component → existing artifact untouched, no output directory for the rejected part (Step 3.3).
- Check mode → rejected without creating `docs/` (Step 3.4).

Preserved existing tests: the single-overload control at line 113 and the `memo`/`forwardRef` tests at the top of the file must pass unchanged; they prove the count excludes the implementation and that React wrapper types keep one signature.

Not covered here, deliberately: a forwarded dependency value with multiple declared overloads. It flows through the same `extractPart` path, so the policy applies uniformly, but the stub-package fixture lives in the out-of-scope `reexport-facade.test.ts`. See Maintenance notes.

Do not replace assertions with snapshots that merely accept current output.

## Done criteria

- [x] `grep -n "signatures\[0\] ?? null" packages/api-artifacts/src/checker.ts` matches only inside `callSignature` (discovery) or the post-cardinality line in `extractPart`; `extractPart` no longer calls `callSignature` before checking `signatures.length > 1`.
- [x] `pnpm --filter @elmeragroup/api-artifacts exec vitest run test/component-source.test.ts` exits 0 with five new tests present.
- [x] `pnpm --filter @elmeragroup/api-artifacts type-check` and `pnpm lint` exit 0.
- [x] `pnpm ci:checks` exits 0.
- [x] `pnpm packages:pack && pnpm test:packed-consumer` exits 0.
- [x] `git diff --check` exits 0 and `git diff --name-only` lists only in-scope paths.
- [x] `.changeset/reject-unsupported-overloads.md` exists with `"@elmeragroup/internal": patch` frontmatter.
- [x] `packages/api-artifacts/README.md` documents the one-call-signature rule and the exact diagnostic.
- [x] This plan's completion notes and the `plans/README.md` status row reflect the actual completion state; no skipped gate is described as passing.

## STOP conditions

Stop and report (do not improvise) if:

- The excerpts in "Current state" do not match the live code (drift, or plan 001 landed first and changed `extractPart`).
- After Step 2, the single-overload control test (line 113) or any `memo`/`forwardRef` test fails with the new diagnostic. That means the pinned compiler or `@types/react` exposes more than one call signature for a supported shape. Report the part name and the signatures' declaration paths; do not special-case by filename, component name or package.
- A caller or consumer requires merged overload support rather than a rejection.
- A required check fails twice after a focused, reasonable fix attempt.
- The fix appears to need an out-of-scope file, including `enrichment.ts` or `generate.ts`.

Report pre-existing or environment failures separately (for example the pnpm bootstrap issue). Never modify immutable evidence, suppress a diagnostic, or weaken a test to obtain a green run.

## Maintenance notes

- Full overload support is deferred. It needs a separate artifact-model decision covering alternative required sets, shared types, provenance and forwarded counts. This plan only makes the limitation explicit.
- Reviewers should confirm the early return in `extractPart` happens before `getParameters()` is called and that `describePart` is not reached for rejected parts (no duplicate `no call signature` problem in the error output).
- If plan 001 changes how `forwarded` is computed for facades, the early return's `withForwardedValue(emptyForwarded, sourceResult)` must follow the same rule.
- Follow-up outside this plan: add an overloaded forwarded-dependency case to `reexport-facade.test.ts` using its `dependencyFiles` stub package, to pin that forwarded parts get the same diagnostic.

## Completion notes

Implemented uncommitted on `codex/deep-audit-plans` at HEAD `3c5ae7a` (operator override: stay on
this branch; no commit, no staging). Runtime: Node v24.13.0, pnpm 11.20.0. Drift vs `e9ad9b3`
touched `packages/api-artifacts/src/checker.ts`, `packages/api-artifacts/test/component-source.test.ts`,
and `packages/api-artifacts/README.md` from plans 001 and 003. Live `extractPart` still began with
`partSourceFromInspection` then `callSignature`; `callSignature` and `LibraryPartApi` bodies were
unchanged. Line numbers shifted; operator noted that is not a STOP.

`extractPart` now queries `getSignaturesOfType` once and, when `signatures.length > 1`, records
`<part>: <N> call signatures — API artifacts describe one public props contract; keep one public overload`
and returns early with empty `declarationPaths`, empty `props`, `part: null`, and
`withForwardedValue(emptyForwarded, sourceResult)`. `describePart` is not reached. Zero and one
signature keep the previous path via `signatures[0] ?? null`. `callSignature` and discovery are
unchanged.

Step 1: `pnpm --filter @elmeragroup/api-artifacts exec vitest run test/component-source.test.ts` —
12 tests, 1 failed: `rejects a part with more than one public call signature` (promise resolved
using the first overload's `label` prop).

Step 2: cardinality check in `extractPart`. Same command — 12 passed, including the new test, the
single-overload control, and `memo`/`forwardRef` cases. `pnpm --filter @elmeragroup/api-artifacts
type-check` exit 0.

Step 3: four additional tests. Focused command — 16 passed (five new).
`pnpm --filter @elmeragroup/api-artifacts test` — 4 files, 43 tests.

Step 4: README paragraph after the implementation-source paragraph.
`pnpm exec oxfmt --check packages/api-artifacts/README.md` — "All matched files use the correct format."

Step 5: `.changeset/reject-unsupported-overloads.md` with `"@elmeragroup/internal": patch`.

Gates:

1. `grep -n "signatures\\[0\\] ?? null" packages/api-artifacts/src/checker.ts` — line 219
   (`callSignature`) and line 491 (post-cardinality in `extractPart`). `extractPart` does not call
   `callSignature`.
2. `pnpm lint` — 0 warnings, 0 errors.
3. `pnpm ci:checks` — first run failed on pre-existing `test/release-version.test.mjs` 5s timeout
   (`plans only the umbrella release`). Second `pnpm ci:checks` exit 0 (15 turbo tasks).
4. `pnpm packages:pack && pnpm test:packed-consumer` — exit 0.
5. `git diff --check` exit 0. Changed paths are the six in-scope files.

No skipped gate is described as passing. No out-of-scope files.
