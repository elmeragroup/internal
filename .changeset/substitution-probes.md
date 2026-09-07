---
"@elmeragroup/internal": patch
---

Discard diagnostics and provenance recorded while probing a rejected substitution candidate. A successful fallback now keeps only the evidence of the candidate whose model is returned, and exhaustion still reports the original unsupported-type warning.
