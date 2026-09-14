# Release Deepening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen `packages/release` so the Canary decision lives in one policy function and the Record lives in one module, with no change to public behaviour.

**Architecture:** Two folds in the private `@elmeragroup/release` workspace. First, `decideCanary` in `policy.ts` absorbs eligibility, the reservation union, allocation and the skip sentences that today sit in `engine.ts`. Second, a new `record.ts` absorbs `ownership.ts`, the record parts of `intent.ts`, and asset classification from `store.ts`; the store keeps transport only.

**Tech Stack:** TypeScript (strict, separate type imports), Effect (pinned), vitest, pnpm workspace, oxlint with `--deny-warnings`, oxfmt.

**Spec:** `docs/superpowers/specs/2026-09-14-release-deepening-design.md`

## Global Constraints

- Public surface of `packages/release/src/index.ts` and `packages/internal/src/release.ts` must not change.
- No changeset. The PR carries the `no-changeset` label with an explanation.
- Lint runs with `--deny-warnings`. Use `import type` for types. Filenames are kebab-case.
- Run every command from the repository root.
- Iterate with `pnpm --filter @elmeragroup/release test`. Before each commit run `pnpm ci:checks`. Before the PR also run `pnpm packages:pack && pnpm test:packed-consumer`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `CONTEXT.md` already contains the uncommitted **Canary decision** entry. Include it in the first commit. Do not rewrite it.

---

## File map

| File                                                        | After this plan                                                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/release/src/policy.ts`                            | Gains `CanarySkip`, `CanaryDecision`, `decideCanary`. `canaryEligibility` and `allocateCanary` become private. |
| `packages/release/src/engine.ts`                            | Calls `decideCanary`; loses `skipReason`, `regressedBaseSkip`. Imports tag helpers from `record.ts`.           |
| `packages/release/src/record.ts`                            | New. Owner marker, asset name, tag rules, parse/serialize, record classification, asset classification.        |
| `packages/release/src/intent.ts`                            | Only `ReleaseIntent`, `VerifiedRelease`, `isCommit`, `assertCommit`.                                           |
| `packages/release/src/ownership.ts`                         | Deleted.                                                                                                       |
| `packages/release/src/store.ts`                             | Imports record rules from `record.ts`; no `classifyReleaseAsset`, no `ReleaseAsset` definition.                |
| `packages/release/src/archive.ts`                           | Local `"archive.tgz"` literal.                                                                                 |
| `packages/release/test/policy.test.ts`                      | All canary cases through `decideCanary`.                                                                       |
| `packages/release/test/record.test.ts`                      | New. Replaces `intent.test.ts` and the uncovered half of `ownership.test.ts`.                                  |
| `packages/release/test/intent.test.ts`, `ownership.test.ts` | Deleted.                                                                                                       |
| `packages/release/test/store.test.ts`, `engine.test.ts`     | Import paths updated; direct asset assertions removed.                                                         |
| `packages/release/README.md`, `CONTEXT.md`                  | Wording for the Canary decision.                                                                               |

---

### Task 0: Branch

**Files:** none

- [ ] **Step 1: Create the branch from a clean main**

```bash
git status --short          # expect only CONTEXT.md and docs/superpowers/** modified/untracked
git checkout -b deepen-release-policy-and-record
```

---

### Task 1: `decideCanary` in policy (test first)

**Files:**

- Modify: `packages/release/src/policy.ts:104-130`
- Test: `packages/release/test/policy.test.ts`

**Interfaces:**

- Consumes: `canarySupersession`, `allocateCanary` (existing, same file), `CanaryTarget`, `Registry` from `./npm.ts`, `CommitAncestry`.
- Produces:

  ```ts
  export type CanarySkip = "canary-superseded" | "stable-superseded" | "regressed-base";
  export type CanaryDecision = { cut: string } | { skip: CanarySkip; reason: string };
  export function decideCanary(
    target: CanaryTarget,
    registry: Registry,
    reserved: readonly string[],
    isAncestor: CommitAncestry
  ): CanaryDecision;
  ```

  Task 2 depends on these exact names.

- [ ] **Step 1: Rewrite the canary parts of `policy.test.ts` to call `decideCanary`**

Replace lines 5-12 (imports) with:

```ts
import { decideCanary, distTagFor, planPublication, shouldPromote } from "../src/policy.ts";
import type { CommitAncestry } from "../src/policy.ts";
```

Replace lines 38-68 (the `CanaryPlanOptions` type, `eligibility`, and `canaryPlan` helpers) with one helper that calls the real function:

```ts
type CanaryDecisionOptions = {
  current?: string;
  commit?: string;
  registry?: Registry;
  reserved?: readonly string[];
  plannedBase?: string;
  ancestry?: CommitAncestry;
};

function decision(options: CanaryDecisionOptions = {}) {
  return decideCanary(
    {
      commit: options.commit ?? commit,
      current: options.current ?? "0.1.9",
      base: options.plannedBase ?? "0.2.0",
    },
    options.registry ?? registry(),
    options.reserved ?? [],
    options.ancestry ?? isAncestor
  );
}

