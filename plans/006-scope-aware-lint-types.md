# Plan 006: Resolve lint type references in their lexical scope

> Executor instructions: Read this entire plan before editing. Follow each step and its expected verification result. On a STOP condition, report the specific blocker instead of expanding scope. Update this plan's status and its row in plans/README.md when complete, unless a reviewing operator owns those updates.
>
> Drift check: `git diff --stat e9ad9b3..HEAD -- 'packages/oxlint-anti-slop/shared/type-name-scope.ts' 'packages/oxlint-anti-slop/shared/dictionary-types.ts' 'packages/oxlint-anti-slop/shared/lexical-type-parameters.ts' 'packages/oxlint-anti-slop/rules/no-unsafe-dictionary-type.ts' 'packages/oxlint-anti-slop/rules/no-unsafe-dictionary-type.test.ts' 'packages/oxlint-anti-slop/rules/no-known-value-widening.ts' 'packages/oxlint-anti-slop/rules/no-known-value-widening.test.ts' 'packages/oxlint-anti-slop/rules/no-object-parameters.ts' 'packages/oxlint-anti-slop/rules/no-object-parameters.test.ts' 'packages/oxlint-anti-slop/rules/no-unknown-returns.ts' 'packages/oxlint-anti-slop/rules/no-unknown-returns.test.ts' 'packages/oxlint-anti-slop/README.md' '.changeset/scope-aware-lint-types.md' 'plans/006-scope-aware-lint-types.md' 'plans/README.md'`
> If implementation files changed, compare the excerpts below to live code. If they no longer match, stop for reconciliation. New plan files alone are expected and do not indicate implementation drift. Also inspect `git status --short` for uncommitted edits before starting; an untracked `plans/` directory is expected.

## Status

- Status: DONE
- Finding: 6 from the deep audit
- Priority: P2
- Effort: M, including regression coverage
- Fix risk: MED
- Depends on: none
- Category: dx
- Planned at: commit `e9ad9b3`, 2026-09-08
- Confidence: HIGH, reproduced during the audit and re-reproduced during plan review (2026-09-08) against `e9ad9b3` with the `oxlint/plugins-dev` RuleTester

## Why this matters

Four anti-slop rules resolve type names from a module-level table only: `no-unsafe-dictionary-type`, `no-known-value-widening` (both through `shared/dictionary-types.ts`), `no-object-parameters`, and `no-unknown-returns`. Because the table ignores where a name is used, three kinds of valid code get CI-blocking diagnostics (all rules are `error` in the root `.oxlintrc.json`):

1. A generic parameter that shares a name with a module alias: `type Value = unknown; type Dictionary<Value extends { id: string }> = Record<string, Value>;` is reported by `no-unsafe-dictionary-type` because `Value` resolves to the module alias instead of the type parameter.
2. A nested alias that shadows a module alias: `type Value = object; function outer() { type Value = { id: string }; function inner(value: Value) {} }` is reported by `no-object-parameters`. The same shape (`type Value = unknown` at module level, `type Value = { id: string }` in a function, `const v: Value = { id: "a" }`) is reported by `no-known-value-widening`.
3. A local or imported `Promise` binding: `type Promise<T> = { value: T }; declare function f(): Promise<unknown>;` and `import { Promise } from "./p"; declare function f(): Promise<unknown>;` are reported by `no-unknown-returns`, which matches `Promise`/`PromiseLike` by name without checking for shadowing.

The mirror image is a set of false negatives: a nested `type Value = unknown` or `type Value = object` inside a function is never seen by the module-level table, so `Record<string, Value>`, `(value: Value)`, `(): Value` and `const v: Value = {...}` inside that function are not reported today. The fix makes both directions correct with purely syntactic, lexical name resolution. It adds no TypeScript or Effect dependency to lint entries.

## Current state

The shared helper `dictionary-types.ts` builds one alias/interface/shadowed-builtin table per `Program`. `no-object-parameters.ts` and `no-unknown-returns.ts` each keep their own module-level alias `Map`. `shared/lexical-type-parameters.ts` already walks the parent chain to collect generic, mapped-type key and `infer` binders that are in scope at a node; the rules use it for type parameters but not for nested alias/interface declarations. All type nodes handed to these helpers are real AST nodes with a `.parent` pointer (the helpers already rely on that in `isInsideTypeAliasDeclaration` and `lexicalTypeParameterNames`), so a use-site anchor is always available: the `TSTypeReference` node itself.

Files and roles:

