---
"@elmeragroup/internal": patch
---

`generateApiArtifacts` now publishes re-export-only facades. A value that authored code forwards from a dependency declaration without implementing it, through `export { X } from "dep"` chains or an `export const X = DepX` alias, becomes a part with no props whose `sourcePath` and `rsc` come from the innermost authored module and whose `forwardedFrom` names the dependency, instead of failing with `no-implementation`. The extractor's `inspectComponentSources` reports such values as `{ status: "forwarded", filePath, packageName }`, exported as `ComponentSourceForwardedSchema`.