function cut(version: string) {
  return { cut: version };
}

const skips = {
  canary: { skip: "canary-superseded", reason: "Skipping a commit superseded by a published canary" },
  stable: { skip: "stable-superseded", reason: "Skipping a commit superseded by a stable release" },
  base: { skip: "regressed-base", reason: "Skipping a commit superseded by a canary on a newer base" },
} as const;
```

Then update every former `canaryPlan(...)` / `eligibility(...)` assertion. The complete set of changed assertions:

```ts
describe("fresh canary decision", () => {
  it("cuts a fresh canary when no record exists", () => {
    expect(decision()).toEqual(cut("0.2.0-canary.0"));
  });

  it("skips when a published stable is greater than the checked-out manifest version", () => {
    const published = registry();
    published.versions.set("0.1.2", { commit: newerCommit, integrity: "stable" });
    expect(decision({ current: "0.1.1", registry: published })).toEqual(skips.stable);
    expect(
      decision({
        current: "0.1.1",
        registry: {
          versions: new Map([
            ["0.1.1", { integrity: "stable" }],
            ["0.1.1-canary.9", { integrity: "canary" }],
          ]),
          tags: new Map(),
        },
      })
    ).toEqual(cut("0.2.0-canary.0"));
    expect(
      decision({
        current: "0.1.1",
        registry: { versions: new Map([["0.1.0", { integrity: "stable" }]]), tags: new Map() },
      })
    ).toEqual(cut("0.2.0-canary.0"));
  });

  it("reuses the same ancestry skip before allocating a new canary", () => {
    const published = registry();
    published.versions.set("0.2.0-canary.12", { commit: newerCommit, integrity: "newer" });
    expect(decision({ registry: published })).toEqual(skips.canary);
    expect(() => decision({ commit: newerCommit, registry: published })).toThrow("record is missing");
  });

  it("ignores published canaries that have no source commit", () => {
    const published = registry();
    published.versions.set("0.2.0-canary.1", { integrity: "legacy" });
    expect(decision({ registry: published })).toEqual(cut("0.2.0-canary.2"));
  });

  it("throws on mixed descendant and divergent canaries regardless of map order", () => {
    const descendantFirst = registry();
    descendantFirst.versions.set("0.2.0-canary.12", { commit: newerCommit, integrity: "newer" });
    descendantFirst.versions.set("0.2.0-canary.13", { commit: unrelatedCommit, integrity: "unrelated" });
    const divergentFirst = registry();
    divergentFirst.versions.set("0.2.0-canary.13", { commit: unrelatedCommit, integrity: "unrelated" });
    divergentFirst.versions.set("0.2.0-canary.12", { commit: newerCommit, integrity: "newer" });
    for (const published of [descendantFirst, divergentFirst]) {
      expect(() => decision({ registry: published })).toThrow("diverged");
      expect(() => publicationPlan(canary, published)).toThrow("diverged");
    }
  });

  it("supersedes when any descendant exists and the rest of history is linear", () => {
    const published = registry();
    published.versions.set("0.2.0-canary.12", { commit: newerCommit, integrity: "newer" });
    published.versions.set("0.2.0-canary.14", { commit: newerCommit, integrity: "also-newer" });
    expect(decision({ registry: published })).toEqual(skips.canary);
    expect(publicationPlan(canary, published)).toEqual({ kind: "superseded" });
  });
});
```

In `describe("descendant stable supersession")`, replace the last `it` (former lines 213-223):

```ts
it("supersedes fresh cuts and recorded retries from an ancestor of a published stable", () => {
  const published = registry();
  published.versions.set("0.2.0", { commit: newerCommit, integrity: "stable" });
  expect(planPublication(recorded, published, isAncestor)).toEqual({ kind: "superseded" });
  expect(decision({ current: "0.2.0", plannedBase: "0.3.0", registry: published })).toEqual(skips.stable);
  expect(
    decision({ commit: newerCommit, current: "0.2.0", plannedBase: "0.3.0", registry: published })
  ).toEqual(cut("0.3.0-canary.0"));
});
```

Replace `describe("canary numbering policy")` (former lines 360-411) entirely:

```ts
describe("canary numbering policy", () => {
  it("refuses a planned base that does not advance the checked-out version", () => {
    expect(() => decision({ current: "0.2.0", plannedBase: "0.2.0" })).toThrow(
      "must advance the stable version"
    );
  });

  it("skips a planned base that is older than an already published canary", () => {
    const published = registry();
    published.versions.set("0.3.0-canary.0", { integrity: "published" });
    expect(decision({ registry: published })).toEqual(skips.base);
  });

  it("skips a planned base that is older than a reserved canary", () => {
    expect(decision({ reserved: ["0.3.0-canary.0"] })).toEqual(skips.base);
  });

  it("skips a stable release that already reaches the planned base", () => {
    const published = registry();
    published.versions.set("0.2.0", { integrity: "published" });
    expect(decision({ registry: published })).toEqual(skips.stable);
  });

  it("skips a later published stable instead of allocating against it", () => {
    const published = registry();
    published.versions.set("0.3.0", { integrity: "published" });
    expect(decision({ current: "0.2.0", plannedBase: "0.2.1", registry: published })).toEqual(skips.stable);
  });

  it("allocates after the policy accepts the base, counting reservations as taken", () => {
    const published = registry();
    published.versions.set("0.1.9", { integrity: "stable" });
    published.versions.set("0.2.0-canary.12", { integrity: "canary" });
    expect(decision({ registry: published, reserved: ["0.2.0-canary.13"] })).toEqual(cut("0.2.0-canary.14"));
  });

  it("increments only matching canary suffixes and skips larger bases", () => {
    const published = registry();
    for (const version of [
      "0.1.9",
      "0.2.0-canary.9",
      "0.2.0-canary.10",
      "0.2.0-canary.2",
      "0.2.0-canary.12",
    ]) {
      published.versions.set(version, { integrity: version });
    }
    expect(decision({ registry: published })).toEqual(cut("0.2.0-canary.13"));
    expect(decision({ current: "0.2.0", plannedBase: "0.3.0", reserved: ["0.2.0-canary.99"] })).toEqual(
      cut("0.3.0-canary.0")
    );
    expect(decision({ reserved: ["0.3.0-canary.0", "0.2.0-canary.4"] })).toEqual(skips.base);
  });

  it("does not round large canary counters", () => {
    expect(
      decision({ current: "0.9.0", plannedBase: "1.0.0", reserved: ["1.0.0-canary.9007199254740993"] })
    ).toEqual(cut("1.0.0-canary.9007199254740994"));
  });
});
```

Note on the former `allocateCanary("0.2.0", ["0.2.0", "0.3.0-canary.0", "0.2.0-canary.4"])` case: with a published `0.2.0` stable the decision would be `stable-superseded` before allocation runs, so the migrated case passes the two canaries as reservations instead. That exercises the same allocation branch (a larger base wins) without a stable in the registry.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @elmeragroup/release test -- policy`
Expected: FAIL. `decideCanary` is not exported from `../src/policy.ts`.

