import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { posixRelative, sha256File } from "./files.ts";

/** The only accepted upstream identity for copied fixture evidence. */
export const pinnedUpstream = {
  repository: "michaldudak/typescript-api-extractor",
  commit: "e14535030957e29ce6e5d870e4ab71740175a0d4",
  root: resolve(import.meta.dirname, "../../../.ref/typescript-api-extractor"),
} as const;

export const upstreamFixtureRoot = join(pinnedUpstream.root, "test/fixtures");

/**
 * This is the path universe at the pinned commit, not a count inferred from
 * whatever checkout happens to be supplied at runtime.  The digest is over
 * `JSON.stringify` of sorted paths relative to `test/fixtures`.
 */
export const pinnedFixturePathUniverse = {
  count: 251,
  sha256: "4b05cb220b44c622021a692b64e283d5f7f2efe47305ba636bb53958a37abe79",
  command: `git ls-tree -r --name-only ${pinnedUpstream.commit} -- test/fixtures`,
} as const;

export const skippedPathUniverseSha256 = "not-verified" as const;

export type ReferenceAuditMode = "optional" | "required";
export type ReferenceAuditResult = {
  readonly mode: ReferenceAuditMode;
  readonly status: "verified" | "skipped";
  readonly repository: typeof pinnedUpstream.repository;
  readonly commit: typeof pinnedUpstream.commit;
  readonly fixtureCount: number;
  readonly comparedFiles: number;
  readonly pathUniverse: {
    readonly count: number;
    readonly sha256: string;
    readonly command: typeof pinnedFixturePathUniverse.command;
  };
  readonly command: string;
};

export const referenceAvailable = existsSync(pinnedUpstream.root);

const generatedFixtureFiles = new Set(["output.tsgo.json", "warnings.tsgo.json", "ts7-oracle.json"]);

function isGeneratedFixtureFile(path: string): boolean {
  return generatedFixtureFiles.has(path.split("/").at(-1) ?? "");
}

function filesRecursively(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...filesRecursively(path));
    else if (entry.isFile()) result.push(path);
    else if (lstatSync(path).isFile()) result.push(path);
  }
  return result.sort();
}

function pathUniverseDigest(paths: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...paths].sort()), "utf8")
    .digest("hex");
}

/** Validate a relative fixture path list against the pinned commit contract. */
export function validatePinnedFixturePathUniverse(paths: readonly string[]): void {
  const sortedPaths = [...paths].sort();
  if (
    sortedPaths.length !== pinnedFixturePathUniverse.count ||
    pathUniverseDigest(sortedPaths) !== pinnedFixturePathUniverse.sha256
  ) {
    throw new Error(
      `Pinned upstream fixture path universe is stale: expected ${pinnedFixturePathUniverse.count} files ` +
        `with digest ${pinnedFixturePathUniverse.sha256}.`
    );
  }
}

