# Plan 008: Require a structural recipe-to-props connection

> Executor instructions: Read this entire plan before editing. Follow each step and its expected verification result. On a STOP condition, report the specific blocker instead of expanding scope. Update this plan's status and its row in plans/README.md when complete, unless a reviewing operator owns those updates.
>
> Drift check: `git diff --stat e9ad9b3..HEAD -- 'packages/oxlint-plugin/rules/enforce-variant-standard.js' 'packages/oxlint-plugin/rules/enforce-variant-standard.test.js' 'packages/internal/README.md' '.changeset/structural-variant-props.md' 'plans/008-structural-variant-props.md' 'plans/README.md'`
> If implementation files changed, compare the excerpts below to live code. If they no longer match, stop for reconciliation. New plan files alone are expected and do not indicate implementation drift. Also inspect `git status --short` for uncommitted edits before starting.

## Status

- Status: TODO
- Finding: 8 from the deep audit
- Priority: P2
- Effort: M, including regression coverage
- Fix risk: MED
- Depends on: none
- Category: bug
- Planned at: commit `e9ad9b3`, 2026-09-08
- Reviewed: 2026-09-08 against `e9ad9b3` (commands, AST field names and test filter behavior verified by running them)
- Confidence: HIGH, reproduced during the audit

## Why this matters

The `elmera/enforce-variant-standard` rule requires component files that define a `tv()` recipe with variant axes to type their props with `VariantProps<typeof recipe>`. The current check is `context.sourceCode.getText().includes("VariantProps")`: any occurrence of that substring anywhere in the file satisfies it, including a comment, an unused import, a string literal, or a `VariantProps<typeof someOtherRecipe>` reference that has nothing to do with the recipe in question. A recipe with axes can therefore be completely disconnected from the component's props while lint passes. After this plan, the rule accepts the requirement only when the file contains a real, local type connection: an imported `VariantProps` helper applied to `typeof <that recipe binding>`, reachable from an exported props type or from a function parameter annotation.

## Current state

The rule limits itself to `src/components/<name>/<name>.tsx` (component entry) and `src/components/<name>/<name>-variants.ts` (recipe module), collects `tv(...)` calls, and checks naming, inline-object and `defaultVariants` policies per call. Only component entries require `VariantProps`. Those filename, naming and `defaultVariants` policies stay unchanged. The rule is plain JavaScript with JSDoc types, uses `defineRule`/`createOnce` from `@oxlint/plugins`, and has no scope analysis or cross-file knowledge. Keep it that way: the fix works on one file's ESTree (with TypeScript-ESTree type nodes, which Oxlint's JS plugin runtime does deliver for `.tsx`; verified below).

Files:

- `packages/oxlint-plugin/rules/enforce-variant-standard.js` — the rule (136 lines). The textual check is at lines 123–132.
- `packages/oxlint-plugin/rules/enforce-variant-standard.test.js` — RuleTester suite (4 valid, 2 invalid cases). Uses `createRuleTester("tsx")` from `packages/oxlint-plugin/rule-tester.js`.
- `packages/oxlint-plugin/index.js` — registers the rule as `enforce-variant-standard` in the `elmera` plugin. Do not change it.
- `packages/internal/README.md` — the published package README. It currently contains no per-rule documentation, only an Oxlint configuration example (lines 40–52). See Step 4 before touching it.

`packages/oxlint-plugin/rules/enforce-variant-standard.js:60-77`:

```text
export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce tv recipe structure: named recipe, variants/defaultVariants on recipes with axes, VariantProps typing",
    },
    messages: {
      unnamedRecipe: "tv() recipes must be assigned to a named const (e.g. buttonVariants).",
      inlineObject: "tv() must receive an inline object.",
      missingDefaultVariants:
        "tv() recipe '{{name}}' must declare defaultVariants when it has a variants axis.",
      missingVariantProps:
        "Component files that define a tv() recipe with axes must type props with VariantProps<typeof recipe>.",
    },
    schema: [],
  },
  defaultOptions: [],
```

