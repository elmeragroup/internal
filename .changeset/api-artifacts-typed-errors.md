---
"@elmeragroup/internal": minor
---

`generateApiArtifacts` reports `ApiArtifactsError` when a selected dependency prop has an unresolvable type instead of throwing a bare `Error`, and both `ApiArtifactsError` and `ApiArtifactsDriftError` now carry a stable `_tag` so callers can branch on the tag without `instanceof`.
