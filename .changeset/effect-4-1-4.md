---
"@elmeragroup/internal": patch
---

Update the pinned `effect` runtime dependency from 4.1.3 to 4.1.4. The bundled release, extractor and artifact code now imports each Effect module from its own subpath (`effect/Effect`, `effect/Schema`, …) instead of the `effect` barrel, which changes the import specifiers in the published JavaScript and declarations, not their behavior.

The `@elmeragroup/internal/oxlint` rule `require-disable-reason` now also holds `@effect/tsgo` directives that relax a rule (`@effect-diagnostics <rule>:off`, `:skip-file`, or a severity below `error`) to a `--` reason. Its `directives` option treats `@effect-diagnostics-next-line` as `disable-next-line` and the section form `@effect-diagnostics` as `disable`, and `rules: "one"` counts every `rule:severity` pair on the directive's line and never accepts `*`. A directive that only raises a rule to `error` needs no reason. Code with an unexplained Effect suppression starts failing this rule.
