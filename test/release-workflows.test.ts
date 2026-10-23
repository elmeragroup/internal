import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { assertReleaseVersion, readManifestVersion, resolveReleasePackage } from "@elmeragroup/release";

import { asRecord, asRecordArray, asString, readJsonObject } from "../scripts/lib/json-object.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function workflow(name: string) {
  return asRecord(parse(readFileSync(join(repoRoot, ".github/workflows", `${name}.yml`), "utf8")), name);
}

function job(workflowName: string, jobName: string) {
  return asRecord(asRecord(workflow(workflowName).jobs, "jobs")[jobName], jobName);
}

function step(workflowName: string, jobName: string, stepName: string) {
  const steps = asRecordArray(job(workflowName, jobName).steps, "steps");
  const found = steps.find((candidate) => candidate.name === stepName);
  if (found === undefined) throw new Error(`${workflowName}/${jobName} has no ${stepName} step`);
  return found;
}

describe("release workflow gates", () => {
  it("requires successful main checks before release and version preparation", () => {
    for (const name of ["release", "version"]) {
      const gated = job("merge", name);
      expect(gated.needs).toBe("checks");
      expect(gated.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    }
    expect(asRecord(job("merge", "release").with, "inputs").source_commit).toBe("${{ github.sha }}");
  });

  it("serializes publication and retains queued stable releases", () => {
    const publish = job("publish-release", "publish");
    expect(publish.concurrency).toEqual({ group: "npm-release", "cancel-in-progress": false, queue: "max" });
    expect(publish.if).toBe("github.ref == 'refs/heads/main'");
    const triggers = asRecord(workflow("publish-release").on, "triggers");
    expect(Object.keys(triggers).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
    const inputs = asRecord(asRecord(triggers.workflow_dispatch, "dispatch").inputs, "inputs");
    expect(Object.keys(inputs)).toEqual(["record_tag"]);
  });

  it("fetches the remote-tracking refs the changeset plan resolves against", () => {
    const steps = asRecordArray(job("publish-release", "publish").steps, "steps");
    const checkout = steps.find((candidate) =>
      asString(candidate.uses ?? "", "uses").startsWith("actions/checkout")
    );
    expect(asRecord(checkout?.with, "checkout inputs")["fetch-depth"]).toBe(0);
    expect(readJsonObject(join(repoRoot, ".changeset/config.json")).baseBranch).toBe("origin/main");
  });

  it("skips version preparation for a commit that main has already moved past", () => {
    const guard = step("version-packages", "version", "Check for a superseded main commit");
    expect(guard.id).toBe("current");
    expect(asString(guard.run, "run")).toContain("git ls-remote origin refs/heads/main");
    expect(asString(guard.run, "run")).toContain('[ "$SOURCE_COMMIT" = "$MAIN_COMMIT" ]');
    expect(step("version-packages", "version", "Version Packages PR").if).toBe(
      "steps.current.outputs.current == 'true'"
    );
  });

  it("explicitly dispatches checks for the generated release PR", () => {
    const version = job("version-packages", "version");
    expect(asRecord(version.permissions, "permissions").actions).toBe("write");
    const dispatch = step("version-packages", "version", "Run checks on the bot-created release PR");
    expect(asString(dispatch.run, "run")).toBe("gh workflow run merge.yml --ref changeset-release/main");
    expect(dispatch.if).toBe("steps.changesets.outputs.pr-number");
    expect(asRecord(workflow("merge").on, "triggers")).toHaveProperty("workflow_dispatch");
    expect(asString(step("merge", "checks", "Validate stable release PR").run, "run")).toBe(
      "pnpm release:check-pr"
    );
  });

  it("runs the version bump through the release script", () => {
    const versionStep = step("version-packages", "version", "Version Packages PR");
    expect(versionStep.uses).toBe("changesets/action@v2");
    expect(versionStep.id).toBe("changesets");
    const inputs = asRecord(versionStep.with, "inputs");
    expect(inputs["version-script"]).toBe("pnpm release:version");
    expect(inputs["pr-title"]).toBe("Version Packages");
    expect(inputs["commit-message"]).toBe("chore: version packages");
    expect(inputs["github-token"]).toBe("${{ github.token }}");
    expect(versionStep).not.toHaveProperty("env");
  });

  it("keeps packed consumer verification on Version Packages PRs", () => {
    const verify = step("merge", "checks", "Verify packed consumer");
    expect(verify.run).toBe("pnpm packages:pack && pnpm test:packed-consumer");
    expect(verify).not.toHaveProperty("if");
  });

  it("publishes through the checked-commit and recorded-archive entry points", () => {
    const publish = asString(
      step("publish-release", "publish", "Publish checked commit or retry recorded archive").run,
      "run"
    );
    const lines = publish.split("\n").map((line) => line.trim());
    expect(lines).toContain('pnpm release:run main "$SOURCE_COMMIT"');
    // npm signs provenance for GITHUB_SHA, but a retry dispatch runs at main's head while it
    // uploads an archive recorded for an earlier commit. Only the retry turns provenance off.
    expect(lines.filter((line) => line.includes("NPM_CONFIG_PROVENANCE"))).toEqual([
      'NPM_CONFIG_PROVENANCE=false pnpm release:run retry "$RECORD_TAG"',
    ]);
    expect(readJsonObject(join(repoRoot, "packages/internal/package.json")).publishConfig).toEqual({
      access: "public",
    });
  });
});

describe("release workflow npm authentication", () => {
  const releasePermissions = { contents: "write", "pull-requests": "read", "id-token": "write" };

  it("grants id-token: write on both sides of the publish call", () => {
    // The called workflow cannot hold more than its caller grants.
    expect(workflow("publish-release").permissions).toEqual(releasePermissions);
    expect(job("merge", "release").permissions).toEqual(releasePermissions);
  });

  it("publishes from the npm environment that the trusted-publisher entries name", () => {
    expect(job("publish-release", "publish").environment).toBe("npm");
  });

  it("passes only the GitHub release token through the call", () => {
    const call = asRecord(asRecord(workflow("publish-release").on, "triggers").workflow_call, "call");
    expect(call.secrets).toEqual({ RELEASE_GITHUB_TOKEN: { required: false } });
    expect(job("merge", "release").secrets).toEqual({
      RELEASE_GITHUB_TOKEN: "${{ secrets.RELEASE_GITHUB_TOKEN }}",
    });
  });

  it("gives the engine step no npm token", () => {
    const engine = step("publish-release", "publish", "Publish checked commit or retry recorded archive");
    expect(engine.env).toEqual({
      GH_TOKEN: "${{ secrets.RELEASE_GITHUB_TOKEN || github.token }}",
      SOURCE_COMMIT: "${{ inputs.source_commit }}",
      RECORD_TAG: "${{ inputs.record_tag }}",
    });
  });

  it("installs an exact npm that promotes over OIDC before the engine runs, on both paths", () => {
    const steps = asRecordArray(job("publish-release", "publish").steps, "steps");
    const pin = steps.find((candidate) =>
      asString(candidate.run ?? "", "run").startsWith("npm install --global npm@")
    );
    if (pin === undefined) throw new Error("publish-release/publish has no npm install step");
    expect(pin).not.toHaveProperty("if");
    const version = /^npm install --global npm@(\d+)\.(\d+)\.(\d+)$/u.exec(asString(pin.run, "run").trim());
    if (version === null) throw new Error("the npm pin must name an exact version");
    // npm documents 11.21.0 as the first release whose `dist-tag` authenticates over OIDC
    // (npm/cli#10038). The npm bundled with .node-version is older.
    const [major, minor] = [Number(version[1]), Number(version[2])];
    expect(
      major > 11 || (major === 11 && minor >= 21),
      `${version[0]} must install npm 11.21.0 or later`
    ).toBe(true);
    const engine = steps.findIndex(
      (candidate) => candidate.name === "Publish checked commit or retry recorded archive"
    );
    expect(engine).toBeGreaterThan(steps.indexOf(pin));
  });
});

describe("release package composition", () => {
  it("resolves the repository's published package from its layout", () => {
    const pkg = resolveReleasePackage(repoRoot, join(repoRoot, "packages/internal"), "@elmeragroup/internal");
    expect(pkg.checkoutRoot).toBe(repoRoot);
    const version = readManifestVersion(pkg.packageDirectory);
    expect(assertReleaseVersion(version)).toBe(version);
    expect(readJsonObject(join(pkg.packageDirectory, "package.json")).version).toBe(version);
  });

  it("rejects a package whose directory does not carry the requested name", () => {
    expect(() =>
      resolveReleasePackage(repoRoot, join(repoRoot, "packages/release"), "@elmeragroup/internal")
    ).toThrow("does not match");
  });
});
