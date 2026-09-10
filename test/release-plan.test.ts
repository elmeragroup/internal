import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { asString, readJsonObject } from "../scripts/lib/json-object.mjs";
import { plannedCanaryBase, readReleasePlan } from "../scripts/release-plan.ts";
import type { PlannedRelease } from "../scripts/release-plan.ts";
import { assertCanaryReleaseVersion, assertReleaseVersion } from "../scripts/release-version.ts";
import { packageName } from "../scripts/release.ts";
import { commitBaseline, withGitWorkspace, workspaceTimeout } from "./lib/git-workspace.ts";
import type { WorkspaceHead } from "./lib/git-workspace.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function writeChangeset(workspace: string, id: string, name: string, bump: string): void {
  writeFileSync(join(workspace, ".changeset", `${id}.md`), `---\n"${name}": ${bump}\n---\n\nplan-test\n`);
}

function writeWorkspaceFixture(workspace: string): void {
  const rootManifest = readJsonObject(join(repoRoot, "package.json"));
  writeFileSync(
    join(workspace, "package.json"),
    `${JSON.stringify(
      {
        name: asString(rootManifest.name, "name"),
        private: true,
        packageManager: asString(rootManifest.packageManager, "packageManager"),
      },
      null,
      2
    )}\n`
  );
  writeFileSync(join(workspace, "pnpm-workspace.yaml"), readFileSync(join(repoRoot, "pnpm-workspace.yaml")));
  for (const name of ["internal", "api-artifacts", "api-extractor", "oxlint-plugin", "oxlint-anti-slop"]) {
    mkdirSync(join(workspace, "packages", name), { recursive: true });
    writeFileSync(
      join(workspace, "packages", name, "package.json"),
      readFileSync(join(repoRoot, "packages", name, "package.json"))
    );
  }
  const changesetConfig = readJsonObject(join(repoRoot, ".changeset/config.json"));
  mkdirSync(join(workspace, ".changeset"));
  writeFileSync(
    join(workspace, ".changeset/config.json"),
    `${JSON.stringify({ ...changesetConfig, changelog: false }, null, 2)}\n`
  );
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
  const version = assertReleaseVersion(asString(release?.newVersion, "newVersion"));
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

describe("canary base planning in the publisher's checkout", () => {
  it(
    "reads the planned version from a detached single-commit checkout",
    () => {
      withPlannerWorkspace((workspace) => {
        expect(existsSync(join(workspace, ".git/refs/heads/main"))).toBe(false);
        writeChangeset(workspace, "minor-internal", packageName, "minor");
        const planned = plannedVersion(plannedPublicReleases(workspace));
        expect(plannedCanaryBase("0.0.1", workspace)).toBe(planned);
      }, "detached");
    },
    workspaceTimeout
  );

  it(
    "falls back to the next patch when no changeset is pending",
    () => {
      withPlannerWorkspace((workspace) => {
        expect(plannedCanaryBase("0.2.9", workspace)).toBe("0.2.10");
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