`packages/oxlint-plugin/rules/enforce-variant-standard.js:78-96` (per-file state and visitors):

```text
  createOnce(context) {
    let shouldCheck = false;
    let requireVariantProps = false;
    /** @type {import("estree").CallExpression[]} */
    const tvCalls = [];

    return {
      Program() {
        const filename = context.filename;
        shouldCheck = isComponentEntry(filename) || isVariantsModule(filename);
        requireVariantProps = isComponentEntry(filename);
        tvCalls.length = 0;
      },
      CallExpression(node) {
        if (!shouldCheck || !isTvCall(node.callee)) return;
        tvCalls.push(node);
      },
      "Program:exit"() {
        if (!shouldCheck || tvCalls.length === 0) return;
```

`packages/oxlint-plugin/rules/enforce-variant-standard.js:123-132` (the defect):

```text
        const anyHasAxes = tvCalls.some((call) => {
          const arg = call.arguments[0];
          return arg?.type === "ObjectExpression" && recipeHasAxes(arg);
        });
        if (requireVariantProps && anyHasAxes && !context.sourceCode.getText().includes("VariantProps")) {
          context.report({
            loc: tvCalls[0]?.loc,
            messageId: "missingVariantProps",
          });
        }
```

The `named` recipe binding is computed at lines 99–101 as `parent?.type === "VariableDeclarator" && parent.id.type === "Identifier" ? parent.id.name : null`. Reuse that identity (the `VariableDeclarator` node or its `id.name`) as the recipe key for the new check.

### Verified AST shapes (Oxlint 1.78.0, `lang: "tsx"`)

These were confirmed by running a probe rule through `RuleTester` at the planned-at commit. Use these exact field names; they differ from typescript-eslint in places (`typeArguments`, not `typeParameters`).

- Type-node visitors fire like any other selector: `TSTypeReference`, `TSTypeQuery`, `TSTypeAliasDeclaration`, `TSInterfaceDeclaration`, `TSIntersectionType`. Every node has `.parent`.
- `ImportSpecifier`: `imported.name`, `local.name`, `importKind` is `"type"` for `import { type X }` and `"value"` otherwise. The enclosing `ImportDeclaration` has `source.value` and `importKind` (`"type"` for `import type { X }`). Treat either kind as an import.
- `TSTypeReference`: `typeName` (`Identifier` with `.name`, or `TSQualifiedName` with `left`/`right`), `typeArguments: TSTypeParameterInstantiation | null` with `.params: TSType[]`.
- `TSTypeQuery` (the `typeof x` type): `exprName` is an `Identifier` with `.name` for `typeof buttonVariants`.
- `TSTypeAliasDeclaration`: `id.name`, `typeAnnotation` (a `TSType`), `typeParameters`. Exported when `parent.type === "ExportNamedDeclaration"`.
- `TSInterfaceDeclaration`: `id.name`, `extends: TSInterfaceHeritage[]` where each heritage has `expression` (an `Identifier` with `.name` for a local name) and `typeArguments`. Exported when `parent.type === "ExportNamedDeclaration"`.
- `TSIntersectionType`: `types: TSType[]`.
- Function parameters: `params[0].typeAnnotation.typeAnnotation` is the `TSType` (for example a `TSTypeReference`). This applies to `FunctionDeclaration`, `FunctionExpression` and `ArrowFunctionExpression`, including a function expression passed to `memo(...)`/`forwardRef(...)`.
- `context.sourceCode.getScope(node)` exists but is not needed here; do not introduce scope analysis.

## Conventions and test pattern

Read root README.md and AGENTS.md before implementation, plus the affected package README where present. Match strict typing, kebab-case filenames, separate type imports, .oxlintrc.json and .oxfmtrc.json. Lint uses --deny-warnings. Fix the underlying issue before adding an exception; in api-extractor no file-wide disable or path override is allowed, and any necessary next-line disable names one rule with a -- reason.

