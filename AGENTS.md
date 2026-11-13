# Working in this repository

This pnpm workspace contains shared engineering packages for the Elmera Group. Read the root
[README](README.md) and the affected package's README before changing behavior.

## Package responsibilities

- `packages/internal` is the only published package and supplies Elmera defaults through explicit exports.
- `packages/api-artifacts` generates component API JSON and checks for drift.
- `packages/api-extractor` extracts a semantic API model from TypeScript projects.
- `packages/release` is the private publication domain: identity, configuration, versioning, policy, and Effect operations.
- `packages/oxlint-plugin` and `packages/oxlint-anti-slop` contain private lint rules.
- `packages/oxlint-test-rules` contains the private test-shape lint rules, published as
  `@elmeragroup/internal/oxlint/tests`.
- `tooling/typescript` contains shared TypeScript configuration.
- `scripts` contains workspace build, packaging, and release tooling. Root `test` contains repository
  policy tests and the packed-consumer test.

Keep the dependency direction `internal` → `api-artifacts` → `api-extractor`. Put consumer defaults in
`internal`, artifact generation policy in `api-artifacts`, and extraction semantics in `api-extractor`.

## Setup and checks

Use the Node version in `.node-version` and the pnpm version in root `package.json`. Shared dependency
versions belong in the catalog in `pnpm-workspace.yaml`; use `catalog:` and `workspace:*` references
where appropriate. Preserve the pinned Effect and tsrs versions unless upgrading them is part of the
task.

The whole workspace compiles with `tsrs`, a Rust port of the TypeScript 7 compiler that follows
TypeScript 7.1: type-check scripts, builds, declaration emit, evidence scripts, and the runtime
`tsrs/*` API. The `typescript` package is not a dependency. Type-aware Oxlint also runs on tsrs: the
lint scripts set `OXLINT_TSGOLINT_PATH=node_modules/.bin/tsrs-lint`, so run Oxlint through
`pnpm lint` or with that variable set. The workspace is supported on macOS
arm64/x64 and Linux x64/arm64 (glibc and musl). tsrs also ships Windows x64 and arm64 binaries, but Windows is
not supported: extraction path identity is not Windows-aware yet.

Run commands from the repository root unless stated otherwise.

```sh
pnpm install --frozen-lockfile
pnpm ci:checks
pnpm packages:pack
pnpm test:packed-consumer
```

These are the workspace checks used by CI. `packages:pack` builds local archives without publishing.
`canary:pack` is a compatibility alias for that command. Run packing before `test:packed-consumer`,
which verifies the packages without workspace links.

While iterating, run the affected package's tests with `pnpm --filter <package-name> test`. Build first
when tests depend on compiled workspace packages. For extractor changes, run
`pnpm --filter @elmeragroup/api-extractor check:all` before review. For documentation-only changes,
check formatting with `pnpm exec oxfmt --check <changed-files>`.

Report the checks run and any failures or checks you could not complete.

## Code conventions

Follow `.oxlintrc.json`, `.oxfmtrc.json`, and the shared TypeScript configuration. Use strict types,
separate type imports, and kebab-case filenames. Lint runs with `--deny-warnings`, so warnings fail
the check too. Use the formatter for layout and import ordering.

Fix the underlying issue before adding a lint exception. Every disable carries a `--` reason that
names the contract it guards (`elmera/require-disable-reason`), and lint reports unused disables as
errors. Use a `SAFETY:` comment where the assertion rule requires it.

`api-extractor` takes next-line disables only, each naming one rule, which lint enforces. No override
may relax a rule for its files, and no disable may name `elmera/require-disable-reason` or no rule at
all, which `test/extractor-lint-policy.test.mjs` enforces.

## Tests

