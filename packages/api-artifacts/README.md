# API artifacts

Generate committed component API JSON with one call. Requires Node >=24.13.0 <25. This private workspace implements generation for `@elmeragroup/internal`. TypeScript is included as a runtime dependency of the published package.

```ts
import { generateApiArtifacts } from "@elmeragroup/internal/api-artifacts";

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

The public generator defaults to `includeExternalTypes: ["@base-ui/react"]` and
`allowedWarningCodes: ["unsupported-type-fallback"]`. Override these options as needed.
The private workspace generator supplies no consumer defaults.

All relative paths resolve against `projectRoot`. Each output must be a distinct `.json` file. The returned components include the generated parts, serialized `text`, absolute `outputFile`, and a `changed` flag. `generatedBy` optionally supplies the artifact's `$generated` banner.

Use `mode: "check"` before any generation in CI. It throws `ApiArtifactsDriftError` listing missing or stale files without writing files or creating directories. The default `write` mode validates the complete inventory before writing, and leaves unchanged files untouched. Each changed file is replaced through a sibling temporary file; filesystem failures can leave earlier files in a batch updated, so batch rollback is not guaranteed. No files outside the explicit inventory are pruned.

Declared public props require JSDoc. Recipe axes use the `*-variants` naming convention. Dependency props are included only when their provenance names a selected package, they have documentation, and the consuming component actually accepts them. Unaccepted extraction warning codes fail generation. Accepted warnings remain in `diagnostics`.

Each part's `sourcePath`, `rsc`, and prop `defaultValue` come from the authored implementation, not
from the public call-signature declaration. React `memo` and `forwardRef` wrappers, including nested
and aliased forms, are followed to that implementation. Checker-backed accepted props, required
flags, printed types, and forwarded counts stay authoritative. Unknown wrappers, cycles, and
declaration-only components the project itself declares fail generation with an explicit diagnostic
naming the component and reason; they do not publish React's type-declaration path or empty defaults.

A facade that only forwards a dependency's value, through named or `export *` re-export chains, an
exported import binding, or an authored `export const X = DepX` alias, publishes a part with no
props. Its `sourcePath` and `rsc` come from the innermost authored module that forwards the value,
and `forwardedFrom` names the declaring dependency together with the packages that declare the
forwarded props. Selecting that dependency through `includeExternalTypes` does not add its
documented props to the facade; enrichment applies only to parts with a resolved implementation.

Each part's `rsc` value is classified from the recovered implementation module's directive prologue
in the parsed syntax. Only an exact authored `"use client"` or `'use client'` expression statement in
that prologue is `client`. `server` means that module has no client directive; it is not a transitive
React server/client module-graph analysis.

Import artifact types through `@elmeragroup/internal/api-artifacts/model`. Generate the JSON during the build, then import it from MDX or other rendering code.
