# Plan 005: Classify client directives from the parsed module prologue

> Follow this self-contained plan in order and record actual verification results.
> Drift check first: `git diff --stat 3994cd4..HEAD -- packages/api-artifacts/src/checker.ts packages/api-artifacts/test/rsc-status.test.ts packages/api-artifacts/test/generate.test.ts packages/api-artifacts/README.md .changeset/rsc-directives.md`.
> Inspect `git status --short`; stop on unexplained changes to the current-state code.

## Status

- Priority: P2
- Effort: S
- Risk: LOW
- Depends on: none; land before 006
- Category: bug
- Original audit finding: 3
- Planned at: commit `3994cd4`, 2026-09-06
- Branch: `codex/plan-005-parse-client-directives-as-syntax`
- Status: DONE

## Repository context

This is a pnpm workspace for Elmera Group build tooling, not a web application.
The public dependency direction is `@elmeragroup/internal` → `@elmeragroup/api-artifacts` →
`@elmeragroup/api-extractor`. The first package supplies consumer defaults, the second writes or checks
component API JSON, and the third produces a compiler-independent semantic model and provenance.
Private packages implement lint rules; `tooling/typescript` owns shared compiler configuration.

Work from the repository root. At planning time it was
`/Users/tommy.lunde.barvag/src/work/elmera/internal`; use the root of your own checkout instead.
Use Node from `.node-version` and pnpm from root `package.json`, currently Node 24.13.0 and pnpm 11.20.0.
TypeScript is pinned to 7.0.2 and Effect to 4.0.0-rc.111 in `pnpm-workspace.yaml`. Do not upgrade either.
TypeScript 7's native API differs from the old TypeScript compiler API; inspect the installed declarations
before using an API you remember from another version.

Read `AGENTS.md` and the affected package README. No separate ADR, CONTEXT.md, or product specification was
found during the audit. Use strict types, separate type imports, kebab-case filenames, and the existing
Oxfmt layout. Oxlint runs with `--deny-warnings`: warnings fail CI. Avoid module mocks. In api-extractor,
never add a file-wide disable or path-wide lint override. A necessary next-line exception names one rule
and includes a `--` reason; type assertions require an accurate `SAFETY:` comment.

If dependencies are already installed, do not reinstall by default. If absent, run
`pnpm install --frozen-lockfile` and expect exit 0 without manifest or lockfile changes. If registry access
or the pinned pnpm runtime is unavailable, report that environment failure. Do not change the package
manager pin or claim skipped checks passed. Direct installed binaries are acceptable for focused
diagnosis, but record any difference from the documented CI commands.

## Why this matters

Generated component documentation exposes a client/server classification. The current helper treats
source code as lines of text and deletes comment-shaped substrings even inside strings.
Valid client components can be labeled server, and ordinary strings can be labeled client.
Use the already-parsed module syntax so formatting and comments cannot change the answer.

## Current state

`packages/api-artifacts/src/checker.ts:53`:

```ts
export function readRscStatus(sourceText: string): RscStatus {
  const withoutComments = sourceText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const line of withoutComments.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    if (/^["'']use client["''];?$/.test(trimmed)) {
      return "client";
    }
    if (/^["''][^"']*["''];?$/.test(trimmed)) {
      continue;
    }
    return "server";
  }
  return "server";
}
```

`readPartSource` already resolves a signature declaration to a node, calls `node.getSourceFile()`, and
passes `sourceFile.text` to this helper. There is no need to start another compiler or parse the file twice.
The helper is internal to the package; it is not exported by `src/index.ts`.

Reproduced inputs:

| Module text                                      | Current | Required |
| ------------------------------------------------ | ------- | -------- |
| `"use client"; // comment` followed by an export | server  | client   |
| `"use client"; export const x = 1;`              | server  | client   |
| `"use /* comment */client";`                     | client  | server   |

The installed package provides `SourceFile.statements` through `typescript/unstable/ast`, and
`isExpressionStatement` / `isStringLiteral` through `typescript/unstable/ast/is`.
These exports were checked during planning. Do not import the historical `typescript.createSourceFile`
API: the installed TypeScript root does not expose that old compiler interface.

Existing integration exemplar in `test/generate.test.ts:62`:

```ts
const root = await fixture();
const result = await generateApiArtifacts(options(root));
expect(result.components[0]?.parts[0]).toMatchObject({
  rsc: "client",
  sourcePath: "button.ts",
  forwardedCount: 0,
});
```

Its `fixture` creates a temporary project, records its root, and removes it in `afterEach`.
Match that cleanup pattern for any additional helper tests.

## Commands you will need

| Purpose            | Command from root                                                                                        | Expected result                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Build dependency   | `pnpm --filter @elmeragroup/api-extractor build`                                                         | Exit 0 before artifact tests if compiled dependency is absent/stale |
| Focused tests      | `pnpm --filter @elmeragroup/api-artifacts exec vitest run test/rsc-status.test.ts test/generate.test.ts` | All pass after fix                                                  |
| Package type check | `pnpm --filter @elmeragroup/api-artifacts type-check`                                                    | Exit 0                                                              |
| Package tests      | `pnpm --filter @elmeragroup/api-artifacts test`                                                          | All pass                                                            |
| Umbrella tests     | `pnpm --filter @elmeragroup/internal test`                                                               | All pass, rebuild artifacts if needed                               |
| Full verification  | `pnpm ci:checks`                                                                                         | Exit 0                                                              |
| Installed consumer | `pnpm canary:pack && pnpm test:packed-consumer`                                                          | Exit 0                                                              |
| Hygiene            | `git diff --check`                                                                                       | Exit 0                                                              |

