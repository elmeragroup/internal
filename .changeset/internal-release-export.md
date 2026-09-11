---
"@elmeragroup/internal": minor
---

Add the `@elmeragroup/internal/release` entry so consumers can run checked-commit publication, recorded-archive retry, and release-PR checks through the bundled release operations. The pack-and-verify adapter returns the package archive bytes; the engine verifies the packed manifest and integrity, records the archive, and re-verifies it on retry. The operations accept an optional `ReleaseEnvironment` (`repository`, `token`, `fetch`) so consumers and tests can supply their own transport. Failures surface as one `ReleaseError` carrying the port that raised it.
