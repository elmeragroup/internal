---
"@elmeragroup/internal": patch
---

`generateApiArtifacts` now fails with `<part>: <N> call signatures — API artifacts describe one public props contract; keep one public overload` when a requested part declares more than one public call signature, instead of silently publishing only the first overload's props and required flags. One overload declaration plus its implementation remains supported.
