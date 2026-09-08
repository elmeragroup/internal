# Plan 003: Preserve authored defaults for literal destructuring keys

> Executor instructions: Read this entire plan before editing. Follow each step and its expected verification result. On a STOP condition, report the specific blocker instead of expanding scope. Update this plan's status and its row in plans/README.md when complete, unless a reviewing operator owns those updates.
>
> Drift check: `git diff --stat e9ad9b3..HEAD -- 'packages/api-extractor/src/backend/ts7/node-facts.ts' 'packages/api-extractor/test/component-source.test.ts' 'packages/api-artifacts/test/component-source.test.ts' 'packages/api-extractor/README.md' '.changeset/quoted-prop-defaults.md' 'plans/003-quoted-prop-defaults.md' 'plans/README.md'`
> If implementation files changed, compare the excerpts below to live code. If they no longer match, stop for reconciliation. New plan files alone are expected and do not indicate implementation drift. Also inspect `git status --short` for uncommitted edits before starting.

## Status

- Status: DONE
- Finding: 3 from the deep audit
- Priority: P1
- Effort: S, including regression coverage
- Fix risk: LOW
- Depends on: none
- Category: bug
- Planned at: commit `e9ad9b3`, 2026-09-08
- Reviewed: 2026-09-08 against `e9ad9b3` (excerpts, guard names, test helpers and commands re-verified)
- Confidence: HIGH, reproduced during the audit

## Why this matters

Both backend default readers discard non-identifier property names. A component parameter such as `{ "aria-label": label = "hello", normal = "ok" }` resolves successfully but loses the `aria-label` default in source inspection (`inspectComponentSources` results), in semantic provenance (`defaultInitializer`), and therefore in generated artifact `defaultValue` fields. Generated docs silently omit an authored default. Hyphenated ARIA and data attributes are the common real-world case.

## Current state

Two readers in one file produce binding-default facts. They intentionally differ in what binding target they accept:

- `bindingDefaults` feeds semantic extraction (`parse/component-authorship.ts:37`, `parse/object-resolver.ts:734`). It only accepts a simple identifier binding target, so `options: { enabled } = {}` reports nothing.
- `sourceBindingDefaults` feeds `inspectComponentSources` (`parse/component-source.ts:135`). It also preserves outer-property defaults on nested binding patterns, so `options: { enabled } = {}` reports `options`.

Both readers share the same defect: when `element.propertyName` exists and is not an `Identifier`, the element is dropped. Share property-key recovery between them without merging those different target policies. Native AST inspection must remain inside `src/backend/ts7`.

Relevant files:

- `packages/api-extractor/src/backend/ts7/node-facts.ts` — both readers (lines 351–391); the only implementation change.
- `packages/api-extractor/src/backend/contracts.ts:270-276` — `bindingDefaults` / `sourceBindingDefaults` fact contract (`BackendBindingDefaultFact` = `{ name, initializerText }`). Do not change.
- `packages/api-extractor/src/parse/object-resolver.ts:288-299` — looks up `context.bindingDefaults?.get(info.name)` where `info.name` is the property symbol's name (`aria-label` for a quoted key, `0` for a numeric key). The decoded key must equal that symbol name for the default to attach.
- `packages/api-artifacts/src/checker.ts:447` and `packages/api-artifacts/src/enrichment.ts:94` — artifact `defaultValue` comes from `source.defaults.get(property.name)`; same name-matching requirement.

`packages/api-extractor/src/backend/ts7/node-facts.ts:351`:

```text
function bindingDefaults(
  name: Node | undefined
): readonly { readonly name: string; readonly initializerText: string }[] {
  if (name === undefined || !isObjectBindingPattern(name)) return [];
  return name.elements.flatMap((element) => {
    if (
      !isBindingElement(element) ||
      element.initializer === undefined ||
      element.name === undefined ||
      !isIdentifier(element.name)
    ) {
      return [];
    }
    const propertyName = element.propertyName;
    if (propertyName !== undefined && !isIdentifier(propertyName)) return [];
    return [
      {
        name: propertyName?.text ?? element.name.text,
        initializerText: element.initializer.getText().trim(),
      },
    ];
  });
```

