---
"@elmeragroup/internal": minor
---

Add the `@elmeragroup/internal/release` entry so consumers can run checked-commit publication, recorded-archive retry, and release-PR checks through the bundled release operations. The pack-and-verify adapter returns the package archive bytes; the engine verifies the packed manifest and integrity, records the archive, and re-verifies it on retry. The engine reads `GITHUB_REPOSITORY` and `GH_TOKEN` when an operation runs; the transport seam used by tests stays internal to the private release package. Failures surface as one `ReleaseError` carrying the failure message and the original cause.
