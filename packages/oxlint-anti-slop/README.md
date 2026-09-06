# @elmeragroup/oxlint-plugin-anti-slop

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

## Tests

Run the rule tests with Node 24:

```sh
pnpm --filter @elmeragroup/oxlint-plugin-anti-slop test
```
