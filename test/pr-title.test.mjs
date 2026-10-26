import { describe, expect, it } from "vitest";

import { prTitleProblems } from "../scripts/check-pr-title.ts";

// Expected verdicts come from the rule in CONTRIBUTING.md#pr-title, using titles from main's history.
describe("PR title check", () => {
  it.each([
    "Publish To `npm` Through Trusted Publishing Instead Of A Stored Token",
    "Migrate From `typescript` 7.0.2 To `tsrs` (TypeScript 7.1)",
    "Name TypeScript's Default Library `typescript` In forwardedFrom",
    "Accept Changesets Plan Entries Without newVersion",
    "Publish Re-Export-Only Facades As Forwarded Parts",
    "Upgrade Effect To Stable 4.0.2",
  ])("accepts %s", (title) => {
    expect(prTitleProblems(title)).toEqual([]);
  });

  it.each([
    {
      title: "Publish to npm Through Trusted Publishing Instead of a Stored Token",
      problems: ["Capitalize: to, npm, of, a."],
    },
    {
      title: "Migrate from typescript 7.0.2 to tsrs (TypeScript 7.1)",
      problems: ["Capitalize: from, typescript, to, tsrs."],
    },
    {
      title: "Publish Re-Export-only Facades As Forwarded Parts",
      problems: ["Capitalize: Re-Export-only."],
    },
    {
      title: "fix(oxlint-anti-slop): Classify Record And Mapped Widening Targets By Key",
      problems: ["Drop the conventional commit prefix; commit messages keep it, PR titles do not."],
    },
    {
      title: "ci: Publish To `npm` Through Trusted Publishing",
      problems: ["Drop the conventional commit prefix; commit messages keep it, PR titles do not."],
    },
    { title: "  ", problems: ["The title is empty."] },
  ])("rejects $title", ({ title, problems }) => {
    expect(prTitleProblems(title)).toEqual(problems);
  });
});
