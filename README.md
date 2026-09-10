# Elmera internal

Shared engineering tools for the Elmera Group.

## Usage

Requires Node >=24.13.0 <25.

```sh
pnpm add -D @elmeragroup/internal@canary
```

```ts
import { generateApiArtifacts } from "@elmeragroup/internal";

const { components } = await generateApiArtifacts({
  projectRoot: process.cwd(),
  tsconfigPath: "tsconfig.json",
  components: [
    {
      slug: "button",
      entryFile: "src/button.ts",
      exportNames: ["Button"],
      outputFile: "docs/button/api.json",
    },
  ],
});
```

Generate artifacts during the build, then import the JSON from your docs pages. Use `mode: "check"` to detect stale artifacts without writing files. See [api-artifacts](packages/api-artifacts/README.md) for options and output details.

## Packages

- [internal](packages/internal): shared consumer entry point and Elmera defaults.
- [api-artifacts](packages/api-artifacts): component API generation and drift checking.
- [api-extractor](packages/api-extractor): TypeScript API extraction and diagnostics.
- [release](packages/release): private publication identity, configuration, versioning, and policy.
- `packages/oxlint-plugin`: private Elmera lint rules.
- `packages/oxlint-anti-slop`: private code-quality rules.
- `tooling/typescript`: private workspace TypeScript configuration.

Only `@elmeragroup/internal` is published, with one Changesets version. The extractor,
artifact generator, lint implementations, and release domain remain private workspace packages with their own tests.
Packaging and publishing support stable `x.y.z` and canary `x.y.z-canary.N` versions.

The package has explicit ESM entries:

| Import                                      | Purpose                                                     |
| ------------------------------------------- | ----------------------------------------------------------- |
| `@elmeragroup/internal`                     | Artifact generation with Elmera defaults, errors, and types |
| `@elmeragroup/internal/api-artifacts`       | The same generator, errors, and types as the root           |
| `@elmeragroup/internal/api-artifacts/model` | Artifact types with an empty runtime module                 |
| `@elmeragroup/internal/api-extractor`       | Low-level Effect extraction, models, schemas, and errors    |
| `@elmeragroup/internal/oxlint`              | Elmera Oxlint plugin default export                         |
| `@elmeragroup/internal/oxlint/anti-slop`    | Anti-slop Oxlint plugin default export                      |

TypeScript, Effect, and `@oxlint/plugins` are pinned runtime dependencies. Installing the package
includes the compiler. Importing lint entries does not load TypeScript or Effect. Consumer bundlers
can remove unused exports. Future browser-safe helpers belong in separate entries; the root remains
the convenient artifact generator.

## Development

Use `.node-version` and the pnpm version in `package.json`.

```sh
pnpm install
pnpm ci:checks
pnpm packages:pack
pnpm test:packed-consumer
```

`packages:pack` builds the package archive without publishing. `canary:pack` is a compatibility alias
for the same command. The consumer test installs the packed package in a temporary project and
checks extraction, defaults, drift detection, all public declarations, both lint plugins, and consumer tree-shaking without workspace links.
It installs a private copy of the archive it verified and writes a receipt bound to that archive's
report. Repacking after verification invalidates the receipt, so re-run `pnpm test:packed-consumer`
before preparing a release record.

## Releases

Only `@elmeragroup/internal` is published. Add a changeset for consumer-facing changes, including
changes to the private implementations bundled into it. Changesets determines the next stable
version and changelog.

### Automatic canaries

Every successful **Merge** check run for a push to `main` calls **Publish Release** with the exact
checked commit. Ordinary commits publish canaries. A commit that merges the stable release PR
publishes stable instead. Pull requests and manually dispatched PR checks never publish.

The canary base is the next version planned by Changesets, or the next patch when there are no
pending changesets. Changesets resolves that plan against the `origin/main` base branch, so the
publisher checks out full history rather than a shallow copy. The publisher reads all npm versions
and reserved GitHub release records, then increments the largest matching `canary.N` suffix. A new
base starts at zero. For example, `0.1.2-canary.9` becomes `0.1.2-canary.10`; a new minor target
starts at `0.2.0-canary.0`.
Canary versions and source metadata are written only in the disposable release checkout.

