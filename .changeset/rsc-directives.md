---
"@elmeragroup/internal": patch
---

Classify `"use client"` from the parsed module prologue instead of stripping comments from raw source text. A valid directive with a trailing comment or a same-line export is now client; a comment-shaped string is not. `server` still means the selected source module has no client directive, not a transitive React module-graph analysis.
