# @elmeragroup/internal

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