- [ ] **Step 3: Implement `decideCanary` in `policy.ts`**

Replace lines 104-130 (`canaryEligibility` and `allocateCanary`, both `export`ed) with:

```ts
/** Why a checked commit does not cut a canary. Each kind renders one log sentence. */
export type CanarySkip = "canary-superseded" | "stable-superseded" | "regressed-base";

/** The Canary decision: the version to cut, or the skip and its sentence. */
export type CanaryDecision = { cut: string } | { skip: CanarySkip; reason: string };

const skipReasons: Readonly<Record<CanarySkip, string>> = {
  "canary-superseded": "Skipping a commit superseded by a published canary",
  "stable-superseded": "Skipping a commit superseded by a stable release",
  "regressed-base": "Skipping a commit superseded by a canary on a newer base",
};

function skip(kind: CanarySkip): CanaryDecision {
  return { skip: kind, reason: skipReasons[kind] };
}

/**
 * Allocates the next canary number for `base`, or reports `undefined` when a published or reserved
 * canary already belongs to a newer base. A regressed base skips; it never blocks publication.
 */
function allocateCanary(base: string, versions: readonly string[]): string | undefined {
  parseStableVersion(base);
  let highest = -1n;
  for (const version of versions) {
    if (!isCanaryReleaseVersion(version)) continue;
    const candidate = parseCanaryVersion(version);
    if (compareStableVersions(candidate.base, base) > 0) return undefined;
    if (candidate.base === base && candidate.n > highest) highest = candidate.n;
  }
  return formatCanaryVersion({ base, n: highest + 1n });
}

/**
 * Decides the canary for a checked main commit. Ancestry and the planned base settle whether the
 * commit still owns the channel; published and reserved versions together settle the number, so a
 * reservation is taken even when npm has not seen it yet.
 */
export function decideCanary(
  target: CanaryTarget,
  registry: Registry,
  reserved: readonly string[],
  isAncestor: CommitAncestry
): CanaryDecision {
  if (compareStableVersions(target.base, target.current) <= 0) {
    throw new Error("The planned version must advance the stable version");
  }
  const status = canarySupersession(target.commit, target.base, registry, isAncestor);
  if (status !== "owned") return skip(status);
  const version = allocateCanary(target.base, [...registry.versions.keys(), ...reserved]);
  if (version === undefined) return skip("regressed-base");
  return { cut: version };
}
```

- [ ] **Step 4: Run the policy tests**

Run: `pnpm --filter @elmeragroup/release test -- policy`
Expected: PASS for every case in `policy.test.ts`.

Do not run the full package suite yet. `engine.ts` still imports the removed exports and will fail type-check until Task 2.

---

### Task 2: Engine uses the Canary decision; docs; first commit

**Files:**

- Modify: `packages/release/src/engine.ts:18-19, 46-52, 108-124`
- Modify: `packages/release/README.md:102-104`
- Modify (already edited, uncommitted): `CONTEXT.md`
- Test: `packages/release/test/engine.test.ts` (no edits expected; the three skip-log assertions at lines 246, 259, 272 must keep passing)