`packages/api-extractor/src/backend/ts7/node-facts.ts:375`:

```text
function sourceBindingDefaults(
  name: Node | undefined
): readonly { readonly name: string; readonly initializerText: string }[] {
  if (name === undefined || !isObjectBindingPattern(name)) return [];
  return name.elements.flatMap((element) => {
    if (!isBindingElement(element) || element.initializer === undefined) return [];
    const propertyName = element.propertyName;
    if (propertyName !== undefined) {
      if (!isIdentifier(propertyName)) return [];
      return [{ name: propertyName.text, initializerText: element.initializer.getText().trim() }];
    }
    if (element.name !== undefined && isIdentifier(element.name)) {
      return [{ name: element.name.text, initializerText: element.initializer.getText().trim() }];
    }
    return [];
  });
```

### Native AST facts (TypeScript 7.0.2, verified)

Type guards come from `typescript/unstable/ast/is`, which `node-facts.ts:3-43` already imports from (`isIdentifier`, `isBindingElement`, `isObjectBindingPattern`, ...). Add to that existing import list; do not add a second import statement or a new module import.

- `BindingElement.propertyName?: PropertyName` where `PropertyName = Identifier | StringLiteral | NoSubstitutionTemplateLiteral | NumericLiteral | ComputedPropertyName | PrivateIdentifier | BigIntLiteral` (`dist/ast/ast.generated.d.ts:986`).
- `isStringLiteral(node): node is StringLiteral` and `isNumericLiteral(node): node is NumericLiteral` are exported from `typescript/unstable/ast/is`. `isComputedPropertyName`, `isPrivateIdentifier`, `isBigIntLiteral`, `isNoSubstitutionTemplateLiteral` also exist but are not needed: everything that is not an identifier, string literal or numeric literal is omitted.
- `StringLiteral.text` and `NumericLiteral.text` (via `LiteralLikeNodeBase.text`) hold the compiler-decoded value: `"aria-label"` and `'aria-label'` both give `aria-label`, with no quotes; a numeric key gives the compiler's normalized numeric text, which matches the property symbol name the checker assigns. Use `.text`; never strip quotes with a regular expression and never evaluate expressions.
- Supported keys are therefore exactly: `Identifier`, `StringLiteral`, `NumericLiteral`. Unsupported keys (`ComputedPropertyName` such as `[key]`, and anything else in the union) are omitted from both readers, as today.

## Conventions and test pattern

Read root README.md and AGENTS.md before implementation, plus `packages/api-extractor/README.md`. Match strict typing, kebab-case filenames, separate type imports, .oxlintrc.json and .oxfmtrc.json (printWidth 110, double quotes, sorted imports). Lint uses --deny-warnings. Fix the underlying issue before adding an exception; in api-extractor no file-wide disable or path override is allowed, and any necessary next-line disable names one rule with a -- reason.

Only src/backend/ts7 may import TypeScript's unstable native API. parse and canonical must stay Effect-free through transitive value imports. Fatal failures remain typed Effect errors; recoverable losses use stable structured warning codes, with prose rendered in src/parse/fallback.ts. Reuse a scoped ProjectExtractor per project and preserve isolated extraction sessions. Never edit upstream output.json or the timing-boundary baseline. Do not refresh reviewed evidence merely to make a check pass.

Three existing helpers cover every assertion this plan needs. Do not add new support files.

