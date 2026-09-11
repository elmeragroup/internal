import { Effect, Schema } from "effect";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readJson } from "../src/json.ts";
import { changesetBaseBranch, plannedCanaryBase, readReleasePlan } from "../src/plan.ts";
import type { PlannedRelease } from "../src/plan.ts";
import { assertCanaryReleaseVersion, assertReleaseVersion } from "../src/version.ts";
import { commitBaseline, withGitWorkspace, workspaceTimeout } from "./lib/git-workspace.ts";
import type { WorkspaceHead } from "./lib/git-workspace.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageName = "@elmeragroup/internal";

function writeChangeset(workspace: string, id: string, name: string, bump: string): void {
  writeFileSync(join(workspace, ".changeset", `${id}.md`), `---\n"${name}": ${bump}\n---\n\nplan-test\n`);
}

function writeWorkspaceFixture(workspace: string): void {
  const rootManifest = readJson(
    join(repoRoot, "package.json"),
    Schema.Struct({ name: Schema.String, packageManager: Schema.String })
  );
  writeFileSync(
    join(workspace, "package.json"),
    `${JSON.stringify(
      {
        name: rootManifest.name,
        private: true,
        packageManager: rootManifest.packageManager,
      },
      null,
      2
    )}\n`
  );
  writeFileSync(join(workspace, "pnpm-workspace.yaml"), readFileSync(join(repoRoot, "pnpm-workspace.yaml")));
  for (const name of [
    "internal",
    "api-artifacts",
    "api-extractor",
    "oxlint-plugin",
    "oxlint-anti-slop",
    "release",
  ]) {
    mkdirSync(join(workspace, "packages", name), { recursive: true });
    writeFileSync(
      join(workspace, "packages", name, "package.json"),
      readFileSync(join(repoRoot, "packages", name, "package.json"))
    );
  }
  const changesetConfig = readJson(
    join(repoRoot, ".changeset/config.json"),
    Schema.Record(Schema.String, Schema.Json)
  );
  mkdirSync(join(workspace, ".changeset"));
  writeFileSync(
    join(workspace, ".changeset/config.json"),
    `${JSON.stringify({ ...changesetConfig, changelog: false }, null, 2)}\n`
  );
  symlinkSync(join(repoRoot, "node_modules"), join(workspace, "node_modules"));
}

function withPlannerWorkspace(run: (workspace: string) => void, head: WorkspaceHead = "branch"): void {
  withGitWorkspace("elmera-release-plan-", (workspace) => {
    writeWorkspaceFixture(workspace.path);
    commitBaseline(workspace, head);
    run(workspace.path);
  });
}

function plannedPublicReleases(workspace: string): PlannedRelease[] {
  return readReleasePlan(workspace).filter((release) => release.type !== "none");
}

function plannedVersion(releases: readonly PlannedRelease[]): string {
  expect(releases).toHaveLength(1);
  const release = releases[0];
  expect(release?.name).toBe(packageName);
  if (release === undefined) throw new Error("expected a planned release");
  const version = assertReleaseVersion(release.newVersion);
  expect(() => assertCanaryReleaseVersion(version)).toThrow(/Canary publication requires/);
  return version;
}

describe("changesets umbrella release plan", () => {
  it(
    "plans only the umbrella release",
    () => {
      withPlannerWorkspace((workspace) => {
        writeChangeset(workspace, "patch-one", packageName, "patch");
        plannedVersion(plannedPublicReleases(workspace));
      });
    },
    workspaceTimeout
  );

  it.each([
    "@elmeragroup/api-extractor",
    "@elmeragroup/api-artifacts",
    "@elmeragroup/oxlint-plugin",
    "@elmeragroup/oxlint-plugin-anti-slop",
    "@elmeragroup/release",
  ])(
    "does not release private changes to %s",
    (name) => {
      withPlannerWorkspace((workspace) => {
        writeChangeset(workspace, "private-patch", name, "patch");
        expect(plannedPublicReleases(workspace)).toEqual([]);
        writeChangeset(workspace, "public-patch", packageName, "patch");
        plannedVersion(plannedPublicReleases(workspace));
      });
    },
    workspaceTimeout
  );

  it(
    "plans one version for mixed patch and minor changesets",
    () => {
      withPlannerWorkspace((workspace) => {
        writeChangeset(workspace, "patch-internal", packageName, "patch");
        writeChangeset(workspace, "minor-internal", packageName, "minor");
        plannedVersion(plannedPublicReleases(workspace));
      });
    },
    workspaceTimeout
  );
});

describe("changeset base branch", () => {
  it(
    "rejects a local branch that is not a remote-tracking ref",
    () => {
      withGitWorkspace("elmera-release-plan-", (workspace) => {
        mkdirSync(join(workspace.path, ".changeset"));
        writeFileSync(
          join(workspace.path, ".changeset/config.json"),
          `${JSON.stringify({ baseBranch: "main" }, null, 2)}\n`
        );
        expect(() => changesetBaseBranch(workspace.path)).toThrow(
          "Changesets baseBranch must be a remote-tracking ref (origin/<branch>)"
        );
      });
    },
    workspaceTimeout
  );
});

describe("canary base planning in the publisher's checkout", () => {
  it(
    "reads the planned version from a detached single-commit checkout",
    () => {
      withPlannerWorkspace((workspace) => {
        expect(existsSync(join(workspace, ".git/refs/heads/main"))).toBe(false);
        writeChangeset(workspace, "minor-internal", packageName, "minor");
        const planned = plannedVersion(plannedPublicReleases(workspace));
        expect(Effect.runSync(plannedCanaryBase("0.0.1", packageName, workspace))).toBe(planned);
      }, "detached");
    },
    workspaceTimeout
  );

  it(
    "falls back to the next patch when no changeset is pending",
    () => {
      withPlannerWorkspace((workspace) => {
        expect(Effect.runSync(plannedCanaryBase("0.2.9", packageName, workspace))).toBe("0.2.10");
      }, "detached");
    },
    workspaceTimeout
  );

  it(
    "leaves no plan file behind in the workspace or the repository",
    () => {
      const before = readdirSync(repoRoot);
      withPlannerWorkspace((workspace) => {
        writeChangeset(workspace, "patch-one", packageName, "patch");
        expect(plannedPublicReleases(workspace)).toHaveLength(1);
        expect(readdirSync(join(workspace, ".artifacts"))).toEqual([]);
      }, "detached");
      expect(readdirSync(repoRoot)).toEqual(before);
    },
    workspaceTimeout
  );
});
