import { Effect } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveReleasePackage } from "../src/config.ts";
import { checkReleasePr } from "../src/engine.ts";
import { commitBaseline, withGitWorkspaceAsync, workspaceTimeout } from "./lib/git-workspace.ts";

function writeStableCheckout(root: string, version: string, baseBranch = "origin/main"): void {
  const packageDirectory = join(root, "packages/app");
  mkdirSync(packageDirectory, { recursive: true });
  mkdirSync(join(root, ".changeset"), { recursive: true });
  writeFileSync(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({ name: "@acme/app", version }, null, 2)}\n`
  );
  writeFileSync(join(packageDirectory, "CHANGELOG.md"), `# changelog\n\n## ${version}\n`);
  writeFileSync(join(root, ".changeset/config.json"), `${JSON.stringify({ baseBranch }, null, 2)}\n`);
  writeFileSync(join(root, ".changeset/README.md"), "ignored\n");
}

describe("checkReleasePr", () => {
  it(
    "reads the previous version from the remote-tracking manifest",
    async () => {
      await withGitWorkspaceAsync("elmera-release-check-pr-", async (workspace) => {
        writeStableCheckout(workspace.path, "0.1.9");
        commitBaseline(workspace);
        writeStableCheckout(workspace.path, "0.2.0");
        const pkg = resolveReleasePackage(workspace.path, join(workspace.path, "packages/app"), "@acme/app");
        await Effect.runPromise(checkReleasePr(pkg));
      });
    },
    workspaceTimeout
  );

  it(
    "fails when pending changesets remain",
    async () => {
      await withGitWorkspaceAsync("elmera-release-check-pr-", async (workspace) => {
        writeStableCheckout(workspace.path, "0.1.9");
        commitBaseline(workspace);
        writeStableCheckout(workspace.path, "0.2.0");
        writeFileSync(join(workspace.path, ".changeset/pending.md"), "pending\n");
        const pkg = resolveReleasePackage(workspace.path, join(workspace.path, "packages/app"), "@acme/app");
        await expect(Effect.runPromise(checkReleasePr(pkg))).rejects.toThrow(
          "did not consume all changesets"
        );
      });
    },
    workspaceTimeout
  );

  it(
    "fails when Changesets names a local branch",
    async () => {
      await withGitWorkspaceAsync("elmera-release-check-pr-", async (workspace) => {
        writeStableCheckout(workspace.path, "0.1.9", "main");
        commitBaseline(workspace);
        const pkg = resolveReleasePackage(workspace.path, join(workspace.path, "packages/app"), "@acme/app");
        await expect(Effect.runPromise(checkReleasePr(pkg))).rejects.toThrow(
          "Changesets baseBranch must be a remote-tracking ref (origin/<branch>)"
        );
      });
    },
    workspaceTimeout
  );
});
