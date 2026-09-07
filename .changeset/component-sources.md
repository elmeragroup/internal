---
"@elmeragroup/internal": minor
---

Recover authored component implementations for artifact source metadata without changing checker-backed public props. `ProjectExtractor` now exposes `inspectComponentSources` to follow React `memo`/`forwardRef` wrappers to the implementation file and destructuring defaults. Artifact generation uses those recovered facts for `sourcePath`, `rsc`, and `defaultValue`, and fails explicitly for unresolved or declaration-only sources instead of publishing React declaration paths.
