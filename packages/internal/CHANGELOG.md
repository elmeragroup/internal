# @elmeragroup/internal

## 0.2.0

### Minor Changes

- 408e0d2: Add the `@elmeragroup/internal/release` entry so consumers can run checked-commit publication, recorded-archive retry, and release-PR checks through the bundled release operations. The pack-and-verify adapter returns the package archive bytes; the engine verifies the packed manifest and integrity, records the archive, and re-verifies it on retry. The engine reads `GITHUB_REPOSITORY` and `GH_TOKEN` when an operation runs; the transport seam used by tests stays internal to the private release package. Failures surface as one `ReleaseError` carrying the failure message and the original cause.

### Patch Changes

- 408e0d2: The extractor now publishes diagnostics from a speculative component-props candidate only when the export is recognized as a component. A rejected or uncertain candidate no longer contributes warnings for props that were never returned.
- 408e0d2: `generateApiArtifacts` no longer adds selected dependency props to a re-export-only facade; such parts keep `props: []` and their full `forwardedCount` even when the forwarding dependency (including the default `@base-ui/react`) is listed in `includeExternalTypes`.
- 408e0d2: `generateApiArtifacts` and the extractor's `inspectComponentSources` now preserve destructuring defaults authored under string-literal or numeric-literal property keys, such as `{ "aria-label": label = "hello" }`. The default is reported under the decoded property name (`aria-label`), so generated `defaultValue` fields and extraction provenance no longer omit it. Computed keys are still omitted rather than guessed.
- 408e0d2: `generateApiArtifacts` now fails with `<part>: <N> call signatures — API artifacts describe one public props contract; keep one public overload` when a requested part declares more than one public call signature, instead of silently publishing only the first overload's props and required flags. One overload declaration plus its implementation remains supported.
- 408e0d2: The `anti-slop/no-slop-comments` lint rule no longer offers its "Delete this comment" suggestion for a block comment that has code on both sides of it on the same line, such as `return/* TODO */x` or a multi-line comment between `return` and its value. Accepting that suggestion could join tokens or change automatic semicolon insertion. The diagnostic itself is unchanged, and suggestions for `//` comments and for block comments that start or end their line still delete the comment as before.
- 408e0d2: The `oxlint/anti-slop` rules `no-unsafe-dictionary-type`, `no-known-value-widening`, `no-object-parameters` and `no-unknown-returns` now resolve type names in their lexical scope. Type parameters, nested aliases, and local or imported `Promise` bindings that shadow a module-level alias no longer produce false positives, and broad aliases declared inside functions are now reported.
- 408e0d2: `elmera/enforce-variant-standard` now requires a structural connection between a `tv()` recipe with axes and the component's props: `VariantProps` must be imported from `tailwind-variants` and applied to `typeof <recipe>` in an exported props type or a function parameter annotation, directly or through local type aliases, interfaces and intersections. A comment, unused import, string, or a reference to a different recipe no longer satisfies the rule.
- 408e0d2: `elmera/no-tailwind-dark-variant` now reports `dark:` before arbitrary values, important and negative utilities, and in stacked variant chains (for example `dark:[color:red]`, `dark:!bg-red-500`, `dark:-mt-1`, `hover:dark:[color:red]`). Text such as `dark:` inside an arbitrary value is no longer reported, and named or custom variants such as `data-dark:` and `theme-dark:` are no longer treated as the dark axis.
- 408e0d2: Publish automatic canaries and maintainer-approved stable releases through verified, recorded archives. Release packages include their source commit and channel so retries and channel updates can verify identity. A published stable from a descendant commit supersedes a canary, a planned canary base that regresses behind an existing canary is skipped instead of failing, and a damaged GitHub record only fails lookup of that record's tag rather than blocking every release.

## 0.1.1

### Patch Changes

- e9ad9b3: `generateApiArtifacts` now publishes re-export-only facades. A value that authored code forwards from a dependency declaration without implementing it, through named or `export *` re-export chains, an exported import binding, or an `export const X = DepX` alias, becomes a part with no props whose `sourcePath` and `rsc` come from the innermost authored module that forwards it and whose `forwardedFrom` names the dependency, instead of failing with `no-implementation`. The extractor's `inspectComponentSources` reports such values as `{ status: "forwarded", filePath, packageName }`, exported as `ComponentSourceForwardedSchema`.

## 0.1.0

### Minor Changes

- 95a02e1: Recover authored component implementations for artifact source metadata without changing checker-backed public props. `ProjectExtractor` now exposes `inspectComponentSources` to follow React `memo`/`forwardRef` wrappers to the implementation file and destructuring defaults. Artifact generation uses those recovered facts for `sourcePath`, `rsc`, and `defaultValue`, and fails explicitly for unresolved or declaration-only sources instead of publishing React declaration paths.
- ea4911e: Publish artifact generation, low-level extraction, and both Oxlint plugins through explicit entry points in one package. Bundle private workspace implementations and declarations while keeping compiler, Effect, and Oxlint runtime dependencies external. Artifact generation loads on invocation so error-only consumers can discard the generator and compiler code.

### Patch Changes

- 95a02e1: Recover authored component sources through namespace and object property aliases. Detect function
  implementations from syntax so semicolon-free object return types neither masquerade as bodies nor
  make overloads ambiguous. Artifact generation preserves implementation defaults and client status.
- 95a02e1: Preserve distinct generic signatures during canonicalization. Nested constraints and defaults no longer collapse through render identity, and inner parameter references keep their own lexical bindings instead of following a one-sided rename map.
- 95a02e1: Classify `"use client"` from the parsed module prologue instead of stripping comments from raw source text. A valid directive with a trailing comment or a same-line export is now client; a comment-shaped string is not. `server` still means the selected source module has no client directive, not a transitive React module-graph analysis.
- 95a02e1: Discard diagnostics and provenance recorded while probing a rejected substitution candidate. A successful fallback now keeps only the evidence of the candidate whose model is returned, and exhaustion still reports the original unsupported-type warning.
