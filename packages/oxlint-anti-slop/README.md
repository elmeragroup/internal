# @elmeragroup/oxlint-plugin-anti-slop

Private implementation of `@elmeragroup/internal/oxlint/anti-slop`.

Vendored copy of [`dmmulroy/anti-slop`](https://github.com/dmmulroy/anti-slop) `src/`.

- Upstream commit: `446268e5d15baa968eaec669ff65358d36ae6259`
- Refresh is a manual diff against that repo; there are no upstream releases.

## Local divergence

`rules/no-slop-comments.ts` and `rules/no-narration-comments.ts` are local rules, not
part of upstream. Keep them, their `index.ts` registrations, and
`shared/slop-comments.ts` when refreshing the vendored files.

`no-slop-comments` takes one option, `ticketPattern` (regex source, default
`[A-Z][A-Z0-9]*-\d+`), for the bare ticket ids that count as a tracker reference.
The root `.oxlintrc.json` sets it to `ELM-\d+`.

`no-slop-comments` and `no-narration-comments` offer a `removeComment` suggestion
only when the deletion cannot join tokens or drop a line terminator: `//` comments,
and block comments that start or end their line. Inline block comments with code on
both sides are still reported without a suggestion. The predicate is
`isSafeCommentRemoval` in `shared/slop-comments.ts`.

`shared/type-name-scope.ts` and the scope-aware resolution in
`shared/dictionary-types.ts`, `rules/no-object-parameters.ts`,
`rules/no-unknown-returns.ts` and `rules/no-unknown-type-aliases.ts` are local
changes: type names resolve in their lexical scope instead of a module-level
alias table, and the module-internal `resolveAliasTarget` chases a bare
reference to the single non-generic local alias it names. `resolvesThroughAliases`
is the one walk from a type to a keyword leaf through parentheses, aliases, and
the enabled container steps (`throughUnions`, `throughPromises`); the unshadowed
`Promise`/`PromiseLike` descent lives there rather than in each rule. Scope containers include `StaticBlock`, whose
`body` is a statement list, so inner type aliases in `class C { static { ... } }`
are found. `TSImportEqualsDeclaration` locals, including
`import Promise = require("./p")`, are recorded as `shadowed`, and any other
identifier-bearing declaration kind fail-closes as `shadowed` so lookup never
walks to an outer name. Keep them when refreshing the vendored upstream files.

`shared/variable-scope.ts`, `shared/function-parameters.ts` and
`shared/expression-unwrapping.ts` are also local: they own the lexical
variable-scope walk, parameter annotation unwrapping with the diagnostic
parameter name, the `FunctionLikeNode` union with the ten-key
`functionLikeVisitors` table the rules share, and the transparent expression
unwrapping with the empty-object predicate that upstream inlines in several
rules. Keep them, and the rules importing them, when refreshing the vendored
upstream files.

## Tests

Run the rule tests and type-check with Node 24:

```sh
pnpm --filter @elmeragroup/oxlint-plugin-anti-slop test
pnpm --filter @elmeragroup/oxlint-plugin-anti-slop type-check
```

## Lint exemptions

The package-wide rule exemptions in the root `.oxlintrc.json` and why each is load-bearing are
recorded in [docs/lint-exemptions.md](../../docs/lint-exemptions.md).
