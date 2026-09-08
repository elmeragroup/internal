# Plan 002: Preserve executable syntax in comment-removal suggestions

> Executor instructions: Read this entire plan before editing. Follow each step and its expected verification result. On a STOP condition, report the specific blocker instead of expanding scope. Update this plan's status, its row in plans/README.md, and the 002 line under "Decisions made in these plans" in plans/README.md when complete, unless a reviewing operator owns those updates.
>
> Drift check: `git diff --stat e9ad9b3..HEAD -- 'packages/oxlint-anti-slop/rules/no-slop-comments.ts' 'packages/oxlint-anti-slop/rules/no-slop-comments.test.ts' 'packages/oxlint-anti-slop/rules/no-narration-comments.ts' 'packages/oxlint-anti-slop/shared/slop-comments.ts' 'packages/oxlint-anti-slop/README.md' '.changeset/safe-comment-removal.md' 'plans/002-safe-comment-removal.md' 'plans/README.md'`
> If implementation files changed, compare the excerpts below to live code. If they no longer match, stop for reconciliation. New plan files alone are expected and do not indicate implementation drift. Also inspect `git status --short` for uncommitted edits before starting.

## Status

- Status: TODO
- Finding: 2 from the deep audit
- Priority: P1
- Effort: S, including regression coverage
- Fix risk: LOW
- Depends on: none
- Category: bug
- Planned at: commit `e9ad9b3`, 2026-09-08
- Reviewed: 2026-09-08 against `e9ad9b3`; every "Verified today" output below was reproduced with the rule tester
- Confidence: HIGH, reproduced during the audit and again during plan review

## Why this matters

`no-slop-comments` reports slop comments (banners, commented-out code, panic prose, unlinked TODOs) and attaches an editor suggestion, `removeComment`, that deletes the comment. Suggestions are opt-in in editors, but a user who accepts one expects a whitespace-only change. Today the suggestion deletes the comment plus the spaces before it, so for an inline block comment it can join two tokens (`return/* TODO */x` becomes `returnx`) or remove a multi-line comment that JavaScript's automatic semicolon insertion treats as a line terminator (`return /*\n TODO\n*/ x` means `return; x;`, the suggestion turns it into `return x`). Both change program behavior. Diagnostics must keep firing; only the suggestion must become safe.

## Current state

### Verified today (rule tester, commit `e9ad9b3`)

Each row is the `output` the current `removeComment` suggestion produces. The first two are the bug. The rest are correct and must be preserved unchanged.

| Input `code`                                                | Current suggestion output      | Verdict                            |
| ----------------------------------------------------------- | ------------------------------ | ---------------------------------- |
| `function f(){ return/* TODO */x; }`                        | `function f(){ returnx; }`     | BUG: joins tokens                  |
| `function f(){ return /*\n TODO\n*/ x; }`                   | `function f(){ return x; }`    | BUG: deletes an ASI terminator     |
| `function f(){ return /*\r\n TODO\r\n*/ x; }`               | `function f(){ return x; }`    | BUG: same, CRLF                    |
| `const c = a/* TODO */+b;`                                  | `const c = a+b;`               | Harmless here, same inline shape   |
| `/* ********** */\nconst a = 1;`                            | `const a = 1;`                 | Correct, standalone block          |
| `/*\nif (user) {\n  return user.name;\n}\n*/\nconst a = 1;` | `const a = 1;`                 | Correct, standalone block          |
| `/* TODO */ const a = 1;`                                   | ` const a = 1;`                | Correct, block starts the line     |
| `const a = 1; /* TODO */\nconst b = 2;`                     | `const a = 1;\nconst b = 2;`   | Correct, block ends the line       |
| `const a = 1;\n  // TODO later\n  const b = 2;`             | `const a = 1;\n  const b = 2;` | Correct, standalone line comment   |
| `const a = 1;\r\n// TODO later\r\nconst b = 2;`             | `const a = 1;\r\nconst b = 2;` | Correct, CRLF line comment         |
| `function f(){ return// TODO\n x; }`                        | `function f(){ return\n x; }`  | Correct, trailing line comment     |
| `// ----------------------------------\nconst a = 1;`       | `const a = 1;`                 | Correct, already asserted in tests |

The `\n` and `\r\n` in the table are the escape sequences inside the JavaScript string literal, exactly as they must appear in test code.

