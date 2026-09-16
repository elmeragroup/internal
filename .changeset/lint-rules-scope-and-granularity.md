---
"@elmeragroup/internal": patch
---

The `oxlint/anti-slop` rule `no-unknown-type-aliases` now reports aliases nested in functions, namespaces, static blocks, and switch cases, and `no-unknown-parameters` reports a parameter's own name for parameter properties and destructured defaults. The `oxlint` plugin's `no-primitive-colors` rule reports each offending class string once and every offending string in a `cn`/`tv` call instead of only the first, `no-rac-outside-quarantine` anchors its allowlist to `packages/ui/src/react-aria/**`, and `no-hardcoded-density-metrics` only treats a control-height pin as a file pin when it appears in code.