- `packages/oxlint-anti-slop/shared/dictionary-types.ts` — `createTypeEnvironment` (lines 51–96), `isBuiltIn` (102–104), alias/interface lookups inside `unsafeDirectValue` (233–243), `dictionaryValueTypes` (298–304), `classifyWideningTarget` (363–380), `isBroadMappedKey` (408) and `classifyAliasBroadTarget` (453–464). Every `environment.aliases.get`, `environment.interfaces.get` and `isBuiltIn` call is a site that must become use-site aware.
- `packages/oxlint-anti-slop/rules/no-unsafe-dictionary-type.ts` — `isPlainAliasConsumerUse` (69–73) uses `environment.aliases.has(name)`; `Program` (113–115) creates the environment. Reports from `TSTypeReference`, `TSTypeLiteral`, `TSMappedType` and `TSIndexSignature` visitors.
- `packages/oxlint-anti-slop/rules/no-known-value-widening.ts` — `Program` (172–174) creates the environment; `annotationTarget` (79–86) and the `TSAsExpression`/`TSTypeAssertion` visitors (228–243) call `classifyWideningTarget`. Its non-type logic (`hasKnownEvidence`, `resolveVariable`, subject naming) must not change.
- `packages/oxlint-anti-slop/rules/no-object-parameters.ts` — module `aliases` map (line 50), `resolvesToObject` (52–81), `Program` (101–113); already passes `lexicalTypeParameterNames(node, context.sourceCode.visitorKeys)` from `checkParameters` (84–87).
- `packages/oxlint-anti-slop/rules/no-unknown-returns.ts` — module `aliases` map (line 40), `resolvesToUnknown` (42–76) including the by-name `Promise`/`PromiseLike` check (56–63), `Program` (93–102). Note this file is indented with two spaces, unlike the tab-indented siblings.
- `packages/oxlint-anti-slop/shared/lexical-type-parameters.ts` — `lexicalTypeParameterNames(node, visitorKeys)` (36–62). Reuse it; only change it if the new helper needs an exported piece of it (for example the `VisitorKeys` type).
- `packages/oxlint-anti-slop/README.md` — has a "Local divergence" section listing what to preserve when refreshing the vendored upstream copy.
- Out of scope but related: `rules/no-unknown-type-aliases.ts` uses the same module-level table but only reports module-level aliases, so it has no false positive of this kind. `rules/no-unknown-parameters.ts` does not resolve aliases at all.

`packages/oxlint-anti-slop/shared/dictionary-types.ts:51`:

```text
export function createTypeEnvironment(program: ESTree.Program): TypeEnvironment {
	const aliases = new Map<string, ESTree.TSTypeAliasDeclaration>();
	const interfaces = new Map<string, ESTree.TSInterfaceDeclaration[]>();
	const shadowedBuiltIns = new Set<string>();

	for (const statement of program.body) {
		const declaration = declaredStatement(statement);
		if (declaration?.type === "ImportDeclaration") {
			for (const specifier of declaration.specifiers) {
				if (BUILT_INS.has(specifier.local.name)) shadowedBuiltIns.add(specifier.local.name);
			}
			continue;
		}

		if (declaration?.type === "TSTypeAliasDeclaration") {
			const existing = aliases.get(declaration.id.name);
			if (existing === undefined) aliases.set(declaration.id.name, declaration);
			else shadowedBuiltIns.add(declaration.id.name);
			if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name);
```

`packages/oxlint-anti-slop/shared/dictionary-types.ts:102`:

```text
function isBuiltIn(name: string, environment: TypeEnvironment): boolean {
	return BUILT_INS.has(name) && !environment.shadowedBuiltIns.has(name);
}
```

`packages/oxlint-anti-slop/shared/dictionary-types.ts:227`:

```text
	const substitution = substitutions.get(name);
	if (substitution !== undefined) {
		return isUnappliedReferenceTo(substitution, name)
			? null
			: unsafeDirectValue(substitution, environment, substitutions, resolvingAliases);
	}
	const interfaceDeclarations = environment.interfaces.get(name);
	if (interfaceDeclarations !== undefined) {
		return isEffectivelyEmptyInterface(interfaceDeclarations) ? "empty-object" : null;
	}
	const alias = environment.aliases.get(name);
	if (alias === undefined || resolvingAliases.has(name)) return null;
	const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
	if (nextSubstitutions === null) return null;
	const nextResolving = new Set(resolvingAliases);
	nextResolving.add(name);
	return unsafeDirectValue(alias.typeAnnotation, environment, nextSubstitutions, nextResolving);
```

`packages/oxlint-anti-slop/rules/no-unsafe-dictionary-type.ts:69`:

```text
function isPlainAliasConsumerUse(node: ESTree.TSType, environment: TypeEnvironment): boolean {
	if (node.type !== "TSTypeReference" || node.typeArguments?.params.length) return false;
	const name = typeReferenceName(node);
	return name !== null && environment.aliases.has(name) && !isInsideTypeAliasDeclaration(node);
}
```

`packages/oxlint-anti-slop/rules/no-object-parameters.ts:100`:

