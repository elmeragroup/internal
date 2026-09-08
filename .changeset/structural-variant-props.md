---
"@elmeragroup/internal": patch
---

`elmera/enforce-variant-standard` now requires a structural connection between a `tv()` recipe with axes and the component's props: `VariantProps` must be imported from `tailwind-variants` and applied to `typeof <recipe>` in an exported props type or a function parameter annotation, directly or through local type aliases, interfaces and intersections. A comment, unused import, string, or a reference to a different recipe no longer satisfies the rule.