1. Source inspection through the public service: `inspectNative(filePath, requests, projectConfig?)` in `packages/api-extractor/test/support/component-source.ts:22`. Its third argument accepts a temporary `tsconfig.json` path.
2. Raw backend facts: `withSession(filePath, (session, draft) => ...)` plus `exportSymbol` and `primaryNode` from the same support file. This is how `component-source.test.ts:101-115` asserts `sourceBindingDefaults` and `bindingDefaults` side by side. Note `withSession` is hard-wired to the fixture project's tsconfig, so it only works for files listed in `test/fixtures/component-source/tsconfig.json`; for temporary projects, use `inspectNative` and `extractFixture` instead.
3. Semantic extraction and provenance: `extractFixture({ tsconfigPath }, filePath)` in `packages/api-extractor/test/support/extract.ts`. Model the provenance assertion after `packages/api-extractor/test/objects.test.ts:167-186`, which finds the exported function, reads `callSignatures[0].parameters[0].name` from the result (do not hardcode the destructured parameter's name) and asserts `expect.objectContaining({ path: [<export>, "callSignatures", "0", "parameters", parameter.name, "properties", <key>], defaultInitializer: <text> })`.

The temporary-project pattern to copy is `component-source.test.ts:576-624` ("distinguishes semicolon-free object return annotations..."): `mkdtemp(resolve(tmpdir(), "component-source-..."))`, write `tsconfig.json` as `JSON.stringify({ compilerOptions: { types: [], strict: true }, include: ["*.ts"] })`, write source files, and `rm(root, { recursive: true, force: true })` in `finally`. `mkdtemp`, `rm`, `writeFile`, `tmpdir`, `resolve` are already imported at the top of that test file.

For the artifact test, `packages/api-artifacts/test/component-source.test.ts` already builds `fixture = projectFixtures({ prefix: "api-artifacts-source-", include: ["**/*.ts", "**/*.tsx"] })` and calls `generateApiArtifacts(options(root, [...]))`. Copy the "recovers nested memo/forwardRef source..." case at lines 10-56: props need a JSDoc description or the checker reports `public prop has no JSDoc description` and fails generation.

## Commands you will need

Run commands from the repository root. Use Node 24.13.0 from .node-version and pnpm 11.20.0 from package.json (`packageManager`). Preserve the pinned TypeScript 7.0.2 and Effect 4.0.0-rc.111 catalog versions.

- Check runtime: `node --version` should report v24.13.0; `pnpm --version` should report 11.20.0.
- If dependencies are absent: `pnpm install --frozen-lockfile` must exit 0 without a lockfile diff. Do not upgrade dependencies to unblock installation.
- Prepare the baseline: `pnpm build` (turbo) must exit 0. `@elmeragroup/api-artifacts` resolves `@elmeragroup/api-extractor` through its `dist/` exports, and `pnpm --filter <pkg> test` runs vitest directly without turbo's build dependency, so the extractor must be rebuilt before any api-artifacts test can observe the fix.
- Focused extractor regression: `pnpm --filter @elmeragroup/api-extractor test -- test/component-source.test.ts`.
- Focused artifact regression: `pnpm --filter @elmeragroup/api-artifacts test -- test/component-source.test.ts`.
- Package tests: `pnpm --filter @elmeragroup/api-extractor test` must exit 0.
- Extractor evidence gate: `pnpm --filter @elmeragroup/api-extractor check:all` must exit 0 (format, lint, build, type-check, tests, catalog, boundary, fixtures, conformance, timing).
- Workspace gate: `pnpm ci:checks` must exit 0.
- Package verification: `pnpm packages:pack && pnpm test:packed-consumer` must exit 0, in that order.
- Formatting for edited markdown: `pnpm exec oxfmt --check packages/api-extractor/README.md .changeset/quoted-prop-defaults.md plans/003-quoted-prop-defaults.md plans/README.md`.

The audit ran focused tests with installed executables because pnpm's pinned-version bootstrap could not fetch signature data. A failed bootstrap is an environment blocker, not evidence that a dependency upgrade is needed. Record it; do not bypass signature validation. The audit did not run a complete fresh-build/packed baseline, so establish it before attributing unrelated failures to this change.

## Scope

Only modify these paths. No new files other than the changeset.

- `packages/api-extractor/src/backend/ts7/node-facts.ts`
- `packages/api-extractor/test/component-source.test.ts`
- `packages/api-artifacts/test/component-source.test.ts`
- `packages/api-extractor/README.md`
- `.changeset/quoted-prop-defaults.md` (create)
- `plans/003-quoted-prop-defaults.md`
- `plans/README.md`

Everything else is out of scope, including `packages/api-extractor/src/backend/contracts.ts` (the fact shape does not change), `src/parse/**` (the lookup by symbol name already works once the key is decoded), test support files under `test/support/`, the fixture project `test/fixtures/component-source/**` and its `tsconfig.json`, dependency versions, lockfiles, unrelated source refactors, public export maps, upstream fixture output.json files, immutable timing evidence and publication credentials. Build outputs in ignored dist/.cache/.artifacts directories are normal verification products, not source changes.

## Git workflow

The advisor branch is `codex/deep-audit-plans`. For implementation, use an isolated branch such as `codex/fix-quoted-prop-defaults` from the operator's approved base; keep unrelated working changes intact. Do not create a second implementation branch if the operator already supplied one. Do not commit, push, publish or open a PR unless the operator requested that action. If a commit is requested, use a conventional subject such as `fix: preserve authored defaults for literal destructuring keys` (recent history mixes PR-title merges with `fix:`/`feat:`/`docs:`/`chore:` subjects).

## Steps

### Step 1: Add literal-key regression coverage in the extractor

In `packages/api-extractor/test/component-source.test.ts`, inside `describe("component source native inspection", ...)`, add one `it` using the temporary-project pattern from lines 576-624. Write one source file, for example `literal-keys.ts`:

```text
export type Props = {
  "aria-label"?: string;
  "data-id"?: string;
  0?: string;
  plain?: string;
  alias?: string;
};
export function LiteralKeys({
  "aria-label": label = "hello",
  'data-id': id = "escaped",
  0: zero = "z",
  plain = "ok",
  alias: renamed = "aliased",
}: Props) {
  return [label, id, zero, plain, renamed];
}
export function ComputedKey({ ["dyn" as string]: value = "never" }: Record<string, string>) {
  return value;
}
```

Assert, in this order:

1. `inspectNative(file, [{ exportName: "LiteralKeys" }, { exportName: "ComputedKey" }], config)` returns `[{ status: "resolved", filePath: file, defaults: [ { name: "aria-label", initializerText: '"hello"' }, { name: "data-id", initializerText: '"escaped"' }, { name: "0", initializerText: '"z"' }, { name: "plain", initializerText: '"ok"' }, { name: "alias", initializerText: '"aliased"' } ] }, { status: "resolved", filePath: file, defaults: [] }]`. Names are decoded (no quotes, escape resolved); `initializerText` is the authored initializer verbatim including its quotes. If the compiler's normalized text for the `0` key differs from `"0"`, STOP and report rather than guessing.
2. `extractFixture({ tsconfigPath: config }, file)` provenance contains `expect.objectContaining({ path: ["LiteralKeys", "callSignatures", "0", "parameters", parameter.name, "properties", "aria-label"], defaultInitializer: '"hello"' })` and the same for `data-id` / `'"escaped"'` and `plain` / `'"ok"'`, following `objects.test.ts:167-186` for how `parameter.name` is read from the result. Import `extractFixture` from `./support/extract.ts` (add a separate import line; the formatter orders imports).
3. Nothing in the returned provenance has `defaultInitializer: '"never"'` (the computed key stays unguessed), modeled on `substitution-fallback.test.ts:442`.

Do not touch the existing "preserves nested outer-property defaults separately from semantic binding defaults" case; it is the control that nested-binding policy is unchanged.

**Verify:** `pnpm --filter @elmeragroup/api-extractor test -- test/component-source.test.ts`

Expected: exactly the new test fails, on the `defaults` / provenance assertions for `aria-label`, `data-id` and `0` (the current code omits them). Every pre-existing test in the file passes. A compile, import, tsconfig or fixture-setup error is not the intended failure; fix the test before proceeding.

### Step 2: Recover supported literal keys at the backend boundary

In `packages/api-extractor/src/backend/ts7/node-facts.ts`:

1. Add `isNumericLiteral` and `isStringLiteral` to the existing `from "typescript/unstable/ast/is"` import list (alphabetical, the formatter will confirm).
2. Add one small module-private helper next to the two readers, shaped like:

```text
/** The property key a binding element destructures, when it is an identifier or a literal the checker names the same way. */
function bindingPropertyKey(propertyName: Node): string | undefined {
  if (isIdentifier(propertyName) || isStringLiteral(propertyName) || isNumericLiteral(propertyName)) {
    return propertyName.text;
  }
  return undefined;
}
```

3. In `bindingDefaults`, replace `if (propertyName !== undefined && !isIdentifier(propertyName)) return [];` and the `propertyName?.text ?? element.name.text` expression so the name becomes the helper result when `propertyName` is defined (returning `[]` when the helper returns `undefined`) and `element.name.text` otherwise. Keep the existing `element.name === undefined || !isIdentifier(element.name)` guard exactly as it is: semantic defaults still require a simple identifier target.
4. In `sourceBindingDefaults`, replace `if (!isIdentifier(propertyName)) return [];` + `propertyName.text` with the helper in the same way. Keep the nested-target behavior: when `propertyName` is defined, the target may be any binding pattern; when it is undefined, the target must be an identifier.

No other file changes. Do not evaluate initializers, add regular-expression quote stripping, change `BackendBindingDefaultFact`, or move logic into `src/parse/**`.

**Verify:** `pnpm --filter @elmeragroup/api-extractor test -- test/component-source.test.ts`

Expected: all tests in the file pass, including the Step 1 case and the unchanged nested-binding control.

### Step 3: Verify artifact output and document supported keys

1. Rebuild the extractor so the artifacts package sees the fix: `pnpm --filter @elmeragroup/api-extractor build`.
2. In `packages/api-artifacts/test/component-source.test.ts`, add an `it` inside the existing `describe("component implementation source", ...)` modeled on lines 10-56. Source, for example `labelled.tsx`:

```text
export type LabelledProps = {
  /** Accessible name. */
  "aria-label"?: string;
  /** Visible label. */
  label?: string;
};
export function Labelled({ "aria-label": ariaLabel = "hello", label = "ok" }: LabelledProps) {
  return [ariaLabel, label];
}
```

Generate with `options(root, [{ slug: "labelled", entryFile: "labelled.tsx", exportNames: ["Labelled"], outputFile: "docs/labelled/api.json" }])` and assert `result.components[0]?.parts[0]?.props` contains `{ name: "aria-label", origin: "declared", type: "string | undefined", shortType: null, defaultValue: '"hello"', description: "Accessible name.", required: false }` (use `expect.arrayContaining([expect.objectContaining({...})])` if prop ordering is not obvious; the existing tests use `toEqual` on the full list, which is also acceptable once the order is observed).

Finally, in `packages/api-extractor/README.md`, extend the `inspectComponentSources` paragraph (lines 34-36, the sentence beginning "`inspectComponentSources(filePath, requests)` recovers authored implementation files and destructuring defaults") with one sentence stating that defaults are reported for identifier, string-literal and numeric-literal keys under the decoded property name (`"aria-label": x = 1` reports `aria-label`), and that computed keys are omitted rather than guessed. Keep the paragraph's wrapping style; `oxfmt --check` must pass.

**Verify:** `pnpm --filter @elmeragroup/api-artifacts test -- test/component-source.test.ts && pnpm exec oxfmt --check packages/api-extractor/README.md`

Expected: the new artifact case passes with `defaultValue: '"hello"'` for `aria-label`; the existing wrapper, overload and nested-binding cases still pass; the README formatting check exits 0.

### Step 4: Complete the release note and final gates

Create `.changeset/quoted-prop-defaults.md` (naming follows `.changeset/forwarded-facade-parts.md`):

```text
---
"@elmeragroup/internal": patch
---

`generateApiArtifacts` and the extractor's `inspectComponentSources` now preserve destructuring defaults authored under string-literal or numeric-literal property keys, such as `{ "aria-label": label = "hello" }`. The default is reported under the decoded property name (`aria-label`), so generated `defaultValue` fields and extraction provenance no longer omit it. Computed keys are still omitted rather than guessed.
```

Only the umbrella package receives a release. Do not version a private workspace or edit package versions/lockfiles.

Run, in order: `pnpm --filter @elmeragroup/api-extractor check:all`, `pnpm ci:checks`, `pnpm packages:pack && pnpm test:packed-consumer`. Then inspect `git diff --check`, `git diff --name-only` and `git status --short`; every changed source/document must be in Scope. Update this plan's Status and Completion notes and the row in `plans/README.md`, then run `pnpm exec oxfmt --check plans/003-quoted-prop-defaults.md plans/README.md .changeset/quoted-prop-defaults.md`. Do not mark DONE with a failed or skipped required gate.

**Verify:** `git diff --check`

Expected: exit 0; all preceding final commands exit 0. Record the actual commands/results in the completion notes, including any blocked check.

## Test plan

Extractor (`packages/api-extractor/test/component-source.test.ts`, one temporary project, no fixture edits):

- Positive: quoted key `"aria-label"`, escaped key `'data-id'` decoded to `data-id`, numeric key `0`, ordinary shorthand `plain`, ordinary alias `alias: renamed`. Assert both `inspectNative` defaults and `extractFixture` provenance `defaultInitializer` carry the authored initializer text with its quotes.
- Negative: computed key `["dyn" as string]` produces no default in either API.
- Control: the existing nested-binding test keeps `sourceBindingDefaults` exposing `options` while `bindingDefaults` omits it.

Artifacts (`packages/api-artifacts/test/component-source.test.ts`, `projectFixtures`): a documented `"aria-label"` prop whose serialized `defaultValue` is `'"hello"'`.

Run the focused extractor command after Step 1 (only the intended assertions fail) and after Step 2 (all pass), then the focused artifacts command after rebuilding the extractor in Step 3. Keep the regressions after the fix; do not replace assertions with snapshots that merely accept current output.

## Done criteria

- [x] Both readers in `node-facts.ts` use one shared key helper accepting `Identifier`, `StringLiteral` and `NumericLiteral`; each keeps its own binding-target policy; computed keys are omitted.
- [x] `pnpm --filter @elmeragroup/api-extractor test -- test/component-source.test.ts` exits 0 and contains the quoted, escaped, numeric, shorthand, alias and computed-key cases plus the provenance assertion.
- [x] `pnpm --filter @elmeragroup/api-artifacts test -- test/component-source.test.ts` exits 0 after an extractor rebuild and contains the `aria-label` `defaultValue` case.
- [x] `pnpm --filter @elmeragroup/api-extractor check:all` exits 0.
- [x] `pnpm ci:checks` exits 0.
- [x] `pnpm packages:pack && pnpm test:packed-consumer` exits 0.
- [x] `git diff --check` exits 0, and `git diff --name-only` lists only Scope paths; `git status --short` shows no other tracked or untracked source changes.
- [x] `.changeset/quoted-prop-defaults.md` exists with the `"@elmeragroup/internal": patch` frontmatter and the consumer-facing description.
- [x] `packages/api-extractor/README.md` documents literal-key support and the computed-key limitation; `pnpm exec oxfmt --check` passes on every edited markdown file.
- [x] This plan and its index row reflect the actual completion state; no skipped gate is described as passing.

## STOP conditions

Stop and report if:

- `isStringLiteral` or `isNumericLiteral` is not exported from `typescript/unstable/ast/is`, or `.text` on those nodes is not the decoded value (for example still carries quotes). Both were verified against TypeScript 7.0.2 at planning time.
- The compiler's normalized text for a numeric key does not match the property symbol name used by `object-resolver.ts:292` and `checker.ts:447` (the Step 1 `0` assertion would fail after Step 2). Report the observed text; do not add a numeric-normalization layer.
- The implementation excerpts above no longer match `node-facts.ts` (drift).
- The `pnpm run check:boundary` step of `check:all` fails after the change; that means native AST types leaked past `src/backend/ts7`.
- Any fixture `output.json`, `timing-boundary.json` or conformance evidence would need to change to pass a check.
- The fix appears to require editing `backend/contracts.ts`, `src/parse/**`, test support files or the fixture project.
- A required check fails twice after a focused, reasonable fix attempt. Report pre-existing or environment failures separately.

Never modify immutable evidence, suppress a diagnostic, or weaken a test just to obtain a green run.

## Maintenance notes

- Keep the two default readers' different binding-target policies. Literal key recovery may be shared; semantic handling of nested bindings is not part of this fix.
- Reviewers should confirm the only `node-facts.ts` changes are the two added import names, the new helper and the two call sites, and that no `.replace(/["']/...)`-style quote stripping was introduced.
- If a later plan supports computed keys or bigint keys, it must show the checker's property symbol name agrees with the recovered key; that name-matching contract (`object-resolver.ts:292`, `checker.ts:447`) is what makes decoded literal keys work here.
- Plan 004 also adds cases to `packages/api-artifacts/test/component-source.test.ts`; land them sequentially to avoid conflicting edits (see plans/README.md).

## Completion notes

Implemented uncommitted on `codex/deep-audit-plans` at HEAD `9ab963c` (operator override: stay on
this branch; no commit, no staging). Runtime: Node v24.13.0, pnpm 11.20.0. Drift check vs `e9ad9b3`
touched only this plan and `plans/README.md`; live `node-facts.ts` excerpts matched.

`bindingPropertyKey` accepts `Identifier`, `StringLiteral`, and `NumericLiteral` via `.text`.
`bindingDefaults` still requires an identifier target; `sourceBindingDefaults` still accepts nested
targets when `propertyName` is defined. Computed keys remain omitted. Numeric key `0` reports `"0"`.

Step 1: `pnpm --filter @elmeragroup/api-extractor test -- test/component-source.test.ts` ran the
full extractor suite (vitest did not isolate the file through that `--` form). 628 passed, 1 failed:
the new case omitted `aria-label`, `data-id`, and `0`; nested-binding control passed.

Step 2: helper and both call sites. Isolated
`pnpm --filter @elmeragroup/api-extractor exec vitest run test/component-source.test.ts` — 16
passed, including the literal-key case and nested-binding control.

Step 3: `pnpm --filter @elmeragroup/api-extractor build` exit 0.
`pnpm --filter @elmeragroup/api-artifacts exec vitest run test/component-source.test.ts` — 11
passed (`aria-label` `defaultValue: '"hello"'`).
`pnpm exec oxfmt --check packages/api-extractor/README.md` exit 0.

Gates:

1. `pnpm --filter @elmeragroup/api-extractor check:all` — exit 0 (format, lint, build, type-check,
   629 tests, catalog 141/116, boundary clear, fixtures pass, conformance pass, timing go).
2. `pnpm ci:checks` — first run failed on pre-existing `test/release-version.test.mjs` 5s timeout
   (`does not release private changes to @elmeragroup/api-extractor`). Second `pnpm ci:checks`
   exit 0 (15 turbo tasks; oxfmt 261 files; repo-policy 31 tests).
3. `pnpm packages:pack && pnpm test:packed-consumer` — exit 0. Packed
   `@elmeragroup/internal@0.1.0`; consumer declarations and tree-shaking passed.
4. `git diff --check` — exit 0. Tracked `git diff --name-only` paths are in Scope. Untracked
   `.changeset/quoted-prop-defaults.md` is also in Scope. Ignored build products under `dist/`,
   `.turbo/`, `.cache/`, `.artifacts/` were produced by verification.
5. `pnpm exec oxfmt --check` on `packages/api-extractor/README.md`,
   `.changeset/quoted-prop-defaults.md`, `plans/README.md`, and this plan — exit 0.
