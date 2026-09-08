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
- `packages/oxlint-plugin`: private Elmera lint rules.
- `packages/oxlint-anti-slop`: private code-quality rules.
- `tooling/typescript`: private workspace TypeScript configuration.

Only `@elmeragroup/internal` is published, with one Changesets version. The extractor,
artifact generator, and lint implementations remain private workspace packages with their own tests.
Packaging accepts stable `x.y.z` and canary `x.y.z-canary.N` versions. Publishing remains canary-only.

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
before `pnpm canary:publish`.

## Canary release

Set the repository Actions secret `NPM_TOKEN` to an npm publishing token with write access to the `@elmeragroup` scope. Run the **Publish Canary** workflow on `main` with a fresh `x.y.z-canary.N` version.

The workflow runs the checks above, uploads the verified archive, and publishes it with public access under the `canary` tag. It does not update `latest`. There is no stable publication path.

To prepare a version locally:

```sh
pnpm canary:version 0.1.0-canary.1
pnpm install --lockfile-only
pnpm ci:checks
pnpm packages:pack
pnpm test:packed-consumer
```

Run `pnpm canary:publish` with npm authentication to publish the verified archive. Each release needs a new version.