Keep both lint implementations private and bundled through internal's explicit lint entries. Use the existing defineRule/createOnce and RuleTester patterns; clear per-file mutable state in Program. This rule is JavaScript: annotate helpers with JSDoc (`@param {import("estree").Node} node`) as the existing helpers at lines 22–58 do. Lint entries must not load TypeScript or Effect, so no `typescript` import and no type checker. Keep the header attribution comment on line 1 (`Adapted from kumo lint/enforce-variant-standard.js (MIT, ...)`).

Use this existing test pattern from `packages/oxlint-plugin/rules/enforce-variant-standard.test.js:47-69`. Cases are `{ name, filename, code, errors? }`; `component` is `"packages/ui/src/components/button/button.tsx"` and `variants` is `"packages/ui/src/components/button/button-variants.ts"` (lines 5–6):

```text
  invalid: [
    {
      name: "recipe with axes missing defaultVariants",
      filename: variants,
      code: `import { tv } from "tailwind-variants";
export const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
});
`,
      errors: [{ messageId: "missingDefaultVariants" }],
    },
    {
      name: "component file with axes missing VariantProps",
      filename: component,
      code: `import { tv } from "tailwind-variants";
const buttonVariants = tv({
  variants: { size: { sm: "text-sm" } },
  defaultVariants: { size: "sm" },
});
`,
      errors: [{ messageId: "missingVariantProps" }],
    },
  ],
```

## Commands you will need

Run commands from the repository root. Use Node 24.13.0 from .node-version and pnpm 11.20.0 from package.json. Preserve the pinned TypeScript 7.0.2 and Effect 4.0.0-rc.111 catalog versions.

- Check runtime: `node --version` should report v24.13.0; `pnpm --version` should report 11.20.0.
- If dependencies are absent: `pnpm install --frozen-lockfile` must exit 0 without a lockfile diff. Do not upgrade dependencies to unblock installation.
- Prepare the baseline: `pnpm build` must exit 0. This ensures workspace exports point to current compiled code before consumer tests.
- Focused regression command: `pnpm --filter @elmeragroup/oxlint-plugin test rules/enforce-variant-standard.test.js`. At the planned-at commit this reports `Test Files 1 passed (1)` and `Tests 6 passed (6)`. Do not insert `--` before the filename: `pnpm ... test -- rules/...` forwards the literal `--` to vitest and runs all 12 files (190 tests), which hides whether this suite was actually exercised.
- Package tests: `pnpm --filter @elmeragroup/oxlint-plugin test` must exit 0 (12 files, 190 tests before this plan; more tests after).
- Workspace gate: `pnpm ci:checks` must exit 0. This runs `oxfmt --check` over the whole repository (including `.changeset/*.md` and `plans/*.md`) and then `turbo run ci:checks`.
- Package verification: `pnpm packages:pack && pnpm test:packed-consumer` must exit 0, in that order. Note that `test/packed-consumer/lint.mjs` only exercises `no-tailwind-dark-variant` and `no-reflect-get`; it proves the bundled lint entry still loads, not this rule's behavior. The rule's behavior is proven by the RuleTester suite.

The audit ran focused tests with installed executables because pnpm's pinned-version bootstrap could not fetch signature data. A failed bootstrap is an environment blocker, not evidence that a dependency upgrade is needed. Record it; do not bypass signature validation. The audit did not run a complete fresh-build/packed baseline, so establish it before attributing unrelated failures to this change.

## Scope

Only modify these paths.

- `packages/oxlint-plugin/rules/enforce-variant-standard.js`
- `packages/oxlint-plugin/rules/enforce-variant-standard.test.js`
- `packages/internal/README.md` (optional; see Step 4)
- `.changeset/structural-variant-props.md` (create)
- `plans/008-structural-variant-props.md`
- `plans/README.md`

Do not create new helper modules; the helpers belong in the rule file next to `getObjectProp`/`recipeHasAxes`. Everything else is out of scope, including `packages/oxlint-plugin/index.js`, `packages/oxlint-plugin/rule-tester.js`, `packages/oxlint-anti-slop/**` (a separate TypeScript package; do not import its helpers across packages), dependency versions, lockfiles, unrelated source refactors, public export maps, upstream fixture output.json files, immutable timing evidence and publication credentials. Build outputs in ignored dist/.cache/.artifacts directories are normal verification products, not source changes.

