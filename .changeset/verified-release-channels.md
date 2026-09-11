---
"@elmeragroup/internal": patch
---

Publish automatic canaries and maintainer-approved stable releases through verified, recorded archives. Release packages include their source commit and channel so retries and channel updates can verify identity. A published stable from a descendant commit supersedes a canary, a planned canary base that regresses behind an existing canary is skipped instead of failing, and a damaged GitHub record only fails lookup of that record's tag rather than blocking every release.