### Files

- `packages/oxlint-anti-slop/shared/slop-comments.ts` — helpers shared by the two local comment rules. `commentRemovalRange` (line 92) computes the deletion range: the comment, the spaces/tabs before it on its line, and, when nothing but indentation precedes it, the line terminator after it.
- `packages/oxlint-anti-slop/rules/no-slop-comments.ts` — the rule. `report` (line 185) builds the suggestion from the first and last comment of a group. Groups with more than one comment are always runs of standalone `//` comments (`groupAdjacentLineComments`, line 121); a block comment is always a group of one.
- `packages/oxlint-anti-slop/rules/no-narration-comments.ts` — the other caller of `commentRemovalRange` (line 90). It only reports comments that pass `isStandaloneLineComment` (line 57), so its suggestion is already safe. It needs no change; it is listed in the drift check so a change to the shared helper is noticed.
- `packages/oxlint-anti-slop/rules/no-slop-comments.test.ts` — the rule's tests, one `tester.run` call with `valid` and `invalid` arrays. Only two invalid cases (lines 66 and 130) assert `suggestions`; the block-comment cases at lines 80, 98, 122, 127 and 250 do not, so their suggestion output is currently unverified.
- `packages/oxlint-anti-slop/shared/rule-tester.ts` — `createRuleTester()` wraps `RuleTester` from `oxlint/plugins-dev`.
- `packages/oxlint-anti-slop/README.md` — has a "Local divergence" section (line 10) describing the two local rules.

`packages/oxlint-anti-slop/shared/slop-comments.ts:85-103`:

```ts
/** A `//` comment with nothing but indentation before it on its line. */
export function isStandaloneLineComment(sourceCode: SourceCode, comment: ESTree.Comment): boolean {
  if (comment.type !== "Line") return false;
  const line = sourceCode.lines[comment.loc.start.line - 1];
  return line !== undefined && line.slice(0, comment.loc.start.column).trim() === "";
}