## Git workflow

The advisor branch is `codex/deep-audit-plans`. For implementation, use an isolated branch such as `codex/fix-structural-variant-props` from the operator's approved base; keep unrelated working changes intact. Do not create a second implementation branch if the operator already supplied one. Do not commit, push, publish or open a PR unless the operator requested that action. If a commit is requested, use a conventional subject such as `fix: require a structural recipe-to-props connection`.

## Accepted and rejected forms (the specification)

Definitions, all local to the file being linted:

- A **recipe** is a named `tv({...})` call whose first argument is an inline object with axes (`recipeHasAxes` returns true), assigned via `const <name> = tv(...)`. Recipes without axes, unnamed recipes and non-inline recipes are not subject to the props requirement (they keep their existing diagnostics).
- The **helper** is the `VariantProps` export of `"tailwind-variants"`, imported into this file under any local name: `import { VariantProps } from "tailwind-variants"`, `import type { VariantProps } from ...`, `import { type VariantProps as VP } from ...`. Record the set of local names. A `VariantProps` name that is not imported from `"tailwind-variants"` (not imported at all, imported from another module, or declared locally as a type alias) is not the helper.
- A type node **proves** recipe `R` when it is a `TSTypeReference` whose `typeName` is an `Identifier` in the helper local-name set and whose `typeArguments.params[0]` is a `TSTypeQuery` whose `exprName` is an `Identifier` named `R`. Anything else (a `TSQualifiedName` like `TV.VariantProps`, a missing type argument, `typeof otherRecipe`, `typeof recipe.slot`) does not prove `R`.
- A type node **reaches** a proof when: it proves `R` directly; it is a `TSIntersectionType` and any member reaches a proof; or it is a `TSTypeReference` with an `Identifier` `typeName` and no type arguments that names a local `TSTypeAliasDeclaration` or `TSInterfaceDeclaration`, and that declaration reaches a proof. A type alias reaches through its `typeAnnotation`; an interface reaches through each `extends[i]` heritage, treating an `Identifier` `expression` with no `typeArguments` as a reference to a local declaration, or, when the heritage has `typeArguments`, checking whether the heritage expression is a helper name and its first type argument is `typeof R` (this is `interface Props extends VariantProps<typeof buttonVariants> {}`). Traversal is bounded: keep a visited set of declaration nodes and never revisit; stop at any name that is a type parameter declared on an enclosing `TSTypeAliasDeclaration`/`TSInterfaceDeclaration`/function (walk `.parent` and inspect `typeParameters.params[i].name.name`), because such a name shadows the module-level declaration. Do not follow anything else (no mapped types, conditional types, indexed access, `Omit<...>`/`Pick<...>` wrappers, or imported types).
- A **contract root** is one of: (a) a `TSTypeAliasDeclaration` or `TSInterfaceDeclaration` whose `parent.type === "ExportNamedDeclaration"`; (b) a declaration whose name appears in an `ExportNamedDeclaration` specifier list (`export { ButtonProps }` or `export type { ButtonProps }`, with `specifiers[i].local.name`); (c) the first parameter annotation (`params[0].typeAnnotation.typeAnnotation`) of any `FunctionDeclaration`, `FunctionExpression` or `ArrowFunctionExpression` anywhere in the file. Form (c) covers `export function Button(props: ButtonProps)`, `const Button = (props: Props) => ...`, and `export const Button = memo(function Inner(props: Props) {...})`/`forwardRef<HTMLButtonElement, Props>((props, ref) => ...)` when the callback's first parameter is annotated. Parameter annotations on destructured parameters (`({ size, ...rest }: Props)`) live at the same `params[0].typeAnnotation` location and count.
- A recipe `R` is **covered** when at least one contract root reaches a proof of `R`. A local, unexported alias `type Base = VariantProps<typeof buttonVariants>` that no contract root reaches does not cover `R`.