Publication uses one shared queue with cancellation disabled. Already superseded commits are
skipped. Each new package records its source commit, which prevents delayed runs from replacing
newer code on the `canary` tag. Fresh releases and retries check all published canary commits,
including uploads that have not advanced beyond `pending`, before publishing or promoting. Existing packages without source metadata use increasing version
order for the initial migration. Registry errors stop publication; only an actual package-not-found
response is treated as an empty history.

### Choosing a stable release

After successful main checks, **Version Packages** creates or updates one `changeset-release/main`
PR with the version, changelog, and lockfile. It explicitly dispatches **Merge** checks on that branch
because PRs created with `GITHUB_TOKEN` do not trigger normal pull-request workflows.

Review the PR yourself or ask an agent to review it. Keep it up to date with `main`, then merge when
you want to release. Use a merge commit or squash merge so GitHub identifies one release commit.
The publisher verifies the merged PR, an increasing stable version, its changelog entry, and that
all pending changesets were consumed. It never publishes a missing stable version just because a
later ordinary commit reaches main.

The release commit runs the full main checks, then the publisher packs and verifies its stable
archive. A stable retry may publish an older version without moving `latest` backward.

### Recorded archives and retries

Before npm publication, the workflow creates a draft GitHub release tied to the source commit and
uploads `verified-release.tgz`. Stable records use `v<version>` tags. Canary records use
`canary-<full-commit-SHA>` tags. The bundle contains the package archive, archive report, and passing
packed-consumer receipt. Automation never moves these tags or replaces an uploaded bundle. Do not
edit release-record bodies or delete their assets; they are used for retries and version reservations.

The publisher downloads that saved bundle and validates its source and receipt. It uploads to npm
under `pending`, verifies the registry's archive integrity and source commit, and only then updates
`canary` or `latest`. Finally it makes the GitHub release visible. `pending` is an internal staging
tag, not a supported installation channel.

If publication or finalization fails after the bundle was saved, run **Publish Release** manually
from `main` and supply its record tag. The retry uses the original archive, even if main has advanced.
An existing npm version must match both the archive integrity and source commit. A mismatch fails;
it is never treated as a successful retry. The retry also finishes an interrupted channel update or
GitHub release finalization.

If preparation failed before the bundle was uploaded, rerun the original **Merge** workflow's failed
jobs. That rebuilds the original checked commit using its reserved version. The manual retry workflow
intentionally refuses an incomplete record. Retain the record and original workflow run until recovery
is complete. Lookup and manual retry leave incomplete records untouched. Preparation removes an empty
failed-upload placeholder only after revalidating the saved release intent. Failed preparations can
leave gaps in canary numbering.

### Repository setup

- Set the Actions secret `NPM_TOKEN` to a token that can publish `@elmeragroup/internal` and update its
  npm tags. npm reads and writes use the public npm registry.
- Allow GitHub Actions to create pull requests. The workflows request scoped content, PR, and workflow
  permissions for release records, the version PR, and explicit PR-check dispatch.
- For historical commits whose workflow files differ from current main, GitHub can require the
  `Workflows: write` permission to create release tags. Set the optional `RELEASE_GITHUB_TOKEN`
  secret to a repository-scoped token with Contents write, Pull requests read, and Workflows write
  for that case. Ordinary publication uses `GITHUB_TOKEN` when this secret is absent.
- Protect `main` with the **checks** job and require branches to be up to date before merging. Do not
  auto-merge the release PR unless you deliberately want automatic stable releases.
- Keep release tag and asset write access limited to release automation and maintainers. All automated
  publication must use the shared **Publish Release** workflow. GitHub's queue retains at most 100
  pending jobs; a job rejected at that limit can be rerun from its original Merge run.

The existing legacy canary also occupies npm `latest`. Installing `@canary` continues to work. The
first approved stable release replaces that legacy `latest` value; ordinary canary merges leave it alone.

Local packing remains available through `pnpm canary:version`, `pnpm packages:pack`, and
`pnpm test:packed-consumer`. The old direct `canary:publish` command is removed so publication follows
the recorded-archive workflow.
