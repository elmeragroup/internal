import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const consumerRoot = process.cwd();

/**
 * @param {string} root
 * @returns {string[]}
 */
function listConsumerFiles(root) {
  /**
   * @param {string} dir
   * @returns {string[]}
   */
  function walk(dir) {
    const files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        files.push(...walk(full));
      } else {
        files.push(path.relative(root, full));
      }
    }
    return files;
  }
  return walk(root).sort();
}

const previousToken = process.env.GH_TOKEN;
const previousRepo = process.env.GITHUB_REPOSITORY;
delete process.env.GH_TOKEN;
delete process.env.GITHUB_REPOSITORY;
const beforeImport = listConsumerFiles(consumerRoot);
const release = await import("@elmeragroup/internal/release");
assert.ok(release.releaseCheckedCommit);
assert.ok(release.checkReleasePr);
assert.ok(release.retryRelease);
assert.ok(release.resolveReleasePackage);
assert.ok(release.releaseEnvironment);
assert.ok(release.readManifestVersion);
assert.ok(release.assertReleaseVersion);
assert.ok(release.assertCanaryReleaseVersion);
assert.ok(release.ReleaseError);
assert.deepEqual(listConsumerFiles(consumerRoot), beforeImport);
if (previousToken === undefined) delete process.env.GH_TOKEN;
else process.env.GH_TOKEN = previousToken;
if (previousRepo === undefined) delete process.env.GITHUB_REPOSITORY;
else process.env.GITHUB_REPOSITORY = previousRepo;

const internalRequire = createRequire(import.meta.resolve("@elmeragroup/internal"));
// SAFETY: resolve Effect from the installed umbrella to run bundled operations.
const { Effect } = /** @type {typeof import("effect")} */ (
  await import(pathToFileURL(internalRequire.resolve("effect")).href)
);

/**
 * @param {string} cwd
 * @param {readonly string[]} args
 */
function git(cwd, args) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=ReleaseTest",
      "-c",
      "user.email=release-test@example.invalid",
      "-c",
      `core.hooksPath=${path.join(cwd, ".empty-git-hooks")}`,
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", env: { ...process.env, HUSKY: "0" }, stdio: "pipe" }
  ).trim();
}

/**
 * @param {string} prefix
 * @param {(root: string) => Promise<void>} run
 */
async function withTempDir(prefix, run) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await withTempDir("elmera-packed-check-pr-", async (root) => {
  mkdirSync(path.join(root, ".empty-git-hooks"));
  mkdirSync(path.join(root, "packages/app"), { recursive: true });
  mkdirSync(path.join(root, ".changeset"), { recursive: true });
  writeFileSync(
    path.join(root, "packages/app/package.json"),
    `${JSON.stringify({ name: "@acme/app", version: "0.1.9" }, null, 2)}\n`
  );
  writeFileSync(path.join(root, "packages/app/CHANGELOG.md"), "# changelog\n\n## 0.1.9\n");
  writeFileSync(
    path.join(root, ".changeset/config.json"),
    `${JSON.stringify({ baseBranch: "origin/main" })}\n`
  );
  writeFileSync(path.join(root, ".changeset/README.md"), "ignored\n");
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "baseline"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  writeFileSync(
    path.join(root, "packages/app/package.json"),
    `${JSON.stringify({ name: "@acme/app", version: "0.2.0" }, null, 2)}\n`
  );
  writeFileSync(path.join(root, "packages/app/CHANGELOG.md"), "# changelog\n\n## 0.2.0\n");
  const pkg = release.resolveReleasePackage(root, path.join(root, "packages/app"), "@acme/app");
  await Effect.runPromise(release.checkReleasePr(pkg));
});

console.log("Packed UI-shaped release consumption passed.");
