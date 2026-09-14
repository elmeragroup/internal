# Release deepening design: Canary decision and Record module

Design decisions for deepening `packages/release`, settled in an architecture review on
2026-09-14. Vocabulary follows CONTEXT.md (domain) and the codebase-design glossary
(module, interface, implementation, seam, adapter, depth, leverage, locality).

## Friction being removed

1. **The Canary decision has no home.** `engine.ts:98-124` composes `canaryEligibility`,
   a hand-written union of npm versions and reserved record versions, `allocateCanary`, and two
   skip-message helpers. `policy.test.ts` re-implements that composition in a `canaryPlan` helper
   to test it. Superseded is spelled four ways: `CanarySupersession`, `PublicationPlan.kind`,
   the `"superseded"` string returned by publication, and `allocateCanary` returning `undefined`.
2. **A Record is three shapes across three files.** `intent.ts` owns the record owner marker and
   GitHub asset name; `ownership.ts` classifies record bodies and has one importer; `store.ts`
   translates `ReleaseRecordClassification` to `CatalogEntry` to `SavedRelease` and classifies
   assets. `ownership.test.ts` is mostly re-proven by `store.test.ts`. `archive.ts` borrows the
   asset name as a temp filename.

## Decisions

| #   | Decision                                                          | Choice                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Shape of `decideCanary` result                                    | `{ cut: string } \| { skip: CanarySkip; reason: string }`. The three log sentences move into policy next to the rule.                                                                                                                                 |
| 2   | Reshape `PublicationPlan` / publication result to carry the cause | No. Share the `CanarySupersession` type only.                                                                                                                                                                                                         |
| 3   | Keep `canaryEligibility` and `allocateCanary` exported            | No. Both become module-private; all tests go through `decideCanary`. `canarySupersession` stays exported for `planPublication`.                                                                                                                       |
| 4   | Where the Record fold lands                                       | New `record.ts`: tag rules, owner marker, parse/serialize, asset name, record classification, asset classification. `intent.ts` keeps `ReleaseIntent`, `VerifiedRelease`, `assertCommit`, `isCommit`. `ownership.ts` is deleted.                      |
| 5   | Engine access to tag helpers                                      | Import `canaryRecordTag`, `assertReleaseTag`, `releaseTag` from `record.ts`. `ReleaseStore` interface unchanged.                                                                                                                                      |
| 6   | `archive.ts` temp filename                                        | Local literal `"archive.tgz"`; no import from record.                                                                                                                                                                                                 |
| 7   | Tests for the Record                                              | New `record.test.ts` takes the tag/parse/serialize cases from `intent.test.ts` plus the five `ownership.test.ts` cases the store does not prove. Ownership cases the store already proves, and direct `classifyReleaseAsset` assertions, are deleted. |
| 8   | Commits                                                           | Two commits on one branch, one PR. Policy fold first.                                                                                                                                                                                                 |
| 9   | Changeset                                                         | None. PR carries the `no-changeset` label with an explanation: private package bundled into `@elmeragroup/internal/release`, no observable change.                                                                                                    |
| 10  | Glossary                                                          | CONTEXT.md gains **Canary decision** (already added, uncommitted).                                                                                                                                                                                    |
| 11  | Policy test migration                                             | All fourteen eligibility/allocation cases go through `decideCanary`, including the direct `canaryEligibility` calls at `policy.test.ts:217-222` and the direct `allocateCanary` calls at `394-410`.                                                   |

## Settled facts (not decisions)

- Reading reservations before the decision costs nothing: `store.find(canaryRecordTag(commit))`
  already loads the memoised catalog, so `reservedCanaryVersions()` is a free read.
- `assertSameIntent` (store) and the archive identity check (archive) compare different facts
  (saved intent vs packed manifest). Out of scope.
- The engine-test fake store copies the store's retry message verbatim
  (`engine.test.ts:108`). Out of scope (separate candidate).
- `classifyReleaseAsset` direct tests are fully re-proven through `ReleaseStore`
  (`store.test.ts:109-140, 162-168, 231-250`).
- Ownership cases the store does NOT prove: valid schema-1 payload on non-record tag `v1`;
  marked owner with missing `commit`; `"not json"` body with `release.tgz` asset;
  `{notes:"human"}` body with `release.tgz` asset; foreign `owner` marker with `release.tgz` asset.

## Constraints from AGENTS.md and ADRs

- ADR 0002 (ownership before validation), 0003, 0005, 0006 unchanged in behaviour.
- `packages/release` is private; only `@elmeragroup/internal` is published. Public surface
  (`index.ts`) does not change.
- Lint runs with `--deny-warnings`; use separate type imports; kebab-case filenames.
- Run `pnpm --filter @elmeragroup/release test` while iterating, `pnpm ci:checks` before each
  commit, and `pnpm packages:pack && pnpm test:packed-consumer` before the PR.
