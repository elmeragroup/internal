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

Both entries export a default plugin. They do not load TypeScript or Effect.
The package is ESM-only. Installation includes the pinned compiler and Effect runtime, while
consumer bundlers can remove unused exports. Browser-safe helpers must have separate entries;
the root is reserved for artifact generation.
