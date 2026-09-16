---
"@elmeragroup/internal": patch
---

`retryRelease` no longer reads `.changeset/config.json` and works from a prepared record alone. Checkout, ancestry, and missing-record diagnostics name the commit SHAs, record tag, and tracked branch they were given, a malformed historical `elmeraRelease.commit` is ignored instead of failing every registry read, and `npm publish` re-emits its output on success and includes captured stderr in failures.
