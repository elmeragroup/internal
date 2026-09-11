# @elmeragroup/internal

Shared engineering helpers for the Elmera Group.

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

The `canary` channel receives checked main-branch changes automatically. Stable versions are released
when a maintainer merges the version PR. After the first stable release, install stable with
`pnpm add -D @elmeragroup/internal@latest`, or pin an exact version for repeatable builds.

Requires Node >=24.13.0 <25. Generate during the build, then import the JSON from rendering code.

The generator defaults to `includeExternalTypes: ["@base-ui/react"]` and `allowedWarningCodes: ["unsupported-type-fallback"]`. Override either option as needed. Accepted warnings are returned in `diagnostics`.

Use `mode: "check"` to detect stale artifacts without writing. See [api-artifacts](https://github.com/elmeragroup/internal/tree/main/packages/api-artifacts) for options and output details.

## Entry points

`@elmeragroup/internal/api-artifacts` exports the same function, defaults, errors, and types as the root.
Use `@elmeragroup/internal/api-artifacts/model` for artifact types. Its runtime module is empty. Diagnostic declarations reference the extractor’s Effect-based warning types.
The low-level Effect interface is available from `@elmeragroup/internal/api-extractor`.

Configure the plugins explicitly in Oxlint:

```json
{
  "jsPlugins": [
    { "name": "elmera", "specifier": "@elmeragroup/internal/oxlint" },
    { "name": "anti-slop", "specifier": "@elmeragroup/internal/oxlint/anti-slop" }
  ],
  "rules": {
    "elmera/no-tailwind-dark-variant": "error",
    "anti-slop/no-reflect-get": "error"
  }
}
```

`no-tailwind-dark-variant` reports the `dark:` variant in any position, including before arbitrary values (`dark:[color:red]`), important or negative utilities and stacked variants; `dark:` text inside an arbitrary value is not reported.

`enforce-variant-standard` requires a structural connection between a `tv()` recipe with axes and the component's props: `VariantProps` must be imported from `tailwind-variants` and applied to `typeof <recipe>` in an exported props type or a function parameter annotation.

Both entries export a default plugin. They do not load TypeScript or Effect.

## Release

`@elmeragroup/internal/release` exports checked-commit publication, recorded-archive retry, and
release-PR checks. Importing the entry does not publish, write the filesystem, or read credentials.
GitHub token and repository (`GH_TOKEN`, `GITHUB_REPOSITORY`) and the checkout layout are validated
when an operation that needs them runs. `resolveReleasePackage` may read `package.json` when called.

```ts
import {
  checkReleasePr,
  releaseCheckedCommit,
  retryRelease,
  resolveReleasePackage,
  type PackAndVerify,
} from "@elmeragroup/internal/release";
```

The operations return Effect:

```ts
checkReleasePr(pkg: ReleasePackage): Effect<void, ReleaseError>
releaseCheckedCommit(pkg: ReleasePackage, adapter: PackAndVerify, commit: string): Effect<void, ReleaseError>
retryRelease(pkg: ReleasePackage, recordTag: string): Effect<void, ReleaseError>
```

`checkReleasePr` does not need GitHub credentials. `releaseCheckedCommit` takes a pack-and-verify
adapter; Git, GitHub, and npm use production defaults inside the engine, reading `GH_TOKEN` and
`GITHUB_REPOSITORY` when an operation runs. The transport seam used by tests stays internal to the
private release package.

```ts
type PackAndVerify = {
  pack: (intent: ReleaseIntent) => Uint8Array;
};
```

The adapter stamps packed identity, builds, packs, verifies, and returns the package archive bytes.
The engine records those bytes and re-verifies them against the intent before publication or retry.
Callers pass checkout root, package directory, and package name; the module does not derive the
repository from its own path.

The package is ESM-only. Installation includes the pinned compiler and Effect runtime, while
consumer bundlers can remove unused exports. Browser-safe helpers must have separate entries;
the root is reserved for artifact generation.
