---
"@elmeragroup/internal": patch
---

The extractor now publishes diagnostics from a speculative component-props candidate only when the export is recognized as a component. A rejected or uncertain candidate no longer contributes warnings for props that were never returned.