Deliberately unsupported (report as `missingVariantProps`; also list them in the rule header comment so the next maintainer sees the boundary): `forwardRef<E, Props>` generic type arguments without a parameter annotation; `React.FC<Props>`/`ComponentProps` annotations on a variable rather than a parameter; namespace imports (`import * as TV`); `typeof recipe` behind `Parameters<...>`/`ReturnType<...>`/indexed access; recipes or props types imported from another file.

## Steps

### Step 1: Replace textual expectations with structural regressions

Extend `packages/oxlint-plugin/rules/enforce-variant-standard.test.js`. Keep every existing case unchanged. Every new case uses `filename: component` unless stated otherwise, and every recipe below has axes and `defaultVariants` so only the props check is in play.

Add these invalid cases, each with `errors: [{ messageId: "missingVariantProps" }]` (exactly one error):

1. `comment only` — recipe plus `// props should use VariantProps<typeof buttonVariants>`; no import.
2. `unused import only` — `import { tv, type VariantProps } from "tailwind-variants";` plus recipe; no type uses it.
3. `string literal only` — recipe plus `const label = "VariantProps";`.
4. `different recipe` — two recipes `buttonVariants` and `iconVariants`, `export type ButtonProps = VariantProps<typeof buttonVariants>;`, nothing for `iconVariants`.
5. `unused local alias` — `type Base = VariantProps<typeof buttonVariants>;` not exported and not used by any parameter, plus `export function Button(props: { size?: string }) { return null; }`.
6. `helper not from tailwind-variants` — `import type { VariantProps } from "./types";` plus `export type ButtonProps = VariantProps<typeof buttonVariants>;`.
7. `locally declared VariantProps` — `type VariantProps<T> = { size?: string };` plus `export type ButtonProps = VariantProps<typeof buttonVariants>;`.
8. `generic shadowing` — `import type { VariantProps } from "tailwind-variants";`, `type Base = VariantProps<typeof buttonVariants>;`, `export type ButtonProps<Base> = Base & { children?: string };` (the type parameter `Base` shadows the alias, so the exported contract does not reach the proof).
9. `alias cycle` — `import type { VariantProps } from "tailwind-variants";`, `type A = B; type B = A;`, `export type ButtonProps = A;`. Expect one `missingVariantProps` and no hang.

Add these valid cases (no `errors`):

1. `exported alias` — `import { tv, type VariantProps } from "tailwind-variants";` and `export type ButtonProps = VariantProps<typeof buttonVariants>;`.
2. `exported intersection` — `export type ButtonProps = React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>;` (leave `React` unimported; the rule does not resolve it).
3. `exported interface extends helper` — `export interface ButtonProps extends VariantProps<typeof buttonVariants> { children?: string }`.
4. `interface extends local alias` — `type Base = VariantProps<typeof buttonVariants>;` and `export interface ButtonProps extends Base {}`.
5. `import type alias name` — `import type { VariantProps as VP } from "tailwind-variants";` and `export type ButtonProps = VP<typeof buttonVariants>;`.
6. `parameter annotation through alias chain` — `type Base = VariantProps<typeof buttonVariants>; type Props = Base & { children?: string }; export function Button(props: Props) { return null; }` (no exported type at all).
7. `memo callback parameter` — `type Props = VariantProps<typeof buttonVariants>; export const Button = memo(function Inner(props: Props) { return null; });`.
8. `export specifier list` — `type ButtonProps = VariantProps<typeof buttonVariants>; export type { ButtonProps };`.
9. `two recipes both covered` — `buttonVariants` and `iconVariants`, `export type ButtonProps = VariantProps<typeof buttonVariants> & VariantProps<typeof iconVariants>;`.
10. `recipe module is exempt` — `filename: variants`, recipe with axes and `defaultVariants`, no `VariantProps` anywhere. (The existing valid case `recipe with axes declares variants and defaultVariants` already covers this; keep it and do not duplicate unless you rename it for clarity.)

