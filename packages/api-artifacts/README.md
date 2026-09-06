# @elmeragroup/api-artifacts

Generate committed component API JSON with one call. Requires Node >=24.13.0 <25. TypeScript is included as a runtime dependency.

```ts
import { generateApiArtifacts } from "@elmeragroup/api-artifacts";

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

All relative paths resolve against `projectRoot`. Each output must be a distinct `.json` file. The returned components include the generated parts, serialized `text`, absolute `outputFile`, and a `changed` flag. `generatedBy` optionally supplies the artifact's `$generated` banner.

Use `mode: "check"` before any generation in CI. It throws `ApiArtifactsDriftError` listing missing or stale files without writing files or creating directories. The default `write` mode validates the complete inventory before writing, and leaves unchanged files untouched. Each changed file is replaced through a sibling temporary file; filesystem failures can leave earlier files in a batch updated, so batch rollback is not guaranteed. No files outside the explicit inventory are pruned.

Declared public props require JSDoc. Recipe axes use the `*-variants` naming convention. Dependency props are included only when their provenance names a selected package, they have documentation, and the consuming component actually accepts them. Unaccepted extraction warning codes fail generation. Accepted warnings remain in `diagnostics`.

Each part's `rsc` value is classified from the selected source module's directive prologue in the parsed syntax. Only an exact authored `"use client"` or `'use client'` expression statement in that prologue is `client`. `server` means that module has no client directive; it is not a transitive React server/client module-graph analysis.

Import artifact types through `@elmeragroup/api-artifacts/model`. Generate the JSON during the build, then import it from MDX or other rendering code.