```text
		return {
			Program(node) {
				aliases.clear();
				for (const statement of node.body) {
					const declaration =
						statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
					if (
						declaration?.type === "TSTypeAliasDeclaration" &&
						(declaration.typeParameters === null || declaration.typeParameters === undefined)
					) {
						aliases.set(declaration.id.name, declaration.typeAnnotation);
					}
```

`packages/oxlint-anti-slop/rules/no-unknown-returns.ts:56`:

```text
      if (
        type.type === "TSTypeReference" &&
        type.typeName.type === "Identifier" &&
        (type.typeName.name === "Promise" || type.typeName.name === "PromiseLike")
      ) {
        const value = type.typeArguments?.params[0];
        return value !== undefined && resolvesToUnknown(value, shadowedAliases, visited);
      }
      const name = referencedAliasName(type);
      if (name === null || visited.has(name) || shadowedAliases.has(name)) return false;
```

`packages/oxlint-anti-slop/shared/lexical-type-parameters.ts:36`:

```text
export function lexicalTypeParameterNames(
	node: ESTree.Node,
	visitorKeys: VisitorKeys,
): ReadonlySet<string> {
	const names = new Set<string>();
	let descendant: ESTree.Node = node;
	let current: ESTree.Node | null = node;
	while (current !== null && current.type !== "Program") {
		if ("typeParameters" in current) {
```

## Conventions and test pattern

Read root README.md and AGENTS.md before implementation, plus `packages/oxlint-anti-slop/README.md`. Match strict typing, kebab-case filenames and separate `import type` statements. Lint runs with `--deny-warnings`, so warnings fail the check. Fix the underlying issue before adding a lint exception.

Formatting: `.oxfmtrc.json` lists `packages/oxlint-anti-slop/**` under `ignorePatterns`, so `oxfmt` neither formats nor checks this package. Match each file's existing indentation by hand: tabs in `dictionary-types.ts`, `lexical-type-parameters.ts`, `no-unsafe-dictionary-type.ts`, `no-known-value-widening.ts`, `no-object-parameters.ts` and their tests; two spaces in `no-unknown-returns.ts` and `no-unknown-returns.test.ts`. Use tabs for the new `shared/type-name-scope.ts`. Root `pnpm lint` does cover this package (`.oxlintrc.json` has an override block for `packages/oxlint-anti-slop/**` that switches off a few anti-slop rules; do not extend that block).

Keep the implementation private and bundled through `@elmeragroup/internal`'s `oxlint/anti-slop` entry (`packages/internal/src/oxlint-anti-slop.ts`, bundled by `packages/internal/tsdown.config.ts`; a new file under `shared/` is bundled automatically because it is imported, so no export-map change is needed). Lint entries must not import `typescript` or `effect`; `test/packed-consumer/lint.mjs:12` and `test/packed-consumer/tree-shaking.mjs:20` fail the packed-consumer test if they do. Use the existing `defineRule`/`createOnce` pattern and reset per-file mutable state in the `Program` visitor, because one rule instance lints every file.

Use this existing test pattern from `packages/oxlint-anti-slop/rules/no-unsafe-dictionary-type.test.ts:1`. Valid cases are plain strings; invalid cases are `{ code, errors: [error] }` or `{ code, errors: <count> }`:

```text
import { createRuleTester } from "../shared/rule-tester.ts";
import { noUnsafeDictionaryTypeRule } from "./no-unsafe-dictionary-type.ts";

const tester = createRuleTester();

const error = { messageId: "unsafeDictionary" };

tester.run("anti-slop/no-unsafe-dictionary-type", noUnsafeDictionaryTypeRule, {
	valid: [
```

The `RuleTester` from `oxlint/plugins-dev` throws an `AssertionError` at the first failing case in a `run` call ("Should have no errors but had 1: [...]" for a valid case that reports), so one failing test file shows one assertion, not one per new case. Put new cases at the end of the arrays.

## Commands you will need

Run commands from the repository root. Use Node 24.13.0 from `.node-version` and pnpm 11.20.0 from root `package.json` (`node --version` → `v24.13.0`, `pnpm --version` → `11.20.0`). Preserve the pinned TypeScript 7.0.2 and Effect 4.0.0-rc.111 catalog versions.

| Purpose                                                                                                | Command                                                   | Expected on success                                        |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------- |
| Install (only if `node_modules` is absent)                                                             | `pnpm install --frozen-lockfile`                          | exit 0, no lockfile diff                                   |
| Focused package tests (no build needed; runs `node --experimental-strip-types --test rules/*.test.ts`) | `pnpm --filter @elmeragroup/oxlint-plugin-anti-slop test` | exit 0, every test file `ok`                               |
| Lint the workspace including this package                                                              | `pnpm lint`                                               | exit 0                                                     |
| Workspace gate                                                                                         | `pnpm ci:checks`                                          | exit 0                                                     |
| Package verification (pack builds first)                                                               | `pnpm packages:pack && pnpm test:packed-consumer`         | exit 0, checks `api`, `types`, `lint`, `tree-shaking` pass |
| Whitespace and scope check                                                                             | `git diff --check && git status --short`                  | exit 0; only Scope paths listed                            |