**Verify:** `pnpm --filter @elmeragroup/oxlint-plugin test rules/enforce-variant-standard.test.js`

Expected: exit code 1. Vitest reports `Test Files 1 failed (1)`. The failing cases are exactly the new invalid cases 1–9 (each fails with "Should have 1 error but had 0" or the RuleTester equivalent) because the substring check accepts them. All valid cases pass, including the new ones (the current check accepts any file containing `VariantProps`). Any other failure (syntax error in a template literal, import failure, timeout) is a test-authoring mistake to fix before continuing.

### Step 2: Collect the file's type facts during traversal

In `packages/oxlint-plugin/rules/enforce-variant-standard.js`, add per-file collections next to `tvCalls` and reset them in `Program()`:

- `helperNames: Set<string>` — local names bound to `VariantProps` from `"tailwind-variants"`. Fill from an `ImportDeclaration` visitor: when `node.source.value === "tailwind-variants"`, for each `ImportSpecifier` whose `imported.type === "Identifier"` and `imported.name === "VariantProps"`, add `specifier.local.name`. Accept both `importKind` values.
- `typeDeclarations: Map<string, TSTypeAliasDeclaration | TSInterfaceDeclaration>` — module-level type declarations by name. Fill from `TSTypeAliasDeclaration` and `TSInterfaceDeclaration` visitors. Only record declarations whose `parent` is `Program` or an `ExportNamedDeclaration` whose parent is `Program`; a duplicate name keeps the first (TypeScript merges interfaces, but this rule only needs one path to a proof; if either declaration reaches a proof, treat the name as reaching it — simplest is to store an array per name and check all).
- `contractRoots: Array<{ node: TSType, kind: "exported-declaration" | "export-specifier" | "parameter" }>` — filled from: exported declarations (check `parent.type === "ExportNamedDeclaration"` in the two declaration visitors and push the alias `typeAnnotation` or the interface node itself); `ExportNamedDeclaration` with `declaration === null` (record `specifiers[i].local.name` into an `exportedNames: Set<string>`; resolve them against `typeDeclarations` at `Program:exit`); and `FunctionDeclaration`, `FunctionExpression`, `ArrowFunctionExpression` visitors that push `params[0]?.typeAnnotation?.typeAnnotation` when present.

Write three pure helpers with JSDoc, placed before `export default defineRule`:

- `provesRecipe(typeNode, helperNames)` → returns the recipe name string when `typeNode` is a `TSTypeReference` with `typeName.type === "Identifier"`, `helperNames.has(typeName.name)`, and `typeArguments?.params[0]?.type === "TSTypeQuery"` with `exprName.type === "Identifier"`; returns `null` otherwise.
- `isShadowedTypeName(name, fromNode)` → walks `fromNode.parent` up to `Program`; returns true if any ancestor has `typeParameters?.params` containing a parameter whose `name.name === name`.
- `collectProvenRecipes(typeNode, ctx, visited, out)` → adds recipe names to `out: Set<string>` following the "reaches" definition above: direct proof; `TSIntersectionType` members; `TSTypeReference` with `Identifier` `typeName`, no `typeArguments`, not shadowed, resolved via `ctx.typeDeclarations`, with each resolved declaration added to `visited` before recursion (this is the cycle guard for the alias-cycle case). For `TSInterfaceDeclaration`, iterate `extends`: if `heritage.expression.type === "Identifier"` and `heritage.typeArguments` is null, resolve it as a local declaration name; if it has `typeArguments` and `helperNames.has(heritage.expression.name)` and `typeArguments.params[0]` is a `TSTypeQuery` with an `Identifier` `exprName`, add that name.

Do not use `context.sourceCode.getText()` for anything in the new code path.

**Verify:** `pnpm --filter @elmeragroup/oxlint-plugin test rules/enforce-variant-standard.test.js`

Expected: still exit code 1 with the same nine failing cases as Step 1 (collection has no effect until Step 3 wires it in). This confirms the visitors and helpers introduce no crashes: no case may fail with a thrown error or a message other than the expected error-count mismatch.

