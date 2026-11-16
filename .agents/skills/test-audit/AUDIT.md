# Test audit workflow

An audit sweeps existing tests for the [junk patterns](SKILL.md#junk-patterns) and the test-only
seams they keep alive, then lands one coherent batch per owner boundary. [SKILL.md](SKILL.md) owns
the value bar and its terms. This file adds the order of work.

## 1. Discovery

Discovery is read-only. For a broad scope, give each package its own read-only agent when subagents
are available, plus one cross-cutting sweep for a single junk pattern. The test trees are each
package's `test/` directory, the colocated rule tests in `packages/oxlint-*`, the root `test/`
repository-policy suite and `test/packed-consumer/`.

Done when every package in scope has returned its candidates, each with its location and the junk
pattern it matches. Prefer a few candidates you can prove to a long speculative inventory.

## 2. Candidate evidence

Before judging a candidate, read the complete test and its owner: the entry point, callers, callees,
overlapping tests and the history that added it (`git log -S`, the PR). Record every field below. A
candidate with a missing field stays.

- exact test name and location;
- the failure it can actually detect;
- non-test callers of the covered code or test-only seam;
- the keeper that remains and the mutation that turned it red, or why no contract exists;
- the reason the test or seam exists;
- the code or seam its removal unlocks;
- the focused command that validates the change.

To prove a keeper, make one deliberate mutation of the owner and confirm the keeper goes red. Then
restore the source byte for byte.

Share the evidence with the user before editing, unless their request already covers the edits.

## 3. Edit

Pick one owner-boundary batch. Delete test-only seams and dead production paths outright. Move
retained regressions to their keepers. A replacement test that restates the same implementation
fails the gate, and an uncertain candidate stays as it is. Removing a public export of
`@elmeragroup/internal` changes its API and needs a changeset.

## 4. Validation

Run the affected package's tests while editing, then the checks in `AGENTS.md` before review. For a
removed source grep or manifest assertion, run the lint rule, script or turbo task that now owns the
contract. Read `git diff --numstat` and count production lines separately from test lines.

## 5. Handoff

Report the junk patterns removed and why they arose, the seams deleted, the retained candidates and
the contract each still guards, every mutation you ran, and the line counts.
