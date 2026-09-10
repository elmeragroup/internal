# The consumer seam is pack-and-verify

The module owns eligibility, reservations, records, bundle identity, pending-then-dist-tag promotion, and retry. The consumer stamps packed identity, builds, packs, verifies, and returns the archive, report, and receipt. The module binds the bundle and restores it on retry. Packed identity lives in `elmeraRelease` on the packed manifest, not only in the source tree.

**Consequences**: the initial publication protocol preserves Internal's token authentication and requires permission to update npm dist-tags. UI's [release runbook](https://github.com/elmeragroup/ui/blob/main/docs/spec/release.md) requires token-free OIDC publishing. [npm's documented OIDC support](https://docs.npmjs.com/trusted-publishers/#limitations-and-future-improvements) covers publication commands, not the separate dist-tag update. Resolving promotion authentication is an open prerequisite for UI adoption; the build adapter alone cannot resolve it. Record that decision before adoption, preserving archive verification and channel ordering without silently introducing a token into UI.

**Considered options**: a bag of shell commands; exported policy helpers; consumer-implemented restore; `gitHead` instead of `elmeraRelease`.
