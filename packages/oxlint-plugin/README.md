# @elmeragroup/oxlint-plugin

Private Elmera lint rules, exported as the `elmera` Oxlint plugin and bundled into
`@elmeragroup/internal/oxlint`. The root `.oxlintrc.json` registers the plugin as `elmera`, so rule
ids are used as `elmera/<rule-name>`.

Each rule lives in `rules/<rule-name>.js` and is registered in `index.js`. The other modules are
shared helpers: `filename-normalizer.js` (POSIX path checks, test-file predicate), `class-tokens.js`
(whitespace tokenization), `extract-strings.js` (string literal collection), `forbidden-rac-packages.js`
(quarantined package policy), `variant-props-proof.js` (VariantProps proof walking), and
`rule-tester.js` (Vitest-wired `RuleTester`).

## Rule inventory

| Rule                                | Purpose                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `enforce-variant-standard`          | Recipe structure: named `tv()` const, inline object, `defaultVariants` with axes, `VariantProps` typing on component files |
| `facade-reexport-grammar`           | `src/<name>.ts(x)` and `src/react-aria/<name>.ts(x)` facades are explicit named re-exports only                            |
| `no-field-part-jsx`                 | Labeled composites must render `Field.*` parts through `FieldFrame`                                                        |
| `no-hardcoded-density-metrics`      | Density-owned heights, gaps, padding, and control type must read `--control-*` variables, not numeric literals             |
| `no-internal-dynamic-import`        | No `import()` in library source; apps own code splitting                                                                   |
| `no-local-focus-ring`               | Focus-ring classes come from the `focusRing` recipe in `src/styles/utils.ts`                                               |
| `no-primitive-colors`               | No raw palette classes or hex/oklch/rgb literals; use role tokens                                                          |
| `no-rac-outside-quarantine`         | React Aria packages are importable only from the `src/react-aria` quarantine                                               |
| `no-raw-class-map`                  | Class maps and hand-spelled class constants must be `tv()` recipes or `cn()`                                               |
| `no-tailwind-dark-variant`          | No Tailwind `dark:` variant; the dark axis is token-reserved behind `[data-theme="dark"]`                                  |
| `require-icon-button-label`         | Icon-only `*Button` JSX needs a nonempty `aria-label`                                                                      |
| `restrict-browser-helper-copy`      | Browser suites import the shared harness helpers instead of re-declaring them                                              |
| `restrict-focus-ring-call`          | `focusRing({…})` calls live in `styles/utils.ts` and `react-aria/link` only                                                |
| `restrict-package-root-from-script` | `dirname(fileURLToPath(import.meta.url))` lives only in `scripts/paths.ts`                                                 |
| `restrict-process-env`              | Direct `process.env` access only for the `NODE_ENV` comparison in the theme validator                                      |

## Fixed-path assumptions

Owners, quarantines, and skips are recognized by path suffix. Lint runs from the repository root so
filenames contain the package path (`packages/ui/...`).

| Rule                                | Assumption                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `enforce-variant-standard`          | `src/components/<name>/<name>.tsx` and `src/components/<name>/<name>-variants.ts`                                                     |
| `facade-reexport-grammar`           | `src/<name>.ts(x)` and `src/react-aria/<name>.ts(x)`, excluding `src/index.ts(x)`                                                     |
| `no-field-part-jsx`                 | Exact labeled-composite paths such as `src/components/text-field/text-field.tsx`                                                      |
| `no-hardcoded-density-metrics`      | A file-level `--control-h-` pin counts only when it appears in code; a comment that mentions the variable is documentation, not a pin |
| `no-local-focus-ring`               | Owner `src/styles/utils.ts`                                                                                                           |
| `no-rac-outside-quarantine`         | Quarantine is exactly `packages/ui/src/react-aria/**`; another package's `src/react-aria/` is not the quarantine                      |
| `no-raw-class-map`                  | Skips `*.test.ts(x)`, `*.test-d.tsx`, `/intl/`, and `/generated/`                                                                     |
| `restrict-browser-helper-copy`      | Owner `test/themed-browser-render.tsx`; every other file is a suite                                                                   |
| `restrict-focus-ring-call`          | Owners `src/styles/utils.ts` and `src/react-aria/link/link.tsx`, plus any test file                                                   |
| `restrict-package-root-from-script` | Owner `scripts/paths.ts`                                                                                                              |
| `restrict-process-env`              | Validator `src/theme/validate-theme.ts`; `NODE_ENV` comparisons with `===`, `!==`, `==`, and `!=` are allowed there and nowhere else  |

## Tests

Run the rule-tester suites and type-check with Node 24:

```sh
pnpm --filter @elmeragroup/oxlint-plugin test
pnpm --filter @elmeragroup/oxlint-plugin type-check
```

Each rule has a sibling `rules/<rule-name>.test.js` suite.

## Lint exemptions

The package-wide rule exemptions in the root `.oxlintrc.json` and why each is load-bearing are
recorded in [docs/lint-exemptions.md](../../docs/lint-exemptions.md).
