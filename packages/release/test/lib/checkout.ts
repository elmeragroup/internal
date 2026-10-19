import type { Schema } from "effect";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ReleasePackage } from "../../src/files.ts";
import { assertCommit } from "../../src/intent.ts";
import type { CommitSha } from "../../src/intent.ts";
import { withGitWorkspaceAsync } from "./git-workspace.ts";

/** One entry of the release plan the fake Changesets CLI reports. */
export type PlannedReleaseFixture = {
  readonly name: string;
  readonly type: string;
  readonly newVersion?: string;
};

/** How a checkout starts; every field has a default. */
export type CheckoutOptions = {
  /** The released package's name; `@acme/app` by default. */
  readonly packageName?: string;
  /** The baseline manifest version; `0.1.9` by default. */
  readonly version?: string;
  /** The branch Changesets tracks, without `origin/`; `main` by default. */
  readonly trackedBranch?: string;
  /** The release plan the fake Changesets CLI reports; empty by default. */
  readonly plan?: readonly PlannedReleaseFixture[];
};

/** A temporary consuming repository with real git history, for one operation test. */
export type Checkout = {
  readonly root: string;
  readonly pkg: ReleasePackage;
  /** Runs git in the checkout with a fixed identity and no hooks. */
  readonly git: (args: readonly string[]) => string;
  /** The commit checked out now. */
  readonly head: () => CommitSha;
  /** Commits every change in the working tree, even none, and returns the new commit. */
  readonly commit: (message: string) => CommitSha;
  /** Points `origin/<trackedBranch>` at `revision`. */
  readonly setTrackedTip: (revision: string) => void;
  /** Checks out `revision` with a detached head, as the publisher's checkout does. */
  readonly detach: (revision: string) => void;
  /** Rewrites the package manifest version. */
  readonly writeVersion: (version: string) => void;
  /** Rewrites the changelog to name `versions`, newest first. */
  readonly writeChangelog: (...versions: readonly string[]) => void;
  /** Adds a pending changeset bumping the package. */
  readonly addChangeset: (id: string) => void;
  /** Deletes a pending changeset, as the release PR consumes it. */
  readonly consumeChangeset: (id: string) => void;
  /** Replaces the release plan the fake Changesets CLI reports. */
  readonly setPlan: (plan: readonly PlannedReleaseFixture[]) => void;
  /** Writes a file relative to the checkout root. */
  readonly writeFile: (path: string, content: string) => void;
  /** Deletes a file relative to the checkout root. */
  readonly removeFile: (path: string) => void;
};

/**
 * Stands in for `@changesets/cli` in the consuming checkout: `status --output <file>` writes the
 * plan stored beside it, so cases never run the real Changesets CLI.
 */
const fakeChangesetsBin = `const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const output = process.argv[process.argv.indexOf("--output") + 1];
const file = resolve(process.cwd(), output);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, readFileSync(join(__dirname, "plan.json"), "utf8"));
`;

function json(value: typeof Schema.Json.Type): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Runs one case against a fresh consuming checkout, removed afterwards. The baseline commit holds
 * a root manifest, `packages/app` with its manifest and changelog, and a `.changeset` directory
 * whose base branch is `origin/<trackedBranch>`; `origin/<trackedBranch>` points at it and the
 * local branch stays checked out until the case detaches.
 */
export function withCheckout(
  options: CheckoutOptions,
  run: (checkout: Checkout) => Promise<void>
): Promise<void> {
  const packageName = options.packageName ?? "@acme/app";
  const trackedBranch = options.trackedBranch ?? "main";
  return withGitWorkspaceAsync("elmera-release-checkout-", async (workspace) => {
    const root = workspace.path;
    const packageDirectory = join(root, "packages/app");
    const path = (relative: string): string => join(root, relative);
    const writeFile = (relative: string, content: string): void => {
      writeFileSync(path(relative), content);
    };
    const changesets = join(root, "node_modules/@changesets/cli");

    const checkout: Checkout = {
      root,
      pkg: { checkoutRoot: root, packageDirectory, packageName },
      git: workspace.git,
      head: () => assertCommit(workspace.git(["rev-parse", "HEAD"])),
      commit: (message) => {
        workspace.git(["add", "-A"]);
        workspace.git(["commit", "--allow-empty", "-m", message]);
        return assertCommit(workspace.git(["rev-parse", "HEAD"]));
      },
      setTrackedTip: (revision) => {
        workspace.git(["update-ref", `refs/remotes/origin/${trackedBranch}`, revision]);
      },
      detach: (revision) => {
        workspace.git(["checkout", "--detach", revision]);
      },
      writeVersion: (version) => {
        writeFile("packages/app/package.json", json({ name: packageName, version }));
      },
      writeChangelog: (...versions) => {
        writeFile(
          "packages/app/CHANGELOG.md",
          `# ${packageName}\n${versions.map((version) => `\n## ${version}\n`).join("")}`
        );
      },
      addChangeset: (id) => {
        writeFile(`.changeset/${id}.md`, `---\n"${packageName}": minor\n---\n\nchange\n`);
      },
      consumeChangeset: (id) => {
        rmSync(path(`.changeset/${id}.md`));
      },
      setPlan: (plan) => {
        writeFileSync(join(changesets, "plan.json"), JSON.stringify({ releases: plan }));
      },
      writeFile,
      removeFile: (relative) => {
        rmSync(path(relative));
      },
    };

    mkdirSync(packageDirectory, { recursive: true });
    mkdirSync(path(".changeset"));
    mkdirSync(changesets, { recursive: true });
    writeFile(".gitignore", "node_modules/\n.artifacts/\n.empty-git-hooks/\n");
    writeFile("package.json", json({ name: "acme-checkout", private: true }));
    writeFile(".changeset/config.json", json({ baseBranch: `origin/${trackedBranch}` }));
    writeFile(".changeset/README.md", "Pending changesets.\n");
    writeFileSync(join(changesets, "package.json"), json({ name: "@changesets/cli", version: "0.0.0" }));
    writeFileSync(join(changesets, "bin.js"), fakeChangesetsBin);
    checkout.setPlan(options.plan ?? []);
    const version = options.version ?? "0.1.9";
    checkout.writeVersion(version);
    checkout.writeChangelog(version);
    if (trackedBranch !== "main") workspace.git(["checkout", "-b", trackedBranch]);
    checkout.commit("baseline");
    checkout.setTrackedTip("HEAD");
    await run(checkout);
  });
}
