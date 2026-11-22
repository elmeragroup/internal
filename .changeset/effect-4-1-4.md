---
"@elmeragroup/internal": patch
---

Update the pinned `effect` runtime dependency from 4.1.3 to 4.1.4. The bundled release, extractor and artifact code now imports each Effect module from its own subpath (`effect/Effect`, `effect/Schema`, …) instead of the `effect` barrel, which changes the import specifiers in the published JavaScript and declarations, not their behavior.