### Step 3: Enforce coverage and preserve existing policies

In `"Program:exit"`, replace lines 123–132 with:

1. Compute `axesRecipes`: for each `tvCalls` entry that is named (same `named` computation as lines 99–101) and whose first argument is an `ObjectExpression` with `recipeHasAxes`, record `{ name, node }`. Recipes rejected by `unnamedRecipe`/`inlineObject` are excluded, exactly as today's `anyHasAxes` would count them but today's report location and message are unchanged for them; the simplest faithful behavior is to exclude unnamed/non-inline recipes from the props requirement since they already receive a diagnostic.
2. If `!requireVariantProps || axesRecipes.length === 0`, return.
3. Compute `proven: Set<string>` by running `collectProvenRecipes` over every contract root (exported declarations, export-specifier names resolved through `typeDeclarations`, parameter annotations), with a fresh `visited` set per root.
4. Find the first `axesRecipes` entry whose `name` is not in `proven`. If one exists, report once: `context.report({ node: entry.node, messageId: "missingVariantProps" })`. Report at most one `missingVariantProps` per file, at the first uncovered recipe's `tv()` call, so files with two uncovered recipes still yield exactly one diagnostic (this keeps the existing invalid case's `errors` array length stable and matches the "different recipe" test, which expects one error).

Do not change `unnamedRecipe`, `inlineObject`, `missingDefaultVariants`, their messages, or the filename predicates. Keep the `missingVariantProps` message text unchanged. Clear every new collection in `Program()`.

Update the header comment (lines 1–5 area) with a short block listing the accepted structural forms and the deliberately unsupported forms from the specification section, so the boundary is visible to the next maintainer. Also update `meta.docs.description` only if it becomes inaccurate (it currently says "VariantProps typing", which remains true).

**Verify:** `pnpm --filter @elmeragroup/oxlint-plugin test rules/enforce-variant-standard.test.js`

Expected: exit 0, `Test Files 1 passed (1)`, and the test count equals 6 plus the number of cases you added (at least 24 if all listed cases are present). Then run `pnpm --filter @elmeragroup/oxlint-plugin test` and expect exit 0 with 12 files passing and 190 plus your new cases.

### Step 4: Documentation, release note and final gates

Documentation: `packages/internal/README.md` has no per-rule section; its only lint content is the configuration example at lines 40–52. Do not add a per-rule section for this one rule. The accepted-forms documentation lives in the rule file's header comment (Step 3). Leave the README untouched unless the operator explicitly asks for consumer-facing rule docs; if they do, add at most one sentence under the configuration example and coordinate with plan 007, which may edit the same file.

Create `.changeset/structural-variant-props.md` following the shape of `.changeset/forwarded-facade-parts.md`:

```yaml
---
"@elmeragroup/internal": patch
---
```

followed by one short paragraph, for example: "`elmera/enforce-variant-standard` now requires a structural connection between a `tv()` recipe with axes and the component's props: `VariantProps` must be imported from `tailwind-variants` and applied to `typeof <recipe>` in an exported props type or a function parameter annotation, directly or through local type aliases, interfaces and intersections. A comment, unused import, string, or a reference to a different recipe no longer satisfies the rule."

Only the umbrella package receives a release. Do not version a private workspace or edit package versions/lockfiles.

Run, in order: `pnpm exec oxfmt --check packages/oxlint-plugin/rules/enforce-variant-standard.js packages/oxlint-plugin/rules/enforce-variant-standard.test.js .changeset/structural-variant-props.md` (exit 0; if it fails, fix layout by hand or run `pnpm exec oxfmt <those files>` on in-scope files only), then `pnpm ci:checks`, then `pnpm packages:pack && pnpm test:packed-consumer`. Inspect `git diff --check`, `git diff --name-only` and `git status --short`; every changed or new path must be in Scope. After updating plan status, run `pnpm exec oxfmt --check plans/008-structural-variant-props.md plans/README.md`. Do not mark DONE with a failed or skipped required gate.

