---
"@elmeragroup/internal": minor
---

`generateApiArtifacts` reports `ApiArtifactsError` when a selected dependency prop has an unresolvable type instead of throwing a bare `Error`, and both `ApiArtifactsError` and `ApiArtifactsDriftError` now carry a stable `_tag` so callers can branch on the tag without `instanceof`.

Artifact ordering is now locale-independent and total: every name comparison uses UTF-16 code-unit order instead of `localeCompare`, and each part's `props` is sorted once across authored and enriched props instead of concatenating two separately sorted runs. Serialized artifacts can therefore reorder when regenerated; regenerate committed artifacts or `check` mode reports drift.