**Interfaces:**

- Consumes: `decideCanary`, `CanaryDecision` from Task 1.

- [ ] **Step 1: Replace the engine imports**

Lines 18-19 of `engine.ts` currently read:

```ts
import { allocateCanary, canaryEligibility } from "./policy.ts";
import type { CanarySupersession } from "./policy.ts";
```

Replace with:

```ts
import { decideCanary } from "./policy.ts";
```

- [ ] **Step 2: Delete the skip helpers**

Remove lines 46-52 entirely:

```ts
function skipReason(status: Exclude<CanarySupersession, "owned">): string {
  return status === "canary-superseded"
    ? "Skipping a commit superseded by a published canary"
    : "Skipping a commit superseded by a stable release";
}

const regressedBaseSkip = "Skipping a commit superseded by a canary on a newer base";
```

- [ ] **Step 3: Replace the tail of `mainReleaseIntent`**

The body from `const registry = yield* deps.readRegistry();` to the end of the generator currently reads:

```ts
const registry = yield * deps.readRegistry();
const status =
  yield * lift(() => canaryEligibility({ commit, current: line.current, base }, registry, deps.ancestry));
if (status !== "owned") {
  deps.log(skipReason(status));
  return undefined;
}
const reserved = yield * deps.store.reservedCanaryVersions();
const version = yield * lift(() => allocateCanary(base, [...registry.versions.keys(), ...reserved]));
if (version === undefined) {
  deps.log(regressedBaseSkip);
  return undefined;
}
return { channel: "canary", version, commit } as const;
```

Replace with:

```ts
const registry = yield * deps.readRegistry();
const reserved = yield * deps.store.reservedCanaryVersions();
const decision =
  yield *
  lift(() => decideCanary({ commit, current: line.current, base }, registry, reserved, deps.ancestry));
if ("skip" in decision) {
  deps.log(decision.reason);
  return undefined;
}
return { channel: "canary", version: decision.cut, commit } as const;
```

Reading reservations before the decision adds no GitHub call: `deps.store.find(canaryRecordTag(commit))` a few lines earlier already loaded the store's memoised catalog.

- [ ] **Step 4: Run the package suite and type-check**

Run: `pnpm --filter @elmeragroup/release test && pnpm --filter @elmeragroup/release type-check`
Expected: PASS. In `engine.test.ts` the cases at lines 236, 249 and 262 still assert the three skip sentences via `outcome.logs`.

- [ ] **Step 5: Update the release README**

In `packages/release/README.md`, the paragraph at lines 102-104 reads:

```
A published stable whose commit is a descendant of a canary supersedes it even when the stable
version is below the canary's base. A planned canary base older than a published or reserved canary
version is skipped, keeping the earlier reservation. Same-version identity mismatches stay fatal.
```

Replace with:

```
The canary decision for a checked commit is one policy function: it either names the canary
version to cut or names what supersedes the commit. A published stable whose commit is a descendant
of a canary supersedes it even when the stable version is below the canary's base. A planned canary
base older than a published or reserved canary version is skipped, keeping the earlier reservation.
Same-version identity mismatches stay fatal.
```

- [ ] **Step 6: Format and run the workspace checks**

Run: `pnpm exec oxfmt packages/release/src/policy.ts packages/release/src/engine.ts packages/release/test/policy.test.ts packages/release/README.md CONTEXT.md && pnpm ci:checks`
Expected: PASS with no warnings.

- [ ] **Step 7: Commit**

```bash
git add packages/release/src/policy.ts packages/release/src/engine.ts packages/release/test/policy.test.ts packages/release/README.md CONTEXT.md docs/superpowers
git commit -m "$(cat <<'EOF'
refactor(release): make the canary decision one policy function

decideCanary absorbs eligibility, the reservation union, allocation and
the skip sentences that the engine composed by hand. The policy test now
exercises the real composition instead of re-implementing it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `record.ts` and `record.test.ts` (test first)

**Files:**

- Create: `packages/release/src/record.ts`
- Create: `packages/release/test/record.test.ts`
- Modify: `packages/release/src/intent.ts`

**Interfaces:**

- Produces (from `record.ts`), all used by Task 4:
  ```ts
  export const releaseRecordOwner: "elmera-release";
  export const releaseArchiveName: "release.tgz";
  export function canaryRecordTag(commit: string): string;
  export function releaseTag(intent: ReleaseIntent): string;
  export function isReleaseTag(tag: string): boolean;
  export function assertReleaseTag(tag: string): string;
  export function parseIntent(text: string): ReleaseIntent;
  export function serializeIntent(intent: ReleaseIntent): string;
  export type ReleaseRecordClassification =
    | { kind: "ignored" }
    | { kind: "foreign" }
    | { kind: "owned"; intent: ReleaseIntent }
    | { kind: "legacy"; intent: ReleaseIntent };
  export function classifyReleaseRecord(
    tag: string,
    body: string,
    assetNames: readonly string[]
  ): ReleaseRecordClassification;
  export type ReleaseAsset = { state: "missing" } | { state: "starter" | "uploaded"; id: number };
  export function classifyReleaseAsset(
    starterAllowed: boolean,
    asset: GitHubReleaseAsset | undefined
  ): ReleaseAsset;
  ```
- `intent.ts` keeps and exports `ReleaseIntent`, `VerifiedRelease`, `assertCommit`, and newly exports `isCommit`.

- [ ] **Step 1: Write `record.test.ts`**

This merges the four cases of `intent.test.ts` (unchanged behaviour, new import path) with the five `ownership.test.ts` sub-cases the store does not prove.

```ts
import { describe, expect, it } from "vitest";

