# Plan 009: Bind packed-consumer verification to the archive actually tested

> Executor instructions: Read this entire plan before editing. Follow each step and its expected verification result. On a STOP condition, report the specific blocker instead of expanding scope. Update this plan's status and its row in plans/README.md when complete, unless a reviewing operator owns those updates.
>
> Drift check: `git diff --stat e9ad9b3..HEAD -- 'scripts/packed-consumer.ts' 'scripts/canary-publish.ts' 'scripts/packed-verification.ts' 'test/packed-verification.test.mjs' 'turbo.json' 'README.md' 'plans/009-bind-packed-verification.md' 'plans/README.md'`
> If implementation files changed, compare the excerpts below to live code. If they no longer match, stop for reconciliation. New plan files alone are expected and do not indicate implementation drift. Also inspect `git status --short` for uncommitted edits before starting.

## Status

- Status: TODO
- Finding: 9 from the deep audit
- Priority: P3
- Effort: M, including regression coverage
- Fix risk: MED
- Depends on: none
- Category: bug
- Planned at: commit `e9ad9b3`, 2026-09-08
- Reviewed: 2026-09-08 against `e9ad9b3`; excerpts and line numbers re-confirmed
- Confidence: HIGH, confirmed by source inspection; concurrent execution was not reproduced during the audit

## Why this matters

`scripts/packed-consumer.ts` installs archive A from the shared `.artifacts/canary` directory, runs four consumer checks, and only then hashes `archive.json` into the receipt `verified.json`. `scripts/canary-pack.ts` deletes and recreates that whole directory on every run. A same-version local repack during the check interval replaces both the archive and the report with B; the receipt then names B although only A was tested, and `canary-publish.ts` accepts it. The publish workflow runs its steps sequentially under a concurrency group, so this is a local overlap correctness gap, not a demonstrated CI vulnerability. After this plan, the receipt is derived only from bytes captured before installation, the consumer installs a private copy of those bytes, and a later report can never be adopted.

## Current state

Files and roles:

- `scripts/release.ts` — shared constants and helpers: `repoRoot`, `archiveDirectory` (`.artifacts/canary`), `packageName`, `run(command, args, cwd)`, `releaseVersion()`, `canaryVersion()`, `archivePath(version)`. Module initialization only resolves paths; it is already imported by `test/release-version.test.mjs`, so it is safe to import from tests.
- `scripts/lib/json-object.mjs` — narrowing helpers `readJsonObject`, `asRecord`, `asString`, `asRecordArray`, `isString`. `test/json-object.mjs` re-exports them for tests. There is no numeric narrowing helper; see Step 2 for how to compare `bytes` without adding one.
- `scripts/canary-pack.ts` — builds the archive and writes `archive.json` with shape `{ version, archive: { name, archive, bytes, sha256 } }` (`archive` is the absolute tarball path, `bytes` is its length, `sha256` its hex digest).
- `scripts/packed-consumer.ts` — the verifier this plan changes (full file is 59 lines).
- `scripts/canary-publish.ts` — the publish preflight this plan changes (full file is 28 lines).
- `test/packed-consumer/{api,types,lint,tree-shaking}.mjs` — the consumer checks. They import `@elmeragroup/internal` only; none reads the archive path or `.artifacts`, so installing from a relocated tarball does not affect them.
- `turbo.json` — `//#test:repo-policy` lists its inputs explicitly (`scripts/packed-consumer.ts`, `scripts/canary-publish.ts`, ...); `//#type-check:scripts` uses `scripts/**` and needs no change.
- `.github/workflows/publish-canary.yml` — runs `pnpm ci:checks`, `pnpm packages:pack`, `pnpm test:packed-consumer`, uploads `.artifacts/canary/`, then `pnpm canary:publish`. Do not change it.

Keep the existing identity checks (receipt `version`, `status`, `archiveReportSha256`; report `archive.name` and `archive.sha256`) and the `archive.json`/`verified.json` schemas. No real npm publication is part of verification.

`scripts/canary-pack.ts:17`:

```text
rmSync(archiveDirectory, { recursive: true, force: true });
mkdirSync(archiveDirectory, { recursive: true });
run("pnpm", ["pack", "--pack-destination", archiveDirectory], packageDirectory);
const archive = archivePath(version);
```

`scripts/packed-consumer.ts:15`:

```text
const consumer = mkdtempSync(resolve(tmpdir(), "elmera-packed-consumer-"));
rmSync(resolve(archiveDirectory, "verified.json"), { force: true });
try {
  writeFileSync(
    resolve(consumer, "package.json"),
    JSON.stringify(
      {
        name: "canary-consumer",
        packageManager: "pnpm@11.20.0",
        private: true,
        type: "module",
        dependencies: { "@elmeragroup/internal": `file:${archivePath(version)}` },
```

`scripts/packed-consumer.ts:36`:

```text
  writeFileSync(resolve(consumer, "pnpm-workspace.yaml"), "autoInstallPeers: false\n");
  cpSync(resolve(repoRoot, "test/packed-consumer"), resolve(consumer, "checks"), { recursive: true });
  run("pnpm", ["install", "--ignore-scripts"], consumer);
  // Node's type stripping is disabled to prove only compiled JavaScript is loaded.
  for (const check of ["api", "types", "lint", "tree-shaking"]) {
    run(process.execPath, ["--no-experimental-strip-types", `checks/${check}.mjs`], consumer);
  }
  writeFileSync(
    resolve(archiveDirectory, "verified.json"),
    `${JSON.stringify(
      {
        version,
        archiveReportSha256: createHash("sha256")
          .update(readFileSync(resolve(archiveDirectory, "archive.json")))
          .digest("hex"),
        status: "pass",
```

`scripts/canary-publish.ts:9`:

```text
const report = readJsonObject(resolve(archiveDirectory, "archive.json"));
const verification = readJsonObject(resolve(archiveDirectory, "verified.json"));
const expected = asRecord(report.archive, "archive");
if (
  verification.status !== "pass" ||
  report.version !== version ||
  verification.version !== version ||
  verification.archiveReportSha256 !==
    createHash("sha256")
      .update(readFileSync(resolve(archiveDirectory, "archive.json")))
      .digest("hex")
)
  throw new Error("Packed consumer verification does not match this archive");
const archive = archivePath(version);
if (
  expected.name !== packageName ||
  asString(expected.sha256, "sha256") !== createHash("sha256").update(readFileSync(archive)).digest("hex")
)
  throw new Error(`${packageName}: archive changed since verification`);
run("npm", ["publish", archive, "--access", "public", "--tag", "canary", "--ignore-scripts"]);
```

## Conventions and test pattern

Read root README.md and AGENTS.md before implementation. Match strict typing, kebab-case filenames, separate type imports (`import type { ... }` on its own line), `.oxlintrc.json` and `.oxfmtrc.json`. Root lint is `oxlint . --deny-warnings` and covers `scripts/**` and `test/**`, so warnings fail too. Rules that will affect a new script file:

- `anti-slop/no-unknown-parameters` (error): do not declare `unknown` parameters. Accept `string`, `Buffer`, named `type` aliases, or `Record<string, unknown>` from `readJsonObject`.
- `anti-slop/no-object-parameters` (error): never use the bare `object` type. A named `type` for a parameter is fine.
- `anti-slop/no-runtime-typeof` (warn, fails the gate): do not narrow with `typeof`. Use `asString`/`asRecord` from `scripts/lib/json-object.mjs`; compare numbers with `!==` against an `unknown` value instead of narrowing first.
- `anti-slop/require-safety-comment-for-type-assertion` (warn): any `as` assertion needs a preceding `// SAFETY: ...` comment; prefer helpers over assertions.
- `typescript/consistent-type-definitions`: use `type`, not `interface`.
- A necessary next-line disable must name one rule and include a `--` reason. Fix the cause first.

Release tooling lives in `scripts/` and repository policy tests live in `test/`. Use explicit paths, typed JSON narrowing and argument-array process invocation (`run` from `scripts/release.ts`, `execFileSync`). Publication remains canary-only. Tests must never invoke a real npm publish or use the user's authenticated registry context.

Use `test/release-version.test.mjs` as the structural pattern. It imports TypeScript scripts directly from a `.mjs` test (lines 9–11), builds a temporary workspace with `mkdtempSync(join(tmpdir(), ...))` and removes it in `finally` (lines 82–124):

```text
import { assertCanaryReleaseVersion, assertReleaseVersion } from "../scripts/release-version.ts";
import { archivePath, packageName } from "../scripts/release.ts";
import { asRecordArray, asString, isString, readJsonObject } from "./json-object.mjs";
```

## Commands you will need

Run commands from the repository root. Use Node 24.13.0 from `.node-version` and pnpm 11.20.0 from `package.json`. Preserve the pinned TypeScript 7.0.2 and Effect 4.0.0-rc.111 catalog versions.

| Purpose              | Command                                                                                  | Expected on success                               |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Runtime              | `node --version && pnpm --version`                                                       | `v24.13.0` and `11.20.0`                          |
| Install              | `pnpm install --frozen-lockfile`                                                         | exit 0, no lockfile diff                          |
| Build baseline       | `pnpm build`                                                                             | exit 0                                            |
| Focused regression   | `pnpm exec vitest run --config test/vitest.config.mjs test/packed-verification.test.mjs` | all pass (after Step 2)                           |
| Script types         | `pnpm type-check:scripts`                                                                | exit 0                                            |
| Lint                 | `pnpm lint`                                                                              | exit 0, no warnings                               |
| Repo policy tests    | `pnpm test:repo-policy`                                                                  | all pass                                          |
| Workspace gate       | `pnpm ci:checks`                                                                         | exit 0                                            |
| Package verification | `pnpm packages:pack && pnpm test:packed-consumer`                                        | exit 0, `.artifacts/canary/verified.json` written |

Never run `pnpm canary:publish`.

The audit ran focused tests with installed executables because pnpm's pinned-version bootstrap could not fetch signature data. A failed bootstrap is an environment blocker, not evidence that a dependency upgrade is needed. Record it; do not bypass signature validation. The audit did not run a complete fresh-build/packed baseline, so establish it before attributing unrelated failures to this change.

## Scope

Only modify these paths. Listed new files may be created.

- `scripts/packed-verification.ts` (create)
- `test/packed-verification.test.mjs` (create)
- `scripts/packed-consumer.ts`
- `scripts/canary-publish.ts`
- `turbo.json` (one input entry only)
- `README.md` (release documentation only)
- `plans/009-bind-packed-verification.md`
- `plans/README.md`

Out of scope, even though related: `scripts/release.ts`, `scripts/canary-pack.ts`, `scripts/lib/json-object.mjs` (if a new narrowing helper seems required, use the comparison technique in Step 2 or STOP), `test/packed-consumer/**`, `.github/workflows/**`, the `archive.json` and `verified.json` schemas, dependency versions and lockfiles, public export maps, upstream fixture `output.json` files, immutable timing evidence and publication credentials. Build outputs in ignored `dist/`, `.cache/`, `.artifacts/` directories are normal verification products, not source changes.

## Git workflow

The advisor branch is `codex/deep-audit-plans`. For implementation, use an isolated branch such as `codex/fix-bind-packed-verification` from the operator's approved base; keep unrelated working changes intact. Do not create a second implementation branch if the operator already supplied one. Do not commit, push, publish or open a PR unless the operator requested that action. If a commit is requested, use a conventional subject such as `fix: bind packed-consumer verification to the archive actually tested`.

## Target design

`scripts/packed-verification.ts` exports pure, import-safe functions (no top-level side effects, no reads of `process.argv`, no calls at module load). Suggested shape; adjust names freely but keep the parameters explicit and the callback seam:

```text
export type PackedInputs = { reportPath: string; archivePath: string; receiptPath: string; version: string };
export type CapturedArchive = { version: string; reportSha256: string; archiveSha256: string; archiveBytes: Buffer };

export function captureArchive(inputs: PackedInputs, packageName: string): CapturedArchive;
export function verifyPackedArchive(
  inputs: PackedInputs,
  packageName: string,
  runChecks: (snapshotArchivePath: string) => void
): void; // writes the receipt on success, always cleans the snapshot
export function validateReceipt(inputs: PackedInputs, packageName: string): string; // returns the archive path to publish, throws otherwise
```

- `captureArchive` reads the report bytes once, hashes them, parses those same bytes (`JSON.parse` on the buffer's UTF-8 text, then `asRecord`), checks `report.version === version`, `archive.name === packageName`, reads the tarball bytes once, and checks `sha256` and `bytes` against the report. Compare `bytes` as `expected.bytes !== archiveBytes.length` (an `unknown` value compared with `!==` needs no narrowing and no `typeof`).
- `verifyPackedArchive` removes any prior receipt, calls `captureArchive`, writes the captured tarball bytes to a fresh `mkdtempSync(resolve(tmpdir(), "elmera-packed-snapshot-"))` directory under the original filename, calls `runChecks(snapshotPath)`, then writes the receipt `{ version, archiveReportSha256, status: "pass" }` using only the captured digest. Before writing, re-read the shared report and archive and throw if either differs from the captured bytes (a replacement was detected). Even if replacement happens after that comparison, the receipt still names A's report digest, so B's report cannot validate. Remove the snapshot directory in `finally`.
- `validateReceipt` performs exactly the checks now in `scripts/canary-publish.ts:9-27` (status, versions, report digest, name, archive sha256) and returns the archive path. It performs no publish.

## Steps

### Step 1: Create the seam and a failing interleaving regression

Create `scripts/packed-verification.ts` with the design above, but implement `verifyPackedArchive` with today's timing: pass the shared archive path to `runChecks` and hash the report after `runChecks` returns. Create `test/packed-verification.test.mjs` with the cases in the Test plan. The interleaving case uses a `runChecks` callback that overwrites the fixture's report and tarball with B (same version, correct B metadata) and then asserts that `validateReceipt` against B's files throws. No timer sleeps, no real `pnpm install`, no writes to the repository's `.artifacts` directory.

**Verify:** `pnpm exec vitest run --config test/vitest.config.mjs test/packed-verification.test.mjs`

Expected: exit code 1. The interleaving case fails on its assertion because the receipt names B's digest and `validateReceipt` accepts B. Every other case passes. An import error, type error or fixture-setup error is not the intended failure; fix that first.

### Step 2: Capture immutable input bytes before the checks

Change `verifyPackedArchive` to the target design: capture and verify the report and tarball before installation, hand `runChecks` only the private snapshot path, build the receipt solely from the captured digest, reject a changed shared report or archive before writing, and always clean the snapshot.

**Verify:** `pnpm exec vitest run --config test/vitest.config.mjs test/packed-verification.test.mjs`

Expected: exit 0; all cases pass, including the interleaving case and the snapshot-path assertion.

### Step 3: Wire the production commands through the seam

- `scripts/packed-consumer.ts`: import `verifyPackedArchive` from `./packed-verification.ts` and pass a `runChecks` callback that writes the temporary consumer `package.json` whose single dependency is `@elmeragroup/internal` with the specifier `file:` followed by the snapshot archive path passed to the callback, writes `pnpm-workspace.yaml`, copies `test/packed-consumer` to `checks/`, runs `pnpm install --ignore-scripts`, and runs the four checks with `--no-experimental-strip-types`. Keep the consumer `mkdtempSync` directory and its `finally` cleanup. Remove the inline receipt write and the standalone `rmSync(verified.json)` (the seam owns both).
- `scripts/canary-publish.ts`: import `validateReceipt` from `./packed-verification.ts`, call it with `canaryVersion()` and `packageName`, and keep `run("npm", ["publish", archive, "--access", "public", "--tag", "canary", "--ignore-scripts"])` unchanged, using the returned archive path. Remove the now-duplicated inline checks.
- `turbo.json`: add `"scripts/packed-verification.ts"` to the `//#test:repo-policy` inputs array next to `scripts/packed-consumer.ts`.

**Verify:** `pnpm type-check:scripts && pnpm lint && pnpm test:repo-policy`

Expected: all exit 0 with no warnings; no npm publish is invoked (no test executes `canary-publish.ts`).

### Step 4: Document the binding and verify a real archive

In `README.md`, extend the paragraph at lines 72–74 (`packages:pack` / consumer test description) with one or two sentences: the consumer test installs a private copy of the archive it verified and writes a receipt bound to that archive's report; repacking after verification invalidates the receipt, so re-run `pnpm test:packed-consumer` before `pnpm canary:publish`. Keep the existing wording otherwise. Then run the real pack and consumer check.

**Verify:** `pnpm packages:pack && pnpm test:packed-consumer`

Expected: exit 0; `.artifacts/canary/verified.json` exists and its `archiveReportSha256` equals `shasum -a 256 .artifacts/canary/archive.json`.

### Step 5: Final gates and plan bookkeeping

No Changeset is needed: this changes private verification tooling, not the published package. State that reason in the completion notes and any PR. Do not change package versions or lockfiles.

Run `pnpm ci:checks` and `pnpm packages:pack && pnpm test:packed-consumer`. Inspect `git diff --check`, `git diff --name-only` and `git status --short`; every changed source/document must be in Scope. Update this plan's Status and Completion notes and the row in `plans/README.md`, then run `pnpm exec oxfmt --check plans/009-bind-packed-verification.md plans/README.md README.md`. Do not mark DONE with a failed or skipped required gate.

**Verify:** `git diff --check`

Expected: exit 0; all preceding final commands exit 0. Record the actual commands and results in the completion notes, including any blocked check.

## Test plan

File: `test/packed-verification.test.mjs`, modeled on `test/release-version.test.mjs`. Build fixtures in `mkdtempSync(join(tmpdir(), "elmera-packed-verification-"))` and remove them in `finally`; never touch the repository's `.artifacts` directory. Use two distinct small byte buffers A and B as fake tarballs (content does not need to be a real tar; the seam only hashes it) with correct `name`, `bytes` and `sha256` in each report and the same version string, e.g. `0.1.0-canary.1`. Import the seam as `../scripts/packed-verification.ts` and `packageName` from `../scripts/release.ts`.

Cases:

1. Normal A verification: `runChecks` is called once; the receipt has `status: "pass"`, the version, and the SHA-256 of the captured report bytes; `validateReceipt` returns the archive path.
2. `runChecks` receives a path outside the fixture archive directory whose bytes equal A, and that path no longer exists after `verifyPackedArchive` returns.
3. Report/archive mismatch before checks (wrong sha256, wrong byte count, wrong name, wrong version, missing report): throws before `runChecks` is called; no receipt is written.
4. Interleaving: `runChecks` replaces the report and archive with B. After `verifyPackedArchive` (which may throw on the pre-write comparison or write A's receipt), `validateReceipt` against the B files throws. B never validates.
5. Replacement after the final comparison: write A's receipt via a normal run, then overwrite the shared files with B; `validateReceipt` throws.
6. Failed checks: `runChecks` throws; the error propagates, no receipt is written, the snapshot directory is removed.
7. `validateReceipt` rejects a receipt with `status` other than `"pass"`, a different version, or a stale `archiveReportSha256`.

Run `pnpm exec vitest run --config test/vitest.config.mjs test/packed-verification.test.mjs` after Step 2 and expect every case to pass. In Step 1 only, the failure must be case 4's assertion, not a compiler/import/runtime/setup failure. Keep the regressions after the fix; do not replace assertions with snapshots that merely accept current output.

## Done criteria

- [ ] `scripts/packed-verification.ts` exists, has no module-load side effects, and is imported by both `scripts/packed-consumer.ts` and `scripts/canary-publish.ts`; `grep -n "archiveReportSha256" scripts/packed-consumer.ts scripts/canary-publish.ts` returns no matches (the seam owns the receipt).
- [ ] The consumer installs from a private snapshot path and the receipt is derived only from bytes captured before `runChecks`.
- [ ] `pnpm exec vitest run --config test/vitest.config.mjs test/packed-verification.test.mjs` exits 0 and the seven cases above exist.
- [ ] `pnpm type-check:scripts`, `pnpm lint` and `pnpm test:repo-policy` exit 0.
- [ ] `pnpm ci:checks` exits 0.
- [ ] `pnpm packages:pack && pnpm test:packed-consumer` exits 0 and writes `.artifacts/canary/verified.json`.
- [ ] `git diff --check` exits 0 and `git diff --name-only` lists only Scope paths.
- [ ] No Changeset added; the completion notes say why.
- [ ] This plan and its `plans/README.md` row reflect the actual completion state; no skipped gate is described as passing.

## STOP conditions

Stop and report (do not improvise) if:

- The "Current state" excerpts no longer match the live files.
- `pnpm install` in the temporary consumer refuses a `file:` dependency that points at a tarball outside the repository, or the checks fail only because the tarball path changed. Report it rather than reverting to the shared mutable path.
- The design appears to require changing `scripts/release.ts`, `scripts/canary-pack.ts`, `scripts/lib/json-object.mjs`, the workflows, the `archive.json`/`verified.json` schemas, tokens, or a locking scheme.
- A lint rule listed under Conventions cannot be satisfied without a disable; report the rule and the line instead of adding a file-wide or path-wide exception.
- A required check fails twice after one focused fix attempt. Report pre-existing or environment failures separately.
- Any fix would disable a checksum, version or canary-only check, weaken a test, modify immutable evidence or suppress a diagnostic to obtain a green run.

## Maintenance notes

- Any new consumer check must run inside the `runChecks` callback against the snapshot path, never against `.artifacts/canary` directly.
- Reviewers should confirm `canary-publish.ts` still publishes the path returned by `validateReceipt` with the same `--access public --tag canary --ignore-scripts` flags, and that `packed-consumer.ts` still runs all four checks with `--no-experimental-strip-types`.
- `canary-pack.ts` deletes the whole archive directory on each run, so a repack during verification also removes an in-flight receipt. That is acceptable: it forces re-verification. Continuous hostile filesystem replacement, and the window between `validateReceipt` and npm opening the tarball, are outside this plan. A future release lock can complement identity binding but must not replace it.

## Completion notes

Not implemented. Record the implementing revision, regression results, full gate results and any reviewed scope changes here.
