# Plan 004: Let coordinated version PRs pass package verification without enabling stable publishing

> Follow this self-contained plan in order. This is tooling implementation, not authorization to publish.
> Drift check first: `git diff --stat 3994cd4..HEAD -- .changeset/config.json .changeset/README.md .github/workflows/merge.yml .github/workflows/publish-canary.yml scripts/release.ts scripts/release-version.ts scripts/canary-pack.ts scripts/packed-consumer.ts scripts/canary-version.ts scripts/canary-publish.ts test/release-version.test.mjs package.json turbo.json README.md AGENTS.md`.
> Inspect `git status --short` and compare changed code with the excerpts before editing.

## Status

- Priority: P1
- Effort: M
- Risk: MED
- Depends on: none
- Category: bug / releases
- Original audit finding: 2
- Planned at: commit `3994cd4`, 2026-09-06
- Branch: `codex/plan-004-align-versioning-and-package-verification`
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

Normal Changesets versioning and mandatory package verification currently require incompatible versions.
A patch changeset for the internal package produces stable `0.1.0`, while the other two packages remain
at `0.1.0-canary.0`. The version PR then runs `canary:pack`, which rejects both stable and mismatched
versions. Fix the workflow contract rather than exempting version PRs from consumer verification.

## Chosen release contract

This plan makes the following concrete choice:

1. All three public packages form a Changesets fixed group and receive one coordinated version.
2. Packaging and installed-consumer verification accept either a coordinated stable version or a
   coordinated canary version.
3. Publishing remains explicitly canary-only, using the existing manual main-branch workflow and
   `canary` tag. Stable package verification does not authorize or implement stable publication.
4. Keep the existing `canary:pack` command as a compatibility alias; introduce the clearer
   `packages:pack` command for CI and documentation.
5. Keep archive filenames, checksums, verification markers, and the current ignored archive directory
   compatible. Its historical `.artifacts/canary` name is not a reason to migrate files in this fix.

This preserves the documented automatic Version Packages PR and the separate manual canary workflow.
Do not instead disable the version bot, add blanket CI exclusions, enter Changesets prerelease mode,
or begin publishing `latest`.

## Current state

`.changeset/config.json:5`:

```json
"fixed": [],
"linked": []
```

`.github/workflows/version-packages.yml:32` runs:

```yaml
- name: Version Packages PR
  uses: changesets/action@v1
  with:
    version: pnpm exec changeset version
```

`scripts/release.ts:16`:

```ts
export function canaryVersion(): string {
  const versions = packageNames.map((name) =>
    asString(readJsonObject(resolve(repoRoot, "packages", name, "package.json")).version, "version")
  );
  const first = versions[0];
  if (
    first === undefined ||
    !/^\d+\.\d+\.\d+-canary\.\d+$/.test(first) ||
    versions.some((version) => version !== first)
  )
    throw new Error("All release packages must have the same x.y.z-canary.N version");
  return first;
}
```

`canary-pack.ts`, `packed-consumer.ts`, and `canary-publish.ts` all call this function.
`archivePath` also defaults to it. Root `package.json` defines
`"canary:pack": "pnpm build && node scripts/canary-pack.ts"`.
The Merge workflow always runs packing and the packed-consumer test, including on version PRs.

The audit called the installed Changesets release planner without writing files. A patch changeset for
`@elmeragroup/internal` produced:

```json
{ "name": "@elmeragroup/internal", "oldVersion": "0.1.0-canary.0", "newVersion": "0.1.0" }
```

The packed consumer verifies compiled JavaScript, dependency defaults, drift checking, and declaration
compilation in a temporary install without workspace links. Preserve that test rather than replacing it
with manifest-only assertions.

Existing root test conventions are in `test/extractor-lint-exceptions.test.mjs`: ESM, Vitest
`describe/expect/it`, Node filesystem helpers, and checked JSON via `test/json-object.mjs`.
Root script conventions are exemplified by `scripts/release.ts`: argument-array process execution,
explicit failure propagation, and functions with primitive/typed inputs.

## Commands you will need

| Purpose                             | Command from root                                                                    | Expected result                              |
| ----------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| New focused tests                   | `pnpm exec vitest run --config test/vitest.config.mjs test/release-version.test.mjs` | All pass                                     |
| Root tests                          | `pnpm test:repo-policy`                                                              | All pass                                     |
| Root script type check              | `pnpm type-check:scripts`                                                            | Exit 0                                       |
| Root lint                           | `pnpm lint`                                                                          | Exit 0; build dependencies first if required |
| Repository gates                    | `pnpm ci:checks`                                                                     | Exit 0                                       |
| Generic packing, added by this plan | `pnpm packages:pack`                                                                 | Builds and verifies local archives           |
| Compatibility alias                 | `pnpm canary:pack`                                                                   | Same packaging operation; no publishing      |
| Installed consumer                  | `pnpm test:packed-consumer`                                                          | Exit 0 after packing                         |
| Hygiene                             | `git diff --check`                                                                   | Exit 0                                       |

