import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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
    expect(
      asString(step("version-packages", "version", "Run checks on the bot-created release PR").run, "run")
    ).toBe("gh workflow run merge.yml --ref changeset-release/main");
    expect(asRecord(workflow("merge").on, "triggers")).toHaveProperty("workflow_dispatch");
    expect(asString(step("merge", "checks", "Validate stable release PR").run, "run")).toBe(
      "pnpm release:check-pr"
    );
  });

  it("runs the version bump through the release script", () => {
    const versionStep = step("version-packages", "version", "Version Packages PR");
    expect(asRecord(versionStep.with, "inputs").version).toBe("pnpm release:version");
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
    expect(publish).toContain('pnpm release:run main "$SOURCE_COMMIT"');
    expect(publish).toContain('pnpm release:run retry "$RECORD_TAG"');
    expect(readJsonObject(join(repoRoot, "packages/internal/package.json")).publishConfig).toEqual({
      access: "public",
    });
  });
});

describe("release package composition", () => {
  it("derives the previous-version git path from the resolved package", () => {
    for (const file of [
      "scripts/check-release-pr.ts",
      "scripts/publish-release.ts",
      "scripts/internal-pack-adapter.ts",
      "packages/release/src/git.ts",
      "packages/release/src/engine.ts",
      "packages/release/src/gate.ts",
    ]) {
      expect(readFileSync(join(repoRoot, file), "utf8")).not.toContain("packages/internal/package.json");
    }
    expect(readFileSync(join(repoRoot, "scripts/release.ts"), "utf8")).toContain("resolveReleasePackage");
    expect(readFileSync(join(repoRoot, "packages/release/src/engine.ts"), "utf8")).toContain(
      "packageManifestGitPath"
    );
    expect(readFileSync(join(repoRoot, "packages/release/src/plan.ts"), "utf8")).toContain(
      'createRequire(resolve(checkoutRoot, "package.json"))'
    );
  });

  it("does not keep a second engine under scripts/", () => {
    for (const file of [
      "release-pipeline.ts",
      "release-github.ts",
      "release-github-client.ts",
      "release-git.ts",
      "release-publication.ts",
      "release-plan.ts",
      "release-gate.ts",
      "release-registry.ts",
      "release-files.ts",
      "release-record.ts",
      "release-archive.ts",
    ]) {
      expect(existsSync(join(repoRoot, "scripts", file))).toBe(false);
    }
  });
});
