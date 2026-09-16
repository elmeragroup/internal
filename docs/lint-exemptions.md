# Lint exemptions

`.oxlintrc.json` takes no comments, so this file records why each package-wide exemption exists and
that it is load-bearing. Every exemption was re-verified by removing it and running
`oxlint <package> --deny-warnings`: a rule stays disabled only when the package fails without it.

## `packages/oxlint-plugin/**`

The rules are plain JavaScript running on untyped ESTree nodes, so the type-aware checks below
cannot hold. Removing any of them produces errors in the rule implementations themselves (unsafe
member access on `node.parent`, unsafe calls to plugin helpers, `any` in the visitor JSDoc types,
and so on). `anti-slop/no-runtime-typeof` is exempt for the same reason: `typeof` is exactly what
the rules inspect in source text.

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
