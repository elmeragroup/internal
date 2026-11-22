---
"@elmeragroup/internal": patch
---

Update the pinned `effect` runtime dependency from 4.1.3 to 4.1.4. The bundled release, extractor and artifact code now imports each Effect module from its own subpath (`effect/Effect`, `effect/Schema`, …) instead of the `effect` barrel, which changes the import specifiers in the published JavaScript and declarations, not their behavior.

The `@elmeragroup/internal/oxlint` rule `require-disable-reason` now also holds `@effect/tsgo` directives that relax a rule (`:off`, `:skip-file`, or a severity below `error`), read as `@effect/tsgo` 0.70.0 reads them: the leftmost directive on every physical source line, in comments, strings and templates alike. Such a directive outside a comment is reported, since `@effect/tsgo` applies it there too; spell quoted text as `\x40effect-diagnostics`. One in a comment needs its relaxing rule before `--` and a reason after it that is more than further `rule:severity` pairs. The `directives` option treats `@effect-diagnostics-next-line` as `disable-next-line`, and the section form, or any directive with a `skip-file` pair, as `disable`; `rules: "one"` counts every `rule:severity` pair of the directive and never accepts `*`. A directive that only raises a rule to `error` needs no reason. Code with an unexplained Effect suppression, or a relaxing directive in a string, starts failing this rule.