export function commentRemovalRange(sourceCode: SourceCode, comment: ESTree.Comment): [number, number] {
  const text = sourceCode.text;
  let start = comment.start;
  while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start -= 1;
  const ownsLine = start === 0 || text[start - 1] === "\n";
  let end = comment.end;
  if (ownsLine) {
    if (text[end] === "\r") end += 1;
    if (text[end] === "\n") end += 1;
  }
  return [start, end];
}
```

`packages/oxlint-anti-slop/rules/no-slop-comments.ts:184-196`:

```ts
  createOnce(context) {
    const report = (comments: ESTree.Comment[], messageId: SlopMessageId) => {
      const first = comments.at(0);
      const last = comments.at(-1);
      if (first === undefined || last === undefined) return;
      const [start] = commentRemovalRange(context.sourceCode, first);
      const [, end] = commentRemovalRange(context.sourceCode, last);
      context.report({
        loc: { start: first.loc.start, end: last.loc.end },
        messageId,
        suggest: [{ messageId: "removeComment", fix: (fixer) => fixer.removeRange([start, end]) }],
      });
    };
```

`packages/oxlint-anti-slop/rules/no-slop-comments.ts:154-157` (the rule already declares suggestions and has no `fixable`; keep it that way):

```ts
export const noSlopCommentsRule = defineRule({
  meta: {
    type: "suggestion",
    hasSuggestions: true,
```

### The safety rule to implement

Deleting `commentRemovalRange(comment)` is safe when the deleted span cannot be the only separator between two tokens. That holds when:

1. the comment is a `Line` comment: it never contains a line terminator, and the terminator after it is only deleted when nothing but indentation precedes the comment, so the tokens around it stay separated; or
2. the comment is a `Block` comment and either nothing but spaces/tabs precedes it on its line (the line terminator before it survives), or nothing but spaces/tabs follows it up to the next line terminator or end of file (that terminator survives, and a multi-line comment that acted as an ASI terminator is replaced by a real one).

Everything else, an inline block comment with code on both sides on its own lines, gets the diagnostic but no suggestion. This needs no lexer: it is two string checks around the existing range. Do not try to make inline blocks safe by replacing them with a space; that is a different design and out of scope.

This is a narrower policy than the one recorded in `plans/README.md` ("removes their deletion suggestions" for all block comments). Standalone block corpses such as the `/*\nif (user) {...}\n*/` case are the most common block-comment slop and their deletion is provably safe, so the suggestion is kept for them. Update the README index line when finishing (Step 4).

### RuleTester facts (oxlint 1.78.0, `oxlint/plugins-dev`)

- An invalid-case error object with no `suggestions` property is not checked for suggestions at all.
- `suggestions: null` asserts the diagnostic has no suggestions. `suggestions: []` also passes when there are none. Use `null`; the declared type is `ErrorSuggestion[] | null`.
- A string error (not an object) asserts the diagnostic has no suggestions and fails otherwise.
- Each expected suggestion needs `messageId` (or `desc`) and `output`; `output` must differ from `code`.
- On the rule side, `context.report` with no `suggest` key or with `suggest: []` both yield a diagnostic with `suggestions === null`.
- The test file is a single `node:test` test, so the focused command reports `tests 1`. A failing case fails that one test with an assertion message naming the case (`name` or code) and the mismatch.

## Conventions and test pattern

Read root README.md and AGENTS.md before implementation, plus `packages/oxlint-anti-slop/README.md`. Match strict typing, kebab-case filenames, separate type imports (`import type { ESTree, SourceCode } from "@oxlint/plugins";` as in `shared/slop-comments.ts:1`), `.oxlintrc.json` and `.oxfmtrc.json` (110 columns, double quotes, LF). Root lint runs `oxlint . --deny-warnings` over this package. Fix the underlying issue before adding a lint exception.

Keep the lint implementation private; it is bundled through `@elmeragroup/internal`'s explicit lint entries and must not load TypeScript or Effect. Use the existing `defineRule`/`createOnce` and `createRuleTester` patterns. Preserve the vendored `LICENSE`; the two local rules are documented as local divergence in the package README.

Test cases follow the existing shape in `packages/oxlint-anti-slop/rules/no-slop-comments.test.ts:130-139`:

```ts
    {
      name: "adjacent line comments form one call corpse",
      code: "// sendRequest(\n//   url,\n//   options,\n// );\nconst a = 1;",
      errors: [
        {
          messageId: "commentedOutCode",
          suggestions: [{ messageId: "removeComment", output: "const a = 1;" }],
        },
      ],
    },
```

Give every new case a `name`. Do not use snapshot files; `output` strings are written inline.

## Commands you will need

Run commands from the repository root. Use Node 24.13.0 from `.node-version` and pnpm 11.20.0 from `package.json`. Preserve the pinned TypeScript 7.0.2 and Effect 4.0.0-rc.111 catalog versions.

- Check runtime: `node --version` prints v24.13.0; `pnpm --version` prints 11.20.0.
- If dependencies are absent: `pnpm install --frozen-lockfile` exits 0 without a lockfile diff. Do not upgrade dependencies to unblock installation.
- Baseline: `pnpm build` exits 0. Root lint and the packed-consumer test depend on the built `@elmeragroup/internal`.
- Focused regression command (package tests run from the package directory, so the same is done here): `cd packages/oxlint-anti-slop && node --experimental-strip-types --test rules/no-slop-comments.test.ts`. Baseline today: `tests 1`, `pass 1`, `fail 0`.
- Package tests: `pnpm --filter @elmeragroup/oxlint-plugin-anti-slop test` exits 0 (runs `rules/*.test.ts`, 14 files today).
- Root lint: `pnpm lint` exits 0.
- Formatting: `pnpm exec oxfmt --check <changed files>` exits 0 for `.ts` and `.md` files.
- Workspace gate: `pnpm ci:checks` exits 0.
- Package verification: `pnpm packages:pack && pnpm test:packed-consumer` exits 0, in that order.

The audit ran focused tests with installed executables because pnpm's pinned-version bootstrap could not fetch signature data. A failed bootstrap is an environment blocker, not evidence that a dependency upgrade is needed. Record it; do not bypass signature validation. The audit did not run a complete fresh-build/packed baseline, so establish it before attributing unrelated failures to this change.

## Scope

Only modify these paths. No new files other than the changeset.

- `packages/oxlint-anti-slop/shared/slop-comments.ts` — add the safety predicate next to `commentRemovalRange`
- `packages/oxlint-anti-slop/rules/no-slop-comments.ts` — consult the predicate in `report`
- `packages/oxlint-anti-slop/rules/no-slop-comments.test.ts` — regression cases
- `packages/oxlint-anti-slop/README.md` — one paragraph in "Local divergence"
- `.changeset/safe-comment-removal.md` (create)
- `plans/002-safe-comment-removal.md`
- `plans/README.md` — status row and the 002 line under "Decisions made in these plans"

Everything else is out of scope, including `rules/no-narration-comments.ts` (already safe, see Current state), `commentRemovalRange` itself (its range semantics are correct and shared; do not change them), dependency versions, lockfiles, unrelated source refactors, `packages/internal` export maps, upstream fixture `output.json` files, immutable timing evidence and publication credentials. Build outputs in ignored `dist/`, `.turbo/`, `.cache/`, `.artifacts/` directories are normal verification products, not source changes.

## Git workflow

The advisor branch is `codex/deep-audit-plans`. For implementation, use an isolated branch such as `codex/fix-safe-comment-removal` from the operator's approved base; keep unrelated working changes intact. Do not create a second implementation branch if the operator already supplied one. Do not commit, push, publish or open a PR unless the operator requested that action. If a commit is requested, use a conventional subject such as `fix: preserve executable syntax in comment-removal suggestions` (recent history: `docs: add repository agent guidance`, `chore: version packages (#3)`).

## Steps

### Step 1: Pin the unsafe and the safe suggestion behavior in tests

In `packages/oxlint-anti-slop/rules/no-slop-comments.test.ts`, inside `invalid`:

1. Add these new cases. `suggestions: null` means "no suggestion offered"; these are the regressions.

   | `name`                                                     | `code`                                        | `errors`                                                |
   | ---------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------- |
   | inline block between keyword and identifier has no removal | `function f(){ return/* TODO */x; }`          | `[{ messageId: "todoWithoutLink", suggestions: null }]` |
   | inline block between operands has no removal               | `const c = a/* TODO */+b;`                    | `[{ messageId: "todoWithoutLink", suggestions: null }]` |
   | multi-line block after return has no removal               | `function f(){ return /*\n TODO\n*/ x; }`     | `[{ messageId: "todoWithoutLink", suggestions: null }]` |
   | CRLF multi-line block after return has no removal          | `function f(){ return /*\r\n TODO\r\n*/ x; }` | `[{ messageId: "todoWithoutLink", suggestions: null }]` |

2. Add these new cases pinning behavior that must stay. Each has one suggestion `{ messageId: "removeComment", output: <output> }`.

   | `name`                                                     | `code`                                          | `output`                       |
   | ---------------------------------------------------------- | ----------------------------------------------- | ------------------------------ |
   | block that starts its line keeps its removal               | `/* TODO */ const a = 1;`                       | ` const a = 1;`                |
   | block that ends its line keeps its removal                 | `const a = 1; /* TODO */\nconst b = 2;`         | `const a = 1;\nconst b = 2;`   |
   | indented standalone line comment keeps its line terminator | `const a = 1;\n  // TODO later\n  const b = 2;` | `const a = 1;\n  const b = 2;` |
   | CRLF standalone line comment removes one line              | `const a = 1;\r\n// TODO later\r\nconst b = 2;` | `const a = 1;\r\nconst b = 2;` |
   | trailing line comment keeps the newline                    | `function f(){ return// TODO\n x; }`            | `function f(){ return\n x; }`  |

3. Add explicit `suggestions` to the existing standalone-block cases that have none, so their output is asserted rather than ignored:
   - line 80, `/* ********** */\nconst a = 1;` → `suggestions: [{ messageId: "removeComment", output: "const a = 1;" }]`
   - line 98, `/*\nif (user) {\n  return user.name;\n}\n*/\nconst a = 1;` → same output `const a = 1;`
   - line 122, `/*\nsendRequest(url, options);\n*/\nconst a = 1;` → same output `const a = 1;`

   Leave every other existing case exactly as it is.

**Verify:** `cd packages/oxlint-anti-slop && node --experimental-strip-types --test rules/no-slop-comments.test.ts`

Expected: `fail 1`, and the assertion message is `Rule produced suggestions` for one of the four `suggestions: null` cases from item 1 (the tester stops at the first failing case). It must not be a compile, import, or `Failed to apply suggestion fix` error. If the failure comes from a case in item 2 or 3, the "Verified today" table no longer matches the code: STOP.

### Step 2: Add the safety predicate to the shared helper

In `packages/oxlint-anti-slop/shared/slop-comments.ts`, directly after `commentRemovalRange`, add an exported predicate. Target shape (adjust names only if a lint rule objects):

```ts
/**
 * Whether deleting `commentRemovalRange(comment)` can never join two tokens or remove
 * the only line terminator between them. Line comments always qualify. A block comment
 * qualifies when only indentation precedes it on its line or only whitespace follows it
 * before the next line terminator; an inline block with code on both sides does not.
 */
export function isSafeCommentRemoval(sourceCode: SourceCode, comment: ESTree.Comment): boolean {
  if (comment.type === "Line") return true;
  const text = sourceCode.text;
  const [start] = commentRemovalRange(sourceCode, comment);
  if (start === 0 || text[start - 1] === "\n") return true;
  const restOfLine = text.slice(comment.end).match(/^[^\r\n]*/u)?.[0] ?? "";
  return restOfLine.trim() === "";
}
```

Do not modify `commentRemovalRange` or `isStandaloneLineComment`.

**Verify:** `pnpm exec oxfmt --check packages/oxlint-anti-slop/shared/slop-comments.ts` → exits 0. Then the focused regression command from Step 1 still reports `fail 1` (nothing consumes the predicate yet).

### Step 3: Offer the suggestion only when every comment in the group is safe

In `packages/oxlint-anti-slop/rules/no-slop-comments.ts`:

1. Add `isSafeCommentRemoval` to the import list from `../shared/slop-comments.ts` (keep the list alphabetical; the formatter sorts members).
2. In `report`, keep `loc` and `messageId` as they are and attach `suggest` only when `comments.every((comment) => isSafeCommentRemoval(context.sourceCode, comment))`. Either build the descriptor conditionally or pass `suggest: []` in the unsafe branch; both produce a diagnostic with no suggestions. Do not add `meta.fixable`; do not change any message text or message id; do not change `groupAdjacentLineComments` or `reportSingle`.

**Verify:** `cd packages/oxlint-anti-slop && node --experimental-strip-types --test rules/no-slop-comments.test.ts` → `tests 1`, `pass 1`, `fail 0`. Then `pnpm --filter @elmeragroup/oxlint-plugin-anti-slop test` → exits 0, all 14 test files pass (this confirms `no-narration-comments` is unaffected). Then `pnpm lint` → exits 0.

### Step 4: Document, add the release note, and run the final gates

1. In `packages/oxlint-anti-slop/README.md`, under "Local divergence", add one short paragraph: `no-slop-comments` and `no-narration-comments` offer a `removeComment` suggestion only when the deletion cannot join tokens or drop a line terminator: `//` comments, and block comments that start or end their line. Inline block comments with code on both sides are still reported without a suggestion. Point at `isSafeCommentRemoval` in `shared/slop-comments.ts`.
2. Create `.changeset/safe-comment-removal.md`:

   ```md
   ---
   "@elmeragroup/internal": patch
   ---

   The `anti-slop/no-slop-comments` lint rule no longer offers its "Delete this comment" suggestion for a block comment that has code on both sides of it on the same line, such as `return/* TODO */x` or a multi-line comment between `return` and its value. Accepting that suggestion could join tokens or change automatic semicolon insertion. The diagnostic itself is unchanged, and suggestions for `//` comments and for block comments that start or end their line still delete the comment as before.
   ```

   Only the umbrella package receives a release. Do not version a private workspace or edit package versions or lockfiles.

3. In `plans/README.md`, update the 002 status row and replace the 002 line under "Decisions made in these plans" so it describes the implemented policy: suggestions are kept for line comments and for block comments that start or end their line; only inline block comments lose the suggestion.
4. Run `pnpm ci:checks`, then `pnpm packages:pack && pnpm test:packed-consumer`. Run `pnpm exec oxfmt --check` on every changed `.ts` and `.md` file. Inspect `git diff --check`, `git diff --name-only` and `git status --short`; every changed tracked file must be in Scope.

**Verify:** `git diff --check` → exit 0, and every command in item 4 exits 0. Record the actual commands and results in Completion notes, including any blocked check. Do not mark DONE with a failed or skipped required gate.

## Test plan

All in `packages/oxlint-anti-slop/rules/no-slop-comments.test.ts`, as listed in Step 1: four `suggestions: null` regressions (inline block between keyword and identifier, between operands, multi-line block after `return` with LF and with CRLF), five preserved-behavior cases with exact `output` (block starting its line, block ending its line, indented standalone `//`, CRLF standalone `//`, trailing `//` after `return`), and explicit `suggestions` on the three existing standalone-block cases. Existing `valid` cases (directives, `SAFETY:`, license headers) are unaffected by this change and need no additions.

Run the focused regression command after each step: Step 1 must fail only with `Rule produced suggestions`; Steps 3 and 4 must pass. Keep the regressions after the fix; do not replace `output` strings with whatever the rule currently emits.

## Done criteria

- [ ] `isSafeCommentRemoval` exists in `packages/oxlint-anti-slop/shared/slop-comments.ts` and `report` in `no-slop-comments.ts` uses it; `commentRemovalRange` is unchanged (`git diff e9ad9b3 -- packages/oxlint-anti-slop/shared/slop-comments.ts` shows only additions).
- [ ] `grep -n "fixable" packages/oxlint-anti-slop/rules/no-slop-comments.ts` returns nothing; `hasSuggestions: true` remains.
- [ ] The focused regression command reports `pass 1`, `fail 0`, and the test file contains all nine new named cases from Step 1 plus explicit `suggestions` on the three existing standalone-block cases.
- [ ] `pnpm --filter @elmeragroup/oxlint-plugin-anti-slop test` exits 0; `rules/no-narration-comments.ts` is unmodified.
- [ ] `pnpm lint` and `pnpm ci:checks` exit 0.
- [ ] `pnpm packages:pack && pnpm test:packed-consumer` exits 0.
- [ ] `git diff --check` exits 0, and `git diff --name-only` lists only Scope paths.
- [ ] `.changeset/safe-comment-removal.md` exists with the `"@elmeragroup/internal": patch` frontmatter.
- [ ] `packages/oxlint-anti-slop/README.md` "Local divergence" describes the suggestion policy.
- [ ] This plan's Status and Completion notes, the `plans/README.md` status row, and its 002 decision line reflect the implemented behavior; no skipped gate is described as passing.

## STOP conditions

Stop and report if:

- The Step 1 verification fails for a reason other than `Rule produced suggestions` on one of the four new `suggestions: null` cases; the "Verified today" table then no longer describes the code.
- The excerpts in Current state do not match the live files (drift since `e9ad9b3`).
- `RuleTester` in the installed oxlint rejects `suggestions: null` on an error object (check `node_modules/oxlint/dist/plugins-dev.d.ts` for `suggestions?: ErrorSuggestion[] | null` before improvising an alternative).
- Making the fix pass appears to require changing `commentRemovalRange`, `no-narration-comments.ts`, or any out-of-scope file.
- A required gate fails twice after a focused fix attempt. Report pre-existing or environment failures (for example the pnpm bootstrap signature fetch) separately from failures caused by this change.

Never modify immutable evidence, suppress a diagnostic, weaken or delete a test, or widen the scope to a token-aware auto-fixer or to a "replace the comment with a space" fix.

## Maintenance notes

- `isSafeCommentRemoval` and `commentRemovalRange` are a pair: any change to the range (for example also deleting a following line terminator for trailing comments) must be re-checked against the ASI hazard, and the four `suggestions: null` regressions must keep passing.
- If a future change wants suggestions for inline block comments, it needs a replacement fix (insert a space) plus tests for token joining and for multi-line comments after `return`, `throw`, `break`, `continue`, `yield`, and postfix `++`/`--`, not a deletion.
- `no-narration-comments` is safe only because `isNarration` requires `isStandaloneLineComment`. If that rule ever reports block or trailing comments, it must also consult `isSafeCommentRemoval`.
- Reviewers should scrutinize that message ids and messages are unchanged and that no existing `output` assertion was edited.
- Preserve these local rules, the shared helper, and their tests when refreshing the vendored upstream files, as the package README already instructs.

## Completion notes

Not implemented. Record the implementing revision, regression results, full gate results and any reviewed scope changes here.
