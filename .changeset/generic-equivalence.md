---
"@elmeragroup/internal": patch
---

Preserve distinct generic signatures during canonicalization. Nested constraints and defaults no longer collapse through render identity, and inner parameter references keep their own lexical bindings instead of following a one-sided rename map.