`pnpm test:packed-consumer` creates a temporary consumer and runs `pnpm install --ignore-scripts` in it, so it needs registry access. The audit ran focused tests with installed executables because pnpm's pinned-version bootstrap could not fetch signature data. A failed bootstrap or offline install is an environment blocker, not evidence that a dependency upgrade is needed. Record it; do not bypass signature validation. The audit did not run a complete fresh-build/packed baseline, so establish it (`pnpm --filter @elmeragroup/oxlint-plugin-anti-slop test` and, if possible, `pnpm ci:checks`) before changing code and before attributing unrelated failures to this change.

## Scope

Only modify these paths. Listed new test/helper files may be created.

- `packages/oxlint-anti-slop/shared/type-name-scope.ts` (create)
- `packages/oxlint-anti-slop/shared/dictionary-types.ts`
- `packages/oxlint-anti-slop/shared/lexical-type-parameters.ts` (only if an export is needed by the new helper)
- `packages/oxlint-anti-slop/rules/no-unsafe-dictionary-type.ts`
- `packages/oxlint-anti-slop/rules/no-unsafe-dictionary-type.test.ts`
- `packages/oxlint-anti-slop/rules/no-known-value-widening.ts`
- `packages/oxlint-anti-slop/rules/no-known-value-widening.test.ts`
- `packages/oxlint-anti-slop/rules/no-object-parameters.ts`
- `packages/oxlint-anti-slop/rules/no-object-parameters.test.ts`
- `packages/oxlint-anti-slop/rules/no-unknown-returns.ts`
- `packages/oxlint-anti-slop/rules/no-unknown-returns.test.ts`
- `packages/oxlint-anti-slop/README.md`
- `.changeset/scope-aware-lint-types.md` (create)
- `plans/006-scope-aware-lint-types.md`
- `plans/README.md`

Out of scope (do not touch, even though they look related):

- `packages/oxlint-anti-slop/rules/no-unknown-type-aliases.ts` — it only reports module-level aliases and has no false positive of this kind; making it report nested aliases is a new feature, not this fix.
- `packages/oxlint-anti-slop/rules/no-unknown-parameters.ts` and every other rule not listed above.
- `packages/oxlint-anti-slop/index.ts` — no rule is added or renamed.
- `.oxlintrc.json`, `.oxfmtrc.json`, `packages/internal/**`, `tsdown` config, export maps, dependency versions, lockfiles.
- `packages/oxlint-plugin/**` (the other lint package), api-extractor fixture `output.json` files, timing evidence, publication credentials.

Build outputs in ignored `dist/`, `.cache/` and `.artifacts/` directories are normal verification products, not source changes.

## Git workflow

The advisor branch is `codex/deep-audit-plans`. For implementation, use an isolated branch such as `codex/fix-scope-aware-lint-types` from the operator's approved base; keep unrelated working changes intact. Do not create a second implementation branch if the operator already supplied one. Do not commit, push, publish or open a PR unless the operator requested that action. If a commit is requested, use a conventional subject such as `fix: resolve lint type references in their lexical scope` (recent history mixes PR titles and conventional subjects such as `docs: add repository agent guidance`).

## Steps

### Step 1: Add the false-positive regressions

Append these to the `valid` arrays of the named test files. Do not rename `Value` or `Promise` in the snippets; the collision is the point.

- `rules/no-unsafe-dictionary-type.test.ts`: `type Value = unknown; type Dictionary<Value extends { id: string }> = Record<string, Value>;`
- `rules/no-object-parameters.test.ts`: `type Value = object; function outer() { type Value = { id: string }; function inner(value: Value) {} }`
- `rules/no-unknown-returns.test.ts`: `type Promise<T> = { value: T }; declare function f(): Promise<unknown>;`
- `rules/no-known-value-widening.test.ts`: `type Value = unknown; function outer() { type Value = { id: string }; const v: Value = { id: "a" }; }` (this rule shares `dictionary-types.ts`, so its regression must exist too). Do not prefix it with the file's `prelude` constant; it declares no `Command`.

**Verify:** `pnpm --filter @elmeragroup/oxlint-plugin-anti-slop test`

Expected: exactly four test files fail (`no-unsafe-dictionary-type`, `no-object-parameters`, `no-unknown-returns`, `no-known-value-widening`), each with one `AssertionError` reading `Should have no errors but had 1` and the rule's own `messageId` (`unsafeDictionary`, `objectParameter`, `unknownReturn`, `widening`). Any other kind of failure (import, syntax, runtime) means the case was added wrongly; fix that before continuing. All other test files stay `ok`.

