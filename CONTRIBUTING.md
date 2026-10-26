# Contributing

This workspace holds Elmera Group's shared engineering tools. Before opening a PR, establish where
the change belongs and complete the review and verification below.

These rules apply to every PR, including drafts. A PR into `main` needs no formal approval, but only
members of the `internal-maintainers` team, the code owners in [CODEOWNERS](.github/CODEOWNERS), can
merge it; branch protection enforces this. Meeting this guide makes a PR eligible for merge. The code
owner decides whether to merge it.

## Setup and workflow

Follow [Development](README.md#development) to set up the workspace. Read [AGENTS.md](AGENTS.md) for
the package responsibilities, code conventions and checks.

<a id="placement"></a>

## Ask first: where does it belong?

Before adding an option, rule, export or default, ask: "Does this belong in this workspace, or in
the consumer repository?" Add it here when it is shared engineering policy that more than one
consumer needs. Keep behavior tied to one consumer's code in that consumer.

Then place it in the package that owns it under the
[package responsibilities](AGENTS.md#package-responsibilities). The PR explains both decisions: why
the change is shared policy, and why this package owns it. A new public entry of
`@elmeragroup/internal` also names the general need it serves.

<a id="one-problem"></a>

## Solve one problem per PR

Split a PR that solves several independent problems, even when each fix is useful on its own. Count
the underlying problems, not the linked issues.

Include the source, tests, documentation, changeset and regenerated evidence the problem requires.
Put unrelated cleanup and other fixes in separate PRs.

<a id="pr-title"></a>

## Title the PR in Title Case

Write the PR title as a plain-language sentence in Title Case: capitalize every word, and keep code
names and brand names in their own casing, such as "Name TypeScript's Default Library In
forwardedFrom". Wrap an all-lowercase code or brand name in backticks, such as "Publish To `npm`
Through Trusted Publishing Instead Of A Stored Token". Leave out the conventional commit prefix.

`main` accepts squash merges only. The PR title becomes the squash commit subject and the PR body its
description. The `pr-title` check flags titles that break the rule. Commit messages on the branch
keep the conventional commit format.

<a id="review-before-submitting"></a>

## Review it before you open it

Complete a full review pass before opening a PR, or before marking a draft ready for review.

Use a reviewer other than the code's author: another person, or an agent with a fresh context. When
an agent wrote the change, the person who directed it can review it. The reviewer checks the
complete proposed diff and relevant surrounding code against the agreed scope, this guide and
[AGENTS.md](AGENTS.md).

Review the generated Version Packages PR (`changeset-release/main`) before merging it. The code owner
who merges it records that review in a PR comment.

<a id="verification"></a>

## Show that it works

Behavior changes include tests. Run the [checks](AGENTS.md#setup-and-checks) the change touches,
then explain in the PR how you established the problem and checked the change: the commands you
ran, their results and anything you could not check. When regenerated evidence or reports change,
explain each semantic change.

<a id="release-impact"></a>

## Declare the release impact

Only `@elmeragroup/internal` is published. Add a changeset with `pnpm changeset` for any change that
ships in it, including changes to the private implementations bundled into it. Otherwise apply the
`no-changeset` label and give the reason in the PR. CI's changeset-presence check honours the label.

Edit an existing changeset only to correct what it says shipped, never to move a gate.

## Merging and closing

Before merging, a code owner checks the problem, where the change lives, the scope and the
verification evidence.

A code owner may close a PR or request changes when it belongs elsewhere, solves several independent
problems, lacks a completed review or lacks evidence. The closing comment names the rule and
explains what would change the outcome.

Address the reason and reopen the PR, or open focused replacement PRs and link them to the original.
