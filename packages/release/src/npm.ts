import { Schema } from "effect";
import type { Effect } from "effect";
import { spawnSync } from "node:child_process";

import { lift, liftPromise } from "./errors.ts";
import type { ReleaseError } from "./errors.ts";
import type { ReleasePackage } from "./files.ts";
import { isCommit } from "./intent.ts";
import type { CommitSha } from "./intent.ts";
import { decodeJson } from "./json.ts";

/** What one published npm version records about the release that produced it. */
type PublishedVersion = {
  /** The archive integrity npm recorded for this version, when the packument carries one. */
  integrity?: string;
  /** The release commit recorded in the published manifest, when it is a full commit SHA. */
  commit?: CommitSha;
};

/** One package's npm packument: versions by version string, and dist-tag to version. */
export type Registry = {
  versions: Map<string, PublishedVersion>;
  tags: Map<string, string>;
};

/** Publishes the archive to the staging tag, then moves the installable dist-tag. */
export type NpmPublisher = {
  publish: (archive: string) => Effect.Effect<void, ReleaseError>;
  promote: (version: string, tag: string) => Effect.Effect<void, ReleaseError>;
};

const ReleaseSource = Schema.Struct({
  commit: Schema.optionalKey(Schema.String),
});

const NpmVersion = Schema.Struct({
  dist: Schema.Struct({
    integrity: Schema.optionalKey(Schema.String),
  }),
  elmeraRelease: Schema.optionalKey(ReleaseSource),
  gitHead: Schema.optionalKey(Schema.String),
});

const NpmPackument = Schema.Struct({
  versions: Schema.Record(Schema.String, NpmVersion),
  "dist-tags": Schema.Record(Schema.String, Schema.String),
});

function registryUrl(packageName: string): string {
  return `https://registry.npmjs.org/${packageName.replace("/", "%2f")}`;
}

function publishedCommit(manifest: typeof NpmVersion.Type): CommitSha | undefined {
  // Both fields are usable only as a full commit SHA; a missing or unusable recorded value is
  // absent metadata, not a reason to fail every read of the package's history. A present
  // `elmeraRelease` record owns the answer: a malformed one never falls back to gitHead.
  if (manifest.elmeraRelease !== undefined) {
    const recorded = manifest.elmeraRelease.commit;
    return recorded !== undefined && isCommit(recorded) ? recorded : undefined;
  }
  return manifest.gitHead !== undefined && isCommit(manifest.gitHead) ? manifest.gitHead : undefined;
}

async function fetchRegistry(packageName: string, fetcher: typeof fetch): Promise<Registry> {
  const response = await fetcher(registryUrl(packageName), { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return { versions: new Map(), tags: new Map() };
  if (!response.ok) throw new Error(`npm registry lookup failed: ${String(response.status)}`);
  const data = decodeJson(await response.text(), NpmPackument, "npm registry");
  const versions = new Map<string, PublishedVersion>();
  for (const [version, manifest] of Object.entries(data.versions)) {
    versions.set(version, {
      integrity: manifest.dist.integrity,
      commit: publishedCommit(manifest),
    });
  }
  return { versions, tags: new Map(Object.entries(data["dist-tags"])) };
}

/**
 * Runs one npm CLI command in `cwd`. A non-zero exit fails naming the status and npm's captured
 * stderr; the release transport injects it so tests can stand in for the npm process.
 */
export type NpmRunner = (cwd: string, args: readonly string[]) => Effect.Effect<void, ReleaseError>;

/** The live npm CLI: a synchronous `npm` child process with stdin closed and stderr captured. */
export const runNpmCli: NpmRunner = (cwd, args) =>
  lift(() => {
    // npm writes its publish notice and progress to stderr. Stdout stays
    // attached, stdin stays closed so npm can never block on a prompt (CI
    // authentication is token-based), and stderr is captured to name a
    // failure and re-emitted after a success; progress is not live, but the
    // CI log keeps the full trace.
    const result = spawnSync("npm", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "inherit", "pipe"],
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      const stderr = result.stderr.trim();
      throw new Error(
        stderr === ""
          ? `npm failed with status ${String(result.status)}`
          : `npm failed with status ${String(result.status)}: ${stderr}`
      );
    }
    process.stderr.write(result.stderr);
  });

/**
 * npm CLI port for one package, run through `run` in the checkout root. Publications publish to
 * `pending`; promotion moves the channel dist-tag.
 */
export function createNpmPublisher(pkg: ReleasePackage, run: NpmRunner = runNpmCli): NpmPublisher {
  return {
    publish: (archive) =>
      run(pkg.checkoutRoot, [
        "publish",
        archive,
        "--access",
        "public",
        "--tag",
        "pending",
        "--ignore-scripts",
      ]),
    promote: (version, tag) =>
      run(pkg.checkoutRoot, ["dist-tag", "add", `${pkg.packageName}@${version}`, tag]),
  };
}

/**
 * Reads and parses the package's npm packument. A 404 is an empty registry; every other HTTP or
 * network failure and any malformed packument is a failure, never an empty registry.
 */
export function readRegistry(
  packageName: string,
  fetcher: typeof fetch
): Effect.Effect<Registry, ReleaseError> {
  return liftPromise(() => fetchRegistry(packageName, fetcher));
}
