# Elmera internal

Shared engineering packages for the Elmera Group.

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

The three public packages are a Changesets fixed group and share one coordinated version,
either stable `x.y.z` or canary `x.y.z-canary.N`. Packaging and installed-consumer
verification accept either form. Publishing remains canary-only.

## Development

Use `.node-version` and the pnpm version in `package.json`.

```sh
pnpm install
pnpm ci:checks
pnpm packages:pack
pnpm test:packed-consumer
```

`packages:pack` builds local archives without publishing. `canary:pack` is a compatibility alias
for the same command. The consumer test installs the packed packages in a temporary project and
checks extraction, defaults, drift detection, and TypeScript compilation without workspace links.

## Canary release

Set the repository Actions secret `NPM_TOKEN` to an npm publishing token with write access to the `@elmeragroup` scope. Run the **Publish Canary** workflow on `main` with a fresh `x.y.z-canary.N` version.

The workflow runs the checks above, uploads the verified archives, and publishes them with public access under the `canary` tag. It does not update `latest`. There is no stable publication path.

To prepare a version locally:

```sh
pnpm canary:version 0.1.0-canary.1
pnpm install --lockfile-only
pnpm ci:checks
pnpm packages:pack
pnpm test:packed-consumer
```

Run `pnpm canary:publish` with npm authentication to publish the verified archives. Each release needs a new version.