function gitOutput(referenceRoot: string, args: readonly string[], description: string): string {
  const result = spawnSync("git", ["-C", referenceRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim();
    throw new Error(
      `Pinned upstream reference ${description} failed: ${detail || "git exited unsuccessfully"}.`
    );
  }
  return result.stdout;
}

function assertCleanPinnedCheckout(referenceRoot: string): void {
  let checkoutRoot: string;
  try {
    checkoutRoot = realpathSync(referenceRoot);
  } catch (error) {
    throw new Error(`Pinned upstream reference checkout is not readable: ${String(error)}.`);
  }

  const reportedRoot = resolve(
    gitOutput(referenceRoot, ["rev-parse", "--show-toplevel"], "root identity").trim()
  );
  if (reportedRoot !== resolve(checkoutRoot)) {
    throw new Error(`Pinned upstream reference root is not a repository checkout: ${referenceRoot}.`);
  }

  const commit = gitOutput(referenceRoot, ["rev-parse", "HEAD"], "commit identity").trim();
  if (commit !== pinnedUpstream.commit) {
    throw new Error(
      `Pinned upstream reference must be at ${pinnedUpstream.commit}; found ${commit || "no commit"}.`
    );
  }

  const status = gitOutput(
    referenceRoot,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "cleanliness"
  );
  if (status.trim().length > 0) {
    throw new Error(
      "Pinned upstream reference checkout is dirty; tracked changes and untracked fixture originals " +
        "cannot redefine conformance evidence."
    );
  }

  const committedPaths = gitOutput(
    referenceRoot,
    ["ls-tree", "-r", "--name-only", pinnedUpstream.commit, "--", "test/fixtures"],
    "fixture path universe"
  )
    .split(/\r?\n/u)
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map((path) => path.slice("test/fixtures/".length));
  validatePinnedFixturePathUniverse(committedPaths);
}

function assertPhysicalPathUniverse(referenceFixtureRoot: string): readonly string[] {
  const paths = filesRecursively(referenceFixtureRoot)
    .map((path) => posixRelative(referenceFixtureRoot, path))
    .sort();
  try {
    validatePinnedFixturePathUniverse(paths);
  } catch {
    throw new Error(
      `Pinned upstream checkout has an unexpected fixture path universe: expected ` +
        `${pinnedFixturePathUniverse.count} files with digest ${pinnedFixturePathUniverse.sha256}.`
    );
  }
  return paths;
}

/**
 * Compare the complete copied fixture tree against the pinned checkout.
 *
 * The audit is intentionally independent of the conformance runner: it walks
 * every upstream support file, not just the manifest's input and output. The
 * only excluded names are locally generated TS7/warning evidence files, which
 * have no counterpart in the immutable checkout.
 */
export function auditPinnedReference(
  mode: ReferenceAuditMode,
  options: { readonly fixtureRoot?: string; readonly referenceRoot?: string } = {}
): ReferenceAuditResult {
  const localRoot = resolve(options.fixtureRoot ?? resolve(import.meta.dirname, "../test/fixtures"));
  const referenceRoot = resolve(options.referenceRoot ?? pinnedUpstream.root);
  const referenceFixtureRoot = join(referenceRoot, "test/fixtures");
  const command = `reference audit ${mode} ${pinnedUpstream.repository}@${pinnedUpstream.commit}`;
  if (!existsSync(referenceRoot)) {
    if (mode === "required") {
      throw new Error(
        `Pinned upstream reference is unavailable: ${referenceRoot}. ` +
          "Provide the ignored checkout or run the normal optional audit."
      );
    }
    return {
      mode,
      status: "skipped",
      repository: pinnedUpstream.repository,
      commit: pinnedUpstream.commit,
      fixtureCount: 0,
      comparedFiles: 0,
      pathUniverse: {
        count: 0,
        sha256: skippedPathUniverseSha256,
        command: pinnedFixturePathUniverse.command,
      },
      command,
    };
  }

  assertCleanPinnedCheckout(referenceRoot);
  const referenceRelativePaths = assertPhysicalPathUniverse(referenceFixtureRoot);
  const referenceFiles = referenceRelativePaths.map((path) => join(referenceFixtureRoot, path));
  const referenceByRelative = new Map(
    referenceFiles.map((path) => [posixRelative(referenceFixtureRoot, path), path])
  );
  const referenceFixtureNames = new Set(referenceRelativePaths.map((path) => path.split("/")[0]));
  if (referenceFixtureNames.size !== 116) {
    throw new Error(
      `Pinned upstream fixture tree must contain 116 fixture directories; found ${referenceFixtureNames.size}.`
    );
  }
  const localFiles = filesRecursively(localRoot).filter((path) => {
    const relativePath = posixRelative(localRoot, path);
    const fixtureName = relativePath.split("/")[0];
    return (
      fixtureName !== undefined &&
      referenceFixtureNames.has(fixtureName) &&
      !isGeneratedFixtureFile(relativePath)
    );
  });
  const localByRelative = new Map(localFiles.map((path) => [posixRelative(localRoot, path), path]));
  for (const [path, referencePath] of referenceByRelative) {
    const localPath = localByRelative.get(path);
    if (localPath === undefined) throw new Error(`Copied upstream file is missing: ${path}`);
    if (sha256File(localPath) !== sha256File(referencePath)) {
      throw new Error(`Copied upstream file bytes changed: ${path}`);
    }
  }
  for (const path of localByRelative.keys()) {
    if (!referenceByRelative.has(path)) throw new Error(`Unexpected copied fixture file: ${path}`);
  }
  return {
    mode,
    status: "verified",
    repository: pinnedUpstream.repository,
    commit: pinnedUpstream.commit,
    fixtureCount: referenceFixtureNames.size,
    comparedFiles: referenceFiles.length,
    pathUniverse: {
      count: referenceFiles.length,
      sha256: pathUniverseDigest(referenceRelativePaths),
      command: pinnedFixturePathUniverse.command,
    },
    command,
  };
}

/** A compact helper for existing issue suites that only need optional bytes. */
export function assertOptionalReferenceBytes(): ReferenceAuditResult {
  return auditPinnedReference("optional");
}