Never run `pnpm canary:publish`, `npm publish`, a workflow dispatch, or an actual version mutation in
the user's checkout as verification. Version mutations used by tests belong in disposable test copies.

## Scope

The paths in the drift check are the complete scope. `scripts/release-version.ts` and
`test/release-version.test.mjs` are new. The Version Packages workflow itself need not change: retain its
ordinary Changesets version command. Public package manifests and versions are not to be bumped manually.
Do not add dependencies, rewrite the lockfile, change authentication, publish tags, or weaken archive
content validation. No package-release changeset is required for this tooling-only change.

## Steps

### Step 1: Add executable contract tests

Create the root .mjs test. Cover a pure coordinated-version validator and a canary-only validator.
Keep the pure functions in the new `scripts/release-version.ts`; their inputs are supplied version
strings, so tests need not modify actual manifests. The existing `canaryVersion()` remains an adapter
that reads the real manifests and delegates. Start with the existing policy extracted unchanged into
that pure module if needed to keep the initial test import valid; the red result must be a contract
assertion, not a missing-module error.

Also add an integration test invoking the installed Changesets CLI from
`createRequire(import.meta.url).resolve("@changesets/cli/bin.js")` in a temporary minimal workspace.
Copy the real public package manifests and fixed-group configuration into it. Create a changeset for
each public package in separate test cases and use `changeset status --output <temporary report>` to
obtain the planned releases. No install or registry request is needed. If the CLI needs workspace
discovery metadata, copy the root pnpm workspace pattern and package-manager metadata; do not copy
node_modules or use unstable transitive package imports. The CLI also invokes Git even when no `--since`
argument is given. Initialize the temporary directory with `git init --initial-branch=main`, stage its
baseline manifests/configuration, and create one local baseline commit using per-command identity:
`git -c user.name=PlanTest -c user.email=plan-test@example.invalid commit -m baseline`.
Set `HUSKY=0` only inside that disposable fixture if inherited global hooks would interfere; do not
disable hooks in the user's repository. Prefer a test-local empty hooks directory through per-command
`-c core.hooksPath=<temporary-empty-directory>` instead of depending on a hook manager. Do not change
global/user Git configuration, add remotes, or push. Create the input changeset after the baseline commit.

Assert that each input change yields all three public packages at the same planned version and that
the version satisfies the generic packing validator. A test-only changelog setting may be disabled in
the temporary workspace to avoid unrelated changelog generation, but fixed groups and version inputs must
come from the real configuration.

**Verify:** focused tests expose the current noncoordinated release plan. Keep assertions about version
sets, not a source-text match for `fixed`.

### Step 2: Separate coordinated packaging from canary eligibility

Implement a pure validator for a nonempty list of identical versions. Support exactly stable
`x.y.z` and canary `x.y.z-canary.N` forms. Reject malformed versions and leading-zero numeric identifiers;
do not accept arbitrary prerelease channels or build metadata in this scoped release contract.
Return the unchanged validated version string.

Implement the stricter canary assertion on top of that validation. Wire:

- Generic `releaseVersion()` in `release.ts` reads all three manifests and validates coordination.
- Existing `canaryVersion()` reads/validates the same set and rejects stable values.
- `archivePath` defaults to the generic version or receives an explicit validated version.
- `canary-pack.ts` and `packed-consumer.ts` use the generic reader.
- `canary-publish.ts` retains the strict reader before any publish process is started.
- `canary-version.ts` uses the strict single-version validation before writing any manifest.

Retain explicit argument arrays for processes. Error messages must distinguish mismatch from unsupported
version format and canary-required publication.

**Verify:** tests pass for stable coordination, canary coordination, mismatches, empty lists, malformed
strings, and stable rejection by the publication validator. `pnpm type-check:scripts` exits 0.

### Step 3: Configure coordinated Changesets releases

Set `fixed` to one exact group:

```json
[["@elmeragroup/api-extractor", "@elmeragroup/api-artifacts", "@elmeragroup/internal"]]
```

Leave private lint and TypeScript tooling packages outside this group. Keep `linked` empty and
preserve the current base branch, changelog, access, and internal dependency update settings.

**Verify:** the real CLI release-plan tests pass for patch changes to each public package. Add a mixed
patch/minor test to prove the whole fixed group takes the necessary coordinated version. Stable planned
versions pass packing validation and fail canary-publication validation.

### Step 4: Wire commands, caching, and docs

Add `packages:pack` with the existing build-plus-pack command. Make `canary:pack` delegate to it without
performing two builds. Update Merge and Publish Canary workflows to call `packages:pack`.
Keep the manual canary version-setting step before checks and keep the publication step unchanged.

