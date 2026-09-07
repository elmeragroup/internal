import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { assertCanaryReleaseVersion, assertReleaseVersion } from "../scripts/release-version.ts";
import { archivePath, packageName } from "../scripts/release.ts";
import { asRecord, asRecordArray, asString, isString, readJsonObject } from "./json-object.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const changesetBin = createRequire(import.meta.url).resolve("@changesets/cli/bin.js");

/**
 * @param {string} workspace
 * @param {string} hooksDir
 * @param {string[]} args
 */
function git(workspace, hooksDir, args) {
  execFileSync(
    "git",
    [
      "-c",
      "user.name=PlanTest",
      "-c",
      "user.email=plan-test@example.invalid",
      "-c",
      `core.hooksPath=${hooksDir}`,
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd: workspace,
      env: { ...process.env, HUSKY: "0" },
      stdio: "pipe",
    }
  );
}

/**
 * @param {string} workspace
 * @param {string} id
 * @param {string} packageName
 * @param {string} bump
 */
function writeChangeset(workspace, id, packageName, bump) {
  writeFileSync(
    join(workspace, ".changeset", `${id}.md`),
    `---\n"${packageName}": ${bump}\n---\n\nplan-test\n`
  );
}

/**
 * @param {string} workspace
 * @returns {Record<string, unknown>[]}
 */
function plannedPublicReleases(workspace) {
  const outputFile = "release-plan.json";
  try {
    execFileSync(process.execPath, [changesetBin, "status", "--output", outputFile], {
      cwd: workspace,
      env: { ...process.env, HUSKY: "0" },
      stdio: "pipe",
    });
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error && isString(error.stderr) ? error.stderr : "";
    const message = error instanceof Error ? error.message : "changeset status failed";
    throw new Error(stderr === "" ? message : `${message}\n${stderr}`);
  }
  return asRecordArray(readJsonObject(join(workspace, outputFile)).releases, "releases").filter((release) => {
    const type = asString(release.type, "type");
    return type !== "none";
  });
}

/**
 * @param {(workspace: string) => void} run
 */
function withPlannerWorkspace(run) {
  const workspace = mkdtempSync(join(tmpdir(), "elmera-release-plan-"));
  const hooksDir = join(workspace, ".empty-git-hooks");
  try {
    mkdirSync(hooksDir);
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
    writeFileSync(
      join(workspace, "pnpm-workspace.yaml"),
      readFileSync(join(repoRoot, "pnpm-workspace.yaml"))
    );
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
    git(workspace, hooksDir, ["init", "--initial-branch=main"]);
    git(workspace, hooksDir, ["add", "."]);
    git(workspace, hooksDir, ["commit", "-m", "baseline"]);
    run(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * @param {Record<string, unknown>[]} releases
 */
function plannedVersion(releases) {
  expect(releases).toHaveLength(1);
  const release = releases[0];
  expect(release.name).toBe(packageName);
  const version = assertReleaseVersion(asString(release.newVersion, "newVersion"));
  expect(() => assertCanaryReleaseVersion(version)).toThrow(/Canary publication requires/);
  return version;
}

describe("release versions", () => {
  it.each(["0.1.0", "1.2.3", "0.1.0-canary.1"])("accepts %s", (version) => {
    expect(assertReleaseVersion(version)).toBe(version);
  });
  it.each([
    "",
    "1.0",
    "v1.0.0",
    "1.0.0-canary",
    "1.0.0-beta.1",
    "1.0.0+build.1",
    "1.0.0-canary.1+meta",
    "01.0.0",
    "1.01.0",
    "1.0.01",
    "1.0.0-canary.01",
  ])("rejects %s", (version) => {
    expect(() => assertReleaseVersion(version)).toThrow(/Unsupported release version/);
  });
});
describe("canary publication versions", () => {
  it("accepts a canary", () => expect(assertCanaryReleaseVersion("0.1.0-canary.2")).toBe("0.1.0-canary.2"));
  it("rejects a stable version", () =>
    expect(() => assertCanaryReleaseVersion("0.1.0")).toThrow(/Canary publication requires/));
});

describe("archive names", () => {
  it("keeps the canary archive filename", () => {
    expect(archivePath("0.1.0-canary.0")).toBe(
      join(repoRoot, ".artifacts/canary", "elmeragroup-internal-0.1.0-canary.0.tgz")
    );
  });

  it("names stable archives with the same pattern", () => {
    expect(archivePath("0.1.0")).toBe(join(repoRoot, ".artifacts/canary", "elmeragroup-internal-0.1.0.tgz"));
  });
});

describe("changesets umbrella release plan", () => {
  it("plans only the umbrella release", () => {
    withPlannerWorkspace((workspace) => {
      writeChangeset(workspace, "patch-one", packageName, "patch");
      plannedVersion(plannedPublicReleases(workspace));
    });
  });

  it("plans one version for mixed patch and minor changesets", () => {
    withPlannerWorkspace((workspace) => {
      writeChangeset(workspace, "patch-internal", "@elmeragroup/internal", "patch");
      writeChangeset(workspace, "minor-internal", "@elmeragroup/internal", "minor");
      plannedVersion(plannedPublicReleases(workspace));
    });
  });
});

describe("release commands and workflows", () => {
  it("keeps packed consumer verification on Version Packages PRs", () => {
    const merge = readFileSync(join(repoRoot, ".github/workflows/merge.yml"), "utf8");
    const verify = merge.split("- name: ").find((step) => step.startsWith("Verify packed consumer"));
    expect(verify).toBeDefined();
    expect(verify).toContain("pnpm packages:pack && pnpm test:packed-consumer");
    expect(verify).not.toContain("if:");
    expect(readFileSync(join(repoRoot, ".github/workflows/version-packages.yml"), "utf8")).toContain(
      "pnpm exec changeset version"
    );
  });

  it("publishes only with the canary tag after generic packing", () => {
    const publish = readFileSync(join(repoRoot, ".github/workflows/publish-canary.yml"), "utf8");
    expect(publish).toContain("pnpm canary:version");
    expect(publish).toContain("pnpm packages:pack");
    expect(publish).toContain("pnpm canary:publish");
    const publisher = readFileSync(join(repoRoot, "scripts/canary-publish.ts"), "utf8");
    expect(publisher).toContain("canaryVersion()");
    expect(publisher).toContain('"--tag"');
    expect(publisher).toContain('"canary"');
    const scripts = asRecord(readJsonObject(join(repoRoot, "package.json")).scripts, "scripts");
    expect(asString(scripts["packages:pack"], "packages:pack")).toBe(
      "pnpm build && node scripts/canary-pack.ts"
    );
    expect(asString(scripts["canary:pack"], "canary:pack")).toBe("pnpm packages:pack");
  });
});