### Step 2: Introduce local type-name lookup

Create `packages/oxlint-anti-slop/shared/type-name-scope.ts`, importing only `import type { ESTree } from "@oxlint/plugins"` (plus `lexicalTypeParameterNames` from `./lexical-type-parameters.ts`). Target shape:

```text
export type TypeNameBinding =
	| { readonly kind: "alias"; readonly declaration: ESTree.TSTypeAliasDeclaration }
	| { readonly kind: "interface"; readonly declarations: readonly ESTree.TSInterfaceDeclaration[] }
	| { readonly kind: "shadowed" };

export type TypeNameScope = {
	/** Nearest lexical binding for `name` visible at `useSite`, or null when no local declaration binds it. */
	readonly resolve: (useSite: ESTree.Node, name: string) => TypeNameBinding | null;
};

export function createTypeNameScope(program: ESTree.Program, visitorKeys: VisitorKeys): TypeNameScope;
```

Rules the implementation must follow:

- Scope containers are `Program`, `BlockStatement`, `TSModuleBlock` and `SwitchCase` (a type declaration is a statement and can appear in any statement list). Index each container's direct statements once, lazily, in a `Map<ESTree.Node, Map<string, TypeNameBinding>>` keyed by the container node; unwrap `ExportNamedDeclaration`/`ExportDefaultDeclaration` as `declaredStatement` does today. Declarations are hoisted within their container: position relative to the use site is irrelevant.
- Per container: `TSTypeAliasDeclaration` → `alias`; one or more `TSInterfaceDeclaration` with the same name → one `interface` binding with all of them (interface merging, as `createTypeEnvironment` does now); `ImportDeclaration` specifiers (`specifier.local.name`), `ClassDeclaration`, `TSEnumDeclaration`, `FunctionDeclaration`, `TSModuleDeclaration` ids, and a name declared by more than one kind → `shadowed`. If an alias name is declared twice in the same container, return `shadowed` (matches the current duplicate handling at `dictionary-types.ts:66-68`).
- `resolve(useSite, name)`: first, if `lexicalTypeParameterNames(useSite, visitorKeys).has(name)`, return `shadowed` (generic, mapped-key and `infer` binders win over declarations). Then walk `useSite.parent` upward; at each container check its index and return the first hit. Reaching `Program` without a hit returns `null`. Never look into sibling or nested containers.
- Callers must resolve names inside an alias body from a node inside that body (for example `alias.typeAnnotation` or the nested `TSTypeReference` itself), never from the consumer's use site. Because every `TSType` node carries `.parent`, passing the reference node being examined is sufficient and is the intended pattern.

Do not add a second module-level table; the new helper replaces `TypeEnvironment.aliases`, `.interfaces` and `.shadowedBuiltIns`.

**Verify:** `pnpm --filter @elmeragroup/oxlint-plugin-anti-slop test`

Expected: the same four files fail as in Step 1 and no other file fails (the new helper is not yet wired in). `pnpm lint` exits 0.

### Step 3: Route the four rules through the lookup

`shared/dictionary-types.ts`:

- Change `createTypeEnvironment(program)` to `createTypeEnvironment(program, visitorKeys)` and make `TypeEnvironment` carry the `TypeNameScope` (for example `{ readonly scope: TypeNameScope }`). Remove `aliases`, `interfaces` and `shadowedBuiltIns` from the type.
- `isBuiltIn(name, environment)` becomes `isBuiltIn(reference, name, environment)`: `BUILT_INS.has(name) && environment.scope.resolve(reference, name) === null`.
- In `unsafeDirectValue`, `dictionaryValueTypes`, `classifyWideningTarget`, `isBroadMappedKey` and `classifyAliasBroadTarget`, replace `environment.interfaces.get(name)` / `environment.aliases.get(name)` with `environment.scope.resolve(unwrapped, name)`: `interface` → existing interface handling; `alias` → existing alias handling; `shadowed` → treat as an opaque, safe name (return `null` / `[]` / `false` exactly where an unknown name does today). Keep `substitutions.get(name)` checks before the lexical lookup: explicit generic substitutions stay authoritative.
- Track alias cycles by declaration identity (`Set<ESTree.TSTypeAliasDeclaration>`) instead of by name, so an inner alias and an outer alias with the same name are distinct.

`rules/no-unsafe-dictionary-type.ts`: pass `context.sourceCode.visitorKeys` in `Program`; change `isPlainAliasConsumerUse` to check `environment.scope.resolve(node, name)?.kind === "alias"`. Keep `shouldReportType`'s parent walk and duplicate-report suppression unchanged.

`rules/no-known-value-widening.ts`: pass `context.sourceCode.visitorKeys` in `Program`. No other change; its classification policy is unchanged apart from where names resolve.