import { assertCommit } from "../src/intent.ts";
import type { ReleaseIntent } from "../src/intent.ts";
import {
  assertReleaseTag,
  classifyReleaseRecord,
  isReleaseTag,
  parseIntent,
  releaseArchiveName,
  releaseRecordOwner,
  releaseTag,
  serializeIntent,
} from "../src/record.ts";

const commit = "a".repeat(40);
const stable: ReleaseIntent = { channel: "stable", version: "0.2.0", commit };
const canary: ReleaseIntent = { channel: "canary", version: "0.3.0-canary.0", commit };

describe("release record identity", () => {
  it("parses unmarked schema-1 and marked owned schema-1", () => {
    const unmarked = { schema: 1, ...stable };
    const marked = { schema: 1, owner: releaseRecordOwner, ...stable };
    expect(parseIntent(JSON.stringify(unmarked))).toEqual(stable);
    expect(parseIntent(JSON.stringify(marked))).toEqual(stable);
    expect(releaseTag(parseIntent(JSON.stringify(unmarked)))).toBe("v0.2.0");
  });

  it("serializes new intents with the stable owner marker", () => {
    expect(JSON.parse(serializeIntent(canary))).toEqual({
      schema: 1,
      owner: releaseRecordOwner,
      channel: "canary",
      version: "0.3.0-canary.0",
      commit,
    });
    expect(parseIntent(serializeIntent(canary))).toEqual(canary);
  });

  it("rejects a foreign owner, unsupported channel, canary-as-stable, and short SHA", () => {
    const recorded = { schema: 1, channel: "stable", version: "0.2.0", commit };
    expect(() => parseIntent(JSON.stringify({ ...recorded, owner: "other-release" }))).toThrow(
      "release intent is invalid"
    );
    expect(() => parseIntent(JSON.stringify({ ...recorded, channel: "beta" }))).toThrow(
      "release intent is invalid"
    );
    expect(() => parseIntent(JSON.stringify({ ...recorded, version: "0.2.0-canary.0" }))).toThrow(
      "Expected a stable version"
    );
    expect(() => parseIntent(JSON.stringify({ ...recorded, commit: "main" }))).toThrow(
      "Expected a full commit SHA"
    );
  });

  it("accepts only v<stable> and canary-<sha> record tags", () => {
    expect(isReleaseTag("v0.2.0")).toBe(true);
    expect(isReleaseTag(`canary-${commit}`)).toBe(true);
    expect(isReleaseTag("weekly-notes")).toBe(false);
    expect(isReleaseTag("v0.2.0-canary.0")).toBe(false);
    expect(assertReleaseTag("v0.2.0")).toBe("v0.2.0");
    expect(() => assertReleaseTag("v1")).toThrow("record tag");
    expect(assertCommit(commit)).toBe(commit);
    expect(() => assertCommit("HEAD")).toThrow("full commit SHA");
  });
});

