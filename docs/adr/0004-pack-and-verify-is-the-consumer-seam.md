# The consumer seam is pack-and-verify

The module owns eligibility, reservations, records, archive identity, pending-then-dist-tag promotion, and retry. The consumer stamps packed identity, builds, packs, verifies, and returns the package archive bytes. The module records those bytes on the release and re-verifies them against the intent before every publication and retry. Packed identity lives in `elmeraRelease` on the packed manifest, not only in the source tree. A separate report or receipt is not part of the recorded protocol: the consumer's packed-consumer checks run against a private snapshot before the archive is returned, and the packed manifest inside the archive is what the module can prove.

**Consequences**: the recorded protocol is one artifact, so `retry` restores exactly what npm received and no report can go stale beside it. Promotion requires permission to update npm dist-tags. [ADR 0008](0008-npm-trusted-publishing-for-publish-and-promotion.md) records how publication and promotion authenticate.

**Considered options**: a bag of shell commands; exported policy helpers; consumer-implemented restore; `gitHead` instead of `elmeraRelease`; the original archive-report-and-receipt bundle, rejected because the module can derive every recorded fact from the archive alone and the receipt never crossed a process boundary.