Every new or changed test passes the authoring gate in
[the test-audit skill](.agents/skills/test-audit/SKILL.md#authoring-gate), and its answers go in the
PR's Test value section. A fix gets a test only when one passes the gate.

Assert behavior against an independently defined oracle: a committed fixture, an upstream
`output.json`, a documented contract, or a value the test states for a reason it gives. A test that
computes its expectation with the code under test, or asserts what its own mock returns, is a
tautology. A cross-check between two representations that must agree names both: the unit under
test and the oracle its output must reproduce.

A test that flakes is made deterministic or deleted in the same change, never rerun or retried.
Wait on a condition (an event, a promise, `vi.waitFor`) or drive a fake clock; a timeout is only a
hang guard. Test files run in parallel, so a test owns its temporary directories and environment.

Each kind of test lives with its owner:

- Package behavior: `packages/<name>/test/*.test.ts`, run by that package's `vitest run`.
- Lint rules: `rules/<rule>.test.{js,ts}` beside each rule, as RuleTester valid and invalid cases.
- Extractor evidence: the fixture, conformance and timing checks in `packages/api-extractor`, driven
  by its scripts; committed reports and baselines are drift gates.
- Repository policy (workflows, release configuration, the lint config): root `test/*.test.{mjs,ts}`,
  run by `pnpm test:repo-policy`.
- Consumer behavior of the published archive: `test/packed-consumer/*.mjs`, run by
  `pnpm test:packed-consumer` after `pnpm packages:pack`.

Mechanical test-shape contracts are lint rules in `packages/oxlint-test-rules`, which `.oxlintrc.json`
turns on for test files and helpers under `test/`. State a new mechanical contract as a rule there,
or in `packages/oxlint-plugin` when it binds source rather than tests, with RuleTester cases.

## Extractor boundaries and evidence

Read [the extractor guide](packages/api-extractor/README.md) before changing its model, backend,
fixtures, warnings, or timing reports.

- Keep the compiler's native API (every `tsrs/*` subpath) inside `src/backend/ts7/**`. Compiler objects and handles
  must not escape into public types.
- Keep semantic policy in the parser. `src/parse/**` and `src/canonical/**` must remain Effect-free,
  including their transitive value imports.
- Preserve scoped compiler cleanup and isolated extraction sessions. Reuse one `ProjectExtractor`
  service across files in the same project.
- Preserve deterministic output. Fatal failures remain typed Effect errors; recoverable losses use
  structured warnings with stable codes. Render warning messages in `src/parse/fallback.ts`.
- Never rewrite or alias fixture `output.json` files. They are immutable upstream evidence. Preserve
  the immutable timing baseline in `test/fixtures/timing-boundary.json`; its ceiling metadata follows
  the catalog as documented in the extractor guide.
- Refresh generated reports and reviewed TypeScript 7 or warning evidence through the documented
  scripts. Inspect the resulting diff and explain semantic changes. Do not update expected output
  merely to make a failing check pass.
- Let the fixture catalog derive its inventory from fixture files. Do not add a second fixture list.
- Keep ignored `.ref` checkouts out of runtime dependencies and retain required `NOTICE` attribution
  when porting upstream source.

## Public behavior and releases

Preserve the distinction between artifact `check` and `write` modes. Check mode must not write files
or create directories. Keep generation limited to the explicit output inventory. Update the relevant
README and tests when changing public options, defaults, diagnostics, or serialized output.

For release preparation, follow the root README. Only `@elmeragroup/internal` is published and receives Changesets versions. The extractor, artifact,
and lint workspaces are private. Package verification accepts a stable or canary version. Publication
runs through the shared Publish Release workflow after successful main checks. Ordinary commits
publish canaries; merging the generated release PR publishes stable. Preserve recorded commit/archive
identity, channel ordering, version reservations, and the common publication lock. Retry prepared
releases from their saved archives.

Bundle private implementations and declarations with the pinned tsdown build. Keep external runtime
dependencies pinned. New public entries require explicit export mappings and packed-consumer coverage.
Keep the model entry free of runtime imports and lint entries free of TypeScript and Effect loads.
Preserve side-effect-free module initialization so consumers can remove unused exports.

## Task references

Before opening a PR, read [CONTRIBUTING.md](CONTRIBUTING.md) in full. Write the PR body from
[the PR template](.github/pull_request_template.md), filling each section, in place of any generic
summary format. Apply the `no-changeset` label when CONTRIBUTING.md's release rule calls for it.