describe("release record classification", () => {
  // Cases the store suite does not reach through fixture fetch responses. Every other ownership rule
  // is proven through ReleaseStore.find/create/reservedCanaryVersions in store.test.ts.
  it("ignores a valid intent body whose tag is not a record tag", () => {
    expect(classifyReleaseRecord("v1", JSON.stringify({ schema: 1, ...stable }), [])).toEqual({
      kind: "ignored",
    });
  });

  it("fails an owned record whose payload is missing a field", () => {
    expect(() =>
      classifyReleaseRecord(
        "v0.2.0",
        JSON.stringify({ schema: 1, owner: releaseRecordOwner, channel: "stable", version: "0.2.0" }),
        []
      )
    ).toThrow("release intent is invalid");
  });

  it("fails an archive-carrying record whose body is not readable intent", () => {
    expect(() => classifyReleaseRecord("v0.2.0", "not json", [releaseArchiveName])).toThrow(/JSON/);
    expect(() =>
      classifyReleaseRecord("v0.2.0", JSON.stringify({ notes: "human" }), [releaseArchiveName])
    ).toThrow("release intent is invalid");
  });

  it("treats an archive-carrying record with another owner marker as foreign", () => {
    expect(
      classifyReleaseRecord("v0.2.0", JSON.stringify({ schema: 1, owner: "other-release", ...stable }), [
        releaseArchiveName,
      ])
    ).toEqual({ kind: "foreign" });
  });
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `pnpm --filter @elmeragroup/release test -- record`
Expected: FAIL. Cannot resolve `../src/record.ts`.

- [ ] **Step 3: Create `record.ts`**

```ts
import { Schema } from "effect";

import type { GitHubReleaseAsset } from "./github.ts";
import { assertCommit, isCommit } from "./intent.ts";
import type { ReleaseIntent } from "./intent.ts";
import { decodeJson } from "./json.ts";
import { assertCanaryReleaseVersion, assertStableReleaseVersion, isStableReleaseVersion } from "./version.ts";

/*
 * A Record is a GitHub draft release that this module owns: its tag is the lookup key, its body
 * carries the intent with an owner marker, and its single asset is the recorded archive. This file
 * holds every format rule for that record; the store holds only transport.
 */

export const releaseRecordOwner = "elmera-release";

/** Asset name of the recorded archive on its GitHub draft release. */
export const releaseArchiveName = "release.tgz";

const canaryRecordPrefix = "canary-";

const IntentDocument = Schema.Struct({
  schema: Schema.Literal(1),
  owner: Schema.optionalKey(Schema.Literal(releaseRecordOwner)),
  channel: Schema.Literals(["stable", "canary"]),
  version: Schema.String,
  commit: Schema.String,
});

/** Record tag for a canary release of `commit`. */
export function canaryRecordTag(commit: string): string {
  return `${canaryRecordPrefix}${commit}`;
}

export function releaseTag(intent: ReleaseIntent): string {
  return intent.channel === "stable" ? `v${intent.version}` : canaryRecordTag(intent.commit);
}

export function isReleaseTag(tag: string): boolean {
  if (tag.startsWith("v")) return isStableReleaseVersion(tag.slice(1));
  return tag.startsWith(canaryRecordPrefix) && isCommit(tag.slice(canaryRecordPrefix.length));
}

export function assertReleaseTag(tag: string): string {
  if (!isReleaseTag(tag)) throw new Error("Expected a stable or canary release record tag");
  return tag;
}

export function parseIntent(text: string): ReleaseIntent {
  const value = decodeJson(text, IntentDocument, "release intent");
  if (value.channel === "stable") assertStableReleaseVersion(value.version);
  else assertCanaryReleaseVersion(value.version);
  return { channel: value.channel, version: value.version, commit: assertCommit(value.commit) };
}

export function serializeIntent(intent: ReleaseIntent): string {
  return JSON.stringify({
    schema: 1,
    owner: releaseRecordOwner,
    channel: intent.channel,
    version: intent.version,
    commit: intent.commit,
  });
}

export type ReleaseRecordClassification =
  | { kind: "ignored" }
  | { kind: "foreign" }
  | { kind: "owned"; intent: ReleaseIntent }
  | { kind: "legacy"; intent: ReleaseIntent };

const IntentProbe = Schema.Struct({
  schema: Schema.optionalKey(Schema.Json),
  owner: Schema.optionalKey(Schema.Json),
});
type IntentProbe = typeof IntentProbe.Type;

function tryParseBody(body: string): IntentProbe | undefined {
  try {
    return decodeJson(body, IntentProbe, "release body");
  } catch {
    return undefined;
  }
}

function intentMatchingTag(body: string, tag: string): ReleaseIntent {
  const intent = parseIntent(body);
  if (releaseTag(intent) !== tag) throw new Error("Release tag does not match its intent");
  return intent;
}

function clearlyForeignIdentity(parsed: IntentProbe | undefined): boolean {
  return parsed !== undefined && parsed.owner !== undefined && parsed.owner !== releaseRecordOwner;
}

/**
 * Ownership is recognized before intent validation (ADR 0002). An owned or legacy record with an
 * unreadable body throws so it is reported damaged rather than skipped as foreign.
 */
export function classifyReleaseRecord(
  tag: string,
  body: string,
  assetNames: readonly string[]
): ReleaseRecordClassification {
  if (!isReleaseTag(tag)) return { kind: "ignored" };
  const parsed = tryParseBody(body);
  if (parsed?.owner === releaseRecordOwner) {
    return { kind: "owned", intent: intentMatchingTag(body, tag) };
  }
  if (parsed?.schema === 1 && parsed.owner === undefined) {
    return { kind: "legacy", intent: intentMatchingTag(body, tag) };
  }
  if (assetNames.includes(releaseArchiveName) && !clearlyForeignIdentity(parsed)) {
    return { kind: "legacy", intent: intentMatchingTag(body, tag) };
  }
  return { kind: "foreign" };
}

export type ReleaseAsset = { state: "missing" } | { state: "starter" | "uploaded"; id: number };

/** `starterAllowed` records that an empty placeholder is only legal on a draft release. */
export function classifyReleaseAsset(
  starterAllowed: boolean,
  asset: GitHubReleaseAsset | undefined
): ReleaseAsset {
  if (asset === undefined) return { state: "missing" };
  if (asset.state === "starter") {
    if (!starterAllowed || asset.size !== 0) throw new Error("Unsupported starter release asset");
    return { state: "starter", id: asset.id };
  }
  if (asset.state !== "uploaded") throw new Error(`Unsupported release asset state ${asset.state}`);
  if (asset.size <= 0) throw new Error("Uploaded release asset has no bytes");
  return { state: "uploaded", id: asset.id };
}
```

- [ ] **Step 4: Shrink `intent.ts`**

Replace the whole file with:

```ts
export type ReleaseIntent = {
  channel: "canary" | "stable";
  version: string;
  commit: string;
};

export type VerifiedRelease = ReleaseIntent & {
  archive: string;
  integrity: string;
};

export function isCommit(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value);
}

export function assertCommit(commit: string): string {
  if (!isCommit(commit)) throw new Error(`Expected a full commit SHA; received ${commit}`);
  return commit;
}
```

- [ ] **Step 5: Run the record tests**

Run: `pnpm --filter @elmeragroup/release test -- record`
Expected: PASS for all eight cases.

Do not run the full suite yet. `store.ts`, `engine.ts`, `archive.ts`, `ownership.ts` and several tests still import moved symbols from `intent.ts`; Task 4 rewires them.

---

### Task 4: Rewire the store, engine, archive and tests; delete `ownership.ts`; second commit

**Files:**

- Modify: `packages/release/src/store.ts:8-12, 52-65`
- Modify: `packages/release/src/engine.ts:14-15`
- Modify: `packages/release/src/archive.ts:11-12, 44`
- Delete: `packages/release/src/ownership.ts`
- Delete: `packages/release/test/ownership.test.ts`, `packages/release/test/intent.test.ts`
- Modify: `packages/release/test/store.test.ts:5-9, 223-252`
- Modify: `packages/release/test/engine.test.ts:20-21`

**Interfaces:**

- Consumes everything `record.ts` exports (Task 3).

- [ ] **Step 1: Rewire `store.ts` imports and drop its asset code**

Lines 8-10 currently read:

```ts
import { releaseArchiveName, releaseTag, serializeIntent } from "./intent.ts";
import type { ReleaseIntent } from "./intent.ts";
import { classifyReleaseRecord } from "./ownership.ts";
```

Replace with:

```ts
import type { ReleaseIntent } from "./intent.ts";
import {
  classifyReleaseAsset,
  classifyReleaseRecord,
  releaseArchiveName,
  releaseTag,
  serializeIntent,
} from "./record.ts";
import type { ReleaseAsset } from "./record.ts";
```

Delete line 12 (`export type ReleaseAsset = ...`) and the exported `classifyReleaseAsset` function with its doc comment (lines 52-65). `SavedRelease` keeps referencing `ReleaseAsset`, now the imported type. `GitHubReleaseAsset` is no longer used in `store.ts`; remove it from the `./github.ts` import on line 6 so the import reads `import { GitHubRelease, GitHubTagRef } from "./github.ts";`.

- [ ] **Step 2: Rewire `engine.ts`**

Lines 14-15 currently read:

```ts
import { assertCommit, assertReleaseTag, canaryRecordTag, releaseTag } from "./intent.ts";
import type { ReleaseIntent, VerifiedRelease } from "./intent.ts";
```

Replace with:

```ts
import { assertCommit } from "./intent.ts";
import type { ReleaseIntent, VerifiedRelease } from "./intent.ts";
import { assertReleaseTag, canaryRecordTag, releaseTag } from "./record.ts";
```

- [ ] **Step 3: Give `archive.ts` a local filename**

Delete line 12 (`import { releaseArchiveName } from "./intent.ts";`). After the `PackedManifest` schema add:

```ts
/** Scratch filename inside the scoped temp directory; unrelated to the record's asset name. */
const scratchArchiveName = "archive.tgz";
```

Change line 44 from `resolve(directory, releaseArchiveName)` to `resolve(directory, scratchArchiveName)`.

- [ ] **Step 4: Delete the folded module and its tests**

```bash
git rm packages/release/src/ownership.ts packages/release/test/ownership.test.ts packages/release/test/intent.test.ts
```

- [ ] **Step 5: Update `store.test.ts`**

Lines 5-9 currently read:

```ts
import { releaseArchiveName, releaseRecordOwner, serializeIntent } from "../src/intent.ts";
import type { ReleaseIntent } from "../src/intent.ts";
import { decodeJson } from "../src/json.ts";
import { classifyReleaseAsset, createReleaseStore } from "../src/store.ts";
import type { ReleaseStore, SavedRelease } from "../src/store.ts";
```

Replace with:

```ts
import type { ReleaseIntent } from "../src/intent.ts";
import { decodeJson } from "../src/json.ts";
import { releaseArchiveName, releaseRecordOwner, serializeIntent } from "../src/record.ts";
import { createReleaseStore } from "../src/store.ts";
import type { ReleaseStore, SavedRelease } from "../src/store.ts";
```

Then in `describe("release asset classification", ...)` (lines 223-252) delete the direct calls and keep the store-level assertions. The block becomes:

```ts
describe("release asset classification", () => {
  it("rejects a non-draft starter asset", async () => {
    const { store } = githubStore([releaseRecord({ draft: false })]);
    await expect(Effect.runPromise(store.find("v0.2.0"))).rejects.toThrow(
      "Unsupported starter release asset"
    );
  });
  it("rejects an unknown asset state", async () => {
    const unknown = { id: 2, name: releaseArchiveName, state: "open", size: 0 };
    const { store } = githubStore([releaseRecord({ assets: [unknown] })]);
    await expect(Effect.runPromise(store.find("v0.2.0"))).rejects.toThrow(
      "Unsupported release asset state open"
    );
  });
  it("rejects a size-zero uploaded asset", async () => {
    const empty = { id: 2, name: releaseArchiveName, state: "uploaded", size: 0 };
    const { store } = githubStore([releaseRecord({ assets: [empty] })]);
    await expect(Effect.runPromise(store.find("v0.2.0"))).rejects.toThrow(
      "Uploaded release asset has no bytes"
    );
  });
});
```

The removed first case (starter, uploaded, missing classified correctly) is already proven through `store.find` and `store.download` at lines 109-140 and 162-168 of the same file. If `starterAsset` or `uploadedAsset` at lines 15-16 become unused after this edit, lint will flag them; delete whichever is unused.

- [ ] **Step 6: Update `engine.test.ts`**

Lines 20-21 currently read:

```ts
import { canaryRecordTag, releaseTag } from "../src/intent.ts";
import type { ReleaseIntent, VerifiedRelease } from "../src/intent.ts";
```

Replace with:

```ts
import type { ReleaseIntent, VerifiedRelease } from "../src/intent.ts";
import { canaryRecordTag, releaseTag } from "../src/record.ts";
```

- [ ] **Step 7: Run the package suite and type-check**

Run: `pnpm --filter @elmeragroup/release test && pnpm --filter @elmeragroup/release type-check`
Expected: PASS. `import.test.ts` still sees the same `index.ts` surface; `ReleaseIntent` is still exported from `intent.ts`.

- [ ] **Step 8: Format and run the workspace checks**

Run: `pnpm exec oxfmt packages/release/src packages/release/test && pnpm ci:checks`
Expected: PASS with no warnings. If the formatter reorders the new imports, accept its order.

- [ ] **Step 9: Commit**

```bash
git add packages/release/src packages/release/test
git commit -m "$(cat <<'EOF'
refactor(release): collect the release record rules in one module

record.ts owns the record tag, owner marker, intent body format, asset
name, and record and asset classification. intent.ts keeps only the
intent types; ownership.ts is folded in; the store keeps transport.
Archive verification uses its own scratch filename.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Packed verification and pull request

**Files:** none

- [ ] **Step 1: Verify the packed consumer path**

Run: `pnpm packages:pack && pnpm test:packed-consumer`
Expected: PASS. The release export is bundled into `@elmeragroup/internal/release`; this proves the bundle still builds and the consumer test still imports it.

- [ ] **Step 2: Push and open the PR with the `no-changeset` label**

```bash
git push -u origin deepen-release-policy-and-record
gh pr create --label no-changeset --title "Deepen release policy and record modules" --body "$(cat <<'EOF'
## Summary

Two folds in the private `@elmeragroup/release` workspace, no public surface or behaviour change.

1. **One Canary decision in policy.** `decideCanary` absorbs eligibility, the reservation union, allocation and the skip sentences the engine composed by hand. `policy.test.ts` now tests the real composition instead of re-implementing it.
2. **One Record module.** `record.ts` owns tag rules, owner marker, body format, asset name, and record and asset classification. `ownership.ts` is folded in, `intent.ts` keeps only the intent types, the store keeps transport, and archive verification stops borrowing the asset name.

Design: `docs/superpowers/specs/2026-09-14-release-deepening-design.md`. CONTEXT.md gains the term **Canary decision**.

## No changeset

`@elmeragroup/release` is private and bundled into `@elmeragroup/internal/release`. Shipped bytes change, observable behaviour and the public interface do not, so this carries `no-changeset` rather than a noise patch bump.

## Checks

- `pnpm ci:checks` after each commit
- `pnpm packages:pack && pnpm test:packed-consumer`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

- **Spec coverage:** decisions 1-3 and 11 land in Tasks 1-2; decisions 4-7 in Tasks 3-4; decision 8 is the two commits; decision 9 is Task 5; decision 10 is committed in Task 2.
- **Type consistency:** `CanarySkip`, `CanaryDecision`, `decideCanary(target, registry, reserved, isAncestor)` are spelled the same in Task 1 (definition), Task 1 tests, and Task 2 (engine). `record.ts` export names in Task 3 match every import rewritten in Task 4.
- **Behaviour preserved:** the three skip sentences are byte-identical to the former `engine.ts:48-52` strings, so `engine.test.ts:246, 259, 272` pass unchanged. `classifyReleaseRecord` and `classifyReleaseAsset` bodies are moved verbatim.
