# Lint exemptions

`.oxlintrc.json` takes no comments, so this file records why each package-wide exemption exists and
that it is load-bearing. Every exemption was re-verified by removing it and running
`oxlint <package> --deny-warnings`: a rule stays disabled only when the package fails without it.

## `packages/oxlint-plugin/**`

One exemption remains:

- `anti-slop/no-runtime-typeof` — the rules inspect source-level `typeof` expressions and runtime
  value shapes by design; that is the analyzer's input, not the package's own boundary. Removing it
  produces 14 findings across the rule implementations.

The package previously disabled the `typescript/no-unsafe-*` checks and
`typescript/no-redundant-type-constituents`. Those were not about JavaScript: the package had no
`tsconfig.json`, so its JSDoc `import("estree")` types resolved to `error`-typed values. With the
package's own program in place (`tsconfig.json` + `type-check`), all six exemptions are provably
unnecessary — removing them yields zero diagnostics.

## `packages/oxlint-anti-slop/**`

The rule implementations parse untyped ESTree and checker shapes. Each remaining exemption is
load-bearing:

- `typescript/no-unnecessary-condition` — rules deliberately branch on runtime facts the checker
  cannot narrow (node kinds, optional ancestors, token shapes).
- `typescript/prefer-optional-chain` — the equivalent chains would hide the explicit shape checks
  the rules report.
- `anti-slop/no-runtime-typeof` — the rules inspect `typeof` expressions and runtime values by
  design; that is the analyzer's input, not the package's own boundary.
- `anti-slop/no-chained-type-assertions` — ESTree node unions are narrowed through plugin-handle
  casts that TypeScript cannot express.
- `anti-slop/no-unknown-parameters` — rule and helper entry points accept unknown parser input that
  they narrow before use.
- `anti-slop/no-unsafe-dictionary-type` — the shared dictionary helpers model exactly the
  ESTree/checker dictionary shapes the rules analyze.

The package's `typescript/no-unsafe-*` and `typescript/no-redundant-type-constituents` exemptions
were removed once the package joined the workspace TypeScript program (see its `tsconfig.json`);
with the program in place those rules no longer report false positives here.