`rules/no-object-parameters.ts`: delete the module `aliases` map and the `Program` loop; create a `TypeNameScope` in `Program` instead and resolve `type` references with `scope.resolve(type, name)`. Keep the rule's existing restrictions: only aliases without type parameters and only references without type arguments resolve; `shadowed` and `interface` bindings return `false`. The `lexicalTypeParameterNames` call in `checkParameters` becomes redundant once `resolve` performs it; remove it only if the rule's tests still pass without it.

`rules/no-unknown-returns.ts`: same replacement of the module `aliases` map. Recognize `Promise`/`PromiseLike` only when `scope.resolve(type, name) === null`; when a local alias named `Promise` resolves, resolve through that alias like any other alias (a generic alias, as in the regression, is not followed and yields `false`; an imported `Promise` is `shadowed` and yields `false`).

All four rules keep `createOnce` and rebuild their scope in `Program`, discarding the previous file's index.

**Verify:** `pnpm --filter @elmeragroup/oxlint-plugin-anti-slop test`

Expected: exit 0; every test file `ok`, including the four Step 1 regressions and all pre-existing invalid controls (for example `type Escape = unknown; type A = Record<string, Escape>;`, `type Alias = object; function f(value: Alias) {}`, `function load(): Promise<unknown> { ... }`). Then `pnpm lint` exits 0.

### Step 4: Add the remaining coverage from the test plan

Add the invalid and valid cases listed under "Test plan" to the four test files. The nested-unsafe cases are new true positives: before this plan they were silently accepted, and they must now report.

**Verify:** `pnpm --filter @elmeragroup/oxlint-plugin-anti-slop test`

Expected: exit 0 with all new cases present. If a new invalid case does not report, the lookup is falling back to the wrong scope; fix the helper, do not delete the case.

### Step 5: Document local divergence and verify consumer isolation

In `packages/oxlint-anti-slop/README.md`, extend the "Local divergence" section with one short paragraph: `shared/type-name-scope.ts` and the scope-aware resolution in `shared/dictionary-types.ts`, `rules/no-object-parameters.ts` and `rules/no-unknown-returns.ts` are local changes to preserve when refreshing the vendored upstream files. Keep the existing paragraphs.

**Verify:** `pnpm packages:pack && pnpm test:packed-consumer`

Expected: exit 0; the `lint` and `tree-shaking` packed checks pass, confirming the anti-slop entry still loads without `typescript` or `effect`.

### Step 6: Release note and final gates

Create `.changeset/scope-aware-lint-types.md`:

```yaml
---
"@elmeragroup/internal": patch
---
```

followed by a short consumer-facing paragraph: the `oxlint/anti-slop` rules `no-unsafe-dictionary-type`, `no-known-value-widening`, `no-object-parameters` and `no-unknown-returns` now resolve type names in their lexical scope, so type parameters, nested aliases and local or imported `Promise` bindings that shadow a module-level alias no longer produce false positives, and broad aliases declared inside functions are now reported. Only the umbrella package receives a release. Do not version a private workspace or edit package versions/lockfiles.

Run `pnpm ci:checks` and `pnpm packages:pack && pnpm test:packed-consumer`. Inspect `git diff --check`, `git diff --name-only` and `git status --short`; every changed source/document must be in Scope. Run `pnpm exec oxfmt --check .changeset/scope-aware-lint-types.md plans/006-scope-aware-lint-types.md plans/README.md` after updating plan status. Do not mark DONE with a failed or skipped required gate.

**Verify:** `git diff --check`

Expected: exit 0; all preceding final commands exit 0. Record the actual commands/results in the completion notes, including any blocked check.

## Test plan

Add to the named files. "invalid, 1" means `{ code, errors: [error] }`; where a count is given use `errors: <n>`.

`rules/no-unsafe-dictionary-type.test.ts`

- valid: `type Value = unknown; type Dictionary<Value extends { id: string }> = Record<string, Value>;` (Step 1)
- valid: `type Value = unknown; function f() { type Value = { id: string }; type D = Record<string, Value>; }`
- valid: `function f() { type D = Record<string, Value>; } type Value = { id: string };` (use before declaration)
- valid: `import { Record } from "./local"; function f() { type A = Record<string, unknown>; }` (shadowed builtin resolves from a nested use site)
- valid: `function f() { type Record<K, V> = { key: K; value: V }; type A = Record<string, unknown>; }`
- valid: `type Item = unknown; type Unpacked<Input> = Input extends Promise<infer Item> ? Record<string, Item> : never;` (infer binder visible on the true branch only)
- invalid, 1: `type Value = { id: string }; function f() { type Value = unknown; type D = Record<string, Value>; }` (nested unsafe alias, new true positive)
- invalid, 1: `type Item = unknown; type Fallback<Input> = Input extends infer Item ? string : Record<string, Item>;` (the false branch does not see the `infer` binder, so `Item` resolves to the module alias)
- valid: `type A = B; type B = A; type D = Record<string, A>;` (alias cycle terminates without a report)
- Keep every existing invalid case unchanged; `type Escape = unknown; type A = Record<string, Escape>;` remains invalid.