**Verify:** `git diff --check`

Expected: exit 0; all preceding final commands exit 0. Record the actual commands and results in the completion notes, including any blocked check.

## Test plan

All cases are listed in Step 1 with their expected outcomes; that list is the test plan. Summary of what it must cover:

- Invalid: comment-only, unused import, string literal, different recipe, unused unexported alias, helper imported from another module, locally declared `VariantProps`, generic type parameter shadowing an alias, alias cycle (bounded traversal, no hang).
- Valid: exported alias, exported intersection, exported interface extending the helper, interface extending a local alias, renamed `import type`, parameter annotation reached through an alias chain with no exported type, `memo` callback parameter, `export type { X }` specifier list, two recipes both covered, recipe module exempt, axis-less component recipe exempt (existing case).
- Keep every pre-existing case byte-for-byte. Do not replace explicit `errors` assertions with snapshots.

Verification: `pnpm --filter @elmeragroup/oxlint-plugin test rules/enforce-variant-standard.test.js` → exit 0 after Step 3, with all listed cases present and named as above so a reviewer can map them to this plan.

## Done criteria

- [ ] `grep -n 'getText().includes("VariantProps")' packages/oxlint-plugin/rules/enforce-variant-standard.js` returns no matches.
- [ ] The focused regression command exits 0 and every invalid/valid case named in Step 1 exists in the test file.
- [ ] `pnpm --filter @elmeragroup/oxlint-plugin test` exits 0.
- [ ] `pnpm ci:checks` exits 0.
- [ ] `pnpm packages:pack && pnpm test:packed-consumer` exits 0.
- [ ] `git diff --check` exits 0, and `git diff --name-only` plus untracked files match Scope.
- [ ] `.changeset/structural-variant-props.md` exists with the `"@elmeragroup/internal": patch` frontmatter and a consumer-facing description.
- [ ] `packages/oxlint-plugin/index.js`, `rule-tester.js` and `packages/oxlint-anti-slop/**` are unchanged.
- [ ] This plan and its index row reflect the actual completion state; no skipped gate is described as passing.

## STOP conditions

Stop and report (do not improvise) if:

- The excerpts in "Current state" no longer match the live file, or the focused test command at the planned-at commit does not report 6 tests in 1 file.
- A `TSTypeReference`, `TSTypeQuery`, `TSTypeAliasDeclaration` or `TSInterfaceDeclaration` visitor does not fire, or `typeArguments`/`exprName`/`importKind` are missing or shaped differently than "Verified AST shapes" states. Report the observed node shape (`JSON.stringify` of the node with `parent` removed).
- Satisfying a listed valid case would require cross-file type resolution, scope analysis, a TypeScript runtime dependency, or a new rule option to bypass the check. Report the exact case name.
- A required gate fails twice after a focused fix attempt, or the fix requires an out-of-scope file. Report pre-existing or environment failures (for example the pnpm bootstrap signature fetch) separately from failures caused by this change.
- Never accept an arbitrary `TSTypeReference` merely because it is spelled `VariantProps`, never suppress a diagnostic, and never weaken or delete an existing test to obtain a green run.

## Maintenance notes

- The proof is deliberately local and bounded. Supporting `forwardRef<E, Props>` generics, `React.FC<Props>` variable annotations, namespace imports, `Omit`/`Pick` wrappers, or props types imported from a sibling module is a separate policy decision; each new accepted form needs a matching rejected-unrelated case in the suite.
- Reviewers should check that no new code path calls `context.sourceCode.getText()`, that the alias-cycle case terminates, and that the existing `missingDefaultVariants`, `unnamedRecipe` and `inlineObject` behavior is byte-identical.
- If `isTvCall` is later extended to accept aliased `tv` imports, the recipe identity used here (`VariableDeclarator.id.name`) still applies without change.
- Plan 007 also lists `packages/internal/README.md` in scope. This plan does not require README changes; if both plans touch it, integrate 007 first.

## Completion notes

Not implemented. Record the implementing revision, regression results, full gate results and any reviewed scope changes here.
