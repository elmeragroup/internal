import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const consumerRoot = process.cwd();
const packageName = "@acme/ui";
const repository = "acme/ui";
const githubApi = `https://api.github.com/repos/${repository}`;
const githubUploads = `https://uploads.github.com/repos/${repository}`;
const npmRegistry = "https://registry.npmjs.org/@acme%2fui";

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
assert.ok(release.parseReleaseCommand);
assert.ok(release.ReleaseError);
assert.equal(release.verifiedBundleName, "verified-release.tgz");
assert.deepEqual(listConsumerFiles(consumerRoot), beforeImport);

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

/** @param {string | Uint8Array} bytes */
function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * @param {unknown} value
 * @param {number} [status]
 */
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * @param {BodyInit | null | undefined} body
 * @returns {string}
 */
function jsonBodyText(body) {
  assert.equal(Object.prototype.toString.call(body), "[object String]");
  // SAFETY: the toString tag above is the string contract for GitHub JSON posts.
  return /** @type {string} */ (body);
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

await withTempDir("elmera-packed-ui-release-", async (root) => {
  mkdirSync(path.join(root, ".empty-git-hooks"));
  mkdirSync(path.join(root, "packages/ui"), { recursive: true });
  mkdirSync(path.join(root, ".changeset"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "acme-ui", private: true }, null, 2)}\n`
  );
  writeFileSync(
    path.join(root, "packages/ui/package.json"),
    `${JSON.stringify({ name: packageName, version: "0.1.0" }, null, 2)}\n`
  );
  writeFileSync(
    path.join(root, ".changeset/config.json"),
    `${JSON.stringify({ baseBranch: "origin/main" })}\n`
  );
  writeFileSync(path.join(root, ".changeset/README.md"), "ignored\n");
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "baseline"]);
  writeFileSync(path.join(root, "packages/ui/README.md"), "ui\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "head"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const commit = git(root, ["rev-parse", "HEAD"]);

  mkdirSync(path.join(root, "node_modules/@changesets/cli"), { recursive: true });
  writeFileSync(
    path.join(root, "node_modules/@changesets/cli/package.json"),
    JSON.stringify({ name: "@changesets/cli", version: "0.0.0" })
  );
  writeFileSync(
    path.join(root, "node_modules/@changesets/cli/bin.js"),
    `const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const output = process.argv[process.argv.indexOf("--output") + 1];
const file = resolve(process.cwd(), output);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify({ releases: [] }));
`
  );

  /** @type {{ bundle: Uint8Array; integrity: string; version: string; commit: string } | undefined} */
  let packed;
  /** @type {Uint8Array | undefined} */
  let uploadedBundle;
  let patchedRelease = false;
  /** @type {{ ref: string; sha: string } | undefined} */
  let createdTag;
  /** @type {{ tag_name: string; id: number; draft: boolean; body: string; assets: readonly never[] } | undefined} */
  let draft;

  /**
   * @param {string | URL} url
   * @param {RequestInit} [init]
   */
  const fixtureFetch = async (url, init = {}) => {
    const href = url instanceof URL ? url.href : url;
    const method = init.method ?? "GET";
    if (method === "GET" && href === npmRegistry) {
      if (packed === undefined) return new Response("", { status: 404 });
      return jsonResponse({
        versions: {
          [packed.version]: {
            dist: { integrity: packed.integrity },
            elmeraRelease: { commit: packed.commit },
          },
        },
        "dist-tags": { canary: packed.version },
      });
    }
    if (method === "GET" && href === `${githubApi}/releases?per_page=100&page=1`) {
      return jsonResponse([]);
    }
    if (method === "GET" && href.startsWith(`${githubApi}/git/ref/tags/`)) {
      const tag = decodeURIComponent(href.slice(`${githubApi}/git/ref/tags/`.length));
      if (createdTag === undefined || createdTag.ref !== `refs/tags/${tag}`) {
        return new Response("", { status: 404 });
      }
      return jsonResponse({ object: { type: "commit", sha: createdTag.sha } });
    }
    if (method === "POST" && href === `${githubApi}/git/refs`) {
      // SAFETY: JSON.parse is untyped; ref/sha checks below are the contract.
      const requested = /** @type {{ ref: string; sha: string }} */ (JSON.parse(jsonBodyText(init.body)));
      assert.match(requested.ref, /^refs\/tags\/canary-/);
      assert.match(requested.sha, /^[a-f0-9]{40}$/);
      createdTag = { ref: requested.ref, sha: requested.sha };
      return jsonResponse({ object: { type: "commit", sha: requested.sha } });
    }
    if (method === "POST" && href === `${githubApi}/releases`) {
      // SAFETY: JSON.parse is untyped; tag_name/body checks below are the contract.
      const requested = /** @type {{ tag_name: string; body: string }} */ (
        JSON.parse(jsonBodyText(init.body))
      );
      assert.match(requested.tag_name, /^canary-/);
      assert.match(requested.body, /elmera-release/);
      draft = { tag_name: requested.tag_name, id: 1, draft: true, body: requested.body, assets: [] };
      return jsonResponse(draft);
    }
    if (method === "GET" && href === `${githubApi}/releases/1`) {
      assert.ok(draft);
      return jsonResponse(draft);
    }
    if (
      method === "POST" &&
      href === `${githubUploads}/releases/1/assets?name=${release.verifiedBundleName}`
    ) {
      assert.ok(init.body instanceof Blob);
      uploadedBundle = new Uint8Array(await init.body.arrayBuffer());
      return jsonResponse({
        id: 1,
        name: release.verifiedBundleName,
        state: "uploaded",
        size: uploadedBundle.length,
      });
    }
    if (method === "GET" && href === `${githubApi}/releases/assets/1`) {
      assert.ok(uploadedBundle);
      return new Response(uploadedBundle);
    }
    if (method === "PATCH" && href === `${githubApi}/releases/1`) {
      assert.ok(draft);
      patchedRelease = true;
      return jsonResponse({ ...draft, draft: false });
    }
    throw new Error(`unexpected fetch: ${method} ${href}`);
  };

  /**
   * @param {{ channel: "canary" | "stable"; version: string; commit: string }} intent
   */
  function pack(intent) {
    const directory = mkdtempSync(path.join(tmpdir(), "acme-ui-pack-"));
    try {
      mkdirSync(path.join(directory, "package"));
      writeFileSync(
        path.join(directory, "package/package.json"),
        JSON.stringify({
          name: packageName,
          version: intent.version,
          elmeraRelease: { commit: intent.commit, channel: intent.channel },
        })
      );
      const archive = path.join(directory, "package.tgz");
      execFileSync("tar", ["-czf", archive, "-C", directory, "package"]);
      const archiveBytes = readFileSync(archive);
      // SAFETY: JSON.parse is untyped; packed-manifest field checks below are the contract.
      const manifest = /** @type {{
        name: string;
        version: string;
        elmeraRelease: { commit: string; channel: string };
      }} */ (
        JSON.parse(execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }))
      );
      assert.equal(manifest.name, packageName);
      assert.equal(manifest.version, intent.version);
      assert.equal(manifest.elmeraRelease.commit, intent.commit);
      assert.equal(manifest.elmeraRelease.channel, intent.channel);
      const reportPath = path.join(directory, "archive.json");
      writeFileSync(
        reportPath,
        JSON.stringify({
          version: intent.version,
          archive: {
            name: packageName,
            archive,
            bytes: archiveBytes.length,
            sha256: sha256Hex(archiveBytes),
          },
        })
      );
      writeFileSync(
        path.join(directory, "verified.json"),
        JSON.stringify({
          version: intent.version,
          archiveReportSha256: sha256Hex(readFileSync(reportPath)),
          status: "pass",
        })
      );
      const bundlePath = path.join(directory, release.verifiedBundleName);
      execFileSync("tar", [
        "-czf",
        bundlePath,
        "-C",
        directory,
        "archive.json",
        "package.tgz",
        "verified.json",
      ]);
      const bundle = new Uint8Array(readFileSync(bundlePath));
      packed = {
        bundle,
        integrity: `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`,
        version: intent.version,
        commit: intent.commit,
      };
      return bundle;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fixtureFetch;
  process.env.GH_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = repository;
  try {
    const pkg = release.resolveReleasePackage(root, path.join(root, "packages/ui"), packageName);
    await Effect.runPromise(release.releaseCheckedCommit(pkg, { pack }, commit));
    assert.deepEqual(uploadedBundle, packed.bundle);
    assert.equal(patchedRelease, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
    if (previousRepo === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previousRepo;
  }
});

console.log("Packed UI-shaped release consumption passed.");