The root `//#test:repo-policy` Turbo task has a custom input list. Extend it to include the release
scripts, Changesets configuration, public package manifests, and relevant workflow files read by the new
tests. Otherwise cached tests could ignore a release-contract change. Preserve existing inputs.

Update root README, `.changeset/README.md`, and AGENTS.md to distinguish coordinated versioning,
generic package verification, and canary-only publication. Explain the legacy alias once.
Do not claim stable publication exists.

**Verify:** `pnpm test:repo-policy`, `pnpm type-check:scripts`, and `pnpm ci:checks` exit 0.
Inspect `pnpm exec turbo run test:repo-policy --dry=json` and confirm its declared inputs include the
configuration consumed by the test.

### Step 5: Verify both package modes without publishing

On the actual canary checkout, run `pnpm packages:pack`, then `pnpm test:packed-consumer`.
For stable verification, create a disposable workspace containing exactly these inputs:

- Root `package.json` for package-manager metadata and the full `pnpm-workspace.yaml`, including its catalog.
- `scripts/` and `test/packed-consumer.mjs`, preserving their repository-relative locations.
- Every workspace package manifest at its original relative path, including private tooling packages,
  so pnpm can resolve workspace specifiers while preparing manifests. Private package source is unnecessary.
- For each public package: its manifest, built `dist/`, README, LICENSE, and NOTICE if present.

The catalog is necessary because pnpm pack rewrites `catalog:` specifiers. The consumer script is necessary
because the copied runner loads `test/packed-consumer.mjs` relative to its own repository root.
Set only the temporary copy's three public versions to a common stable value. In that temporary root run
`node scripts/canary-pack.ts`, then `node scripts/packed-consumer.ts`; both must exit 0. Do not use
`packages:pack` in this copy, because it would unnecessarily rebuild the already-copied dist outputs and
require a complete development install. The scripts resolve their root from their own copied location,
so the real checkout remains untouched. Always remove the temporary workspace in `finally`.

The temporary stable test may reuse installed build outputs, but packed manifests must be rewritten
through pnpm pack so workspace dependencies resolve to the coordinated stable version. Any required
temporary dependency links must not become packed workspace links; the consumer check remains decisive.
Document the test setup in `test/release-version.test.mjs` or a test helper embedded there. Keep slow
network-dependent consumer installation as an explicit integration verification, not a mandatory unit
test on every run.

**Verify:** both modes produce valid archives and pass consumer verification. A stable version supplied
to the pure publication guard is rejected. No publication command was invoked. Real package versions,
lockfile, and authentication settings are unchanged.

## Test plan

Mandatory fast tests: stable and canary validation; every public package as a Changesets input; mixed
release sizes; mismatch rejection; malformed/leading-zero versions; stable publication rejection;
unchanged archive-name derivation for canaries. Mandatory final integration: pack and install both a real
canary build and a disposable coordinated stable build.

Do not test publication by mocking npm into success and calling that proof of a safe release. The relevant
contract here is that the strict eligibility guard runs before publication and rejects stable versions.

## Done criteria

- [ ] Each public-package changeset yields one coordinated version across all three packages.
- [ ] Coordinated stable and canary archives pass the same installed-consumer verification.
- [ ] Stable versions fail the publication validator.
- [ ] The actual publisher still uses the strict canary reader and `--tag canary`.
- [ ] Version PRs retain the full package/consumer checks.
- [ ] Generic and legacy pack commands are documented and work.
- [ ] Turbo inputs cover the new test's configuration dependencies.
- [ ] No real manifest version, lockfile, credential, or registry state changed during testing.
- [ ] All gates pass and status results identify both integration modes.

## STOP conditions

Stop if Changesets fixed groups fail to coordinate the current prerelease-to-stable transition, if the
chosen design would publish stable packages, or if resolving it requires changing package versions in
the real checkout. Stop if a required test needs new dependencies rather than the already-installed CLI.
Do not add prerelease state or skip version-PR checks as a fallback. Report registry/install limitations
for the consumer integration separately from code failures.

## Maintenance notes

Packaging eligibility and publication eligibility are separate policies. Any future stable-release
feature needs its own explicit publication design and authorization. Keep the three-package group,
archive dependency checks, and the release planner tests aligned when adding another public package.

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

## Independent release verification, 2026-09-07

A fresh verification agent reran all 16 release-policy tests with Node 24.13.0 and pnpm 11.20.0.
Disposable coordinated `0.1.0` and `0.1.0-canary.0` workspaces both passed archive creation and the
installed-consumer checks. Each copy retained workspace/catalog metadata and existing compiled outputs;
a temporary `pnpm install --ignore-scripts` resolved workspace development dependencies before packing.
The consumer verified umbrella imports, extraction, dependency props, defaults, drift detection, and
declaration compilation without workspace links. The disposable workspaces were removed. No real
package version, lockfile, registry state, or publication setting changed. The coordinator separately
runs final packing and consumer verification after a fresh build.
