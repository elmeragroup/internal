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
`shared/dictionary-types.ts`, `rules/no-object-parameters.ts` and
`rules/no-unknown-returns.ts` are local changes: type names resolve in their
lexical scope instead of a module-level alias table. Scope containers include
`StaticBlock`, whose `body` is a statement list, so inner type aliases in
`class C { static { ... } }` are found. `TSImportEqualsDeclaration` locals,
including `import Promise = require("./p")`, are recorded as `shadowed`, and
any other identifier-bearing declaration kind fail-closes as `shadowed` so
lookup never walks to an outer name. Keep them when refreshing the vendored
upstream files.

## Tests

Run the rule tests with Node 24:

```sh
pnpm --filter @elmeragroup/oxlint-plugin-anti-slop test
```