`rules/no-known-value-widening.test.ts`

- valid: `type Value = unknown; function outer() { type Value = { id: string }; const v: Value = { id: "a" }; }` (Step 1)
- invalid, 1: `type Value = { id: string }; function outer() { type Value = unknown; const v: Value = { id: "a" }; }` (new true positive)
- Keep `const value: unknown = {};` and the other existing invalid cases unchanged.

`rules/no-object-parameters.test.ts`

- valid: `type Value = object; function outer() { type Value = { id: string }; function inner(value: Value) {} }` (Step 1)
- valid: `function outer() { function inner(value: Value) {} type Value = { id: string }; } type Value = object;` (use before declaration in the nested scope)
- invalid, 1: `type Value = object; function outer() { type Value = { id: string }; } function other(value: Value) {}` (the sibling function does not see `outer`'s alias and resolves to the module alias)
- invalid, 1: `type Value = { id: string }; function outer() { type Value = object; function inner(value: Value) {} }` (new true positive)
- Keep `type Alias = object; function f(value: Alias) {}` invalid.

`rules/no-unknown-returns.test.ts`

- valid: `type Promise<T> = { value: T }; declare function f(): Promise<unknown>;` (Step 1)
- valid: `import { Promise } from "./p"; declare function f(): Promise<unknown>;`
- valid: `function outer() { type Promise<T> = { value: T }; function f(): Promise<unknown> { return x; } }`
- invalid, 1: `type Value = string; function outer() { type Value = unknown; function inner(): Value { return x; } }` (new true positive)
- Keep `function load(): Promise<unknown> { return promise; }` and `type UnknownValue = unknown; function load(): UnknownValue { return input; }` invalid.

Cross-file state: RuleTester runs every case through the same `createOnce` rule instance, so order the new cases so that a case declaring a module-level `type Value = unknown` is immediately followed by a case that uses `Value` without declaring it (for example `function f(value: Value) {}` in `no-object-parameters.test.ts` valid). A stale index from the previous file would make the second case report.

Run `pnpm --filter @elmeragroup/oxlint-plugin-anti-slop test` after the implementation and expect every case to pass. In Step 1 only, the failure must be the intended assertion, not a compiler/import/runtime/setup failure. Keep the new regressions after the fix; do not replace assertions with snapshots that merely accept current output.

## Done criteria

- [x] The four Step 1 regressions pass as valid without renaming `Value` or `Promise` in their source.
- [x] The four "new true positive" invalid cases report exactly one diagnostic each.
- [x] Pre-existing invalid controls still report: `grep -c 'type Escape = unknown; type A = Record<string, Escape>;' packages/oxlint-anti-slop/rules/no-unsafe-dictionary-type.test.ts` → `1`, and the file passes.
- [x] `grep -n 'aliases\|shadowedBuiltIns' packages/oxlint-anti-slop/shared/dictionary-types.ts packages/oxlint-anti-slop/rules/no-object-parameters.ts packages/oxlint-anti-slop/rules/no-unknown-returns.ts` returns no module-level table (only `resolvingAliases`/local identifiers may remain).
- [x] `grep -En 'from "(typescript|effect)' packages/oxlint-anti-slop/shared/type-name-scope.ts` returns nothing.
- [x] `pnpm --filter @elmeragroup/oxlint-plugin-anti-slop test` exits 0.
- [x] `pnpm lint` exits 0 and `pnpm ci:checks` exits 0.
- [x] `pnpm packages:pack && pnpm test:packed-consumer` exits 0.
- [x] `git diff --check` exits 0, and `git status --short` lists only Scope paths.
- [x] `.changeset/scope-aware-lint-types.md` exists with the `"@elmeragroup/internal": patch` frontmatter.
- [x] This plan and its index row reflect the actual completion state; no skipped gate is described as passing.

## STOP conditions

Stop and report (do not improvise) if:

- Correct lookup would require semantic type checking, cross-file import resolution, or a new dependency. For an unsupported binding form, return `shadowed` (so no outer binding is blamed) and document the form in the README; do not guess.
- The excerpts in "Current state" no longer match the live files.
- `ESTree.TSType` nodes turn out not to expose `.parent` at the type level in the pinned `@oxlint/plugins` (they do today; `lexicalTypeParameterNames` depends on it). Do not add `SAFETY:` casts to work around it.
- A pre-existing test case in any of the four test files starts failing and the only way to make it pass is to weaken or delete it.
- A required check fails twice after a focused fix attempt, or the fix requires an out-of-scope file.
- `pnpm test:packed-consumer` fails on network or registry access: report it as an environment blocker, not as a defect.

Never modify immutable evidence, suppress a diagnostic, or weaken a test just to obtain a green run.

## Maintenance notes

- Any new rule that resolves type names must use `shared/type-name-scope.ts`; do not reintroduce a module-level alias table.
- Keep generic substitutions (explicit type arguments) separate from lexical declarations, and keep `infer` binders visible only on a conditional type's true branch (`lexical-type-parameters.ts:55`).
- Reviewer focus: every former `environment.aliases.get` / `interfaces.get` / `shadowedBuiltIns` site now passes the reference node being examined, not the outer consumer node; cycle tracking is by declaration identity.
- Deferred: `no-unknown-type-aliases` still reports only module-level aliases. Extending it to nested aliases is a separate feature.
- The README's "Local divergence" paragraph must be kept when the vendored upstream copy is refreshed.

## Completion notes

Implemented uncommitted on `codex/deep-audit-plans` at HEAD `70e6019` (operator override: stay on
this branch; no commit, no staging). Runtime: Node v24.13.0, pnpm 11.20.0. Drift vs `e9ad9b3` touched
`packages/oxlint-anti-slop/README.md` from plan 002 (`removeComment` / `isSafeCommentRemoval`). That
paragraph was kept. Implementation excerpts in `dictionary-types.ts`, `no-object-parameters.ts`, and
`no-unknown-returns.ts` still matched.

`shared/type-name-scope.ts` indexes `Program`, `BlockStatement`, `TSModuleBlock`, and `SwitchCase`
statement lists lazily. `resolve` treats lexical type parameters, mapped keys, and `infer` binders as
`shadowed`, then walks parents. Duplicate aliases, mixed kinds, imports, classes, enums, functions,
and modules bind as `shadowed`. `TypeEnvironment` now carries only `{ scope }`. Alias cycles are
tracked by declaration identity. `substitutions.get` still runs before lexical lookup.
`no-object-parameters` and `no-unknown-returns` dropped their module-level alias maps.
`Promise`/`PromiseLike` are builtins only when `scope.resolve` returns null.

Step 1: `pnpm --filter @elmeragroup/oxlint-plugin-anti-slop test` — 14 files, 4 failed
(`no-unsafe-dictionary-type`, `no-object-parameters`, `no-unknown-returns`,
`no-known-value-widening`), each `Should have no errors but had 1` with `unsafeDictionary`,
`objectParameter`, `unknownReturn`, `widening`. Other files `ok`.

Step 2: helper added. Same four failures. `pnpm lint` — 0 warnings, 0 errors.

Step 3: four rules routed through the lookup. Package tests — 14 passed. `pnpm lint` — 0 warnings,
0 errors. `lexicalTypeParameterNames` was removed from the two rules because `resolve` already
applies it; existing type-parameter cases still passed.

Step 4: remaining valid/invalid cases, including nested true positives and a
`function f(value: Value) {}` stale-index sentinel after a module-level `type Value = object` case.
Package tests — 14 passed.

Step 5: README local-divergence paragraph added after the comment-removal note.
`pnpm packages:pack && pnpm test:packed-consumer` — exit 0. Packed `@elmeragroup/internal@0.1.0`;
consumer declarations and tree-shaking passed (lint and api checks also ran in that loop).

Gates:

1. `pnpm --filter @elmeragroup/oxlint-plugin-anti-slop test` — 14 passed.
2. `pnpm lint` — 0 warnings, 0 errors.
3. `pnpm ci:checks` — exit 0 on the first run (15 turbo tasks; oxfmt 265 files; anti-slop 14;
   oxlint-plugin 190; api-artifacts 43; api-extractor 634; repo-policy included).
4. `pnpm packages:pack && pnpm test:packed-consumer` — exit 0 (Step 5 and again in Step 6).
5. `grep -c 'type Escape = unknown; type A = Record<string, Escape>;' ...no-unsafe-dictionary-type.test.ts`
   → `1`.
6. `grep -n 'aliases\|shadowedBuiltIns'` on dictionary-types / no-object-parameters /
   no-unknown-returns — no module-level table. One remaining hit is the existing rule description
   comment "including local aliases to object."
7. `grep -En 'from "(typescript|effect)' ...type-name-scope.ts` — no matches.
8. `git diff --check` — exit 0. Tracked and untracked source/document paths are in Scope.
9. `pnpm exec oxfmt --check .changeset/scope-aware-lint-types.md plans/006-scope-aware-lint-types.md plans/README.md`
   — exit 0. Anti-slop sources remain formatter-ignored; tabs vs two-space indent was matched by
   hand (`no-unknown-returns.ts` kept two spaces).
10. `.changeset/scope-aware-lint-types.md` has `"@elmeragroup/internal": patch` only.
