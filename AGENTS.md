# Working in this repository

This pnpm workspace contains shared engineering packages for the Elmera Group. Read the root
[README](README.md) and the affected package's README before changing behavior.

## Package responsibilities

- `packages/internal` is the consumer entry point and supplies Elmera defaults.
- `packages/api-artifacts` generates component API JSON and checks for drift.
- `packages/api-extractor` extracts a semantic API model from TypeScript projects.
- `packages/oxlint-plugin` and `packages/oxlint-anti-slop` contain private lint rules.
- `tooling/typescript` contains shared TypeScript configuration.
- `scripts` contains workspace build, packaging, and release tooling. Root `test` contains repository
  policy tests and the packed-consumer test.

Keep the dependency direction `internal` → `api-artifacts` → `api-extractor`. Put consumer defaults in
`internal`, artifact generation policy in `api-artifacts`, and extraction semantics in `api-extractor`.

## Setup and checks

Use the Node version in `.node-version` and the pnpm version in root `package.json`. Shared dependency
versions belong in the catalog in `pnpm-workspace.yaml`; use `catalog:` and `workspace:*` references
where appropriate. Preserve the pinned Effect and TypeScript versions unless upgrading them is part
of the task.

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

Fix the underlying issue before adding a lint exception. In `api-extractor`, file-wide disables and
path-wide overrides are prohibited. A necessary next-line disable must name one rule and include a
`--` reason. Use a `SAFETY:` comment where the assertion rule requires it. Remove obsolete exceptions.

## Extractor boundaries and evidence

Read [the extractor guide](packages/api-extractor/README.md) before changing its model, backend,
fixtures, warnings, or timing reports.

- Keep TypeScript's unstable native API inside `src/backend/ts7/**`. Compiler objects and handles
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

For release preparation, follow the root README. The three public packages share one coordinated
Changesets version. Package verification accepts a coordinated stable or canary version. Publication
remains canary-only through the manual Publish Canary workflow and does not publish `latest`. CI
checks changeset presence for ordinary pull requests unless they carry the `no-changeset` label.
Include a changeset for publishable changes and explain when a change needs no release.
