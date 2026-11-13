---
name: test-audit
description: "Test value gate and audit. Use when writing or changing a test, reviewing tests in a diff, or auditing existing tests and the test-only seams they keep alive."
---

# Test audit

One value bar serves three branches:

- To write or change a test, pass the [authoring gate](#authoring-gate).
- To review tests in a diff, check the PR's Test value answers against every added or changed
  test. Report as a finding each test the section leaves unanswered, each answer the diff
  contradicts, each gate question the diff cannot answer, and each matched junk pattern.
- To audit existing tests, read [AUDIT.md](AUDIT.md) before discovery.

The Tests section of `AGENTS.md` owns the oracle rule, the flake rule and where each kind of test
lives. This skill decides whether a test earns its place.

## Terms

- The **owner boundary** is the public entry point of the module that owns a behavior: an export
  of `@elmeragroup/internal`, a package's `src/index.ts`, a script's CLI, a lint rule object, or a
  generated artifact. A contract's one primary test there is its **keeper**.
- The **oracle** is the independently defined expectation a test reproduces; the Tests section of
  `AGENTS.md` lists what qualifies.
- A **change detector** goes red under a behavior-preserving refactor.
- A **test-only seam** is an export, parameter, option, global or code path whose only callers are
  tests, such as a `…ForTest` factory.
- A test goes **red** when it fails for the reason it claims to guard.

## Authoring gate

A behavior change or fix gets a test only when one passes this gate. It needs no test when no
behavior changed or when the keeper already goes red on the regression; the PR's Test value section
names which.

Answer each question before adding the test, and put the answers in the PR's Test value section.

1. What observable behavior, invariant or independent contract does it protect, and what is its
   oracle?
2. What credible regression turns it red?
3. Why does the keeper not already go red on that regression? A second layer earns a test only
   through a risk the keeper cannot reach, such as the packed archive under a consumer without
   workspace links. Extend a table-driven case or shared fixture before writing a near-duplicate.
4. Does it need a test-only seam? Then move it to the owner boundary, where it needs none.

Then check the test against every [junk pattern](#junk-patterns). A match fails the gate unless the
[retention bar](#retention-bar) names the contract it independently guards. Rewrite a failed test
at the owner boundary.

A bug regression test goes red on the pre-fix code for the intended reason and passes after the fix.
Until you have seen it go red, it proves only its setup. Break the owner on purpose once, watch the
test fail with the expected message, and restore the source byte for byte.

## Junk patterns

`pnpm lint` rejects the mechanical shapes through the `tests/*` rules from
`packages/oxlint-test-rules`, which the test-file overrides in `.oxlintrc.json` turn on. A disable
comment names the contract the test guards, and the gate still applies to it.

**Tautologies.** The expectation comes from the thing under test.

- a function compared with its own output from the same run;
- a literal the test defines and then asserts back;
- a fake that implements the asserted behavior, or one fake standing in for different APIs;
- a fixture that supplies the state, ordering or callback the owner should produce.

**Change detectors.** The test pins the implementation's shape.

- source, import or string greps that go red on an identifier-only refactor;
- a copied inventory, manifest or export list that echoes the source without forcing a decision on
  each new item;
- catalog or dependency versions that `pnpm-workspace.yaml` or a `package.json` already pins.

**Duplicates.** The contract already has a proof.

- the same contract asserted at several layers, or twice in one layer;
- a private helper or call-shape test the keeper already covers.

**Seam keepers.** A test whose only purpose is keeping a test-only seam alive, including dead
production code whose only callers are tests.

**False signals.** The test passes without the behavior.

- assertion-free coverage probes;
- tombstones that assert deleted internal code stays deleted, where a live rule about what exists
  belongs;
- negative controls that pass for an unrelated reason, such as a rejection from a different guard;
- an optional check that returns early when its input is missing, with no test that the input is
  present where it must be;
- names that promise more than the input exercises.

**Flakes.** The result depends on timing, load or order: a wall-clock budget, a fixed delay, a
retry, a scan of a directory other test files share.

## Retention bar

Keep a test that independently enforces a public behavior `AGENTS.md` names, or the package
manifests, release workflow or repository policy. Also keep:

- a cross-check between two representations that names its oracle;
- a drift gate that compares committed generated files or reports with a fresh generation, such as
  the extractor's conformance, warning and timing evidence. Every change shows in the PR diff;
- a reviewed inventory that forces a decision on each new item, such as the fixture catalog;
- a guard that keeps a retired public API from returning;
- call ordering when order is observable behavior;
- a regression with a credible failure mode;
- a check on the lint config or the source text that no lint rule can state, when the test says
  why. A mechanical source contract (an import boundary, a restricted call) is a lint rule instead.

A test that is static, slow or shaped like the implementation can still be a contract's only proof.
Before removing it, prove a keeper goes red on the same regression, as
[AUDIT.md §2](AUDIT.md#2-candidate-evidence) describes.
