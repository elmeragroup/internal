---
"@elmeragroup/internal": patch
---

Canary planning no longer fails with `Missing key at ["releases"][n]["newVersion"]` when a workspace package without a `version` field, such as a private app, depends on the released package. Changesets lists such a dependent with `type: "none"` and no `newVersion`; only the released package's planned entry must carry one now, and a planned entry without it still fails the publish.
