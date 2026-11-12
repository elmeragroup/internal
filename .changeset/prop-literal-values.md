---
"@elmeragroup/internal": minor
---

`generateApiArtifacts` adds two optional fields to a prop whose type is a finite union of two or more string literals. `values` lists the literals with aliases expanded and `undefined` and `null` removed, so a prop printed as `ButtonSize | undefined` also carries `["lg", "md", "sm"]`. `requires` maps each value that needs other props to its alternatives, read from the arms of a props union. Each alternative lists the extra props of one arm that admits the value, and any one of them is enough: Button's `size="icon"` lists `[["aria-label"]]`. Other props omit both fields. Regenerated artifacts gain the fields, so `check` mode reports drift until committed artifacts are regenerated.