## Scope

Only the five paths in the drift check may change. Create `rsc-status.test.ts` and a patch changeset for
`@elmeragroup/api-artifacts`. Do not change artifact shape, defaults, prop filtering, wrapper resolution,
generation modes, dependencies, public exports, or extractor code. Wrapper-source resolution is a separate
approved plan and will consume this corrected classifier later.

## Implementation decision

Change the internal helper to accept the existing parsed `SourceFile`, not a raw string.
Walk `sourceFile.statements` in source order:

1. A directive-prologue candidate is an expression statement whose expression is a string literal.
2. Return client for an exact authored single- or double-quoted `use client` literal.
3. Continue past other string-literal directive statements.
4. Stop with server on the first non-directive statement, including imports, declarations,
   parenthesized expressions, and empty statements.
5. Return server if the prologue ends without the client directive.

Use AST node kinds to determine statement boundaries. Comments, BOM, and a valid shebang are trivia,
not statements. Do not manually strip them.
Use the literal's original text when checking exact directive spelling, so an escaped string such as
`"use\\x20client"` is not newly accepted merely because its decoded text matches.
A template literal or parenthesized string is not a directive.

Retain the API's existing binary meaning: server here means no client directive was found in the chosen
source module. This plan does not infer the transitive React server/client module graph.

## Steps

### Step 1: Add output-level regressions

Extend `generate.test.ts` with documented component props and each of the three reproduced sources.
Assert emitted `parts[0].rsc`, not just helper output. Keep the ordinary file-per-fixture setup and cleanup.

**Verify:** run the existing generate test file. The two valid client cases fail with server; the
comment-shaped string case fails with client. Existing generation and drift tests still pass.

### Step 2: Replace text preprocessing with AST prologue traversal

Import the `SourceFile` type separately and the two syntax predicates as values.
Update `readRscStatus` and its existing caller to pass the parsed file. Keep this logic small and explicit.
Do not export an additional public API or cache mutable AST nodes globally.

**Verify:** the generation regressions pass and package type checking exits 0. Run
`rg -n 'readRscStatus' packages/api-artifacts` excluding ignored build output as needed and confirm every
source caller passes a SourceFile.

### Step 3: Add the syntax matrix through a real compiler project

Create `rsc-status.test.ts`. Write its temporary source cases before opening one `openLibraryProject`
for those files; the compiler project is an immutable snapshot. Obtain each source with
`context.program.getSourceFile(absolutePath)`, assert it exists, and call the helper.
Always call `context.close()` in `finally`, even when a case fails.

Cover the test matrix below. A fake object containing only statement kinds is insufficient: the regression
is about actual parsing and trivia.

**Verify:** the focused helper and generation suites pass with the real pinned compiler.

### Step 4: Verify unchanged artifact contracts

Run package, umbrella, repository, and packed-consumer checks. Inspect the changeset to ensure it describes
a classification fix and does not promise graph-level RSC analysis.
Add a short paragraph to the package README explaining exact directive-prologue classification and that
`server` means the selected source module has no client directive, not a transitive module-graph analysis.

**Verify:** all commands exit 0. Existing write/check behavior and mtime assertions remain green.
Only the allowed files and plan status records changed.

## Test plan

Client cases: single/double quotes; optional semicolon; leading blank lines; block and line comments;
trailing line/block comments; same-line following export; preceding other string directives;
BOM; CRLF; valid shebang.

Server cases: empty module; import/declaration before a later client string; template literal;
parenthesized string; `"use /* comment */client"`; line-comment-like content inside a string;
escaped directive spelling; empty statement before the string; and a string followed on the next line by
a continuation such as a call, so it is not a standalone directive expression.

Each table row states a concrete expected classification. Include valid TypeScript parser inputs;
do not use malformed syntax to define product behavior.

## Done criteria

- [ ] All three audit reproductions return the required classification.
- [ ] Syntax matrix and output-level generation tests pass.
- [ ] The classifier consumes the existing AST without starting another compiler.
- [ ] Source caller(s), type checking, umbrella tests, and packed-consumer checks pass.
- [ ] No public data shape or generation behavior changed.
- [ ] Patch changeset and status results are recorded.

## STOP conditions

Stop if the installed AST predicates differ from the verified API, if a caller outside the allowed scope
depends on the helper's raw-string signature, or if fixing classification requires new parsing dependencies.
Do not add a second regex parser. If an edge case turns into a product decision about React's transitive
module graph, leave that outside scope and report it. Stop after two failed corrective attempts.

## Maintenance notes

Keep RSC classification tied to the authored module chosen by source resolution. The next wrapper-source
plan must call this same helper on the recovered implementation SourceFile. Formatting-only source edits
must not alter classification.

## Git and handoff workflow

Use an isolated checkout if other executors are working concurrently. Preserve unrelated changes.
Use the branch named in this plan, with the repository's `codex/` prefix.
Conventional commit example from this repository: `docs: add repository agent guidance`.
Create commits only if the operator authorized them for this execution; a plan is not authorization to
push, publish, open a PR, or run a release. Do not add Co-Authored-By trailers.

The plan and `plans/README.md` are the only documentation files outside the listed implementation scope
that you may update for status and verification results. Mark only this plan's row. Record commands,
results, and any intentionally unrun gates. Use TODO → IN PROGRESS → DONE or BLOCKED with a concrete reason.
If a coordinating reviewer owns the index, send those results to the reviewer instead.
